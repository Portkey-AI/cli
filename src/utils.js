import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";

// ── Constants ────────────────────────────────────────────────────────────────

const require = createRequire(import.meta.url);
const pkg = require("../package.json");
export const VERSION = pkg.version;
export const PORTKEY_GATEWAY = "https://api.portkey.ai";
export const PORTKEY_DASHBOARD = "https://app.portkey.ai";

/**
 * Placeholder written into team-shared / git-committed config instead of the live key.
 * Claude Code expands `${VAR}` in `.mcp.json` headers and `settings.json` env values,
 * so the secret stays in the environment (e.g. the user's shell rc) and never lands in git.
 */
export const PORTKEY_KEY_ENV = "PORTKEY_API_KEY";
export const PORTKEY_KEY_ENV_REF = "${" + PORTKEY_KEY_ENV + "}";

/** Shown on multiselect prompts — Clack uses arrows, Space toggles, Enter submits */
export const MULTISELECT_HINT =
  "↑↓ move highlight · Space = select or deselect · Enter = finish";

// ── Colors ───────────────────────────────────────────────────────────────────

const isColorSupported =
  process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";

const fmt = (code) => (isColorSupported ? `\x1b[${code}m` : "");

export const c = {
  reset: fmt(0),
  bold: fmt(1),
  dim: fmt(2),
  red: fmt("0;31"),
  green: fmt("0;32"),
  yellow: fmt("1;33"),
  cyan: fmt("0;36"),
  magenta: fmt("0;35"),
  blue: fmt("0;34"),
};

export const ok   = (msg) => console.log(`${c.green}✔${c.reset} ${msg}`);
export const err  = (msg) => console.log(`${c.red}✘${c.reset} ${msg}`);
export const warn = (msg) => console.log(`${c.yellow}⚠${c.reset} ${msg}`);
export const info = (msg) => console.log(`${c.cyan}→${c.reset} ${msg}`);
export const dim  = (msg) => console.log(`${c.dim}  ${msg}${c.reset}`);

export function mask(key) {
  if (!key) return "***";
  if (key.length > 8) return key.slice(0, 4) + "····" + key.slice(-4);
  if (key.length > 4) return key.slice(0, 2) + "····" + key.slice(-2);
  return "***";
}

// ── Secure write ─────────────────────────────────────────────────────────────

/**
 * Write a file the CLI itself authors and that may contain a secret (API key /
 * auth token) with owner-only permissions (0600). `fs.writeFileSync`'s `mode`
 * only applies when the file is created, so we also `chmod` to tighten any
 * pre-existing file on the default umask (which would otherwise leave it
 * world-readable at 0644).
 *
 * Use this only for files we own (e.g. `.mcp.json`, `.claude/settings.json`).
 * Do NOT use it for user-managed files like shell rc — their permissions are the
 * user's choice; warn with `warnIfFileGroupOrWorldReadable` instead.
 */
export function writeFileSecure(filePath, data) {
  fs.writeFileSync(filePath, data, { mode: 0o600 });
  try { fs.chmodSync(filePath, 0o600); } catch {}
}

/**
 * Warn (without modifying anything) when a file we just wrote a secret into is
 * readable by group or other. Intended for user-managed files such as shell rc,
 * where we deliberately never change permissions implicitly.
 */
export function warnIfFileGroupOrWorldReadable(filePath, secretLabel = "a credential") {
  let mode;
  try { mode = fs.statSync(filePath).mode & 0o777; } catch { return; }
  if (mode & 0o077) {
    warn(
      `${filePath} is readable by other users (permissions ${mode.toString(8)}) and now contains ${secretLabel}. ` +
        `On a shared machine, restrict it with: ${c.bold}chmod 600 ${filePath}${c.reset}`
    );
  }
}

// ── JSON helpers ─────────────────────────────────────────────────────────────

export function jsonRead(filePath, keyPath) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return keyPath.split(".").reduce((obj, key) => obj?.[key], data);
  } catch {
    return undefined;
  }
}

export function settingsSetEnv(filePath, pairs) {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(filePath, "utf8")); } catch {}
  if (!data.env) data.env = {};
  Object.assign(data.env, pairs);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSecure(filePath, JSON.stringify(data, null, 2) + "\n");
}

export function settingsSetKey(filePath, key, value) {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(filePath, "utf8")); } catch {}
  data[key] = value;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSecure(filePath, JSON.stringify(data, null, 2) + "\n");
}

export function settingsRemoveKeys(filePath, envKeys) {
  let data;
  try { data = JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return; }
  const env = data.env || {};
  for (const k of envKeys) delete env[k];
  if (Object.keys(env).length === 0) delete data.env;
  else data.env = env;
  writeFileSecure(filePath, JSON.stringify(data, null, 2) + "\n");
}

// ── MCP settings helpers ─────────────────────────────────────────────────────
//
// Claude Code has three MCP scopes, all stored in JSON files:
//
//   "local"   (default) – ~/.claude.json → projects["/abs/path"].mcpServers
//                         private, only active in the current project
//   "project"           – .mcp.json at project root
//                         committed to git, shared with the whole team
//   "user"              – ~/.claude.json → root mcpServers
//                         private, available across all projects
//
// Pass { scope: "local", projectPath: "/abs/path" } for local scope.
// Omit options (or pass scope: "user") to write to the root mcpServers.

function _mcpTarget(data, scope, projectPath) {
  if (scope === "local" && projectPath) {
    if (!data.projects) data.projects = {};
    if (!data.projects[projectPath]) data.projects[projectPath] = {};
    return data.projects[projectPath];
  }
  return data;
}

/**
 * Add or update MCP servers in a Claude settings JSON file.
 * servers: { "server-name": { type, url, headers } }
 * opts:    { scope: "local"|"project"|"user", projectPath: "/abs/path" }
 *          scope defaults to "user" (root mcpServers).
 */
export function settingsSetMcp(filePath, servers, { scope = "user", projectPath = null } = {}) {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(filePath, "utf8")); } catch {}
  const target = _mcpTarget(data, scope, projectPath);
  if (!target.mcpServers) target.mcpServers = {};
  Object.assign(target.mcpServers, servers);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSecure(filePath, JSON.stringify(data, null, 2) + "\n");
}

/**
 * Remove named MCP servers from a Claude settings JSON file.
 * names: array of server keys to remove.
 */
export function settingsRemoveMcp(filePath, names, { scope = "user", projectPath = null } = {}) {
  let data;
  try { data = JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return; }
  const target = _mcpTarget(data, scope, projectPath);
  const servers = target.mcpServers || {};
  for (const n of names) delete servers[n];
  if (Object.keys(servers).length === 0) delete target.mcpServers;
  else target.mcpServers = servers;
  writeFileSecure(filePath, JSON.stringify(data, null, 2) + "\n");
}

/**
 * Read all mcpServers from a Claude settings JSON file.
 * Returns {} if not found or file doesn't exist.
 */
export function settingsReadMcp(filePath, { scope = "user", projectPath = null } = {}) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (scope === "local" && projectPath) {
      return data.projects?.[projectPath]?.mcpServers || {};
    }
    return data.mcpServers || {};
  } catch {
    return {};
  }
}

// ── Path detection ───────────────────────────────────────────────────────────

export function findProjectRoot(startDir = process.cwd()) {
  let dir = startDir;
  const home = os.homedir();
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    if (fs.existsSync(path.join(dir, ".claude")) && dir !== home) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

export function detectShellRc() {
  const home = os.homedir();

  if (process.platform === "win32") {
    const pwshProfile = path.join(home, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1");
    const wpwshProfile = path.join(home, "Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1");
    if (fs.existsSync(pwshProfile)) return pwshProfile;
    if (fs.existsSync(wpwshProfile)) return wpwshProfile;
    const bashrc = path.join(home, ".bashrc");
    if (fs.existsSync(bashrc)) return bashrc;
    return pwshProfile;
  }

  const shell = path.basename(process.env.SHELL || "").toLowerCase();
  switch (shell) {
    case "zsh":
      return path.join(home, ".zshrc");
    case "fish":
      return path.join(home, ".config", "fish", "config.fish");
    case "nu":
    case "nushell":
      return path.join(home, ".config", "nushell", "env.nu");
    case "pwsh":
    case "powershell":
      return path.join(home, ".config", "powershell", "Microsoft.PowerShell_profile.ps1");
    case "bash":
      if (fs.existsSync(path.join(home, ".bashrc"))) return path.join(home, ".bashrc");
      return path.join(home, ".bash_profile");
    default:
      return path.join(home, ".bashrc");
  }
}

export function getConfigPath(layer, projectRoot) {
  const home = os.homedir();
  switch (layer) {
    case "enterprise": return findEnterprisePath();
    case "global":     return path.join(home, ".claude", "settings.json");
    case "project-shared":
      return projectRoot ? path.join(projectRoot, ".claude", "settings.json") : null;
    case "project-local":
      return projectRoot ? path.join(projectRoot, ".claude", "settings.local.json") : null;
    default: return null;
  }
}

function findEnterprisePath() {
  const candidates = [
    "/Library/Application Support/ClaudeCode/managed-settings.json",
    "/etc/claude-code/managed-settings.json",
  ];
  if (process.env.ProgramData)
    candidates.push(path.join(process.env.ProgramData, "ClaudeCode", "managed-settings.json"));
  if (process.env.LOCALAPPDATA)
    candidates.push(path.join(process.env.LOCALAPPDATA, "ClaudeCode", "managed-settings.json"));
  return candidates.find((p) => fs.existsSync(p)) || null;
}

export function getSettingsPath(location, projectRoot) {
  const home = os.homedir();
  switch (location) {
    case "project-local":  return path.join(projectRoot, ".claude", "settings.local.json");
    case "project-shared": return path.join(projectRoot, ".claude", "settings.json");
    case "global":         return path.join(home, ".claude", "settings.json");
    case "env":            return detectShellRc();
    default:               return path.join(home, ".claude", "settings.json");
  }
}

/**
 * Return the correct file path for MCP server storage based on scope.
 *
 * Claude Code MCP scopes (from https://code.claude.com/docs/en/mcp):
 *   project → .mcp.json at project root (team-shared, committed to git)
 *   user    → ~/.claude.json  (personal, all projects)
 *   local   → ~/.claude.json  (personal, this project only — stored under project path)
 *
 * For CLI purposes we simplify to two storage locations:
 *   - Any project scope  → <projectRoot>/.mcp.json
 *   - Global/user scope  → ~/.claude.json  (top-level mcpServers field)
 */
export function getMcpFilePath(location, projectRoot) {
  if (location === "global" || location === "user" || !projectRoot) {
    return path.join(os.homedir(), ".claude.json");
  }
  // project-local, project-shared, env, project — all write to .mcp.json in project
  return path.join(projectRoot, ".mcp.json");
}

/** @deprecated Use getMcpFilePath instead */
export function getMcpSettingsPath(projectRoot) {
  return getMcpFilePath("project", projectRoot);
}

// ── Skills path helpers ──────────────────────────────────────────────────────

export const AGENTS = {
  claude: { label: "Claude Code", dir: ".claude" },
  cursor: { label: "Cursor",      dir: ".cursor" },
  codex:  { label: "Codex",       dir: ".codex"  },
};

export const AGENT_SKILLS_DIRS = {
  claude: (root, global) => global
    ? path.join(os.homedir(), ".claude", "skills")
    : path.join(root || process.cwd(), ".claude", "skills"),
  cursor: (root, global) => global
    ? path.join(os.homedir(), ".cursor", "skills")
    : path.join(root || process.cwd(), ".cursor", "skills"),
  // Codex discovers skills at `~/.agents/skills` (USER) and `<repo>/.agents/skills` (REPO),
  // walking up to the repo root. See https://developers.openai.com/codex/skills
  codex:  (root, global) => global
    ? path.join(os.homedir(), ".agents", "skills")
    : path.join(root || process.cwd(), ".agents", "skills"),
};

/** Detect which of the supported agents are already configured. */
export function detectInstalledAgents(projectRoot) {
  const home = os.homedir();
  const installed = [];
  for (const [key, agent] of Object.entries(AGENTS)) {
    const globalDir  = path.join(home, agent.dir);
    const projectDir = projectRoot ? path.join(projectRoot, agent.dir) : null;
    if (fs.existsSync(globalDir) || (projectDir && fs.existsSync(projectDir))) {
      installed.push(key);
    }
  }
  return installed;
}

// ── Shell RC helpers ─────────────────────────────────────────────────────────

export function writeShellRc(filePath, block) {
  let content = "";
  try { content = fs.readFileSync(filePath, "utf8"); } catch {}
  content = content.replace(
    /\n?# ── Portkey \+ Claude Code[\s\S]*?# ── End Portkey \+ Claude Code ──\n?/g,
    ""
  );
  content += "\n" + block + "\n";
  // Preserve the user's existing permissions — never implicitly chmod a
  // user-managed shell rc. Callers warn via warnIfFileGroupOrWorldReadable
  // when the block contains a secret.
  fs.writeFileSync(filePath, content);
}

export function removeShellRcBlock(filePath) {
  try {
    let content = fs.readFileSync(filePath, "utf8");
    if (!content.includes("# ── Portkey + Claude Code")) return false;
    content = content.replace(
      /\n?# ── Portkey \+ Claude Code[\s\S]*?# ── End Portkey \+ Claude Code ──\n?/g,
      ""
    );
    fs.writeFileSync(filePath, content);
    return true;
  } catch {
    return false;
  }
}

// ── Config discovery ─────────────────────────────────────────────────────────

export function readExistingConfig() {
  const projectRoot = findProjectRoot();
  const checkOrder = [
    { layer: "project-local",  path: getConfigPath("project-local",  projectRoot) },
    { layer: "project-shared", path: getConfigPath("project-shared", projectRoot) },
    { layer: "global",         path: getConfigPath("global",         projectRoot) },
  ].filter((c) => c.path && fs.existsSync(c.path));

  for (const { layer, path: filePath } of checkOrder) {
    const baseUrl = jsonRead(filePath, "env.ANTHROPIC_BASE_URL");
    if (!baseUrl) continue;

    const authToken = jsonRead(filePath, "env.ANTHROPIC_AUTH_TOKEN") || "";
    const headers   = jsonRead(filePath, "env.ANTHROPIC_CUSTOM_HEADERS") || "";
    const model     = jsonRead(filePath, "model") || "";

    let mode = "", provider = "", configId = "";
    if (headers.includes("x-portkey-provider:")) {
      mode = "provider";
      provider = (headers.match(/x-portkey-provider:(\S+)/)?.[1] || "").replace(/^@+/, "");
    } else if (headers.includes("x-portkey-config:")) {
      const cfgVal = headers.match(/x-portkey-config:(\S+)/)?.[1] || "";
      if (cfgVal.startsWith("pc-") || cfgVal.length < 30) {
        mode = "config";
        configId = cfgVal;
      } else {
        mode = "oauth";
      }
    }

    return { found: true, filePath, location: layer, portkeyKey: authToken, gateway: baseUrl, mode, provider, configId, model, headers };
  }

  return { found: false };
}

// ── Misc ─────────────────────────────────────────────────────────────────────

export function isClaudeInstalled() {
  try {
    execSync("which claude", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function normalizeProvider(slug) {
  return "@" + slug.replace(/^@+/, "");
}

export function sortModels(a, b) {
  const idA = a.id.toLowerCase();
  const idB = b.id.toLowerCase();
  const latestA = idA.includes("latest"), latestB = idB.includes("latest");
  if (latestA && !latestB) return -1;
  if (!latestA && latestB) return 1;
  const hasDateA = /\d{8}$/.test(idA), hasDateB = /\d{8}$/.test(idB);
  if (!hasDateA && hasDateB) return -1;
  if (hasDateA && !hasDateB) return 1;
  const tierOrder = { opus: 0, sonnet: 1, haiku: 2 };
  const tierA = Object.keys(tierOrder).find((t) => idA.includes(t)) || "zzz";
  const tierB = Object.keys(tierOrder).find((t) => idB.includes(t)) || "zzz";
  const tierDiff = (tierOrder[tierA] ?? 99) - (tierOrder[tierB] ?? 99);
  if (tierDiff !== 0) return tierDiff;
  return idB.localeCompare(idA);
}

// ── Portkey API key permissions (403 hints) ───────────────────────────────────

/** True when Portkey likely rejected the call because the API key scopes are too narrow */
export function isLikelyPortkeyApiKeyPermissionError(message) {
  const m = String(message || "");
  return (
    /\b403\b/.test(m) ||
    /AB03/i.test(m) ||
    /not have enough permissions/i.test(m) ||
    (/permission/i.test(m) && /execute/i.test(m))
  );
}

/**
 * Copy for p.note: which Permission toggles to enable in the Portkey dashboard.
 * @param {"mcp"|"providers"|"configs"|"skills"|"models"} feature — what the user was doing
 */
export function portkeyApiKeyPermissionNoteBody(feature) {
  const intro = [
    `${c.yellow}HTTP 403 — your API key needs more permissions${c.reset}`,
    `In ${PORTKEY_DASHBOARD} go to ${c.bold}API Keys${c.reset} → your key → ${c.bold}Permissions${c.reset}. Enable:`,
  ];

  /** Shown only when fetch MCP integrations fails — MCP section only (no Providers / Completions) */
  const mcp = [
    ``,
    `${c.bold}MCP${c.reset}`,
    `  ${c.dim}•${c.reset} Enable ${c.bold}INVOKE${c.reset} under MCP in Permissions.`,
  ];

  const providers = [
    ``,
    `${c.bold}Providers${c.reset} (Model Catalog / virtual keys)`,
    `  ${c.dim}•${c.reset} READ, LIST`,
  ];

  const completions = [
    ``,
    `${c.bold}Completions${c.reset} (gateway chat)`,
    `  ${c.dim}•${c.reset} WRITE on /chat/completions, /completions, /images, /audio`,
  ];

  const configs = [
    ``,
    `${c.bold}Configs${c.reset}`,
    `  ${c.dim}•${c.reset} READ, LIST (and other config scopes you use)`,
  ];

  const prompts = [
    ``,
    `${c.bold}Prompts${c.reset} (team skills / partials)`,
    `  ${c.dim}•${c.reset} READ, LIST (and publish scopes if you sync writes)`,
  ];

  const foot = [``, `Save the key, then retry.`];

  const chunks = [intro];
  if (feature === "mcp") chunks.push(mcp);
  else if (feature === "providers") chunks.push(providers, completions);
  else if (feature === "configs") chunks.push(configs);
  else if (feature === "skills") chunks.push(prompts);
  else if (feature === "models") chunks.push(providers, completions);

  return chunks.flat().concat(foot).join("\n");
}
