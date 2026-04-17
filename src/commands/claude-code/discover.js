import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as p from "@clack/prompts";
import {
  PORTKEY_GATEWAY,
  c,
  ok,
  warn,
  mask,
  jsonRead,
  findProjectRoot,
  detectShellRc,
  getConfigPath,
  settingsReadMcp,
  AGENT_SKILLS_DIRS,
} from "../../utils.js";

const LAYERS = ["enterprise", "global", "project-shared", "project-local"];
const LAYER_LABELS = {
  enterprise:        "Enterprise",
  global:            "Global",
  "project-shared":  "Project shared",
  "project-local":   "Project local",
};

const VARS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_MODEL",
  "PORTKEY_API_KEY",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];

const SENSITIVE = /API_KEY|AUTH|HEADERS/;

export async function doDiscover() {
  p.intro(`${c.bold}Config Discovery${c.reset}`);
  console.log("  Scanning Portkey/Claude Code configuration across all layers.\n");

  const projectRoot = findProjectRoot();

  // ── Config files ─────────────────────────────────────────────────────────
  const fileLines = [];
  for (const layer of LAYERS) {
    const filePath = getConfigPath(layer, projectRoot);
    const label = LAYER_LABELS[layer];
    if (!filePath) {
      fileLines.push(`${c.dim}${label.padEnd(16)} (not applicable)${c.reset}`);
    } else if (fs.existsSync(filePath)) {
      fileLines.push(`${c.green}${label.padEnd(16)}${c.reset} ${filePath}`);
    } else {
      fileLines.push(`${c.dim}${label.padEnd(16)} ${filePath} (not found)${c.reset}`);
    }
  }

  const shellRc = detectShellRc();
  let shellHasVars = false;
  try {
    const content = fs.readFileSync(shellRc, "utf8");
    shellHasVars = /PORTKEY|ANTHROPIC/.test(content);
  } catch {}

  if (shellHasVars) {
    fileLines.push(`${c.green}${"Shell env".padEnd(16)}${c.reset} ${shellRc}`);
  } else {
    fileLines.push(`${c.dim}${"Shell env".padEnd(16)} ${shellRc} (no Portkey/Anthropic vars)${c.reset}`);
  }

  if (projectRoot) {
    fileLines.push(`${c.dim}Project root: ${projectRoot}${c.reset}`);
  } else {
    fileLines.push(`${c.yellow}⚠ No project root detected${c.reset}`);
  }

  p.note(fileLines.join("\n"), "Config Files");

  // ── Variable resolution ──────────────────────────────────────────────────
  const varLines = [
    `${c.dim}Shows where each variable is set and which value wins.${c.reset}`,
    `${c.dim}Precedence: Shell env > Enterprise > Project local > Project shared > Global${c.reset}`,
    "",
  ];

  let conflictCount = 0;

  for (const varName of VARS) {
    const sources = [];
    const values  = {};

    for (const layer of LAYERS) {
      const filePath = getConfigPath(layer, projectRoot);
      if (!filePath || !fs.existsSync(filePath)) continue;
      const val = jsonRead(filePath, `env.${varName}`);
      if (val !== undefined && val !== null) {
        sources.push(layer);
        values[layer] = String(val);
      }
    }

    const shellVal = process.env[varName];
    if (shellVal) {
      sources.push("shell");
      values["shell"] = shellVal;
    }

    if (sources.length === 0) {
      varLines.push(`${c.dim}${varName.padEnd(30)} (not set)${c.reset}`);
      continue;
    }

    const precedence = ["shell", "enterprise", "project-local", "project-shared", "global"];
    let winner = "", wsrc = "";
    for (const src of precedence) {
      if (values[src]) { winner = values[src]; wsrc = src; break; }
    }

    const display = SENSITIVE.test(varName) ? mask(winner) : winner;

    if (sources.length > 1) {
      conflictCount++;
      const also = sources.filter((s) => s !== wsrc).join(", ");
      varLines.push(
        `${c.yellow}⚠${c.reset} ${c.bold}${varName.padEnd(28)}${c.reset} = ${display}  ${c.yellow}← ${wsrc} wins${c.reset}  ${c.dim}(also in: ${also})${c.reset}`
      );
    } else {
      varLines.push(
        `${c.green}✔${c.reset} ${varName.padEnd(28)} = ${display}  ${c.dim}← ${wsrc}${c.reset}`
      );
    }
  }

  p.note(varLines.join("\n"), "Variable Resolution");

  // ── MCP servers ──────────────────────────────────────────────────────────
  // Claude Code has three MCP scopes:
  //   project → .mcp.json at project root
  //   local   → ~/.claude.json under projects["/abs/path"].mcpServers  (this project only)
  //   user    → ~/.claude.json root mcpServers  (all projects)
  const mcpLines = [];
  const claudeJson = path.join(os.homedir(), ".claude.json");

  let totalMcp = 0;

  // Project scope: .mcp.json
  if (projectRoot) {
    const mcpJson = path.join(projectRoot, ".mcp.json");
    if (fs.existsSync(mcpJson)) {
      const servers = settingsReadMcp(mcpJson);
      const names   = Object.keys(servers);
      if (names.length > 0) {
        totalMcp += names.length;
        mcpLines.push(`${c.dim}${mcpJson}  ${c.reset}${c.dim}[repo .mcp.json]${c.reset}`);
        for (const name of names) {
          const s = servers[name];
          mcpLines.push(`  ${c.green}✔${c.reset} ${name.padEnd(24)} ${c.dim}${s.url || ""}${c.reset}`);
        }
      }
    }
  }

  // Local scope: ~/.claude.json → projects[projectPath].mcpServers  (this project only)
  if (projectRoot && fs.existsSync(claudeJson)) {
    const servers = settingsReadMcp(claudeJson, { scope: "local", projectPath: projectRoot });
    const names   = Object.keys(servers);
    if (names.length > 0) {
      totalMcp += names.length;
        mcpLines.push(`${c.dim}${claudeJson}  ${c.reset}${c.dim}[this project only — ~/.claude.json]${c.reset}`);
      for (const name of names) {
        const s = servers[name];
        mcpLines.push(`  ${c.green}✔${c.reset} ${name.padEnd(24)} ${c.dim}${s.url || ""}${c.reset}`);
      }
    }
  }

  // User scope: ~/.claude.json → root mcpServers  (all projects)
  if (fs.existsSync(claudeJson)) {
    const servers = settingsReadMcp(claudeJson, { scope: "user" });
    const names   = Object.keys(servers);
    if (names.length > 0) {
      totalMcp += names.length;
        mcpLines.push(`${c.dim}${claudeJson}  ${c.reset}${c.dim}[all projects — ~/.claude.json]${c.reset}`);
      for (const name of names) {
        const s = servers[name];
        mcpLines.push(`  ${c.green}✔${c.reset} ${name.padEnd(24)} ${c.dim}${s.url || ""}${c.reset}`);
      }
    }
  }

  if (totalMcp === 0) {
    mcpLines.push(`${c.dim}No MCP servers configured. Run: portkey mcp add${c.reset}`);
    mcpLines.push(`${c.dim}Create one at https://app.portkey.ai/mcp-servers${c.reset}`);
  }
  p.note(mcpLines.join("\n"), "MCP Servers");

  // ── Skills ───────────────────────────────────────────────────────────────
  const skillsLines = [];
  const agentKeys = ["claude", "cursor", "codex"];
  let totalSkills = 0;

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
      totalSkills += entries.length;
      skillsLines.push(`${c.dim}${dir}${c.reset}`);
      for (const name of entries) {
        const exists = fs.existsSync(`${dir}/${name}/SKILL.md`);
        skillsLines.push(`  ${exists ? c.green + "✔" : c.dim + "○"}${c.reset} ${name}`);
      }
    }
  }

  if (totalSkills === 0) {
    skillsLines.push(`${c.dim}No skills synced. Run: portkey skills sync${c.reset}`);
    skillsLines.push(`${c.dim}Create one at https://app.portkey.ai/partials${c.reset}`);
  }
  p.note(skillsLines.join("\n"), "Skills");

  // ── Routing health ───────────────────────────────────────────────────────
  const healthLines = [];

  let baseUrl = process.env.ANTHROPIC_BASE_URL || "";
  if (!baseUrl) {
    const checkOrder = [
      getConfigPath("enterprise",    projectRoot),
      getConfigPath("project-local", projectRoot),
      getConfigPath("project-shared",projectRoot),
      getConfigPath("global",        projectRoot),
    ].filter(Boolean);
    for (const f of checkOrder) {
      if (!fs.existsSync(f)) continue;
      const val = jsonRead(f, "env.ANTHROPIC_BASE_URL");
      if (val) { baseUrl = val; break; }
    }
  }

  if (baseUrl === PORTKEY_GATEWAY || baseUrl === `${PORTKEY_GATEWAY}/`) {
    healthLines.push(`${c.green}✔${c.reset} ANTHROPIC_BASE_URL → Portkey managed gateway`);
  } else if (baseUrl && baseUrl.includes("portkey")) {
    healthLines.push(`${c.green}✔${c.reset} ANTHROPIC_BASE_URL → ${baseUrl} (private gateway)`);
  } else if (baseUrl) {
    healthLines.push(`${c.yellow}⚠${c.reset} ANTHROPIC_BASE_URL = ${baseUrl} (not a recognized Portkey URL)`);
  } else {
    healthLines.push(`${c.red}✘${c.reset} ANTHROPIC_BASE_URL is not set — run: portkey setup`);
  }

  let hdrs = process.env.ANTHROPIC_CUSTOM_HEADERS || "";
  if (!hdrs) {
    const checkOrder = [
      getConfigPath("enterprise",    projectRoot),
      getConfigPath("project-local", projectRoot),
      getConfigPath("project-shared",projectRoot),
      getConfigPath("global",        projectRoot),
    ].filter(Boolean);
    for (const f of checkOrder) {
      if (!fs.existsSync(f)) continue;
      const val = jsonRead(f, "env.ANTHROPIC_CUSTOM_HEADERS");
      if (val) { hdrs = val; break; }
    }
  }

  if (hdrs.includes("x-portkey-config:")) {
    const configVal = hdrs.match(/x-portkey-config:(\S+)/)?.[1] || "";
    healthLines.push(`${c.green}✔${c.reset} Routing via config: ${configVal}`);
  } else if (hdrs.includes("x-portkey-provider:")) {
    const provVal = hdrs.match(/x-portkey-provider:(\S+)/)?.[1] || "";
    healthLines.push(`${c.green}✔${c.reset} Routing via provider: ${provVal}`);
  } else if (baseUrl) {
    healthLines.push(`${c.yellow}⚠${c.reset} No routing header found (x-portkey-provider or x-portkey-config)`);
  }

  for (const flag of ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]) {
    if (process.env[flag] === "1") {
      healthLines.push(`${c.yellow}⚠${c.reset} ${flag}=1 — bypasses ANTHROPIC_BASE_URL`);
    }
  }

  p.note(healthLines.join("\n"), "Routing Health");

  // ── Summary ──────────────────────────────────────────────────────────────
  if (conflictCount > 0) {
    warn(`${conflictCount} variable(s) set in multiple layers — highest precedence wins`);
  }

  const isRoutingActive =
    baseUrl === PORTKEY_GATEWAY ||
    baseUrl === `${PORTKEY_GATEWAY}/` ||
    (baseUrl && baseUrl.includes("portkey"));

  if (isRoutingActive) {
    ok("Portkey gateway routing active.");
  } else {
    console.log(`${c.red}✘${c.reset} Portkey routing NOT active — run: ${c.bold}portkey setup${c.reset}`);
  }

  if (totalMcp > 0) ok(`${totalMcp} MCP server(s) configured.`);
  if (totalSkills > 0) ok(`${totalSkills} skill(s) synced.`);
  console.log();
}
