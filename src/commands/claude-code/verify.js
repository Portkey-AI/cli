import fs from "node:fs";
import * as p from "@clack/prompts";
import {
  PORTKEY_GATEWAY,
  PORTKEY_DASHBOARD,
  c,
  ok,
  err,
  warn,
  info,
  dim,
  jsonRead,
  findProjectRoot,
  getConfigPath,
  readExistingConfig,
} from "../../utils.js";

export async function doVerify() {
  p.intro(`${c.bold}Verifying Portkey Gateway${c.reset}`);

  // ── Resolve API key ─────────────────────────────────────────────────────
  let pk =
    process.env.PORTKEY_API_KEY ||
    process.env.ANTHROPIC_AUTH_TOKEN ||
    "";

  if (!pk) {
    const projectRoot = findProjectRoot();
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

  if (!pk) {
    err(
      "No Portkey API key found — set ANTHROPIC_AUTH_TOKEN in config or PORTKEY_API_KEY."
    );
    return;
  }

  // ── Get routing headers from config ─────────────────────────────────────
  let customHeaders = process.env.ANTHROPIC_CUSTOM_HEADERS || "";
  if (!customHeaders) {
    const projectRoot = findProjectRoot();
    const checkOrder = [
      getConfigPath("project-local", projectRoot),
      getConfigPath("project-shared", projectRoot),
      getConfigPath("global", projectRoot),
    ].filter(Boolean);
    for (const f of checkOrder) {
      if (!fs.existsSync(f)) continue;
      const val = jsonRead(f, "env.ANTHROPIC_CUSTOM_HEADERS");
      if (val) {
        customHeaders = val;
        break;
      }
    }
  }

  // Determine routing type
  const routingHeaders = {};
  if (customHeaders.includes("x-portkey-config:")) {
    const configVal = customHeaders.match(/x-portkey-config:(\S+)/)?.[1] || "";
    routingHeaders["x-portkey-config"] = configVal;
    info(`Using config: ${configVal}`);
  } else if (customHeaders.includes("x-portkey-provider:")) {
    let provVal = customHeaders.match(/x-portkey-provider:(\S+)/)?.[1] || "";
    if (!provVal || provVal === "@") {
      err("Provider slug is empty in ANTHROPIC_CUSTOM_HEADERS. Run setup first.");
      return;
    }
    routingHeaders["x-portkey-provider"] = provVal;
    info(`Using provider: ${provVal}`);
  } else {
    err("No routing header found (x-portkey-provider or x-portkey-config). Run setup first.");
    return;
  }

  // ── Resolve model for test request ──────────────────────────────────────
  const existing = readExistingConfig();
  const testModel = existing.model || "claude-opus-4-6";

  // ── Resolve gateway URL ───────────────────────────────────────────────
  const gateway =
    process.env.ANTHROPIC_BASE_URL || existing.gateway || PORTKEY_GATEWAY;

  // ── Test connectivity ───────────────────────────────────────────────────
  const s = p.spinner();
  s.start("Testing connectivity...");

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

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
    const status = res.status;

    switch (status) {
      case 200:
        s.stop("Gateway returned 200");
        ok("Routing works!");
        break;
      case 401:
        s.stop("401 — invalid API key");
        try {
          const body = await res.text();
          dim(body.slice(0, 200));
        } catch {}
        break;
      case 422:
        s.stop("422 — Portkey reachable but provider rejected request");
        try {
          const body = await res.text();
          dim(body.slice(0, 200));
        } catch {}
        break;
      case 429:
        s.stop("429 — rate limited, but gateway is reachable");
        ok("Connection works.");
        break;
      default:
        s.stop(`HTTP ${status}`);
        try {
          const body = await res.text();
          dim(body.slice(0, 200));
        } catch {}
    }
  } catch (e) {
    s.stop("Connection failed");
    if (e.name === "AbortError") {
      err(`Request timed out connecting to ${gateway}`);
    } else {
      err(`Could not reach ${gateway}`);
      dim(e.message);
    }
  }

  p.outro(`${c.dim}Dashboard: ${PORTKEY_DASHBOARD}/logs${c.reset}`);
}
