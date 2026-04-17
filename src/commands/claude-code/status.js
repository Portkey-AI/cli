import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  VERSION,
  c,
  mask,
  jsonRead,
  findProjectRoot,
  getConfigPath,
  readExistingConfig,
  settingsReadMcp,
} from "../../utils.js";
import {
  countCodexMcpServerTables,
  codexTomlMentionsPortkey,
} from "./codex-mcp-toml.js";

function readTomlSafe(pth) {
  try {
    return fs.readFileSync(pth, "utf8");
  } catch {
    return null;
  }
}

function codexModelLine(toml) {
  if (!toml) return "";
  const m = toml.match(/^model\s*=\s*"([^"]+)"/m);
  return m ? m[1] : "";
}

/**
 * One-screen summary: Portkey key, Claude + Codex routing hints, MCP counts per agent.
 * Use `portkey discover` for a full layered audit.
 */
export async function doStatus() {
  const projectRoot = findProjectRoot();
  const existing = readExistingConfig();

  let pk =
    process.env.PORTKEY_API_KEY ||
    process.env.ANTHROPIC_AUTH_TOKEN ||
    (existing.found ? existing.portkeyKey : "") ||
    "";

  if (!pk) {
    const checkOrder = [
      getConfigPath("project-local", projectRoot),
      getConfigPath("project-shared", projectRoot),
      getConfigPath("global", projectRoot),
    ].filter(Boolean);
    for (const f of checkOrder) {
      if (!fs.existsSync(f)) continue;
      const val = jsonRead(f, "env.ANTHROPIC_AUTH_TOKEN");
      if (val) {
        pk = val;
        break;
      }
    }
  }

  let baseUrl =
    process.env.ANTHROPIC_BASE_URL ||
    (existing.found ? existing.gateway : "") ||
    "";
  if (!baseUrl && existing.found && existing.filePath) {
    baseUrl = jsonRead(existing.filePath, "env.ANTHROPIC_BASE_URL") || "";
  }

  let headers =
    process.env.ANTHROPIC_CUSTOM_HEADERS ||
    (existing.found ? existing.headers : "") ||
    "";
  if (!headers && existing.found && existing.filePath) {
    headers = jsonRead(existing.filePath, "env.ANTHROPIC_CUSTOM_HEADERS") || "";
  }

  const claudeJson = path.join(os.homedir(), ".claude.json");
  const cwd = projectRoot || process.cwd();
  let claudeMcp = 0;
  const mcpFiles = [
    projectRoot ? path.join(projectRoot, ".mcp.json") : null,
    claudeJson,
  ].filter(Boolean);
  for (const f of mcpFiles) {
    if (!fs.existsSync(f)) continue;
    if (f.endsWith(".mcp.json")) {
      claudeMcp += Object.keys(settingsReadMcp(f, { scope: "user" })).length;
    } else {
      claudeMcp += Object.keys(
        settingsReadMcp(f, { scope: "local", projectPath: cwd })
      ).length;
      claudeMcp += Object.keys(settingsReadMcp(f, { scope: "user" })).length;
    }
  }

  const codexProjectToml = projectRoot
    ? path.join(projectRoot, ".codex", "config.toml")
    : null;
  const codexGlobalToml = path.join(os.homedir(), ".codex", "config.toml");
  const codexProjText = codexProjectToml ? readTomlSafe(codexProjectToml) : null;
  const codexGlobText = readTomlSafe(codexGlobalToml);
  const codexProjMcp = countCodexMcpServerTables(codexProjText);
  const codexGlobMcp = countCodexMcpServerTables(codexGlobText);
  const codexProjPortkey = codexTomlMentionsPortkey(codexProjText);
  const codexGlobPortkey = codexTomlMentionsPortkey(codexGlobText);

  console.log(`${c.bold}portkey${c.reset} ${c.dim}v${VERSION}${c.reset}`);
  console.log(`${c.dim}Portkey API key${c.reset}  ${pk ? mask(pk) : `${c.yellow}not set${c.reset}`}`);
  console.log();

  console.log(`${c.bold}Claude Code${c.reset}`);
  console.log(
    `${c.dim}Gateway${c.reset}        ${baseUrl || `${c.yellow}not set${c.reset}`}`
  );
  if (headers.includes("x-portkey-provider:")) {
    const prov = headers.match(/x-portkey-provider:(\S+)/)?.[1] || "";
    console.log(`${c.dim}Routing${c.reset}        provider ${prov}`);
  } else if (headers.includes("x-portkey-config:")) {
    const cfg = headers.match(/x-portkey-config:(\S+)/)?.[1] || "";
    console.log(`${c.dim}Routing${c.reset}        config ${cfg}`);
  } else if (baseUrl) {
    console.log(`${c.dim}Routing${c.reset}        ${c.yellow}no x-portkey-* header in env/settings${c.reset}`);
  } else {
    console.log(`${c.dim}Routing${c.reset}        ${c.dim}(env / .claude/settings*)${c.reset}`);
  }
  console.log(
    `${c.dim}MCP (Claude)${c.reset}   ${claudeMcp} server${claudeMcp !== 1 ? "s" : ""}${c.dim}  (~/.claude.json + .mcp.json)${c.reset}`
  );
  console.log();

  console.log(`${c.bold}Codex${c.reset}`);
  if (codexProjectToml && fs.existsSync(codexProjectToml)) {
    const model = codexModelLine(codexProjText);
    console.log(
      `${c.dim}Project${c.reset}       ${c.dim}${codexProjectToml}${c.reset}`
    );
    console.log(
      `              ${codexProjPortkey ? `${c.green}Portkey block${c.reset}` : `${c.dim}no Portkey block${c.reset}`}` +
        (model ? `${c.dim}  model ${model}${c.reset}` : "")
    );
    console.log(
      `              ${c.dim}MCP tables${c.reset}  ${codexProjMcp}`
    );
  } else {
    console.log(`${c.dim}Project${c.reset}       ${c.dim}(no .codex/config.toml in repo)${c.reset}`);
  }
  if (fs.existsSync(codexGlobalToml)) {
    const model = codexModelLine(codexGlobText);
    console.log(
      `${c.dim}Global${c.reset}        ${c.dim}${codexGlobalToml}${c.reset}`
    );
    console.log(
      `              ${codexGlobPortkey ? `${c.green}Portkey block${c.reset}` : `${c.dim}no Portkey block${c.reset}`}` +
        (model ? `${c.dim}  model ${model}${c.reset}` : "")
    );
    console.log(
      `              ${c.dim}MCP tables${c.reset}  ${codexGlobMcp}`
    );
  } else {
    console.log(`${c.dim}Global${c.reset}        ${c.dim}(no ~/.codex/config.toml)${c.reset}`);
  }

  console.log();
  console.log(`${c.dim}Full audit: ${c.bold}portkey discover${c.reset}`);
}
