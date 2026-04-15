import * as p from "@clack/prompts";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
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
  mask,
  findProjectRoot,
  detectShellRc,
  getSettingsPath,
  getMcpFilePath,
  settingsSetEnv,
  settingsSetKey,
  settingsSetMcp,
  writeShellRc,
  normalizeProvider,
  isClaudeInstalled,
  readExistingConfig,
  AGENT_SKILLS_DIRS,
  detectInstalledAgents,
  MULTISELECT_HINT,
  isLikelyPortkeyApiKeyPermissionError,
  portkeyApiKeyPermissionNoteBody,
} from "../../utils.js";
import {
  fetchProviders,
  fetchConfigs,
  fetchModels,
  fetchMcpServers,
  fetchSkills,
  fetchSkillContent,
  buildClaudeMcpHttpConfig,
  portkeyMcpRequiresOAuth,
} from "../../api.js";
import { writeSingleSkill, skillStableKey, skillSkillDirName } from "./skills.js";
import {
  writeCodexMcpServersToml,
  codexMcpTableId,
  getCodexConfigTomlPath,
} from "./codex-mcp-toml.js";
import {
  writeCodexPortkeyBundle,
  appendCodexPortkeyProviderBlock,
  normalizeCodexWireApi,
} from "./codex-config-toml.js";

// Fallback suggestions when `/v1/models` returns nothing (some gateways don't list models).
const MODEL_DEFAULTS = {
  anthropic: ["claude-sonnet-4-20250514", "claude-opus-4-20250514", "claude-haiku-4-20250514", "claude-3-7-sonnet-20250219", "claude-3-5-sonnet-20241022"],
  openai:    ["gpt-4o", "gpt-4o-mini", "o3", "o4-mini", "gpt-4-turbo"],
  azure:     ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"],
  google:    ["gemini-2.5-pro", "gemini-2.0-flash", "gemini-1.5-pro"],
  mistral:   ["mistral-large-latest", "mistral-small-latest"],
  cohere:    ["command-r-plus", "command-r"],
  groq:      ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
  deepseek:  ["deepseek-chat", "deepseek-reasoner"],
};

function getModelOptions(providerType) {
  const key = Object.keys(MODEL_DEFAULTS).find((k) =>
    (providerType || "").toLowerCase().includes(k)
  );
  return MODEL_DEFAULTS[key] || [];
}

const PORTKEY_CUSTOM_MODEL = "__portkey_custom_model__";

/** Normalize pasted `@virtual-key/model` to the short id stored in config */
function shortModelIdForProvider(raw, providerSlug) {
  const t = String(raw || "").trim();
  if (!t) return t;
  const slug = providerSlug.replace(/^@+/, "");
  const prefix = `@${slug}/`;
  if (t.startsWith(prefix)) return t.slice(prefix.length);
  const m = t.match(/^@[^/]+\/(.+)$/);
  if (m) return m[1].trim();
  return t;
}

/** `/v1/models` missing or disabled (e.g. HTTP 404, UnknownOperationException) */
function isModelsCatalogApiUnavailable(errMsg) {
  if (!errMsg || typeof errMsg !== "string") return false;
  return (
    /\b404\b/i.test(errMsg) ||
    /UnknownOperation/i.test(errMsg) ||
    /not\s+valid\s+for\s+this\s+api/i.test(errMsg)
  );
}

// ── Main setup ────────────────────────────────────────────────────────────────

export async function doSetup(args) {
  if (process.stdout.isTTY) console.clear();
  p.intro(
    `${c.bold}Portkey CLI${c.reset} ${c.dim}v${VERSION}${c.reset}  ` +
    `${c.dim}One command. Your AI coding agent, fully configured.${c.reset}`
  );

  // ── Step 0: Which coding agent? ───────────────────────────────────────────
  let targetAgent = args.agent || "";
  if (!targetAgent && !args.yes) {
    const pick = await p.select({
      message: "Which coding agent are you setting up?",
      options: [
        { value: "claude", label: "Claude Code",  hint: "Anthropic — full setup" },
        { value: "cursor", label: "Cursor",        hint: "IDE — skills sync only" },
        { value: "codex",  label: "Codex",         hint: "OpenAI — config.toml setup" },
      ],
    });
    if (p.isCancel(pick)) return p.outro("Setup cancelled.");
    targetAgent = pick;
  }
  if (!targetAgent) targetAgent = "claude";

  // ── Step 0b: Where to save config? (right after agent, before anything else) ─
  // Claude Code supports: project-local, project-shared, global
  // Codex: always config.toml (project or home)
  // Cursor: N/A (handled separately below)
  const projectRoot = findProjectRoot();
  let location = args.location || "global";

  if (targetAgent === "claude" && !args.location && !args.yes) {
    const locationOptions = [
      { value: "global",         label: "Global settings",     hint: "~/.claude/settings.json  (recommended)" },
    ];
    if (projectRoot) {
      locationOptions.push(
        { value: "project-local",  label: "Project (private)",   hint: ".claude/settings.local.json  (gitignored)" },
        { value: "project-shared", label: "Project (shared)",    hint: ".claude/settings.json  (committed to git)" },
      );
    }
    const picked = await p.select({
      message: "Where should config be saved?",
      initialValue: "global",
      options: locationOptions,
    });
    if (p.isCancel(picked)) return p.outro("Setup cancelled.");
    location = picked;
  }

  if (targetAgent === "codex" && !args.location && !args.yes && projectRoot) {
    const picked = await p.select({
      message: "Where should config.toml be saved?",
      options: [
        { value: "project", label: "This project",  hint: `.codex/config.toml` },
        { value: "global",  label: "Global (home)", hint: `~/.codex/config.toml` },
      ],
      initialValue: "project",
    });
    if (p.isCancel(picked)) return p.outro("Setup cancelled.");
    location = picked;
  }

  // ── Cursor shortcut: gateway is configured via Cursor Settings UI ─────────
  if (targetAgent === "cursor") {
    p.note(
      `Cursor's AI provider is configured through ${c.bold}Cursor Settings → Models${c.reset}.\n` +
      `The Portkey CLI handles skills sync for Cursor.`,
      "Cursor"
    );

    let key = args.portkeyKey || process.env.PORTKEY_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || "";
    if (!key && !args.yes) {
      key = await p.text({
        message: "Portkey API key (for skills sync)",
        placeholder: `paste from ${PORTKEY_DASHBOARD}/api-keys`,
        validate: (v) => (!v ? "API key is required" : undefined),
      });
      if (p.isCancel(key)) return p.outro("Setup cancelled.");
    }

    if (key && !args.skipSkills) {
      const doSkills = args.yes
        ? true
        : await p.confirm({ message: "Sync team skills to Cursor?", initialValue: true });
      if (!p.isCancel(doSkills) && doSkills) {
        await runSkillsSelection(args, key, PORTKEY_GATEWAY, null, "cursor");
      }
    }

    return p.outro(`Done!  Configure Cursor gateway: ${c.bold}Cursor Settings → Models${c.reset}`);
  }

  // ── Detect existing config (claude / codex) ───────────────────────────────
  const existing = targetAgent === "claude" ? readExistingConfig() : { found: false };

  if (existing.found && !args.yes && !args.advanced) {
    const summary = [
      existing.provider ? `@${existing.provider}` : null,
      existing.configId ? `config:${existing.configId}` : null,
      existing.model    ? `model:${existing.model}`    : null,
    ].filter(Boolean).join(", ");

    const action = await p.select({
      message: `Existing config found: ${summary}`,
      options: [
        { value: "keep",   label: "Keep current config", hint: "no changes" },
        { value: "update", label: "Update config",        hint: "guided setup" },
        { value: "cancel", label: "Cancel" },
      ],
    });
    if (p.isCancel(action) || action === "cancel") return p.outro("Setup cancelled.");
    if (action === "keep") {
      const resolvedKey =
        args.portkeyKey ||
        process.env.PORTKEY_API_KEY ||
        process.env.ANTHROPIC_AUTH_TOKEN ||
        existing.portkeyKey ||
        "";
      const resolvedGateway = existing.gateway || PORTKEY_GATEWAY;
      await offerMcpAndSkills(args, resolvedKey || null, resolvedGateway, targetAgent, location);
      return;
    }
  }

  // ── Install Claude Code if missing ────────────────────────────────────────
  if (targetAgent === "claude" && !args.skipInstall && !isClaudeInstalled()) {
    const install = await p.confirm({
      message: "Claude Code not found. Install via npm?",
      initialValue: true,
    });
    if (p.isCancel(install)) return p.outro("Setup cancelled.");
    if (install) {
      const s = p.spinner();
      s.start("Installing Claude Code...");
      try {
        execSync("npm install -g @anthropic-ai/claude-code", { stdio: "ignore" });
        s.stop("Claude Code installed");
      } catch {
        s.stop("Install failed");
        warn("Install manually: npm install -g @anthropic-ai/claude-code");
      }
    }
  }

  // ── Step 1: Portkey API key + validation ──────────────────────────────────
  let portkeyKey =
    args.portkeyKey ||
    process.env.PORTKEY_API_KEY ||
    (existing.found ? existing.portkeyKey : "") ||
    "";

  let gateway = args.gateway ||
    (existing.found && existing.gateway !== PORTKEY_GATEWAY ? existing.gateway : PORTKEY_GATEWAY);

  let providers = null;
  let configs   = null;

  if (portkeyKey && !args.portkeyKey) {
    if (!args.yes) {
      const s = p.spinner();
      s.start("Validating existing API key...");
      const { data, error } = await fetchProviders(portkeyKey, gateway);
      if (error) {
        s.stop(
          isLikelyPortkeyApiKeyPermissionError(error)
            ? "API key rejected (check Permissions in Portkey dashboard)"
            : `Invalid API key: ${error}`
        );
        if (isLikelyPortkeyApiKeyPermissionError(error)) {
          p.note(portkeyApiKeyPermissionNoteBody("providers"), "API key permissions");
        }
        portkeyKey = "";
      } else {
        providers = data;
        s.stop(`Connected (${providers.length} provider${providers.length !== 1 ? "s" : ""} in Model Catalog)`);
        await sleep(500);
      }
    }
  }

  if (!portkeyKey) {
    portkeyKey = await p.text({
      message: "Portkey API key",
      placeholder: `paste from ${PORTKEY_DASHBOARD}/api-keys`,
      validate: (v) => (!v ? "API key is required" : undefined),
    });
    if (p.isCancel(portkeyKey)) return p.outro("Setup cancelled.");

    const s = p.spinner();
    s.start("Connecting to Portkey...");
    const { data, error } = await fetchProviders(portkeyKey, gateway);
    if (error) {
      s.stop(
        isLikelyPortkeyApiKeyPermissionError(error)
          ? "Connection failed (API key permissions)"
          : `Connection failed: ${error}`
      );
      if (isLikelyPortkeyApiKeyPermissionError(error)) {
        p.note(portkeyApiKeyPermissionNoteBody("providers"), "API key permissions");
      }
      err("Check your API key and try again.");
      return;
    }
    providers = data;
    s.stop(`Connected! ${providers.length} provider${providers.length !== 1 ? "s" : ""} in Model Catalog`);
    await sleep(500);
  }

  // ── Step 2: Gateway URL ───────────────────────────────────────────────────
  // Show the current gateway and allow override — always, not just --advanced
  if (!args.gateway && !args.yes) {
    const changeGw = await p.confirm({
      message: `Gateway: ${c.bold}${gateway}${c.reset}  — use a self-hosted gateway instead?`,
      initialValue: false,
    });
    if (!p.isCancel(changeGw) && changeGw) {
      const customGw = await p.text({
        message: "Custom gateway URL",
        placeholder: "https://your-portkey-gateway.example.com",
        validate: (v) => {
          if (!v) return "URL is required";
          if (v.endsWith("/v1")) return "Remove the /v1 suffix";
          if (!v.startsWith("http")) return "Must start with http:// or https://";
        },
      });
      if (p.isCancel(customGw)) return p.outro("Setup cancelled.");
      gateway = customGw;
    }
  }

  // ── Step 3: Provider or Config selection ──────────────────────────────────
  let mode         = args.config ? "config" : "provider";
  let providerSlug = args.provider || "";
  let providerType = "";
  let configId     = args.config  || "";
  let extraHeaders = "";

  if (mode === "provider") {
    if (!providers) {
      const s = p.spinner();
      s.start("Loading providers...");
      const { data, error } = await fetchProviders(portkeyKey, gateway);
      if (error) {
        s.stop(
          isLikelyPortkeyApiKeyPermissionError(error)
            ? "Could not load providers (API key permissions)"
            : `Could not load providers: ${error}`
        );
        if (isLikelyPortkeyApiKeyPermissionError(error)) {
          p.note(portkeyApiKeyPermissionNoteBody("providers"), "API key permissions");
        }
        return;
      }
      providers = data;
      s.stop(`Found ${providers.length} provider${providers.length !== 1 ? "s" : ""}`);
    }

    if (providers.length === 0) {
      err("No providers found in your Model Catalog.");
      info(`Create one at ${PORTKEY_DASHBOARD}/virtual-keys`);
      return;
    }

    if (targetAgent === "claude" && !args.yes && !args.provider) {
      p.note(
        `${c.yellow}Warning:${c.reset} With Claude Code behind Portkey, many models will still ${c.bold}accept requests${c.reset}, ` +
          `but ${c.bold}non-Claude${c.reset} or non-Anthropic-shaped endpoints can break ${c.bold}reasoning${c.reset}, ` +
          `${c.bold}extended thinking${c.reset}, tool behavior, and other Anthropic-specific features. ` +
          `Prefer ${c.bold}Anthropic Claude${c.reset} models when you rely on those capabilities.`,
        "Claude Code + Portkey"
      );
      await sleep(250);
    }

    if (providers.length === 1 && !args.provider) {
      providerSlug = providers[0].slug;
      providerType = (providers[0].provider || "").toLowerCase();
      ok(`Using @${providerSlug} (your only provider)`);
      await sleep(400);
    } else if (!providerSlug) {
      const existingProv = existing.found ? existing.provider : "";
      providerSlug = await p.select({
        message: "Select provider from Model Catalog",
        initialValue: existingProv || undefined,
        options: providers.map((prov) => ({
          value: prov.slug,
          label: `@${prov.slug}`,
          hint:  prov.provider || "",
        })),
      });
      if (p.isCancel(providerSlug)) return p.outro("Setup cancelled.");
      const selected = providers.find((pv) => pv.slug === providerSlug);
      if (selected) providerType = (selected.provider || "").toLowerCase();
    } else {
      const selected = providers.find((pv) => pv.slug === providerSlug.replace(/^@/, ""));
      if (selected) providerType = (selected.provider || "").toLowerCase();
    }

    providerSlug = normalizeProvider(providerSlug).slice(1);
    extraHeaders = `x-portkey-provider:@${providerSlug}`;

  } else {
    if (!configId) {
      const s = p.spinner();
      s.start("Loading configs...");
      const { data, error } = await fetchConfigs(portkeyKey, gateway);
      if (error) {
        s.stop(
          isLikelyPortkeyApiKeyPermissionError(error)
            ? "Could not load configs (API key permissions)"
            : `Could not load configs: ${error}`
        );
        if (isLikelyPortkeyApiKeyPermissionError(error)) {
          p.note(portkeyApiKeyPermissionNoteBody("configs"), "API key permissions");
        }
        return;
      }
      configs = data;
      s.stop(`Found ${configs.length} config${configs.length !== 1 ? "s" : ""}`);

      if (configs.length === 0) {
        err("No configs found.");
        info(`Create one at ${PORTKEY_DASHBOARD}/configs`);
        return;
      }

      configId = await p.select({
        message: "Select gateway config",
        options: configs.map((cfg) => ({
          value: cfg.id,
          label: cfg.name || cfg.id,
          hint:  cfg.isDefault ? "default" : "",
        })),
      });
      if (p.isCancel(configId)) return p.outro("Setup cancelled.");
    }
    extraHeaders = `x-portkey-config:${configId}`;
  }

  // ── Step 4: Model selection ───────────────────────────────────────────────
  // Always shown — not hidden behind --advanced
  let model            = args.model       || (existing.found ? existing.model : "") || "";
  let opusModel        = args.opusModel   || "";
  let sonnetModel      = args.sonnetModel || "";
  let haikuModel       = args.haikuModel  || "";
  let setModelMappings = !!(opusModel || sonnetModel || haikuModel);
  /** Populated during interactive provider flow — reused for optional alias mapping */
  let aliasPickMerged  = [];

  if (!args.yes && mode === "provider") {
    const curated = getModelOptions(providerType);
    const isCodex = targetAgent === "codex";

    const spin = p.spinner();
    spin.start("Loading models from Portkey…");
    const { data: catalogModels, error: modelsErr } = await fetchModels(
      portkeyKey,
      providerSlug,
      gateway
    );
    const catalogUnavailable = isModelsCatalogApiUnavailable(modelsErr || "");
    const permDenied = !!(modelsErr && isLikelyPortkeyApiKeyPermissionError(modelsErr));

    spin.stop(
      permDenied
        ? "Could not load models (API key permissions)"
        : catalogUnavailable
          ? "Model list API not available for this workspace"
          : modelsErr
            ? `Could not load models: ${modelsErr}`
            : catalogModels?.length
              ? `Found ${catalogModels.length} model${catalogModels.length !== 1 ? "s" : ""} for @${providerSlug}`
              : "No models returned for this provider — pick a suggestion or type an ID"
    );
    await sleep(300);
    if (permDenied) {
      p.note(portkeyApiKeyPermissionNoteBody("models"), "API key permissions");
      await sleep(200);
    } else if (catalogUnavailable) {
      p.note(
        [
          `Portkey’s ${c.bold}model-list API${c.reset} isn’t available for this workspace (often disabled on the current plan).`,
          ``,
          `${c.bold}Enterprise:${c.reset} to enable automatic model listing, contact ${c.cyan}support@portkey.ai${c.reset}.`,
          ``,
          `You can still continue: type the ${c.bold}model ID${c.reset} your virtual key uses — the same name as in the Portkey app.`,
        ].join("\n"),
        "Model list unavailable"
      );
      await sleep(200);
    }

    // On 403, do not inject curated defaults — they go stale; user must type a model ID.
    const wantModel =
      model || (!permDenied ? curated[0] : "") || "";

    const fromApi = (catalogModels || []).map((m) => m.id).filter(Boolean);
    const merged = [];
    const seen = new Set();
    for (const id of fromApi) {
      if (!seen.has(id)) {
        seen.add(id);
        merged.push(id);
      }
    }
    if (!permDenied) {
      for (const id of curated) {
        if (!seen.has(id)) {
          seen.add(id);
          merged.push(id);
        }
      }
    }

    aliasPickMerged = merged;

    const manualFirst = !permDenied && catalogUnavailable && merged.length > 0;
    const skipSelect =
      permDenied || (catalogUnavailable && merged.length === 0);

    const options = [];
    if (manualFirst) {
      options.push({
        value: PORTKEY_CUSTOM_MODEL,
        label: "Type model ID manually…",
        hint:  "when the list API is off",
      });
    }
    options.push(...merged.map((id) => ({ value: id, label: id })));
    if (!manualFirst) {
      options.push({
        value: PORTKEY_CUSTOM_MODEL,
        label: "Other…",
        hint:  "type a model ID",
      });
    }

    let picked;
    if (skipSelect) {
      picked = PORTKEY_CUSTOM_MODEL;
    } else if (merged.length > 0 || manualFirst) {
      const initial = manualFirst
        ? PORTKEY_CUSTOM_MODEL
        : model && merged.includes(model)
          ? model
          : merged[0];
      picked = await p.select({
        message: isCodex
          ? "Which model should Codex use?"
          : catalogUnavailable
            ? "Default model (type manually or pick a suggestion)"
            : "Default model",
        initialValue: initial,
        options,
      });
    } else {
      picked = PORTKEY_CUSTOM_MODEL;
    }

    if (p.isCancel(picked)) return p.outro("Setup cancelled.");

    if (picked === PORTKEY_CUSTOM_MODEL) {
      const manual = await p.text({
        message: isCodex
          ? "Model ID for Codex"
          : permDenied || catalogUnavailable
            ? "Default model ID for this virtual key"
            : "Default model ID",
        placeholder: permDenied
          ? "paste the model name your virtual key uses"
          : wantModel ||
            (isCodex ? "e.g. gpt-4o" : "e.g. claude-sonnet-4-20250514"),
        initialValue: model || "",
        validate: (v) =>
          !String(v || "").trim()
            ? "Enter the model ID your virtual key expects"
            : undefined,
      });
      if (p.isCancel(manual)) return p.outro("Setup cancelled.");
      model = shortModelIdForProvider(manual, providerSlug);
    } else {
      model = picked;
    }
  }

  let codexWireApi = normalizeCodexWireApi(args.codexWireApi);

  if (targetAgent === "codex" && mode === "config" && !String(model || "").trim()) {
    if (args.yes) {
      model = args.model || "gpt-4o";
    } else {
      const t = await p.text({
        message: "Default model name for Codex (Portkey routes via your Config)",
        placeholder: "e.g. gpt-4o",
        initialValue: args.model || "gpt-4o",
        validate: (v) => (!String(v || "").trim() ? "Enter a model name" : undefined),
      });
      if (p.isCancel(t)) return p.outro("Setup cancelled.");
      model = String(t).trim();
    }
  }

  if (targetAgent === "codex" && !args.codexWireApi && !args.yes) {
    p.note(
      [
        `${c.bold}wire_api${c.reset} sets how Codex talks to Portkey’s OpenAI-compatible surface:`,
        `  ${c.dim}chat${c.reset}       → \`/v1/chat/completions\` (default for most catalog models)`,
        `  ${c.dim}responses${c.reset} → Responses API (reasoning summaries, some tool flows)`,
        ``,
        `${c.dim}Pick per primary + any extra provider blocks you add below.${c.reset}`,
      ].join("\n"),
      "Codex wire API"
    );
    const wPick = await p.select({
      message: "wire_api for [model_providers.portkey]",
      options: [
        {
          value: "chat",
          label: "chat",
          hint:  "Chat Completions (default)",
        },
        {
          value: "responses",
          label: "responses",
          hint:  "OpenAI Responses API",
        },
      ],
      initialValue: "chat",
    });
    if (p.isCancel(wPick)) return p.outro("Setup cancelled.");
    codexWireApi = normalizeCodexWireApi(wPick);
  }

  // Optional: Sonnet / Opus / Haiku → concrete model IDs (Claude Code + provider)
  if (
    targetAgent === "claude" &&
    mode === "provider" &&
    !args.yes &&
    !setModelMappings
  ) {
    p.note(
      [
        `${c.bold}Already set:${c.reset} default startup model → ${c.bold}${model}${c.reset}.`,
        "",
        `${c.bold}Optional (Anthropic Claude Code):${c.reset} ${c.dim}/model${c.reset} has shortcuts ` +
          `${c.dim}sonnet${c.reset}, ${c.dim}opus${c.reset}, ${c.dim}haiku${c.reset}.`,
        `Each shortcut must map to the model string Portkey should receive.`,
        `Claude Code loads that from env:`,
        `  ${c.dim}ANTHROPIC_DEFAULT_SONNET_MODEL${c.reset}`,
        `  ${c.dim}ANTHROPIC_DEFAULT_OPUS_MODEL${c.reset}`,
        `  ${c.dim}ANTHROPIC_DEFAULT_HAIKU_MODEL${c.reset}`,
        `(See Anthropic model configuration docs.)`,
        "",
        `Say yes below only if you want Portkey IDs for all three. Skip if you mostly use one model.`,
        "",
        `Using non Claude models here can still route traffic but tools and thinking modes may break.`,
      ].join("\n"),
      "Optional alias targets"
    );

    const mapAliases = await p.confirm({
      message: "Set the three /model alias env vars (Sonnet, Opus, Haiku) for Portkey?",
      initialValue: false,
    });
    if (p.isCancel(mapAliases)) return p.outro("Setup cancelled.");

    if (mapAliases) {
      const merged = aliasPickMerged;
      const tierHint = (needle) => {
        const n = needle.toLowerCase();
        return merged.find((id) => id.toLowerCase().includes(n)) || "";
      };

      const pickAliasTarget = async (label, hintId) => {
        const initial =
          (hintId && merged.includes(hintId) && hintId) ||
          (model && merged.includes(model) ? model : merged[0]);
        const options = merged.map((id) => ({ value: id, label: id }));
        options.push({
          value: PORTKEY_CUSTOM_MODEL,
          label: "Other…",
          hint:  "enter a model ID",
        });
        let picked;
        if (merged.length > 0) {
          picked = await p.select({
            message:      label,
            initialValue: initial || merged[0],
            options,
          });
        } else {
          picked = PORTKEY_CUSTOM_MODEL;
        }
        if (p.isCancel(picked)) return null;
        if (picked === PORTKEY_CUSTOM_MODEL) {
          const manual = await p.text({
            message:      label,
            placeholder:  hintId || model || "e.g. claude-sonnet-4-20250514",
            initialValue: hintId || model || "",
            validate:     (v) => (!String(v || "").trim() ? "Model ID is required" : undefined),
          });
          if (p.isCancel(manual)) return null;
          return shortModelIdForProvider(manual, providerSlug);
        }
        return picked;
      };

      sonnetModel = await pickAliasTarget(
        "Sonnet alias → model ID",
        tierHint("sonnet") || model
      );
      if (sonnetModel == null) return p.outro("Setup cancelled.");
      opusModel = await pickAliasTarget(
        "Opus alias → model ID",
        tierHint("opus") || model
      );
      if (opusModel == null) return p.outro("Setup cancelled.");
      haikuModel = await pickAliasTarget(
        "Haiku alias → model ID",
        tierHint("haiku") || model
      );
      if (haikuModel == null) return p.outro("Setup cancelled.");
      setModelMappings = true;
    }
  }

  // ── Step 5: Summary + confirmation ───────────────────────────────────────
  const codexConfigFile = getCodexConfigTomlPath(
    projectRoot,
    location === "global" ? "global" : "project"
  );

  const targetFile = targetAgent === "codex"
    ? codexConfigFile
    : getSettingsPath(location, projectRoot || process.cwd());

  const summaryLines = [
    `${c.bold}Agent${c.reset}      ${targetAgent === "claude" ? "Claude Code" : "Codex"}`,
    `${c.bold}Gateway${c.reset}    ${gateway}`,
    mode === "provider" ? `${c.bold}Provider${c.reset}   @${providerSlug}` : null,
    mode === "config"   ? `${c.bold}Config${c.reset}     ${configId}`       : null,
    model && targetAgent === "codex"
      ? `${c.bold}Model${c.reset}      ${
          mode === "config" ? model : `@${providerSlug}/${model}`
        }`
      : model
        ? `${c.bold}Model${c.reset}      ${model}`
        : null,
    targetAgent === "codex" ? `${c.bold}wire_api${c.reset}   ${codexWireApi}` : null,
    setModelMappings    ? `${c.bold}Opus${c.reset}       ${opusModel}`      : null,
    setModelMappings    ? `${c.bold}Sonnet${c.reset}     ${sonnetModel}`    : null,
    setModelMappings    ? `${c.bold}Haiku${c.reset}      ${haikuModel}`     : null,
    `${c.bold}Config file${c.reset} ${targetFile}`,
  ].filter(Boolean).join("\n");

  p.note(summaryLines, "Configuration");
  await sleep(300);

  if (args.dryRun) return p.outro("Dry run — no changes made.");

  if (!args.yes) {
    const confirmWrite = await p.confirm({
      message: `Write config to ${targetFile}?`,
      initialValue: true,
    });
    if (p.isCancel(confirmWrite) || !confirmWrite) return p.outro("Setup cancelled.");
  }

  // ── Step 7: Write config ──────────────────────────────────────────────────

  if (targetAgent === "codex") {
    writeCodexPortkeyBundle(targetFile, {
      gateway,
      providerSlug,
      modelId: model,
      wireApi: codexWireApi,
      portkeyConfigId: mode === "config" ? configId : null,
    });
    ok(`Codex config written to ${targetFile}`);

    if (mode === "provider" && providers && providers.length > 1 && !args.yes) {
      p.note(
        [
          `${c.bold}Multiple catalog providers:${c.reset} the file now has the primary block`,
          `${c.dim}model_provider = \"portkey\"${c.reset} + ${c.dim}[model_providers.portkey]${c.reset}.`,
          ``,
          `You can ${c.bold}append${c.reset} more \`[model_providers.portkey-<slug>]\` tables (same`,
          `\`PORTKEY_API_KEY\` and \`base_url\`) and ${c.bold}switch${c.reset} by editing two lines:`,
          `  ${c.dim}model_provider${c.reset} = the table name (without brackets)`,
          `  ${c.dim}model${c.reset} = \`@<catalog-slug>/<model-id>\``,
          ``,
          `Each block can use a different ${c.dim}wire_api${c.reset} (${c.dim}chat${c.reset} vs ${c.dim}responses${c.reset}).`,
        ].join("\n"),
        "Codex + multiple Portkey providers"
      );
      const usedSlugs = new Set([providerSlug]);
      let addExtra = await p.confirm({
        message: "Append another Model Catalog provider as [model_providers.portkey-…] now?",
        initialValue: false,
      });
      while (addExtra && !p.isCancel(addExtra)) {
        const rest = providers.filter((pv) => !usedSlugs.has(pv.slug));
        if (rest.length === 0) break;
        const slugPick = await p.select({
          message: "Which provider should we add?",
          options: rest.map((pv) => ({
            value: pv.slug,
            label: `@${pv.slug}`,
            hint:  pv.provider || "",
          })),
        });
        if (p.isCancel(slugPick)) break;
        usedSlugs.add(slugPick);
        const wExtra = await p.select({
          message: `wire_api for @${slugPick}`,
          options: [
            { value: "chat", label: "chat", hint: "Chat Completions" },
            { value: "responses", label: "responses", hint: "Responses API" },
          ],
          initialValue: codexWireApi,
        });
        if (p.isCancel(wExtra)) break;
        const modExtra = await p.text({
          message: `Model id for @${slugPick} (becomes @${slugPick}/<id>)`,
          placeholder: "e.g. gpt-4o",
          initialValue: model,
          validate: (v) => (!String(v || "").trim() ? "Model id is required" : undefined),
        });
        if (p.isCancel(modExtra)) break;
        const modResolved = shortModelIdForProvider(modExtra, slugPick);
        appendCodexPortkeyProviderBlock(targetFile, {
          gateway,
          providerSlug: slugPick,
          modelId:      modResolved,
          wireApi:      wExtra,
        });
        ok(`Appended [model_providers…] for @${slugPick}`);
        addExtra = await p.confirm({
          message: "Add another provider block?",
          initialValue: false,
        });
      }
    }

    // Write PORTKEY_API_KEY to shell RC
    const shellRc = detectShellRc();
    const isFish  = shellRc.endsWith("config.fish");
    const isPwsh  = shellRc.endsWith(".ps1");
    const isNu    = shellRc.endsWith(".nu");

    let exportLine;
    if (isFish)      exportLine = `set -gx PORTKEY_API_KEY "${portkeyKey}"`;
    else if (isPwsh) exportLine = `$env:PORTKEY_API_KEY = "${portkeyKey}"`;
    else if (isNu)   exportLine = `$env.PORTKEY_API_KEY = "${portkeyKey}"`;
    else             exportLine = `export PORTKEY_API_KEY="${portkeyKey}"`;

    writeShellRc(shellRc, [
      `# ── Portkey + Codex (v${VERSION}) ──`,
      exportLine,
      "# ── End Portkey + Codex ──",
    ].join("\n"));
    ok(`PORTKEY_API_KEY written to ${shellRc}`);

    const reloadCmd = isPwsh ? `. ${shellRc}` : `source ${shellRc}`;
    console.log();
    console.log(`  ${c.bold}${c.cyan}▶  Run this command now:${c.reset}`);
    console.log();
    console.log(`     ${c.bold}${reloadCmd}${c.reset}`);
    console.log();
    console.log(`  ${c.dim}Or open a new terminal window.${c.reset}`);
    console.log();
    dim(`Codex MCP entries use env var PORTKEY_API_KEY for streamable HTTP servers.`);

  } else {
    // Claude Code: write env vars or settings.json
    if (location === "env") {
      const envVars = {
        ANTHROPIC_BASE_URL:       gateway,
        ANTHROPIC_AUTH_TOKEN:     portkeyKey,
        ANTHROPIC_CUSTOM_HEADERS: extraHeaders,
      };
      if (model) envVars.ANTHROPIC_MODEL = model;
      if (setModelMappings) {
        envVars.ANTHROPIC_DEFAULT_OPUS_MODEL   = opusModel;
        envVars.ANTHROPIC_DEFAULT_SONNET_MODEL = sonnetModel;
        envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL  = haikuModel;
      }

      const isFish = targetFile.endsWith("config.fish");
      const isPwsh = targetFile.endsWith(".ps1");
      const isNu   = targetFile.endsWith(".nu");

      const lines = [`# ── Portkey + Claude Code (v${VERSION}) ──`];
      for (const [k, v] of Object.entries(envVars)) {
        if (isFish)      lines.push(`set -gx ${k} "${v}"`);
        else if (isPwsh) lines.push(`$env:${k} = "${v}"`);
        else if (isNu)   lines.push(`$env.${k} = "${v}"`);
        else             lines.push(`export ${k}="${v}"`);
      }
      lines.push("# ── End Portkey + Claude Code ──");

      writeShellRc(targetFile, lines.join("\n"));
      ok(`Gateway config written to ${targetFile}`);

    } else {
      // Write to settings.json
      const envPairs = {
        ANTHROPIC_BASE_URL:       gateway,
        ANTHROPIC_AUTH_TOKEN:     portkeyKey,
        ANTHROPIC_CUSTOM_HEADERS: extraHeaders,
      };
      if (setModelMappings) {
        envPairs.ANTHROPIC_DEFAULT_OPUS_MODEL   = opusModel;
        envPairs.ANTHROPIC_DEFAULT_SONNET_MODEL = sonnetModel;
        envPairs.ANTHROPIC_DEFAULT_HAIKU_MODEL  = haikuModel;
      }
      settingsSetEnv(targetFile, envPairs);
      if (model) settingsSetKey(targetFile, "model", model);
      ok(`Gateway config written to ${targetFile}`);

      // Also write auth token to shell RC so Claude Code can start
      const shellRc = detectShellRc();
      const isFish  = shellRc.endsWith("config.fish");
      const isPwsh  = shellRc.endsWith(".ps1");
      const isNu    = shellRc.endsWith(".nu");
      let exportLine;
      if (isFish)      exportLine = `set -gx ANTHROPIC_AUTH_TOKEN "${portkeyKey}"`;
      else if (isPwsh) exportLine = `$env:ANTHROPIC_AUTH_TOKEN = "${portkeyKey}"`;
      else if (isNu)   exportLine = `$env.ANTHROPIC_AUTH_TOKEN = "${portkeyKey}"`;
      else             exportLine = `export ANTHROPIC_AUTH_TOKEN="${portkeyKey}"`;

      writeShellRc(shellRc, [
        `# ── Portkey + Claude Code (v${VERSION}) ──`,
        exportLine,
        "# ── End Portkey + Claude Code ──",
      ].join("\n"));
      ok(`Auth token also written to ${shellRc}`);
    }

    // Reload reminder (once, at the end)
    const shellRcFinal = detectShellRc();
    const isPwshFinal  = shellRcFinal.endsWith(".ps1");
    const reloadCmd    = isPwshFinal ? `. ${shellRcFinal}` : `source ${shellRcFinal}`;
    console.log();
    console.log(`  ${c.bold}${c.cyan}▶  Run this command now:${c.reset}`);
    console.log();
    console.log(`     ${c.bold}${reloadCmd}${c.reset}`);
    console.log();
    console.log(`  ${c.dim}Or open a new terminal window.${c.reset}`);
    console.log();
  }

  // ── Step 8: MCP + Skills ──────────────────────────────────────────────────
  await offerMcpAndSkills(args, portkeyKey, gateway, targetAgent, location);

  p.outro(`${c.green}All done!${c.reset}  ${c.dim}Dashboard → ${PORTKEY_DASHBOARD}/logs${c.reset}`);
}

// ── Offer MCP and Skills after gateway setup ──────────────────────────────────

async function offerMcpAndSkills(args, portkeyKey, gateway, targetAgent = "claude", location = "global") {
  const projectRoot = findProjectRoot();
  const resolvedGw  = gateway || PORTKEY_GATEWAY;
  let   resolvedKey = portkeyKey || "";

  // MCP: Claude Code (.mcp.json / ~/.claude.json) + Codex (.codex/config.toml)
  // Interactive default: yes. With --yes: add all workspace MCP servers (unless --skip-mcp).
  if ((targetAgent === "claude" || targetAgent === "codex") && !args.skipMcp) {
    console.log();
    let addMcp = false;
    if (args.yes) {
      addMcp = true;
    } else {
      const mcpPrompt =
        targetAgent === "codex"
          ? "Add Portkey MCP servers to Codex config.toml?  (see https://developers.openai.com/codex/mcp)"
          : "Add MCP servers from your Portkey workspace?  (recommended)";
      addMcp = await p.confirm({
        message: mcpPrompt,
        initialValue: true,
      });
    }

    if (!p.isCancel(addMcp) && addMcp) {
      resolvedKey = await ensureApiKey(args, resolvedKey, resolvedGw);
      if (resolvedKey) {
        const codexTomlPath =
          targetAgent === "codex"
            ? getCodexConfigTomlPath(
                projectRoot,
                location === "global" ? "global" : "project"
              )
            : null;
        await runMcpSelection(
          args,
          resolvedKey,
          resolvedGw,
          projectRoot,
          location,
          codexTomlPath
        );
      }
    }
  }

  // Skills: all agents — same defaults as MCP
  if (!args.skipSkills) {
    console.log();
    let addSkills = false;
    if (args.yes) {
      addSkills = true;
    } else {
      addSkills = await p.confirm({
        message: "Sync team skills from Portkey (SKILL.md files)?  (recommended)",
        initialValue: true,
      });
    }

    if (!p.isCancel(addSkills) && addSkills) {
      resolvedKey = await ensureApiKey(args, resolvedKey, resolvedGw);
      if (resolvedKey) await runSkillsSelection(args, resolvedKey, resolvedGw, projectRoot, targetAgent);
    }
  }
}

// ── Ensure API key is available ───────────────────────────────────────────────

async function ensureApiKey(args, currentKey, gateway) {
  if (currentKey) return currentKey;

  const key = await p.text({
    message: "Portkey API key",
    placeholder: `paste from ${PORTKEY_DASHBOARD}/api-keys`,
    validate: (v) => (!v ? "API key is required" : undefined),
  });
  if (p.isCancel(key)) return "";

  const s = p.spinner();
  s.start("Validating API key...");
  const { data, error } = await fetchProviders(key, gateway);
  if (error) {
    s.stop(
      isLikelyPortkeyApiKeyPermissionError(error)
        ? "API key rejected (check Permissions in Portkey dashboard)"
        : `Invalid API key: ${error}`
    );
    if (isLikelyPortkeyApiKeyPermissionError(error)) {
      p.note(portkeyApiKeyPermissionNoteBody("providers"), "API key permissions");
    }
    return "";
  }
  s.stop(`Connected (${data.length} provider${data.length !== 1 ? "s" : ""} in Model Catalog)`);
  return key;
}

// ── MCP selection helper ──────────────────────────────────────────────────────

async function runMcpSelection(
  args,
  portkeyKey,
  gateway,
  projectRoot,
  location = "global",
  codexConfigPath = null
) {
  const s = p.spinner();
  s.start("Fetching MCP servers from Portkey...");
  const { data: servers, error } = await fetchMcpServers(portkeyKey, gateway);
  if (error) {
    s.stop(
      isLikelyPortkeyApiKeyPermissionError(error)
        ? "Could not load MCP servers (API key permissions)"
        : `Could not load MCP servers: ${error}`
    );
    if (isLikelyPortkeyApiKeyPermissionError(error)) {
      p.note(portkeyApiKeyPermissionNoteBody("mcp"), "API key permissions");
    }
    return;
  }
  s.stop(`Found ${servers.length} MCP server${servers.length !== 1 ? "s" : ""}`);

  if (servers.length === 0) {
    info(`No MCP servers in workspace. Register one at ${PORTKEY_DASHBOARD}/mcp`);
    return;
  }

  let selected;
  if (args.yes) {
    selected = servers.map((s) => s.slug);
    info(`Adding all ${selected.length} MCP server${selected.length !== 1 ? "s" : ""} from your workspace  ${c.dim}(--yes)${c.reset}`);
  } else {
    p.note(
      `${c.dim}${MULTISELECT_HINT}${c.reset}\n` +
        `${c.dim}A checked row (●) will be installed; unchecked (○) is skipped.${c.reset}`,
      "Choose MCP servers"
    );
    selected = await p.multiselect({
      message: "Which MCP servers should we add?",
      options: servers.map((srv) => ({
        value: srv.slug,
        label: srv.name,
        hint:  srv.description || srv.url || "",
      })),
      required: false,
    });
  }

  if (p.isCancel(selected)) return;
  if (!selected.length) {
    const skip = await p.confirm({ message: "Nothing selected — skip MCP setup?", initialValue: true });
    if (p.isCancel(skip) || skip) return;
    if (codexConfigPath) {
      info(`Add servers later: ${c.bold}codex mcp add${c.reset} or edit ${c.dim}config.toml${c.reset} — ${c.dim}https://developers.openai.com/codex/mcp${c.reset}`);
    } else {
      info(`Run ${c.bold}portkey mcp add${c.reset} to add MCP servers any time.`);
    }
    return;
  }

  const picked = selected
    .map((slug) => servers.find((s) => s.slug === slug))
    .filter(Boolean);

  if (codexConfigPath) {
    writeCodexMcpServersToml(codexConfigPath, picked);
    const oauthServers = picked.filter(portkeyMcpRequiresOAuth);
    if (oauthServers.length) {
      const ids = oauthServers.map((s) => codexMcpTableId(s.slug)).join(", ");
      info(
        `Upstream OAuth may be required for: ${oauthServers.map((s) => s.name || s.slug).join(", ")}  ` +
          `${c.dim}— run ${c.bold}codex mcp login <server-name>${c.reset}${c.dim} (server names: ${ids}).${c.reset}`
      );
    }
    ok(
      `${selected.length} MCP server${selected.length !== 1 ? "s" : ""} added to ${c.dim}${codexConfigPath}${c.reset}`
    );
    dim(`Docs: https://developers.openai.com/codex/mcp`);
    const codexIds = picked.map((s) => codexMcpTableId(s.slug)).join(", ");
    p.note(
      `${c.bold}/mcp${c.reset} can still show ${c.bold}Auth: OAuth${c.reset} if the Portkey MCP endpoint advertises OAuth in the protocol — independent of ${c.dim}env_http_headers${c.reset}. ` +
        `If tools stay empty, run ${c.bold}codex mcp login${c.reset} for: ${codexIds}. ` +
        `For header-only behavior (like Claude), the integration should use API-key/header auth in Portkey so the gateway does not require OAuth.`,
      "Codex MCP"
    );
    return;
  }

  // Map setup location → Claude Code MCP scope
  // "global" / "env"        → user  (root mcpServers in ~/.claude.json)
  // "project-local"         → local (projects[path].mcpServers in ~/.claude.json)
  // "project-shared"        → project (.mcp.json, git-committed)
  const mcpScope =
    location === "project-shared" ? "project" :
    location === "project-local"  ? "local"   :
    "user";

  const mcpFile = getMcpFilePath(
    mcpScope === "project" ? "project-shared" : "global",
    projectRoot
  );
  const mcpEntries = {};
  for (const slug of selected) {
    const srv = servers.find((sv) => sv.slug === slug);
    if (!srv) continue;
    mcpEntries[`portkey-${slug}`] = buildClaudeMcpHttpConfig(srv, portkeyKey);
  }

  settingsSetMcp(mcpFile, mcpEntries, {
    scope:       mcpScope,
    projectPath: mcpScope === "local" ? (projectRoot || process.cwd()) : null,
  });

  const oauthServers = picked.filter(portkeyMcpRequiresOAuth);
  if (oauthServers.length) {
    info(
      `Also complete upstream OAuth for: ${oauthServers.map((s) => s.name || s.slug).join(", ")}  ` +
        `${c.dim}— in Claude Code run ${c.bold}/mcp${c.reset}${c.dim} (workspace key is already in config).${c.reset}`
    );
  }

  const mcpScopeLabel =
    mcpScope === "project" ? `repo .mcp.json  ${c.dim}(team can commit)${c.reset}` :
    mcpScope === "local"   ? `this project only  ${c.dim}(~/.claude.json)${c.reset}` :
                             `all projects  ${c.dim}(~/.claude.json)${c.reset}`;
  ok(`${selected.length} MCP server${selected.length !== 1 ? "s" : ""} added  [${mcpScopeLabel}]`);
}

// ── Skills selection helper ───────────────────────────────────────────────────

async function runSkillsSelection(args, portkeyKey, gateway, projectRoot, defaultAgent = null) {
  const s = p.spinner();
  s.start("Fetching team skills from Portkey...");
  const { data: skills, error } = await fetchSkills(portkeyKey, gateway);
  if (error) {
    s.stop(
      isLikelyPortkeyApiKeyPermissionError(error)
        ? "Could not load skills (API key permissions)"
        : `Could not load skills: ${error}`
    );
    if (isLikelyPortkeyApiKeyPermissionError(error)) {
      p.note(portkeyApiKeyPermissionNoteBody("skills"), "API key permissions");
    }
    return;
  }
  s.stop(`Found ${skills.length} skill${skills.length !== 1 ? "s" : ""}`);

  if (skills.length === 0) {
    info(`No prompt partials in workspace. Create one at ${PORTKEY_DASHBOARD}/prompts`);
    return;
  }

  let selectedSkills;
  if (args.yes) {
    selectedSkills = skills.map(skillStableKey);
    info(`Syncing all ${selectedSkills.length} skill${selectedSkills.length !== 1 ? "s" : ""}  ${c.dim}(--yes)${c.reset}`);
  } else {
    p.note(
      `${c.dim}${MULTISELECT_HINT}${c.reset}\n` +
        `${c.dim}Check every skill you want; leave unchecked to skip.${c.reset}`,
      "Choose skills"
    );
    selectedSkills = await p.multiselect({
      message: "Which skills should we download?",
      options: skills.map((sk) => ({
        value: skillStableKey(sk),
        label: sk.name,
        hint:  `${skillSkillDirName(sk)}  · v${sk.version}`,
      })),
      required: false,
    });
  }

  if (p.isCancel(selectedSkills)) return;
  if (!selectedSkills.length) {
    const skip = await p.confirm({ message: "Nothing selected — skip skills sync?", initialValue: true });
    if (p.isCancel(skip) || skip) return;
    info(`Run ${c.bold}portkey skills sync${c.reset} to sync skills any time.`);
    return;
  }

  // ── Where to install: project vs personal (home) ─────────────────────────
  let useGlobal = args.global || !projectRoot;
  if (!args.yes && !args.global && projectRoot) {
    // Show paths specific to the chosen agent (or generic if unknown)
    const agentDir = defaultAgent
      ? { claude: ".claude", cursor: ".cursor", codex: ".codex" }[defaultAgent] || ".claude"
      : null;

    const projectHint  = agentDir ? `.${agentDir}/skills/` : ".claude/skills/  .cursor/skills/  .codex/skills/";
    const personalHint = agentDir
      ? `~/${agentDir}/skills/`
      : "~/.claude/skills/  ~/.cursor/skills/  ~/.codex/skills/";

    const scopePick = await p.select({
      message: "Where should skills be installed?",
      options: [
        { value: "project",  label: "This project",              hint: projectHint },
        { value: "personal", label: "Personal (all your projects)", hint: personalHint },
      ],
      initialValue: "project",
    });
    if (p.isCancel(scopePick)) return;
    useGlobal = scopePick === "personal";
  }

  // ── Which agents ──────────────────────────────────────────────────────────
  let selectedAgents;

  if (args.agent) {
    // --agent flag from CLI
    selectedAgents = args.agent === "all"
      ? ["claude", "cursor", "codex"]
      : args.agent.split(",").map((a) => a.trim()).filter((a) => AGENT_SKILLS_DIRS[a]);

  } else if (defaultAgent) {
    // Called from setup wizard — agent already chosen, no need to ask again
    selectedAgents = [defaultAgent];
    const dir = AGENT_SKILLS_DIRS[defaultAgent](projectRoot, useGlobal);
    info(`Installing to: ${dir}`);

  } else if (args.yes) {
    const installed = detectInstalledAgents(projectRoot);
    selectedAgents  = installed.length ? installed : ["claude"];

  } else {
    const installed    = detectInstalledAgents(projectRoot);
    const agentOptions = [
      { value: "claude", label: "Claude Code", hint: (useGlobal ? "~/.claude/skills/" : ".claude/skills/") + (installed.includes("claude") ? "  ✓" : "") },
      { value: "cursor", label: "Cursor",       hint: (useGlobal ? "~/.cursor/skills/" : ".cursor/skills/") + (installed.includes("cursor") ? "  ✓" : "") },
      { value: "codex",  label: "Codex",        hint: (useGlobal ? "~/.codex/skills/"  : ".codex/skills/")  + (installed.includes("codex")  ? "  ✓" : "") },
    ];
    p.note(
      `${c.dim}${MULTISELECT_HINT}${c.reset}\n` +
        `${c.dim}✓ = this agent’s config folder was detected on disk.${c.reset}`,
      "Target agents"
    );
    const picked = await p.multiselect({
      message:       "Install skills to which agents?",
      options:       agentOptions,
      initialValues: installed.length ? installed : ["claude"],
      required:      false,
    });
    if (p.isCancel(picked)) return;
    if (!picked.length) {
      const skip = await p.confirm({ message: "No agents selected — skip?", initialValue: true });
      if (p.isCancel(skip) || skip) return;
    }
    selectedAgents = picked;
  }

  if (!selectedAgents?.length) return;

  const chosenSkills = skills.filter((sk) => selectedSkills.includes(skillStableKey(sk)));

  // Fetch full content for each skill (the list endpoint omits content)
  const fetchSpin = p.spinner();
  fetchSpin.start(`Downloading ${chosenSkills.length} skill${chosenSkills.length !== 1 ? "s" : ""}...`);
  const skillContents = new Map();
  for (const skill of chosenSkills) {
    const { content, error: fetchErr } = await fetchSkillContent(portkeyKey, gateway, skill.id || skill.name);
    if (fetchErr) {
      fetchSpin.stop(`Warning: could not fetch "${skill.name}": ${fetchErr}`);
      fetchSpin.start("Continuing...");
    } else if (content) {
      skillContents.set(skillStableKey(skill), content);
    }
  }
  fetchSpin.stop(`Downloaded ${skillContents.size} skill${skillContents.size !== 1 ? "s" : ""}`);

  const written = [];
  for (const agent of selectedAgents) {
    const skillsDir = AGENT_SKILLS_DIRS[agent](projectRoot, useGlobal);
    for (const skill of chosenSkills) {
      const key = skillStableKey(skill);
      const content = skillContents.get(key);
      if (content == null) continue;
      const folder = skillSkillDirName(skill);
      writeSingleSkill(skillsDir, folder, content);
      written.push(path.join(skillsDir, folder, "SKILL.md"));
    }
  }

  console.log();
  for (const f of written) console.log(`  ${c.green}✔${c.reset}  ${c.dim}${f}${c.reset}`);
  console.log();

  ok(`${written.length} skill${written.length !== 1 ? "s" : ""} synced. Restart your agent to pick them up.`);
}
