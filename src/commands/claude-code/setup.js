import * as p from "@clack/prompts";
import { execSync } from "node:child_process";
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
  fetchProviders,
  fetchConfigs,
  fetchModels,
  findProjectRoot,
  detectShellRc,
  getSettingsPath,
  settingsSetEnv,
  settingsSetKey,
  writeShellRc,
  normalizeProvider,
  isClaudeInstalled,
  readExistingConfig,
} from "../../utils.js";

// Provider types that need model name mappings
const BEDROCK_VERTEX_TYPES = new Set([
  "bedrock",
  "vertex_ai",
  "vertex-ai",
  "google",
]);

export async function doSetup(args) {
  // Clear screen for a fresh start
  console.clear();
  
  p.intro(`${c.bold}Portkey + Claude Code${c.reset} ${c.dim}v${VERSION}${c.reset}`);

  // ── Discover existing config ───────────────────────────────────────────
  const existing = readExistingConfig();
  
  // Quick path: existing config found, offer one-key update
  if (existing.found && !args.yes && !args.advanced) {
    const summary = [
      existing.provider ? `@${existing.provider}` : null,
      existing.configId ? `config:${existing.configId}` : null,
      existing.model ? `model:${existing.model}` : null,
    ].filter(Boolean).join(", ");
    
    const action = await p.select({
      message: `Existing config: ${summary}`,
      options: [
        { value: "keep", label: "Keep current config", hint: "no changes" },
        { value: "update", label: "Update config", hint: "guided setup" },
        { value: "cancel", label: "Cancel" },
      ],
    });
    if (p.isCancel(action) || action === "cancel") return p.outro("Setup cancelled.");
    if (action === "keep") {
      p.outro("Config unchanged.");
      return;
    }
  }

  // ── Step 0: Install Claude Code (skip by default, only if missing) ─────
  if (!args.skipInstall && !isClaudeInstalled()) {
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

  // ── Step 1: Portkey API key + immediate validation ─────────────────────
  let portkeyKey =
    args.portkeyKey ||
    process.env.PORTKEY_API_KEY ||
    (existing.found ? existing.portkeyKey : "") ||
    "";

  // Gateway (from flag or existing, no prompt - use --gateway for custom)
  let gateway = args.gateway || 
    (existing.found && existing.gateway !== PORTKEY_GATEWAY ? existing.gateway : PORTKEY_GATEWAY);

  let providers = null;
  let configs = null;

  if (portkeyKey && !args.portkeyKey) {
    // Have key from env/config - validate it
    if (!args.yes) {
      const s = p.spinner();
      s.start("Validating API key...");
      const { data, error } = await fetchProviders(portkeyKey, gateway);
      if (error) {
        s.stop(`Invalid API key: ${error}`);
        portkeyKey = ""; // Force re-entry
      } else {
        providers = data;
        s.stop(`Connected to Portkey (${providers.length} providers in Model Catalog)`);
        await sleep(600); // Let user read
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

    // Validate immediately
    const s = p.spinner();
    s.start("Connecting to Portkey...");
    const { data, error } = await fetchProviders(portkeyKey, gateway);
    if (error) {
      s.stop(`Connection failed: ${error}`);
      err("Check your API key and try again.");
      return;
    }
    providers = data;
    s.stop(`Connected! Found ${providers.length} providers in Model Catalog`);
    await sleep(600); // Let user read
  }

  // ── Step 2: Provider selection (or Config if --config flag) ────────────
  let mode = args.config ? "config" : "provider";
  let providerSlug = args.provider || "";
  let providerType = "";
  let configId = args.config || "";
  let extraHeaders = "";

  if (mode === "provider") {
    // Fetch providers if not already done
    if (!providers) {
      const s = p.spinner();
      s.start("Loading providers...");
      const { data, error } = await fetchProviders(portkeyKey, gateway);
      if (error) {
        s.stop(`Could not load providers: ${error}`);
        return;
      }
      providers = data;
      s.stop(`Found ${providers.length} providers`);
    }

    if (providers.length === 0) {
      err("No providers found in your Model Catalog.");
      info(`Create one at ${PORTKEY_DASHBOARD}/virtual-keys`);
      return;
    }

    // Auto-select if only one provider
    if (providers.length === 1 && !args.provider) {
      providerSlug = providers[0].slug;
      providerType = (providers[0].provider || "").toLowerCase();
      ok(`Using @${providerSlug} (your only provider)`);
      await sleep(500);
    } else if (!providerSlug) {
      // Let user select
      const existingProv = existing.found ? existing.provider : "";
      providerSlug = await p.select({
        message: "Select provider from Model Catalog",
        initialValue: existingProv || undefined,
        options: providers.map((prov) => {
          const isBV = BEDROCK_VERTEX_TYPES.has((prov.provider || "").toLowerCase());
          return {
            value: prov.slug,
            label: `@${prov.slug}`,
            hint: [
              prov.provider || "",
              isBV ? "(requires model config)" : "",
            ].filter(Boolean).join(" "),
          };
        }),
      });
      if (p.isCancel(providerSlug)) return p.outro("Setup cancelled.");

      const selected = providers.find((pv) => pv.slug === providerSlug);
      if (selected) providerType = (selected.provider || "").toLowerCase();
    } else {
      // Provider from flag - find its type
      const selected = providers.find((pv) => pv.slug === providerSlug.replace(/^@/, ""));
      if (selected) providerType = (selected.provider || "").toLowerCase();
    }

    providerSlug = normalizeProvider(providerSlug).slice(1);
    extraHeaders = `x-portkey-provider:@${providerSlug}`;
  } else if (mode === "config") {
    // Config mode
    if (!configId) {
      const s = p.spinner();
      s.start("Loading configs...");
      const { data, error } = await fetchConfigs(portkeyKey, gateway);
      if (error) {
        s.stop(`Could not load configs: ${error}`);
        return;
      }
      configs = data;
      s.stop(`Found ${configs.length} configs`);

      if (configs.length === 0) {
        err("No configs found.");
        info(`Create one at ${PORTKEY_DASHBOARD}/configs`);
        return;
      }

      configId = await p.select({
        message: "Select config",
        options: configs.map((cfg) => ({
          value: cfg.id,
          label: cfg.name || cfg.id,
          hint: cfg.isDefault ? "default" : "",
        })),
      });
      if (p.isCancel(configId)) return p.outro("Setup cancelled.");
    }
    extraHeaders = `x-portkey-config:${configId}`;
  }

  // ── Step 3: Model config (only for Bedrock/Vertex) ─────────────────────
  const isBedrock = BEDROCK_VERTEX_TYPES.has(providerType);
  let model = args.model || (existing.found ? existing.model : "") || "";
  let opusModel = args.opusModel || "";
  let sonnetModel = args.sonnetModel || "";
  let haikuModel = args.haikuModel || "";
  let setModelMappings = !!(opusModel || sonnetModel || haikuModel);

  if (isBedrock && !setModelMappings && !args.yes) {
    p.note(
      "Bedrock/Vertex uses different model names.\nClaude Code needs to know which models to use.",
      "Model configuration required"
    );

    // Fetch models for this provider
    const s = p.spinner();
    s.start("Loading available models...");
    const { data: availableModels, error: modelsErr } = await fetchModels(portkeyKey, providerSlug, gateway);
    if (modelsErr) {
      s.stop(`Could not load models: ${modelsErr}`);
    } else {
      s.stop(`Found ${availableModels?.length || 0} Claude models`);
    }

    const models = availableModels || [];
    const findModel = (tier) => models.find((m) => m.id.toLowerCase().includes(tier))?.id || "";

    if (models.length > 0) {
      // Sort models with relevant tier on top
      const sortedForTier = (tier) =>
        [...models].sort((a, b) => {
          const aMatch = a.id.toLowerCase().includes(tier);
          const bMatch = b.id.toLowerCase().includes(tier);
          if (aMatch && !bMatch) return -1;
          if (!aMatch && bMatch) return 1;
          return 0;
        }).map((m) => ({ value: m.id, label: m.id }));

      opusModel = await p.select({
        message: "Opus model",
        initialValue: findModel("opus"),
        options: sortedForTier("opus"),
      });
      if (p.isCancel(opusModel)) return p.outro("Setup cancelled.");

      sonnetModel = await p.select({
        message: "Sonnet model",
        initialValue: findModel("sonnet"),
        options: sortedForTier("sonnet"),
      });
      if (p.isCancel(sonnetModel)) return p.outro("Setup cancelled.");

      haikuModel = await p.select({
        message: "Haiku model",
        initialValue: findModel("haiku"),
        options: sortedForTier("haiku"),
      });
      if (p.isCancel(haikuModel)) return p.outro("Setup cancelled.");
    } else {
      // No models from API - manual entry
      const mappings = await p.group({
        opus: () => p.text({
          message: "Opus model name",
          placeholder: "e.g. us.anthropic.claude-opus-4-20250514-v1:0",
        }),
        sonnet: () => p.text({
          message: "Sonnet model name",
          placeholder: "e.g. us.anthropic.claude-sonnet-4-20250514-v1:0",
        }),
        haiku: () => p.text({
          message: "Haiku model name",
          placeholder: "e.g. us.anthropic.claude-haiku-4-20250514-v1:0",
        }),
      });
      if (p.isCancel(mappings)) return p.outro("Setup cancelled.");
      opusModel = mappings.opus;
      sonnetModel = mappings.sonnet;
      haikuModel = mappings.haiku;
    }
    setModelMappings = true;
  }

  // ── Step 4: Advanced settings (only if --advanced flag) ────────────────
  let location = args.location || "env";
  const projectRoot = findProjectRoot();

  if (args.advanced && !args.yes) {
    // Default model
    const modelChoice = await p.text({
      message: "Default model (Enter to skip)",
      placeholder: "opus | sonnet | haiku | claude-sonnet-4-20250514",
      defaultValue: model,
    });
    if (p.isCancel(modelChoice)) return p.outro("Setup cancelled.");
    model = modelChoice;

    // Location
    const shellRc = detectShellRc();
    const locationOptions = [
      { value: "env", label: "Shell environment", hint: `${shellRc} (recommended)` },
    ];
    if (projectRoot) {
      locationOptions.push(
        { value: "project-local", label: "Project (private)", hint: ".claude/settings.local.json" },
        { value: "project-shared", label: "Project (shared)", hint: ".claude/settings.json" }
      );
    }
    locationOptions.push({ value: "global", label: "Global", hint: "~/.claude/settings.json" });

    location = await p.select({
      message: "Where to save config?",
      initialValue: location,
      options: locationOptions,
    });
    if (p.isCancel(location)) return p.outro("Setup cancelled.");

    // Custom gateway
    if (gateway === PORTKEY_GATEWAY) {
      const customGw = await p.confirm({
        message: "Use a private Portkey gateway?",
        initialValue: false,
      });
      if (p.isCancel(customGw)) return p.outro("Setup cancelled.");
      if (customGw) {
        gateway = await p.text({
          message: "Gateway URL",
          placeholder: "https://your-gateway.example.com",
          validate: (v) => {
            if (!v) return "URL is required";
            if (v.endsWith("/v1")) return "Remove /v1 suffix";
            if (!v.startsWith("http")) return "Must start with http:// or https://";
          },
        });
        if (p.isCancel(gateway)) return p.outro("Setup cancelled.");
      }
    }
  }

  // ── Summary + Confirmation ─────────────────────────────────────────────
  const targetFile = getSettingsPath(location, projectRoot || process.cwd());
  const resolvedHeaders = extraHeaders;

  const summaryLines = [
    mode === "provider" ? `${c.bold}Provider${c.reset}  @${providerSlug}` : null,
    mode === "config" ? `${c.bold}Config${c.reset}    ${configId}` : null,
    model ? `${c.bold}Model${c.reset}     ${model}` : null,
    setModelMappings ? `${c.bold}Opus${c.reset}      ${opusModel}` : null,
    setModelMappings ? `${c.bold}Sonnet${c.reset}    ${sonnetModel}` : null,
    setModelMappings ? `${c.bold}Haiku${c.reset}     ${haikuModel}` : null,
    gateway !== PORTKEY_GATEWAY ? `${c.bold}Gateway${c.reset}   ${gateway}` : null,
    `${c.bold}Save to${c.reset}   ${targetFile}`,
  ].filter(Boolean).join("\n");

  p.note(summaryLines, "Configuration");
  await sleep(400); // Let user read summary

  if (args.dryRun) {
    return p.outro("Dry run - no changes made.");
  }

  if (!args.yes) {
    const confirmWrite = await p.confirm({
      message: "Write config?",
      initialValue: true,
    });
    if (p.isCancel(confirmWrite) || !confirmWrite) {
      return p.outro("Setup cancelled.");
    }
  }

  if (location === "env") {
    // Write to shell RC file
    const envVars = {
      ANTHROPIC_BASE_URL: gateway,
      ANTHROPIC_AUTH_TOKEN: portkeyKey,
      ANTHROPIC_CUSTOM_HEADERS: resolvedHeaders,
    };
    if (model) envVars.ANTHROPIC_MODEL = model;
    if (setModelMappings) {
      envVars.ANTHROPIC_DEFAULT_OPUS_MODEL = opusModel;
      envVars.ANTHROPIC_DEFAULT_SONNET_MODEL = sonnetModel;
      envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL = haikuModel;
    }

    const isFish = targetFile.endsWith("config.fish");
    const isPwsh = targetFile.endsWith(".ps1");
    const isNu = targetFile.endsWith(".nu");

    const lines = [`# ── Portkey + Claude Code (v${VERSION}) ──`];
    for (const [k, v] of Object.entries(envVars)) {
      if (isFish) {
        lines.push(`set -gx ${k} "${v}"`);
      } else if (isPwsh) {
        lines.push(`$env:${k} = "${v}"`);
      } else if (isNu) {
        lines.push(`$env.${k} = "${v}"`);
      } else {
        lines.push(`export ${k}="${v}"`);
      }
    }
    lines.push("# ── End Portkey + Claude Code ──");

    writeShellRc(targetFile, lines.join("\n"));
    ok(`Config written to ${targetFile}`);

    const reloadCmd = isPwsh ? `. ${targetFile}` : `source ${targetFile}`;
    console.log();
    console.log(`  ${c.bold}${c.cyan}▶ Run this command now:${c.reset}`);
    console.log();
    console.log(`    ${c.bold}${reloadCmd}${c.reset}`);
    console.log();
    console.log(`  ${c.dim}Or open a new terminal window.${c.reset}`);
    console.log();
  } else {
    // Write to settings.json
    const envPairs = {
      ANTHROPIC_BASE_URL: gateway,
      ANTHROPIC_AUTH_TOKEN: portkeyKey,
      ANTHROPIC_CUSTOM_HEADERS: resolvedHeaders,
    };
    if (setModelMappings) {
      envPairs.ANTHROPIC_DEFAULT_OPUS_MODEL = opusModel;
      envPairs.ANTHROPIC_DEFAULT_SONNET_MODEL = sonnetModel;
      envPairs.ANTHROPIC_DEFAULT_HAIKU_MODEL = haikuModel;
    }
    settingsSetEnv(targetFile, envPairs);
    if (model) settingsSetKey(targetFile, "model", model);
    ok(`Config written to ${targetFile}`);

    // Also write auth token to shell for Claude Code startup
    const shellRc = detectShellRc();
    const isFish = shellRc.endsWith("config.fish");
    const isPwsh = shellRc.endsWith(".ps1");
    const isNu = shellRc.endsWith(".nu");

    let exportLine;
    if (isFish) exportLine = `set -gx ANTHROPIC_AUTH_TOKEN "${portkeyKey}"`;
    else if (isPwsh) exportLine = `$env:ANTHROPIC_AUTH_TOKEN = "${portkeyKey}"`;
    else if (isNu) exportLine = `$env.ANTHROPIC_AUTH_TOKEN = "${portkeyKey}"`;
    else exportLine = `export ANTHROPIC_AUTH_TOKEN="${portkeyKey}"`;

    writeShellRc(shellRc, [
      `# ── Portkey + Claude Code (v${VERSION}) ──`,
      exportLine,
      "# ── End Portkey + Claude Code ──",
    ].join("\n"));

    const reloadCmd = isPwsh ? `. ${shellRc}` : `source ${shellRc}`;
    console.log();
    console.log(`  ${c.bold}${c.cyan}▶ Run this command now:${c.reset}`);
    console.log();
    console.log(`    ${c.bold}${reloadCmd}${c.reset}`);
    console.log();
    console.log(`  ${c.dim}Or open a new terminal window.${c.reset}`);
    console.log();
  }

  p.outro(`${c.green}Ready!${c.reset} ${c.dim}Dashboard: ${PORTKEY_DASHBOARD}/logs${c.reset}`);
}
