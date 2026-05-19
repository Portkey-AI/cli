import { PORTKEY_GATEWAY, sortModels } from "./utils.js";

// ── Base fetch ────────────────────────────────────────────────────────────────

export async function fetchJSON(url, headers = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) {
      let detail = "";
      try {
        const raw = await res.text();
        try {
          const body = JSON.parse(raw);
          // Try common Portkey/OpenAI error shapes
          detail =
            body.message ||
            body.error?.message ||
            body.error?.type ||
            (typeof body.error === "string" ? body.error : "") ||
            raw.slice(0, 200);
        } catch {
          detail = raw.slice(0, 200);
        }
      } catch {}
      throw new Error(`HTTP ${res.status}${detail ? ": " + detail : ""}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

function base(gateway) {
  return (gateway || PORTKEY_GATEWAY).replace(/\/+$/, "");
}

// ── Providers (Model Catalog) ─────────────────────────────────────────────────

/**
 * Fetch AI providers from the workspace Model Catalog.
 * Returns { data: [...], error: null } or { data: null, error: "reason" }.
 */
export async function fetchProviders(portkeyKey, gateway) {
  try {
    const data = await fetchJSON(`${base(gateway)}/v1/providers`, {
      "x-portkey-api-key": portkeyKey,
    });
    const providers = (data.data || [])
      .filter((p) => p.status === "active" && p.slug)
      .map((p) => ({
        slug:      p.slug,
        name:      p.name || "",
        provider:  p.provider || "",
        workspace: p.workspace_name || "",
        note: (p.note || "").replace(/\|/g, "-") ===
          "Created automatically on integration access grant"
          ? ""
          : (p.note || "").replace(/\|/g, "-"),
      }));
    return { data: providers, error: null };
  } catch (e) {
    return { data: null, error: e.message };
  }
}

// ── Configs ───────────────────────────────────────────────────────────────────

/**
 * Fetch gateway configs from the workspace.
 * Returns { data: [...], error: null } or { data: null, error: "reason" }.
 */
export async function fetchConfigs(portkeyKey, gateway) {
  try {
    const data = await fetchJSON(`${base(gateway)}/v1/configs`, {
      "x-portkey-api-key": portkeyKey,
    });
    const configs = (data.data || [])
      .filter((cfg) => cfg.status === "active" && cfg.slug)
      .map((cfg) => ({
        id:        cfg.slug || cfg.id,
        name:      cfg.name || "",
        isDefault: cfg.is_default || false,
        updatedAt: cfg.last_updated_at || "",
      }));
    return { data: configs, error: null };
  } catch (e) {
    return { data: null, error: e.message };
  }
}

// ── Models ────────────────────────────────────────────────────────────────────

/**
 * Fetch models for a Model Catalog virtual key from Portkey `GET /v1/models`.
 * The provider slug is passed as the `provider` query parameter so the gateway
 * returns only models for that virtual key (same as:
 * curl '…/v1/models?provider=my-slug' -H x-portkey-api-key …).
 * Each item is `{ id }` — short model name for config (no `@virtual-key/` prefix).
 * Returns { data: [...], error: null } or { data: null, error: "reason" }.
 */
export async function fetchModels(portkeyKey, providerSlug, gateway) {
  const slug   = providerSlug.replace(/^@+/, "");
  const prefix = `@${slug}/`;

  try {
    const url = `${base(gateway)}/v1/models?provider=${encodeURIComponent(slug)}`;
    const data = await fetchJSON(url, {
      "x-portkey-api-key": portkeyKey,
    });

    const rows = (data.data || []).filter(
      (m) => m && (m.id != null || m.slug != null)
    );

    const toShortId = (m) => {
      const id = m.id != null ? String(m.id) : "";
      if (id.startsWith(prefix)) {
        return (m.slug || id.slice(prefix.length)).replace(/^@+/, "").trim();
      }
      if (m.slug != null && String(m.slug).trim() !== "") {
        return String(m.slug).replace(/^@+/, "").trim();
      }
      if (!id) return "";
      const nested = id.match(/^@[^/]+\/(.+)$/);
      if (nested) return nested[1].trim();
      return id.replace(/^@+/, "").trim();
    };

    const prefixed = rows.filter(
      (m) => typeof m.id === "string" && m.id.startsWith(prefix)
    );
    const source = prefixed.length > 0 ? prefixed : rows;

    const seen = new Set();
    const models = source
      .map((m) => ({ id: toShortId(m) }))
      .filter((m) => {
        if (!m.id || seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      })
      .sort(sortModels);

    return { data: models, error: null };
  } catch (e) {
    return { data: null, error: e.message };
  }
}

// ── MCP Servers ───────────────────────────────────────────────────────────────

/**
 * Build Claude Code HTTP MCP config from a Portkey integration row + API key.
 *
 * The Portkey **MCP gateway** always needs workspace identity: **`x-portkey-api-key`** on every
 * integration we add (same as the REST API). Without it, the gateway cannot route the session.
 *
 * `auth_type` describes **upstream** needs:
 * - **`headers` / `none`** — Often only the workspace key is required.
 * - **`oauth_auto`** — Upstream apps (e.g. Linear, Slack) also need OAuth. We still write the
 *   workspace key; users **also** run **`/mcp`** in Claude so Portkey can complete OAuth to those
 *   services.
 *
 * Never put the key in `Authorization` or use `Authorization: x-portkey-api-key: …`.
 */
export function buildClaudeMcpHttpConfig(server, portkeyKey) {
  const cfg = {
    type: "http",
    url:  server.url,
  };
  if (!portkeyKey) return cfg;
  return {
    ...cfg,
    headers: {
      "x-portkey-api-key": portkeyKey,
    },
  };
}

/** Upstream may still need OAuth in Claude (`/mcp`) in addition to the workspace API key. */
export function portkeyMcpRequiresOAuth(server) {
  const t = (server.authType || "").toLowerCase();
  return t === "oauth_auto" || t === "oauth";
}

/**
 * Fetch MCP integrations registered in the Portkey workspace.
 * Returns { data: [...], error: null } or { data: null, error: "reason" }.
 *
 * Each item: { id, name, slug, url, description, tools, authType }
 */
export async function fetchMcpServers(portkeyKey, gateway) {
  try {
    const data = await fetchJSON(`${base(gateway)}/v2/mcp-integrations`, {
      "x-portkey-api-key": portkeyKey,
    });

    // Derive the MCP gateway hostname from the API gateway.
    // Hosted: https://api.portkey.ai  →  https://mcp.portkey.ai
    // Self-hosted: same host is used for MCP too.
    const gwBase = base(gateway);
    const mcpBase = gwBase.replace("//api.", "//mcp.");

    const servers = (data.data || []).map((s) => {
      const slug = s.slug || s.id || "";
      return {
        id:          s.id || "",
        name:        s.name || slug,
        slug,
        // Always use the Portkey MCP gateway URL — s.url is the upstream server's
        // original endpoint, not the URL clients should connect to.
        url:         `${mcpBase}/${slug}/mcp`,
        description: s.description || "",
        tools:       Array.isArray(s.tools) ? s.tools : [],
        authType:    s.auth_type || "headers",
      };
    });
    return { data: servers, error: null };
  } catch (e) {
    return { data: null, error: e.message };
  }
}

// ── Skills (Prompt Partials) ──────────────────────────────────────────────────

/**
 * Fetch the list of Prompt Partials (metadata only — no content).
 * The list endpoint does not return full content; use fetchSkillContent() for that.
 *
 * Returns { data: [...], error: null } or { data: null, error: "reason" }.
 * Each item: { id, name, version }
 */
export async function fetchSkills(portkeyKey, gateway) {
  try {
    const data = await fetchJSON(`${base(gateway)}/v1/prompts/partials`, {
      "x-portkey-api-key": portkeyKey,
    });
    const all = data.data || [];

    const skills = all.map((partial) => ({
      id:      partial.slug || partial.id || "",
      name:    partial.name || partial.slug || partial.id || "untitled",
      version: partial.version ?? partial.current_version ?? partial.latest_version ?? 1,
    }));

    return { data: skills, error: null };
  } catch (e) {
    return { data: null, error: e.message };
  }
}

/**
 * Fetch the full content of a single Prompt Partial by id/slug.
 * The list endpoint omits content — a separate per-partial call is required.
 *
 * Returns { content: "...", error: null } or { content: null, error: "reason" }.
 */
export async function fetchSkillContent(portkeyKey, gateway, identifier) {
  try {
    const encoded = encodeURIComponent(identifier);
    const data = await fetchJSON(`${base(gateway)}/v1/prompts/partials/${encoded}`, {
      "x-portkey-api-key": portkeyKey,
    });
    // API may nest content under data: {} or return it at the top level
    const content =
      data.data?.string   ??
      data.string         ??
      data.data?.content  ??
      data.content        ??
      data.data?.template ??
      data.template       ??
      null;
    return { content, error: null };
  } catch (e) {
    return { content: null, error: e.message };
  }
}

// ── Connectivity test ─────────────────────────────────────────────────────────

/**
 * Send a minimal chat completion to verify the gateway is reachable.
 * Caller must supply `model` — we no longer assume a hardcoded default.
 * Returns { ok: true, model, latencyMs } or { ok: false, error }.
 */
export async function testGatewayConnection(portkeyKey, extraHeaders, gateway, model) {
  if (!model || !String(model).trim()) {
    return { ok: false, error: "Model is required for connection test", latencyMs: 0 };
  }
  const url = `${base(gateway)}/v1/chat/completions`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  const start = Date.now();

  // Parse extra headers string (e.g. "x-portkey-provider:@ant,x-portkey-config:pc-xxx")
  const parsedHeaders = { "x-portkey-api-key": portkeyKey, "Content-Type": "application/json" };
  if (extraHeaders) {
    for (const part of extraHeaders.split(",")) {
      const colonIdx = part.indexOf(":");
      if (colonIdx === -1) continue;
      const key = part.slice(0, colonIdx).trim();
      const val = part.slice(colonIdx + 1).trim();
      if (key) parsedHeaders[key] = val;
    }
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: parsedHeaders,
      body: JSON.stringify({
        model,
        max_tokens: 8,
        messages: [{ role: "user", content: "Say: ok" }],
      }),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - start;
    if (!res.ok) {
      let detail = "";
      try { const b = await res.json(); detail = b.message || b.error?.message || ""; } catch {}
      return { ok: false, error: `HTTP ${res.status}${detail ? ": " + detail : ""}`, latencyMs };
    }
    const body = await res.json();
    const model = body.model || "unknown";
    return { ok: true, model, latencyMs };
  } catch (e) {
    return { ok: false, error: e.name === "AbortError" ? "Request timed out" : e.message, latencyMs: Date.now() - start };
  } finally {
    clearTimeout(timeout);
  }
}
