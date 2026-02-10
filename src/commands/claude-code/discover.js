import fs from "node:fs";
import * as p from "@clack/prompts";
import {
  PORTKEY_GATEWAY,
  c,
  ok,
  err,
  warn,
  mask,
  jsonRead,
  findProjectRoot,
  detectShellRc,
  getConfigPath,
} from "../../utils.js";

const LAYERS = ["enterprise", "global", "project-shared", "project-local"];
const LAYER_LABELS = {
  enterprise: "Enterprise",
  global: "Global",
  "project-shared": "Project shared",
  "project-local": "Project local",
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
  console.log("  Scanning where Portkey/Claude Code variables are currently set.\n");

  const projectRoot = findProjectRoot();

  // ── Config files ──────────────────────────────────────────────────────────
  const fileLines = [];
  for (const layer of LAYERS) {
    const filePath = getConfigPath(layer, projectRoot);
    const label = LAYER_LABELS[layer];
    if (!filePath) {
      fileLines.push(`${c.dim}${label.padEnd(16)} (not applicable)${c.reset}`);
    } else if (fs.existsSync(filePath)) {
      fileLines.push(`${c.green}${label.padEnd(16)}${c.reset} ${filePath}`);
    } else {
      fileLines.push(
        `${c.dim}${label.padEnd(16)} ${filePath} (not found)${c.reset}`
      );
    }
  }

  // Shell RC
  const shellRc = detectShellRc();
  let shellHasVars = false;
  try {
    const content = fs.readFileSync(shellRc, "utf8");
    shellHasVars = /PORTKEY|ANTHROPIC/.test(content);
  } catch {}
  if (shellHasVars) {
    fileLines.push(`${c.green}${"Shell env".padEnd(16)}${c.reset} ${shellRc}`);
  } else {
    fileLines.push(
      `${c.dim}${"Shell env".padEnd(16)} ${shellRc} (no Portkey/Anthropic vars)${c.reset}`
    );
  }

  if (projectRoot) {
    fileLines.push(`${c.dim}Project root: ${projectRoot}${c.reset}`);
  } else {
    fileLines.push(`${c.yellow}⚠ No project root detected${c.reset}`);
  }

  p.note(fileLines.join("\n"), "Config Files");

  // ── Variable resolution ───────────────────────────────────────────────────
  const varLines = [
    `${c.dim}Shows where each variable is set and which value wins.${c.reset}`,
    `${c.dim}Precedence: Shell env > Enterprise > Project local > Project shared > Global${c.reset}`,
    "",
  ];

  let conflictCount = 0;

  for (const varName of VARS) {
    const sources = [];
    const values = {};

    // Read from each settings file
    for (const layer of LAYERS) {
      const filePath = getConfigPath(layer, projectRoot);
      if (!filePath || !fs.existsSync(filePath)) continue;
      const val = jsonRead(filePath, `env.${varName}`);
      if (val !== undefined && val !== null) {
        sources.push(layer);
        values[layer] = String(val);
      }
    }

    // Shell env
    const shellVal = process.env[varName];
    if (shellVal) {
      sources.push("shell");
      values["shell"] = shellVal;
    }

    if (sources.length === 0) {
      varLines.push(
        `${c.dim}${varName.padEnd(30)} (not set)${c.reset}`
      );
      continue;
    }

    // Determine winner (shell > enterprise > project-local > project-shared > global)
    const precedence = ["shell", "enterprise", "project-local", "project-shared", "global"];
    let winner = "";
    let wsrc = "";
    for (const src of precedence) {
      if (values[src]) {
        winner = values[src];
        wsrc = src;
        break;
      }
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

  // ── Routing health ────────────────────────────────────────────────────────
  const healthLines = [];

  // Resolve ANTHROPIC_BASE_URL
  let base = process.env.ANTHROPIC_BASE_URL || "";
  if (!base) {
    const checkOrder = [
      getConfigPath("enterprise", projectRoot),
      getConfigPath("project-local", projectRoot),
      getConfigPath("project-shared", projectRoot),
      getConfigPath("global", projectRoot),
    ].filter(Boolean);
    for (const f of checkOrder) {
      if (!fs.existsSync(f)) continue;
      const val = jsonRead(f, "env.ANTHROPIC_BASE_URL");
      if (val) {
        base = val;
        break;
      }
    }
  }

  if (base === PORTKEY_GATEWAY) {
    healthLines.push(`${c.green}✔${c.reset} ANTHROPIC_BASE_URL → Portkey gateway`);
  } else if (base && base.includes("portkey")) {
    healthLines.push(`${c.green}✔${c.reset} ANTHROPIC_BASE_URL → ${base} (custom gateway)`);
  } else if (base) {
    healthLines.push(`${c.yellow}⚠${c.reset} ANTHROPIC_BASE_URL = ${base} (not a recognized Portkey URL)`);
  } else {
    healthLines.push(`${c.red}✘${c.reset} ANTHROPIC_BASE_URL is not set anywhere`);
  }

  // Detect routing type from custom headers
  let hdrs = "";
  const checkOrder = [
    getConfigPath("enterprise", projectRoot),
    getConfigPath("project-local", projectRoot),
    getConfigPath("project-shared", projectRoot),
    getConfigPath("global", projectRoot),
  ].filter(Boolean);
  for (const f of checkOrder) {
    if (!fs.existsSync(f)) continue;
    const val = jsonRead(f, "env.ANTHROPIC_CUSTOM_HEADERS");
    if (val) {
      hdrs = val;
      break;
    }
  }
  if (!hdrs) hdrs = process.env.ANTHROPIC_CUSTOM_HEADERS || "";

  if (hdrs.includes("x-portkey-config:")) {
    const configVal = hdrs.match(/x-portkey-config:(\S+)/)?.[1] || "";
    healthLines.push(`${c.green}✔${c.reset} Routing via config: ${configVal}`);
  } else if (hdrs.includes("x-portkey-provider:")) {
    const provVal = hdrs.match(/x-portkey-provider:(\S+)/)?.[1] || "";
    healthLines.push(`${c.green}✔${c.reset} Routing via provider: ${provVal}`);
  }

  for (const flag of [
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
  ]) {
    if (process.env[flag] === "1") {
      healthLines.push(
        `${c.yellow}⚠${c.reset} ${flag}=1 — bypasses ANTHROPIC_BASE_URL`
      );
    }
  }

  p.note(healthLines.join("\n"), "Routing Health");

  // ── Summary ───────────────────────────────────────────────────────────────
  if (conflictCount > 0) {
    warn(
      `${conflictCount} variable(s) set in multiple layers — highest precedence wins`
    );
  } else {
    ok("No conflicts across config layers.");
  }
  if (base === PORTKEY_GATEWAY) {
    ok("Portkey routing active.");
  } else {
    err("Portkey routing NOT active — run setup.");
  }
  console.log();
}
