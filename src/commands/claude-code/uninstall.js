import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as p from "@clack/prompts";
import {
  c,
  ok,
  findProjectRoot,
  detectShellRc,
  settingsRemoveKeys,
  settingsRemoveMcp,
  removeShellRcBlock,
  jsonRead,
  settingsReadMcp,
  AGENT_SKILLS_DIRS,
} from "../../utils.js";

const ENV_KEYS_TO_REMOVE = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_AUTH_TOKEN",
  "PORTKEY_API_KEY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
];

export async function doUninstall(args) {
  p.intro(`${c.bold}Removing Portkey Config${c.reset}`);

  const home        = os.homedir();
  const projectRoot = findProjectRoot();

  // ── Shell RC block ────────────────────────────────────────────────────────
  const shellRc = detectShellRc();
  try {
    const content = fs.readFileSync(shellRc, "utf8");
    if (content.includes("# ── Portkey + Claude Code")) {
      const remove = args.yes || (await p.confirm({
        message: `Remove Portkey block from ${shellRc}?`,
        initialValue: true,
      }));
      if (!p.isCancel(remove) && remove) {
        removeShellRcBlock(shellRc);
        ok(`Removed from ${shellRc}`);
      }
    }
  } catch {}

  // ── Settings env vars ─────────────────────────────────────────────────────
  const settingsFiles = [path.join(home, ".claude", "settings.json")];
  if (projectRoot) {
    settingsFiles.push(
      path.join(projectRoot, ".claude", "settings.json"),
      path.join(projectRoot, ".claude", "settings.local.json")
    );
  }

  for (const f of settingsFiles) {
    if (!fs.existsSync(f)) continue;
    const hasPortkey =
      jsonRead(f, "env.ANTHROPIC_BASE_URL") ||
      jsonRead(f, "env.ANTHROPIC_CUSTOM_HEADERS");
    if (!hasPortkey) continue;

    const remove = args.yes || (await p.confirm({
      message: `Remove Portkey env vars from ${f}?`,
      initialValue: true,
    }));
    if (p.isCancel(remove)) break;
    if (remove) {
      settingsRemoveKeys(f, ENV_KEYS_TO_REMOVE);
      ok(`Cleaned gateway config from ${f}`);
    }
  }

  // ── MCP servers ───────────────────────────────────────────────────────────
  // Claude Code stores MCP in .mcp.json (project) and ~/.claude.json (user)
  const mcpFiles = [
    projectRoot ? path.join(projectRoot, ".mcp.json") : null,
    path.join(home, ".claude.json"),
  ].filter(Boolean);

  for (const f of mcpFiles) {
    if (!fs.existsSync(f)) continue;
    const servers = settingsReadMcp(f);
    const names   = Object.keys(servers);
    if (names.length === 0) continue;
    const label = f.endsWith(".mcp.json") ? "project (.mcp.json)" : "user (~/.claude.json)";

    const remove = args.yes || (await p.confirm({
      message: `Remove ${names.length} MCP server(s) from ${label}? (${names.join(", ")})`,
      initialValue: false,
    }));
    if (p.isCancel(remove)) break;
    if (remove) {
      settingsRemoveMcp(f, names);
      ok(`Removed MCP servers from ${label}`);
    }
  }

  // ── Skills ────────────────────────────────────────────────────────────────
  const agentKeys = ["claude", "cursor", "codex"];
  for (const agent of agentKeys) {
    const dirFn   = AGENT_SKILLS_DIRS[agent];
    const projDir = dirFn(projectRoot, false);
    const globDir = dirFn(projectRoot, true);

    for (const dir of [projDir, globDir]) {
      if (!fs.existsSync(dir)) continue;
      const entries = fs.readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
      if (entries.length === 0) continue;

      const remove = args.yes || (await p.confirm({
        message: `Remove ${entries.length} skill(s) from ${dir}? (${entries.join(", ")})`,
        initialValue: false,
      }));
      if (p.isCancel(remove)) break;
      if (remove) {
        for (const name of entries) {
          const skillDir = path.join(dir, name);
          fs.rmSync(skillDir, { recursive: true, force: true });
        }
        ok(`Removed skills from ${dir}`);
      }
    }
  }

  // ── Clean current session env ─────────────────────────────────────────────
  for (const k of ENV_KEYS_TO_REMOVE) delete process.env[k];

  p.outro("Done. Run a new terminal session to apply changes.");
}
