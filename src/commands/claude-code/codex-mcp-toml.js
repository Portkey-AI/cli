import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/** `.codex/config.toml` path: `scope` is `project` (repo) or `global` (home). */
export function getCodexConfigTomlPath(projectRoot, scope) {
  const useGlobal = scope === "global" || !projectRoot;
  if (useGlobal) return path.join(os.homedir(), ".codex", "config.toml");
  return path.join(projectRoot, ".codex", "config.toml");
}

/** Safe `[mcp_servers.<id>]` table name fragment for TOML */
export function codexMcpTableId(slug) {
  const tail = String(slug || "server")
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "server";
  return `portkey-${tail}`;
}

function tomlDoubleQuoted(s) {
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Append or replace Portkey MCP entries in Codex `config.toml` (streamable HTTP).
 * @see https://developers.openai.com/codex/mcp
 */
export function writeCodexMcpServersToml(codexConfigPath, selectedServers) {
  let existing = "";
  try {
    existing = fs.readFileSync(codexConfigPath, "utf8");
  } catch {
    existing = "";
  }
  existing = existing.replace(
    /\n?# ── Portkey MCP servers \(auto\)[\s\S]*?# ── End Portkey MCP servers\n?/g,
    ""
  );

  const lines = [
    "",
    "# ── Portkey MCP servers (auto) — https://developers.openai.com/codex/mcp",
    "",
  ];
  for (const srv of selectedServers) {
    const id = codexMcpTableId(srv.slug);
    lines.push(`[mcp_servers.${id}]`);
    lines.push(`url = ${tomlDoubleQuoted(srv.url)}`);
    lines.push(
      `env_http_headers = { "x-portkey-api-key" = "PORTKEY_API_KEY" }`
    );
    lines.push(
      `# Same key idea as Claude: PORTKEY_API_KEY is sent as x-portkey-api-key on each request.`
    );
    lines.push(
      `# If /mcp shows "Auth: OAuth" and no tools, Codex is following OAuth metadata from the MCP handshake, not this file — try: codex mcp login ${id}`
    );
    lines.push(
      `# or set this integration to header/API-key auth in Portkey so the gateway does not advertise OAuth.`
    );
    lines.push("");
  }
  lines.push("# ── End Portkey MCP servers", "");

  const out = (existing.trimEnd() ? `${existing.trimEnd()}\n` : "") + lines.join("\n");
  fs.mkdirSync(path.dirname(codexConfigPath), { recursive: true });
  fs.writeFileSync(codexConfigPath, out, "utf8");
}

/** Count `[mcp_servers.*]` tables (Codex / OpenAI MCP TOML). */
export function countCodexMcpServerTables(tomlText) {
  if (!tomlText) return 0;
  const m = tomlText.match(/^\[mcp_servers\.[^\]]+\]\s*$/gm);
  return m ? m.length : 0;
}

export function codexTomlMentionsPortkey(tomlText) {
  if (!tomlText) return false;
  return (
    /# ── Portkey/.test(tomlText) ||
    /\[model_providers\.portkey\]/.test(tomlText) ||
    /model_provider\s*=\s*["']portkey["']/.test(tomlText)
  );
}

/** Table names after `mcp_servers.` (e.g. `portkey-my-slug`). */
export function listCodexMcpServerTableNames(tomlText) {
  if (!tomlText) return [];
  const re = /^\[mcp_servers\.([^\]]+)\]\s*$/gm;
  const out = [];
  let m;
  while ((m = re.exec(tomlText)) !== null) out.push(m[1]);
  return out;
}
