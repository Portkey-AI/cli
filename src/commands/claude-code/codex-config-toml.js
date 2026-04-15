import fs from "node:fs";
import path from "node:path";
import { PORTKEY_GATEWAY } from "../../utils.js";

/** Codex ↔ gateway protocol: Chat Completions vs OpenAI Responses API */
export function normalizeCodexWireApi(v) {
  const t = String(v || "").toLowerCase();
  return t === "responses" ? "responses" : "chat";
}

/** Suffix for `[model_providers.portkey-<suffix>]` from catalog slug */
export function codexProviderTableSuffix(slug) {
  const s = String(slug || "")
    .replace(/^@+/, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return s || "extra";
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Write the primary Portkey block for Codex (model_provider portkey + [model_providers.portkey]).
 * Preserves other `model_providers.*` tables (e.g. added via appendCodexPortkeyProviderBlock).
 *
 * @param {object} opts
 * @param {string|null} [opts.portkeyConfigId] — if set, uses plain `model = "<modelId>"` (config routing); attach config to the API key in Portkey.
 */
export function writeCodexPortkeyBundle(filePath, { gateway, providerSlug, modelId, wireApi, portkeyConfigId = null }) {
  const base = (gateway || PORTKEY_GATEWAY).replace(/\/+$/, "");
  const baseUrl = base.endsWith("/v1") ? base : `${base}/v1`;
  const w = normalizeCodexWireApi(wireApi);

  let existing = "";
  try {
    existing = fs.readFileSync(filePath, "utf8");
  } catch {
    existing = "";
  }

  existing = existing
    .replace(/\n?# ── Portkey \+ Codex(?: \(config routing\))? ──[\s\S]*?# ── End Portkey ──\n?/g, "")
    .replace(/^model_provider\s*=.*\n?/gm, "")
    .replace(/^model\s*=.*\n?/gm, "")
    .replace(/\[model_providers\.portkey\][\s\S]*?(?=\n\[|\n# ── Portkey provider:|$)/g, "");

  const modelLine = portkeyConfigId
    ? `model = "${String(modelId).replace(/"/g, '\\"')}"`
    : `model = "@${providerSlug}/${modelId}"`;

  const header = portkeyConfigId
    ? "# ── Portkey + Codex (config routing) ──"
    : "# ── Portkey + Codex ──";

  const configComment = portkeyConfigId
    ? `# Portkey Config: ${portkeyConfigId} — ensure this config is applied to your API key or virtual key in the dashboard.`
    : null;

  const block = [
    header,
    `model_provider = "portkey"`,
    modelLine,
    ...(configComment ? [configComment] : []),
    "",
    "[model_providers.portkey]",
    `name = "Portkey"`,
    `base_url = "${baseUrl}"`,
    `env_key = "PORTKEY_API_KEY"`,
    `wire_api = "${w}"`,
    "# wire_api: \"chat\" = Chat Completions; \"responses\" = OpenAI Responses API",
    "# ── End Portkey ──",
  ].join("\n");

  const trimmed = existing.trim();
  const content = trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

/**
 * Append another Portkey-backed provider (same gateway + PORTKEY_API_KEY, different catalog slug).
 * Switch active routing by editing top-level model_provider + model in config.toml.
 */
export function appendCodexPortkeyProviderBlock(filePath, {
  gateway,
  providerSlug,
  modelId,
  wireApi,
  tableKey,
  displayName,
}) {
  const base = (gateway || PORTKEY_GATEWAY).replace(/\/+$/, "");
  const baseUrl = base.endsWith("/v1") ? base : `${base}/v1`;
  const w = normalizeCodexWireApi(wireApi);
  const slug = String(providerSlug || "").replace(/^@+/, "");
  const key = tableKey || `portkey-${codexProviderTableSuffix(slug)}`;
  const safeName = (displayName || `Portkey @${slug}`).replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  let existing = "";
  try {
    existing = fs.readFileSync(filePath, "utf8");
  } catch {
    throw new Error(`Cannot append provider: missing file ${filePath}`);
  }

  const endTag = `# ── End provider @${slug} ──`;
  existing = existing.replace(
    new RegExp(
      `\\n# ── Portkey provider: @${escapeRegExp(slug)} ──[\\s\\S]*?${escapeRegExp(endTag)}\\n?`,
      "g"
    ),
    ""
  );

  const block = [
    "",
    `# ── Portkey provider: @${slug} ──`,
    `# Active routing: set model_provider = "${key}" and model = "@${slug}/${modelId}"`,
    `[model_providers.${key}]`,
    `name = "${safeName}"`,
    `base_url = "${baseUrl}"`,
    `env_key = "PORTKEY_API_KEY"`,
    `wire_api = "${w}"`,
    endTag,
    "",
  ].join("\n");

  fs.writeFileSync(filePath, existing.trimEnd() + block, "utf8");
}
