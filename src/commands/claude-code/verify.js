import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as p from "@clack/prompts";
import {
  VERSION,
  PORTKEY_GATEWAY,
  PORTKEY_DASHBOARD,
  c,
  ok,
  err,
  warn,
  info,
  dim,
  jsonRead,
  mask,
  findProjectRoot,
  getConfigPath,
  readExistingConfig,
  settingsReadMcp,
} from "../../utils.js";

/** Minimal JSON-RPC initialize (streamable HTTP) — same shape clients use to open a session. */
const MCP_INIT_BODY = JSON.stringify({
  jsonrpc: "2.0",
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "portkey-cli-verify", version: VERSION },
  },
  id: 1,
});

function collectRemoteMcpEntries(projectRoot) {
  const out = [];
  const claudeJson = path.join(os.homedir(), ".claude.json");

  const consider = (label, name, cfg) => {
    if (!cfg || typeof cfg.url !== "string" || !cfg.url.trim()) return;
    const t = String(cfg.type || "http").toLowerCase();
    if (t === "stdio") return;
    out.push({ label, name, url: cfg.url.trim(), headers: cfg.headers && typeof cfg.headers === "object" ? cfg.headers : {} });
  };

  if (projectRoot) {
    const mcpJson = path.join(projectRoot, ".mcp.json");
    if (fs.existsSync(mcpJson)) {
      for (const [name, cfg] of Object.entries(settingsReadMcp(mcpJson)))
        consider(`repo .mcp.json`, name, cfg);
    }
  }
  if (fs.existsSync(claudeJson)) {
    if (projectRoot) {
      for (const [name, cfg] of Object.entries(
        settingsReadMcp(claudeJson, { scope: "local", projectPath: projectRoot })
      ))
        consider(`~/.claude.json (this project)`, name, cfg);
    }
    for (const [name, cfg] of Object.entries(settingsReadMcp(claudeJson, { scope: "user" })))
      consider(`~/.claude.json (all projects)`, name, cfg);
  }
  return out;
}

async function probeOneMcp({ label, name, url, headers }) {
  const h = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...headers,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: h,
      body: MCP_INIT_BODY,
      signal: controller.signal,
    });
    const text = await res.text();
    const lower = text.toLowerCase();
    const oauthHint =
      lower.includes("authorization_url") ||
      lower.includes("authorize") ||
      lower.includes("oauth");
    let rpcOk = false;
    if (res.ok) {
      try {
        const j = JSON.parse(text);
        rpcOk = j && (j.result !== undefined || (j.error === undefined && j.jsonrpc === "2.0"));
      } catch {
        rpcOk = text.includes('"result"') || text.includes("event:");
      }
    }
    return { status: res.status, ok: res.ok && rpcOk, text: text.slice(0, 400), oauthHint };
  } catch (e) {
    return {
      status: 0,
      ok: false,
      text: e.name === "AbortError" ? "timeout after 15s" : e.message,
      oauthHint: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST MCP `initialize` to every remote entry in .mcp.json / ~/.claude.json using saved headers.
 * Distinguishes gateway reachability from Claude Code UI state (`/mcp` can still differ).
 */
export async function doVerifyMcp() {
  p.intro(`${c.bold}Verifying MCP endpoints${c.reset}`);

  const projectRoot = findProjectRoot();
  const entries = collectRemoteMcpEntries(projectRoot);

  if (entries.length === 0) {
    err("No remote MCP servers found. Add some with: portkey mcp add");
    p.outro(`${c.dim}Create one at https://app.portkey.ai/mcp-servers${c.reset}`);
    return;
  }

  info(`Checking ${entries.length} remote MCP entr${entries.length === 1 ? "y" : "ies"} (initialize handshake)`);
  console.log();

  for (const e of entries) {
    const where = `${c.dim}[${e.label}]${c.reset}`;
    const r = await probeOneMcp(e);
    if (r.ok) {
      ok(`${e.name} ${where} HTTP ${r.status}`);
    } else if (r.status === 401 || r.status === 403) {
      err(`${e.name} ${where} HTTP ${r.status} — check x-portkey-api-key and workspace MCP access`);
    } else if (r.oauthHint) {
      warn(`${e.name} ${where} may need upstream OAuth (Linear/Slack): complete flow in Claude /mcp or Portkey dashboard`);
      dim(r.text.slice(0, 200));
    } else if (r.status === 0) {
      err(`${e.name} ${where} ${r.text}`);
    } else {
      err(`${e.name} ${where} HTTP ${r.status}`);
      dim(r.text.slice(0, 200));
    }
  }

  console.log();
  dim("If this passes but Claude shows \"failed\", run: claude --debug  (see MCP connection logs)");
  p.outro(`${c.dim}Docs: ${PORTKEY_DASHBOARD}/docs/product/mcp-gateway/mcp-clients${c.reset}`);
}

export async function doVerify(args = {}) {
  if (args.verifyMcp) return doVerifyMcp();
  p.intro(`${c.bold}Verifying Portkey Gateway${c.reset}`);

  // ── Resolve API key ───────────────────────────────────────────────────────
  let pk = process.env.PORTKEY_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || "";

  if (!pk) {
    const projectRoot = findProjectRoot();
    const checkOrder = [
      getConfigPath("project-local",  projectRoot),
      getConfigPath("project-shared", projectRoot),
      getConfigPath("global",         projectRoot),
    ].filter(Boolean);
    for (const f of checkOrder) {
      if (!fs.existsSync(f)) continue;
      const val = jsonRead(f, "env.ANTHROPIC_AUTH_TOKEN");
      if (val) { pk = val; break; }
    }
  }

  if (!pk) {
    err("No Portkey API key found — set ANTHROPIC_AUTH_TOKEN in config or run: portkey setup");
    return;
  }

  info(`API key: ${mask(pk)}`);

  // ── Resolve routing headers ───────────────────────────────────────────────
  let customHeaders = process.env.ANTHROPIC_CUSTOM_HEADERS || "";
  if (!customHeaders) {
    const projectRoot = findProjectRoot();
    const checkOrder = [
      getConfigPath("project-local",  projectRoot),
      getConfigPath("project-shared", projectRoot),
      getConfigPath("global",         projectRoot),
    ].filter(Boolean);
    for (const f of checkOrder) {
      if (!fs.existsSync(f)) continue;
      const val = jsonRead(f, "env.ANTHROPIC_CUSTOM_HEADERS");
      if (val) { customHeaders = val; break; }
    }
  }

  const routingHeaders = {};
  if (customHeaders.includes("x-portkey-config:")) {
    const configVal = customHeaders.match(/x-portkey-config:(\S+)/)?.[1] || "";
    routingHeaders["x-portkey-config"] = configVal;
    info(`Routing via config: ${configVal}`);
  } else if (customHeaders.includes("x-portkey-provider:")) {
    const provVal = customHeaders.match(/x-portkey-provider:(\S+)/)?.[1] || "";
    if (!provVal || provVal === "@") {
      err("Provider slug is empty — run: portkey setup");
      return;
    }
    routingHeaders["x-portkey-provider"] = provVal;
    info(`Routing via provider: ${provVal}`);
  } else {
    err("No routing header found (x-portkey-provider or x-portkey-config) — run: portkey setup");
    return;
  }

  // ── Resolve gateway + test model ─────────────────────────────────────────
  const existing   = readExistingConfig();
  const gateway    = process.env.ANTHROPIC_BASE_URL || existing.gateway || PORTKEY_GATEWAY;
  const testModel  = existing.model || "claude-haiku-4-20250514";

  info(`Gateway: ${gateway}`);
  console.log();

  // ── Fire test request ─────────────────────────────────────────────────────
  const s = p.spinner();
  s.start("Sending test request...");

  try {
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 15000);
    const start      = Date.now();

    const res = await fetch(`${gateway}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-portkey-api-key": pk,
        Authorization: `Bearer ${pk}`,
        ...routingHeaders,
      },
      body: JSON.stringify({
        model: testModel,
        max_tokens: 5,
        messages: [{ role: "user", content: "Say ok" }],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    const latencyMs = Date.now() - start;
    const status    = res.status;

    switch (status) {
      case 200:
        s.stop(`Gateway responded in ${latencyMs}ms`);
        ok("Routing works! Claude Code is ready to use through Portkey.");
        break;
      case 401:
        s.stop(`401 — authentication failed (${latencyMs}ms)`);
        try { dim((await res.text()).slice(0, 200)); } catch {}
        err("Check your Portkey API key or run: portkey setup");
        break;
      case 422:
        s.stop(`422 — Portkey reachable, provider rejected request (${latencyMs}ms)`);
        try { dim((await res.text()).slice(0, 200)); } catch {}
        ok("Gateway is reachable. The provider may not support this test model.");
        break;
      case 429:
        s.stop(`429 — rate limited (${latencyMs}ms)`);
        ok("Gateway is reachable — rate limit hit, but routing works.");
        break;
      default:
        s.stop(`HTTP ${status} (${latencyMs}ms)`);
        try { dim((await res.text()).slice(0, 200)); } catch {}
    }
  } catch (e) {
    s.stop("Connection failed");
    if (e.name === "AbortError") {
      err(`Request timed out after 15s — check gateway: ${gateway}`);
    } else {
      err(`Could not reach ${gateway}`);
      dim(e.message);
    }
  }

  p.outro(`${c.dim}Dashboard: ${PORTKEY_DASHBOARD}/logs${c.reset}`);
}
