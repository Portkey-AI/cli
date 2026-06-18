import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as p from "@clack/prompts";
import {
  VERSION,
  PORTKEY_DASHBOARD,
  PORTKEY_KEY_ENV,
  PORTKEY_KEY_ENV_REF,
  c,
  ok,
  err,
  info,
  warn,
  mask,
  findProjectRoot,
  detectShellRc,
  writeShellRc,
  getMcpFilePath,
  settingsSetMcp,
  settingsRemoveMcp,
  settingsReadMcp,
  jsonRead,
  readExistingConfig,
  MULTISELECT_HINT,
  isLikelyPortkeyApiKeyPermissionError,
  portkeyApiKeyPermissionNoteBody,
} from "../../utils.js";
import {
  fetchMcpServers,
  buildClaudeMcpHttpConfig,
  portkeyMcpRequiresOAuth,
} from "../../api.js";
import {
  writeCodexMcpServersToml,
  codexMcpTableId,
  getCodexConfigTomlPath,
  listCodexMcpServerTableNames,
} from "./codex-mcp-toml.js";

// ── Scope helpers ─────────────────────────────────────────────────────────────
// Claude Code MCP scopes (https://code.claude.com/docs/en/mcp):
//   local   (default) → ~/.claude.json  projects["/abs/path"].mcpServers
//   project           → .mcp.json at project root  (git-committed, team-shared)
//   user              → ~/.claude.json  root mcpServers  (all your projects)

function scopeToFilePath(scope, projectRoot) {
  if (scope === "project") return getMcpFilePath("project-shared", projectRoot);
  return getMcpFilePath("global", projectRoot); // both "local" and "user"
}

function scopeLabel(scope, projectRoot) {
  if (scope === "project") {
    return `project  ${c.dim}(.mcp.json in repo — uses ${PORTKEY_KEY_ENV_REF}, safe to commit)${c.reset}`;
  }
  if (scope === "local") {
    return `this project only  ${c.dim}(~/.claude.json, not under .claude/settings*)${c.reset}`;
  }
  return `all your projects  ${c.dim}(~/.claude.json root list)${c.reset}`;
}

// ── Add MCP servers ───────────────────────────────────────────────────────────

export async function doMcpAdd(args) {
  p.intro(`${c.bold}Add MCP Servers${c.reset}`);

  const existing   = readExistingConfig();
  const portkeyKey =
    args.portkeyKey ||
    process.env.PORTKEY_API_KEY  ||
    process.env.ANTHROPIC_AUTH_TOKEN ||
    existing.portkeyKey ||
    "";

  const gateway = args.gateway || existing.gateway || "https://api.portkey.ai";

  if (!portkeyKey) {
    err("No Portkey API key found. Run: portkey setup — or set PORTKEY_API_KEY.");
    return;
  }

  const projectRoot = findProjectRoot();

  // ── Which agent (harness)? ─────────────────────────────────────────────────
  let harness = (args.agent || "").toLowerCase().trim();
  if (harness === "all") harness = "";

  if (!harness && !args.yes) {
    const pick = await p.select({
      message: "Which agent should receive these MCP servers?",
      options: [
        {
          value: "claude",
          label: "Claude Code",
          hint:  "~/.claude.json and/or .mcp.json",
        },
        {
          value: "codex",
          label: "OpenAI Codex",
          hint:  ".codex/config.toml (streamable HTTP MCP)",
        },
      ],
      initialValue: "claude",
    });
    if (p.isCancel(pick)) return p.outro("Cancelled.");
    harness = pick;
  } else if (!harness && args.yes) {
    harness = "claude";
  }

  if (harness === "cursor") {
    p.note(
      `Cursor MCP is not written by this command. Use ${c.bold}portkey skills sync --agent cursor${c.reset} for team skills, ` +
        `or configure MCP in Cursor’s settings.`,
      "Cursor"
    );
    return p.outro("Done.");
  }

  if (harness !== "claude" && harness !== "codex") {
    err(`Unknown agent for mcp add: ${harness || "(empty)"}. Use --agent claude or --agent codex.`);
    return;
  }

  // ── Codex: config.toml scope ───────────────────────────────────────────────
  let codexTomlPath = null;
  if (harness === "codex") {
    let codexScope = "global";
    if (args.location === "project" || args.location === "local") {
      codexScope = projectRoot ? "project" : "global";
    } else if (args.location === "user" || args.location === "global") {
      codexScope = "global";
    } else if (!args.yes) {
      if (!projectRoot) {
        codexScope = "global";
        info(`${c.dim}No git project root — using ~/.codex/config.toml${c.reset}`);
      } else {
        const pick = await p.select({
          message: "Where should Codex MCP entries be saved?",
          options: [
            {
              value: "project",
              label: "This project",
              hint:  ".codex/config.toml in the repo",
            },
            {
              value: "global",
              label: "Global (home)",
              hint:  "~/.codex/config.toml",
            },
          ],
          initialValue: "project",
        });
        if (p.isCancel(pick)) return p.outro("Cancelled.");
        codexScope = pick;
      }
    } else {
      codexScope = projectRoot ? "project" : "global";
    }
    codexTomlPath = getCodexConfigTomlPath(projectRoot, codexScope);
  }

  // ── Claude: MCP file scope ─────────────────────────────────────────────────
  let mcpScope;
  if (harness === "claude") {
    if (args.location === "user" || args.location === "global") {
      mcpScope = "user";
    } else if (args.location === "project") {
      mcpScope = "project";
    } else if (args.location === "local") {
      mcpScope = "local";
    } else if (!args.yes) {
      const scopeOptions = [
        {
          value: "local",
          label: "This project only",
          hint:  "~/.claude.json (per-repo entry) — private, default",
        },
        {
          value: "project",
          label: "Repo file (.mcp.json)",
          hint:  `in project root — committed; key read from ${PORTKEY_KEY_ENV} env`,
        },
        {
          value: "user",
          label: "All your projects",
          hint:  "~/.claude.json — same MCP in every repo",
        },
      ];
      if (!projectRoot) scopeOptions.splice(0, 2);
      const pick = await p.select({
        message: "Where should Claude Code MCP servers be saved?",
        options: scopeOptions.length ? scopeOptions : [{ value: "user", label: "User (~/.claude.json)", hint: "all projects" }],
        initialValue: projectRoot ? "local" : "user",
      });
      if (p.isCancel(pick)) return p.outro("Cancelled.");
      mcpScope = pick;
    } else {
      mcpScope = projectRoot ? "local" : "user";
    }
  }

  // ── Fetch from Portkey ─────────────────────────────────────────────────────
  const s = p.spinner();
  s.start("Fetching MCP servers from Portkey...");
  const { data: servers, error } = await fetchMcpServers(portkeyKey, gateway);
  if (error) {
    s.stop(
      isLikelyPortkeyApiKeyPermissionError(error)
        ? "Failed to load MCP servers (API key permissions)"
        : `Failed to load MCP servers: ${error}`
    );
    if (isLikelyPortkeyApiKeyPermissionError(error)) {
      p.note(portkeyApiKeyPermissionNoteBody("mcp"), "API key permissions");
    }
    return;
  }
  s.stop(`Found ${servers.length} MCP server${servers.length !== 1 ? "s" : ""}`);

  if (servers.length === 0) {
    info(`No MCP servers registered in your workspace.`);
    info(`Create one at https://app.portkey.ai/mcp-servers`);
    return;
  }

  p.note(
    `${c.dim}Servers come from your Portkey workspace registry (same list for every agent).${c.reset}`,
    "Source"
  );

  // ── Multi-select ───────────────────────────────────────────────────────────
  p.note(
    `${c.dim}${MULTISELECT_HINT}${c.reset}`,
    "How to pick multiple servers"
  );
  const selected = await p.multiselect({
    message: "Which MCP servers should we add?",
    options: servers.map((srv) => ({
      value: srv.slug,
      label: srv.name,
      hint:  srv.description || srv.url || "",
    })),
    required: false,
  });

  if (p.isCancel(selected)) return p.outro("Cancelled.");
  if (!selected.length) {
    const skip = await p.confirm({
      message: "Nothing selected — skip MCP setup?",
      initialValue: true,
    });
    if (p.isCancel(skip) || skip) return;
    info(`Run ${c.bold}portkey mcp add${c.reset} to add MCP servers any time.`);
    return;
  }

  const picked = selected
    .map((slug) => servers.find((x) => x.slug === slug))
    .filter(Boolean);

  // ── Codex write ────────────────────────────────────────────────────────────
  if (harness === "codex") {
    if (args.dryRun) {
      p.note(
        `Would append ${picked.length} MCP table(s) to ${codexTomlPath}`,
        "Dry run"
      );
      return p.outro("No changes made.");
    }
    writeCodexMcpServersToml(codexTomlPath, picked);
    console.log();
    for (const srv of picked) {
      ok(`${codexMcpTableId(srv.slug)}  ${c.dim}${srv.url}${c.reset}`);
    }
    const oauthServers = picked.filter(portkeyMcpRequiresOAuth);
    if (oauthServers.length) {
      const ids = oauthServers.map((x) => codexMcpTableId(x.slug)).join(", ");
      console.log();
      info(
        `Upstream OAuth may be required for: ${oauthServers.map((x) => x.name || x.slug).join(", ")}  ` +
          `${c.dim}— ${c.bold}codex mcp login <name>${c.reset}${c.dim} (names: ${ids}).${c.reset}`
      );
    }
    const codexIds = picked.map((x) => codexMcpTableId(x.slug)).join(", ");
    console.log();
    p.note(
      `${c.bold}/mcp${c.reset} may still show OAuth until the server handshake matches your integration. ` +
        `If tools are empty, try ${c.bold}codex mcp login${c.reset} for: ${codexIds}.`,
      "Codex MCP"
    );
    return p.outro(
      `${picked.length} server${picked.length !== 1 ? "s" : ""} added to ${c.dim}${codexTomlPath}${c.reset}\n` +
        `  ${c.dim}Restart Codex to pick up MCP.${c.reset}`
    );
  }

  // ── Claude write ────────────────────────────────────────────────────────────
  // "project" scope writes a git-committed .mcp.json, so reference the key via
  // ${PORTKEY_API_KEY} instead of embedding the secret in a tracked file.
  const committed = mcpScope === "project";
  const keyRef = committed ? PORTKEY_KEY_ENV_REF : null;
  const mcpEntries = {};
  for (const slug of selected) {
    const srv = servers.find((x) => x.slug === slug);
    if (!srv) continue;
    mcpEntries[`portkey-${slug}`] = buildClaudeMcpHttpConfig(srv, portkeyKey, { keyRef });
  }

  if (args.dryRun) {
    p.note(JSON.stringify(mcpEntries, null, 2), "Dry run — would write to mcpServers");
    return p.outro("No changes made.");
  }

  const mcpFile = scopeToFilePath(mcpScope, projectRoot);
  settingsSetMcp(mcpFile, mcpEntries, {
    scope:       mcpScope,
    projectPath: mcpScope === "local" ? (projectRoot || process.cwd()) : null,
  });

  // The committed file only resolves if PORTKEY_API_KEY is in the environment.
  // Persist the secret to the user's shell rc (owner-only) so it works out of the box.
  if (committed && !process.env[PORTKEY_KEY_ENV]) {
    const shellRc = detectShellRc();
    const isFish  = shellRc.endsWith("config.fish");
    const isPwsh  = shellRc.endsWith(".ps1");
    const isNu    = shellRc.endsWith(".nu");
    let exportLine;
    if (isFish)      exportLine = `set -gx ${PORTKEY_KEY_ENV} "${portkeyKey}"`;
    else if (isPwsh) exportLine = `$env:${PORTKEY_KEY_ENV} = "${portkeyKey}"`;
    else if (isNu)   exportLine = `$env.${PORTKEY_KEY_ENV} = "${portkeyKey}"`;
    else             exportLine = `export ${PORTKEY_KEY_ENV}="${portkeyKey}"`;
    writeShellRc(shellRc, [
      `# ── Portkey + Claude Code (v${VERSION}) ──`,
      exportLine,
      "# ── End Portkey + Claude Code ──",
    ].join("\n"));
    warn(
      `.mcp.json references ${c.bold}${PORTKEY_KEY_ENV_REF}${c.reset} (no secret committed). ` +
        `Your key was saved to ${c.bold}${shellRc}${c.reset} — run ${c.bold}source ${shellRc}${c.reset} or open a new terminal.`
    );
  } else if (committed) {
    info(
      `.mcp.json references ${c.bold}${PORTKEY_KEY_ENV_REF}${c.reset} — no secret committed. ` +
        `Teammates set ${c.bold}${PORTKEY_KEY_ENV}${c.reset} in their environment.`
    );
  }

  console.log();
  for (const [name, cfg] of Object.entries(mcpEntries)) {
    ok(`${name}  ${c.dim}${cfg.url}${c.reset}`);
  }
  const oauthServers = picked.filter(portkeyMcpRequiresOAuth);
  if (oauthServers.length) {
    console.log();
    info(
      `Also complete upstream OAuth for: ${oauthServers.map((x) => x.name || x.slug).join(", ")}  ` +
        `${c.dim}— run ${c.bold}/mcp${c.reset}${c.dim} in Claude Code (workspace key is already saved).${c.reset}`
    );
  }
  console.log();
  p.outro(
    `${selected.length} server${selected.length !== 1 ? "s" : ""} added  ` +
    `[${scopeLabel(mcpScope, projectRoot)}]\n` +
    `  ${c.dim}Restart Claude Code to pick up the new MCP servers.${c.reset}`
  );
}

// ── List MCP servers ──────────────────────────────────────────────────────────

export async function doMcpList() {
  p.intro(`${c.bold}MCP Servers${c.reset}`);
  p.note(
    `${c.dim}Claude Code:${c.reset} ${c.reset}.mcp.json${c.dim} / ${c.reset}~/.claude.json${c.dim} (not .claude/settings*). ` +
      `${c.dim}Codex:${c.reset} ${c.reset}.codex/config.toml${c.dim} → ${c.reset}[mcp_servers.*]${c.dim} tables.${c.reset}`,
    "Where MCP is stored"
  );

  const projectRoot = findProjectRoot();
  const claudeJson  = path.join(os.homedir(), ".claude.json");
  const cwd         = projectRoot || process.cwd();

  // All three scopes Claude Code reads from
  const sections = [
    {
      label:   "This project only  (~/.claude.json, scoped to repo)",
      scope:   "local",
      file:    claudeJson,
      opts:    { scope: "local", projectPath: cwd },
    },
    {
      label:   "Repo file  (.mcp.json at project root)",
      scope:   "project",
      file:    projectRoot ? path.join(projectRoot, ".mcp.json") : null,
      opts:    { scope: "user" },
    },
    {
      label:   "All your projects  (~/.claude.json, global list)",
      scope:   "user",
      file:    claudeJson,
      opts:    { scope: "user" },
    },
  ];

  let totalFound = 0;

  for (const { label, file, opts } of sections) {
    if (!file || !fs.existsSync(file)) continue;
    const servers = settingsReadMcp(file, opts);
    const names   = Object.keys(servers);
    if (names.length === 0) continue;

    totalFound += names.length;
    const lines = [`${c.dim}${file}${c.reset}`, ""];
    for (const name of names) {
      const srv = servers[name];
      lines.push(`  ${c.green}✔${c.reset}  ${c.bold}${name}${c.reset}`);
      if (srv.url)  lines.push(`       ${c.dim}url:${c.reset}  ${srv.url}`);
      if (srv.type) lines.push(`       ${c.dim}type:${c.reset} ${srv.type}`);
    }
    p.note(lines.join("\n"), label);
  }

  const codexTomlPaths = [
    projectRoot
      ? { label: "Codex (project .codex/config.toml)", file: path.join(projectRoot, ".codex", "config.toml") }
      : null,
    { label: "Codex (global ~/.codex/config.toml)", file: path.join(os.homedir(), ".codex", "config.toml") },
  ].filter(Boolean);

  for (const { label, file } of codexTomlPaths) {
    if (!file || !fs.existsSync(file)) continue;
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const tableNames = listCodexMcpServerTableNames(text);
    if (tableNames.length === 0) continue;
    totalFound += tableNames.length;
    const lines = [`${c.dim}${file}${c.reset}`, ""];
    for (const name of tableNames) {
      lines.push(`  ${c.green}✔${c.reset}  ${c.bold}${name}${c.reset}  ${c.dim}[mcp_servers]${c.reset}`);
    }
    p.note(lines.join("\n"), label);
  }

  if (totalFound === 0) {
    info("No MCP servers configured.");
    info(`Add servers with: ${c.bold}portkey mcp add${c.reset}`);
  } else {
    ok(`${totalFound} MCP server${totalFound !== 1 ? "s" : ""} configured (Claude + Codex).`);
  }

  p.outro(
    `${c.dim}Quick summary: ${c.bold}portkey status${c.reset}${c.dim}  ·  full audit: ${c.bold}portkey discover${c.reset}`
  );
}

// ── Remove MCP servers ────────────────────────────────────────────────────────

export async function doMcpRemove(args) {
  p.intro(`${c.bold}Remove MCP Servers${c.reset}`);
  p.note(`${c.dim}${MULTISELECT_HINT}${c.reset}`, "How to select");

  const projectRoot = findProjectRoot();
  const claudeJson  = path.join(os.homedir(), ".claude.json");
  const cwd         = projectRoot || process.cwd();

  const sections = [
    { label: "This project only", file: claudeJson, opts: { scope: "local", projectPath: cwd } },
    { label: "Repo .mcp.json",    file: projectRoot ? path.join(projectRoot, ".mcp.json") : null, opts: { scope: "user" } },
    { label: "All projects",      file: claudeJson, opts: { scope: "user" } },
  ];

  const allServers = [];
  for (const { label, file, opts } of sections) {
    if (!file || !fs.existsSync(file)) continue;
    const servers = settingsReadMcp(file, opts);
    for (const name of Object.keys(servers)) {
      // Encode scope info into the value so we can look it up after selection
      allServers.push({
        name,
        file,
        opts,
        value: `${label}::${file}::${name}`,
        hint:  label,
      });
    }
  }

  if (allServers.length === 0) {
    info("No MCP servers configured to remove.");
    return;
  }

  const toRemove = await p.multiselect({
    message: "Which MCP servers should we remove?",
    options: allServers.map((s) => ({
      value: s.value,
      label: s.name,
      hint:  s.hint,
    })),
    required: false,
  });

  if (p.isCancel(toRemove)) return p.outro("Cancelled.");
  if (!toRemove.length) {
    info("Nothing removed.");
    return;
  }

  if (args.dryRun) {
    info(`Would remove: ${toRemove.map((v) => v.split("::")[2]).join(", ")}`);
    return p.outro("No changes made.");
  }

  for (const val of toRemove) {
    const entry = allServers.find((s) => s.value === val);
    if (!entry) continue;
    settingsRemoveMcp(entry.file, [entry.name], entry.opts);
    ok(`Removed ${entry.name}  ${c.dim}[${entry.hint}]${c.reset}`);
  }

  console.log();
  p.outro(`${toRemove.length} server${toRemove.length !== 1 ? "s" : ""} removed.`);
}
