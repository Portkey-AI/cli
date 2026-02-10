import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";

// ── Constants ────────────────────────────────────────────────────────────────

export const VERSION = "1.0.0";
export const PORTKEY_GATEWAY = "https://api.portkey.ai";
export const PORTKEY_PROVIDERS_API = "https://api.portkey.ai/v1/providers";
export const PORTKEY_CONFIGS_API = "https://api.portkey.ai/v1/configs";
export const PORTKEY_DASHBOARD = "https://app.portkey.ai";

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
};

export const ok = (msg) => console.log(`${c.green}✔${c.reset} ${msg}`);
export const err = (msg) => console.log(`${c.red}✘${c.reset} ${msg}`);
export const warn = (msg) => console.log(`${c.yellow}⚠${c.reset} ${msg}`);
export const info = (msg) => console.log(`${c.cyan}→${c.reset} ${msg}`);
export const dim = (msg) => console.log(`${c.dim}  ${msg}${c.reset}`);

export function mask(key) {
  if (!key) return "***";
  if (key.length > 8) return key.slice(0, 4) + "····" + key.slice(-4);
  if (key.length > 4) return key.slice(0, 2) + "····" + key.slice(-2);
  return "***";
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
  try {
    data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    // start fresh
  }
  if (!data.env) data.env = {};
  Object.assign(data.env, pairs);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

export function settingsSetKey(filePath, key, value) {
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    // start fresh
  }
  data[key] = value;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

export function settingsRemoveKeys(filePath, envKeys) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return;
  }
  const env = data.env || {};
  for (const k of envKeys) delete env[k];
  if (Object.keys(env).length === 0) delete data.env;
  else data.env = env;
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
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

  // On Windows, $SHELL is usually not set
  if (process.platform === "win32") {
    // Check for PowerShell profile
    const pwshProfile = path.join(
      home,
      "Documents",
      "PowerShell",
      "Microsoft.PowerShell_profile.ps1"
    );
    const wpwshProfile = path.join(
      home,
      "Documents",
      "WindowsPowerShell",
      "Microsoft.PowerShell_profile.ps1"
    );
    if (fs.existsSync(pwshProfile)) return pwshProfile;
    if (fs.existsSync(wpwshProfile)) return wpwshProfile;
    // Git Bash on Windows
    const bashrc = path.join(home, ".bashrc");
    if (fs.existsSync(bashrc)) return bashrc;
    // Default to PowerShell Core profile
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
      // PowerShell on macOS/Linux
      return path.join(home, ".config", "powershell", "Microsoft.PowerShell_profile.ps1");
    case "bash":
      // Prefer .bashrc, fall back to .bash_profile on macOS
      if (fs.existsSync(path.join(home, ".bashrc")))
        return path.join(home, ".bashrc");
      return path.join(home, ".bash_profile");
    default:
      // Unknown shell — try .bashrc as safest default
      return path.join(home, ".bashrc");
  }
}

export function getConfigPath(layer, projectRoot) {
  const home = os.homedir();
  switch (layer) {
    case "enterprise":
      return findEnterprisePath();
    case "global":
      return path.join(home, ".claude", "settings.json");
    case "project-shared":
      return projectRoot
        ? path.join(projectRoot, ".claude", "settings.json")
        : null;
    case "project-local":
      return projectRoot
        ? path.join(projectRoot, ".claude", "settings.local.json")
        : null;
    default:
      return null;
  }
}

function findEnterprisePath() {
  const candidates = [
    "/Library/Application Support/ClaudeCode/managed-settings.json",
    "/etc/claude-code/managed-settings.json",
  ];
  if (process.env.ProgramData) {
    candidates.push(
      path.join(
        process.env.ProgramData,
        "ClaudeCode",
        "managed-settings.json"
      )
    );
  }
  if (process.env.LOCALAPPDATA) {
    candidates.push(
      path.join(
        process.env.LOCALAPPDATA,
        "ClaudeCode",
        "managed-settings.json"
      )
    );
  }
  return candidates.find((p) => fs.existsSync(p)) || null;
}

export function getSettingsPath(location, projectRoot) {
  const home = os.homedir();
  switch (location) {
    case "project-local":
      return path.join(projectRoot, ".claude", "settings.local.json");
    case "project-shared":
      return path.join(projectRoot, ".claude", "settings.json");
    case "global":
      return path.join(home, ".claude", "settings.json");
    case "env":
      return detectShellRc();
    default:
      return path.join(home, ".claude", "settings.json");
  }
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

export async function fetchJSON(url, headers = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, {
      headers,
      signal: controller.signal,
    });
    if (!res.ok) {
      let detail = "";
      try {
        const body = await res.json();
        detail = body.message || body.error?.message || "";
      } catch {}
      const msg = `HTTP ${res.status}${detail ? ": " + detail : ""}`;
      throw new Error(msg);
    }
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch providers from Portkey API.
 * @param {string} portkeyKey - Portkey API key
 * @param {string} [gateway] - Custom gateway URL (defaults to PORTKEY_GATEWAY)
 * Returns { data: [...], error: null } on success,
 * or { data: null, error: "reason" } on failure.
 */
export async function fetchProviders(portkeyKey, gateway) {
  const baseUrl = (gateway || PORTKEY_GATEWAY).replace(/\/+$/, "");
  try {
    const data = await fetchJSON(`${baseUrl}/v1/providers`, {
      "x-portkey-api-key": portkeyKey,
    });
    const providers = (data.data || [])
      .filter((p) => p.status === "active" && p.slug)
      .map((p) => ({
        slug: p.slug,
        name: p.name || "",
        provider: p.provider || "",
        workspace: p.workspace_name || "",
        note:
          (p.note || "").replace(/\|/g, "-") ===
          "Created automatically on integration access grant"
            ? ""
            : (p.note || "").replace(/\|/g, "-"),
      }));
    return { data: providers, error: null };
  } catch (e) {
    return { data: null, error: e.message };
  }
}

/**
 * Fetch configs from Portkey API.
 * @param {string} portkeyKey - Portkey API key
 * @param {string} [gateway] - Custom gateway URL (defaults to PORTKEY_GATEWAY)
 * Returns { data: [...], error: null } on success,
 * or { data: null, error: "reason" } on failure.
 */
export async function fetchConfigs(portkeyKey, gateway) {
  const baseUrl = (gateway || PORTKEY_GATEWAY).replace(/\/+$/, "");
  try {
    const data = await fetchJSON(`${baseUrl}/v1/configs`, {
      "x-portkey-api-key": portkeyKey,
    });
    const configs = (data.data || [])
      .filter((cfg) => cfg.status === "active" && cfg.slug)
      .map((cfg) => ({
        id: cfg.slug || cfg.id,
        name: cfg.name || "",
        isDefault: cfg.is_default || false,
        updatedAt: cfg.last_updated_at || "",
      }));
    return { data: configs, error: null };
  } catch (e) {
    return { data: null, error: e.message };
  }
}

// ── Shell RC helpers ─────────────────────────────────────────────────────────

export function writeShellRc(filePath, block) {
  let content = "";
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    // new file
  }
  // Remove existing Portkey block
  content = content.replace(
    /\n?# ── Portkey \+ Claude Code[\s\S]*?# ── End Portkey \+ Claude Code ──\n?/g,
    ""
  );
  content += "\n" + block + "\n";
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

/**
 * Read existing Portkey config from settings files.
 * Returns the highest-precedence values found, plus which file they came from.
 */
export function readExistingConfig() {
  const projectRoot = findProjectRoot();
  const checkOrder = [
    { layer: "project-local", path: getConfigPath("project-local", projectRoot) },
    { layer: "project-shared", path: getConfigPath("project-shared", projectRoot) },
    { layer: "global", path: getConfigPath("global", projectRoot) },
  ].filter((c) => c.path && fs.existsSync(c.path));

  for (const { layer, path: filePath } of checkOrder) {
    const baseUrl = jsonRead(filePath, "env.ANTHROPIC_BASE_URL");
    if (!baseUrl) continue; // no Portkey config here

    const authToken = jsonRead(filePath, "env.ANTHROPIC_AUTH_TOKEN") || "";
    const headers = jsonRead(filePath, "env.ANTHROPIC_CUSTOM_HEADERS") || "";
    const model = jsonRead(filePath, "model") || "";

    // Parse routing from headers
    let mode = "";
    let provider = "";
    let configId = "";
    if (headers.includes("x-portkey-provider:")) {
      mode = "provider";
      provider = (headers.match(/x-portkey-provider:(\S+)/)?.[1] || "").replace(/^@+/, "");
    } else if (headers.includes("x-portkey-config:")) {
      const cfgVal = headers.match(/x-portkey-config:(\S+)/)?.[1] || "";
      // Check if it's a base64-encoded OAuth config or a config ID
      if (cfgVal.startsWith("pc-") || cfgVal.length < 30) {
        mode = "config";
        configId = cfgVal;
      } else {
        mode = "oauth";
      }
    }

    // Determine location from layer
    let location = layer;

    return {
      found: true,
      filePath,
      location,
      portkeyKey: authToken,
      gateway: baseUrl,
      mode,
      provider,
      configId,
      model,
      headers,
    };
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
