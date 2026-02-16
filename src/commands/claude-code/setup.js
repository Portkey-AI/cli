import * as p from "@clack/prompts";
import { execSync } from "node:child_process";
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
  p.intro(`${c.bold}Portkey + Claude Code${c.reset} ${c.dim}v${VERSION}${c.reset}`);

  // ── Discover existing config ───────────────────────────────────────────
  const existing = readExistingConfig();
  if (existing.found && !args.yes) {
    p.note(
      [
        `${c.bold}File${c.reset}      ${existing.filePath}`,
        `${c.bold}Mode${c.reset}      ${existing.mode || "unknown"}`,
        existing.provider ? `${c.bold}Provider${c.reset}  @${existing.provider}` : null,
        existing.configId ? `${c.bold}Config${c.reset}    ${existing.configId}` : null,
        existing.model ? `${c.bold}Model${c.reset}     ${existing.model}` : null,
        existing.gateway !== PORTKEY_GATEWAY
          ? `${c.bold}Gateway${c.reset}   ${existing.gateway}`
          : null,
      ]
        .filter(Boolean)
        .join("\n"),
      "Existing config found"
    );
  }

  // ── Step 0: Install Claude Code ──────────────────────────────────────────
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
        execSync("npm install -g @anthropic-ai/claude-code", {
          stdio: "ignore",
        });
        s.stop("Claude Code installed");
      } catch {
        s.stop("Install failed");
        warn("Install manually: npm install -g @anthropic-ai/claude-code");
      }
    }
  }

  // ── Step 1: Portkey API key ──────────────────────────────────────────────
  // Priority: CLI flag > env var > existing config > prompt
  let portkeyKey =
    args.portkeyKey ||
    process.env.PORTKEY_API_KEY ||
    (existing.found ? existing.portkeyKey : "") ||
    "";

  if (portkeyKey && !args.portkeyKey) {
    // We have a key from env or config — let user keep or change it
    if (!args.yes) {
      const keepKey = await p.confirm({
        message: `Use existing API key (${mask(portkeyKey)})?`,
        initialValue: true,
      });
      if (p.isCancel(keepKey)) return p.outro("Setup cancelled.");
      if (!keepKey) {
        portkeyKey = await p.text({
          message: `New Portkey API key ${c.dim}(${PORTKEY_DASHBOARD}/api-keys)${c.reset}`,
          placeholder: "paste your key",
          validate: (v) => (!v ? "API key is required" : undefined),
        });
        if (p.isCancel(portkeyKey)) return p.outro("Setup cancelled.");
      }
    } else {
      ok(`Using existing API key (${mask(portkeyKey)})`);
    }
  } else if (!portkeyKey) {
    portkeyKey = await p.text({
      message: `Portkey API key ${c.dim}(${PORTKEY_DASHBOARD}/api-keys)${c.reset}`,
      placeholder: "paste your key",
      validate: (v) => (!v ? "API key is required" : undefined),
    });
    if (p.isCancel(portkeyKey)) return p.outro("Setup cancelled.");
  } else {
    ok(`Using Portkey API key (${mask(portkeyKey)})`);
  }

  // ── Step 1b: Gateway URL ───────────────────────────────────────────────
  let gateway =
    args.gateway ||
    (existing.found && existing.gateway !== PORTKEY_GATEWAY
      ? existing.gateway
      : "") ||
    PORTKEY_GATEWAY;

  if (!args.gateway && !args.yes && gateway === PORTKEY_GATEWAY) {
    const customGw = await p.confirm({
      message: "Using a private Portkey gateway?",
      initialValue: false,
    });
    if (p.isCancel(customGw)) return p.outro("Setup cancelled.");
    if (customGw) {
      gateway = await p.text({
        message: "Gateway URL",
        placeholder: "https://your-gateway.example.com",
        initialValue: PORTKEY_GATEWAY,
        validate: (v) => {
          if (!v) return "URL is required";
          if (v.endsWith("/v1"))
            return "Remove the /v1 suffix — Claude Code adds it automatically";
          if (!v.startsWith("http"))
            return "URL must start with http:// or https://";
          return undefined;
        },
      });
      if (p.isCancel(gateway)) return p.outro("Setup cancelled.");
    }
  } else if (gateway !== PORTKEY_GATEWAY) {
    ok(`Using gateway: ${gateway}`);
  }

  // ── Step 2: Routing mode ─────────────────────────────────────────────────
  let mode = args.mode || "";
  if (!mode && args.config) mode = "config";
  if (!mode && args.provider) mode = "provider";
  if (!mode && args.yes) mode = existing.found ? existing.mode || "provider" : "provider";

  if (!mode) {
    mode = await p.select({
      message: "How should Portkey route requests?",
      initialValue: existing.found ? existing.mode : "provider",
      options: [
        {
          value: "provider",
          label: "Provider routing",
          hint: "route via a provider in your Model Catalog",
        },
        {
          value: "config",
          label: "Config routing",
          hint: "use a Portkey Config for fallbacks, load balancing, etc.",
        },
        {
          value: "oauth",
          label: "OAuth passthrough",
          hint: "keep your Anthropic key, Portkey logs only",
        },
      ],
    });
    if (p.isCancel(mode)) return p.outro("Setup cancelled.");
  }

  // ── Step 3: Provider / Config selection ──────────────────────────────────
  let providerSlug = "";
  let providerType = "";
  let configId = "";
  let extraHeaders = "";

  if (mode === "provider") {
    if (args.provider) {
      providerSlug = args.provider;
    } else if (args.yes && existing.found && existing.provider) {
      // Auto-select existing provider in --yes mode
      providerSlug = existing.provider;
      ok(`Using existing provider: @${providerSlug}`);
    } else {
      const s = p.spinner();
      s.start("Fetching providers from your Portkey account...");
      const { data: providers, error: provErr } = await fetchProviders(portkeyKey, gateway);
      if (provErr) {
        s.stop(`Could not fetch providers: ${provErr}`);
      } else {
        s.stop(
          `Found ${providers.length} provider${providers.length !== 1 ? "s" : ""}`
        );
      }

      if (providers && providers.length > 0) {
        // Pre-select existing provider if re-running
        const existingProv = existing.found ? existing.provider : "";
        providerSlug = await p.select({
          message: "Select a provider",
          initialValue: existingProv || undefined,
          options: providers.map((prov) => ({
            value: prov.slug,
            label: `@${prov.slug}`,
            hint: [prov.name, prov.provider, prov.workspace]
              .filter(Boolean)
              .join(" · "),
          })),
        });
        if (p.isCancel(providerSlug)) return p.outro("Setup cancelled.");

        const selected = providers.find((pv) => pv.slug === providerSlug);
        if (selected) providerType = (selected.provider || "").toLowerCase();
      } else {
        providerSlug = await p.text({
          message: "Enter provider slug",
          placeholder: "e.g. anthropic, bedrock-prod",
          defaultValue: existing.found ? existing.provider || "" : "",
          validate: (v) => (!v ? "Provider slug is required" : undefined),
        });
        if (p.isCancel(providerSlug)) return p.outro("Setup cancelled.");
      }
    }
    providerSlug = normalizeProvider(providerSlug).slice(1);
    extraHeaders = `x-portkey-provider:@${providerSlug}`;

    // If we don't know the provider type (manual entry), ask the user
    if (!providerType && !args.yes) {
      const isBV = await p.confirm({
        message: "Is this a Bedrock or Vertex AI provider?",
        initialValue: false,
      });
      if (p.isCancel(isBV)) return p.outro("Setup cancelled.");
      if (isBV) providerType = "bedrock"; // Treat as Bedrock for model mapping purposes
    }

    // Start fetching models in the background while user continues
    var modelsPromise = fetchModels(portkeyKey, providerSlug, gateway);
  } else if (mode === "config") {
    configId = args.config || "";
    if (!configId && args.yes && existing.found && existing.configId) {
      configId = existing.configId;
      ok(`Using existing config: ${configId}`);
    }
    if (!configId) {
      const s = p.spinner();
      s.start("Fetching configs from your Portkey account...");
      const { data: configs, error: cfgErr } = await fetchConfigs(portkeyKey, gateway);
      if (cfgErr) {
        s.stop(`Could not fetch configs: ${cfgErr}`);
      } else {
        s.stop(
          `Found ${configs.length} config${configs.length !== 1 ? "s" : ""}`
        );
      }

      if (configs && configs.length > 0) {
        const existingCfg = existing.found ? existing.configId : "";
        configId = await p.select({
          message: "Select a config",
          initialValue: existingCfg || undefined,
          options: [
            ...configs.map((cfg) => ({
              value: cfg.id,
              label: cfg.name || cfg.id,
              hint: [cfg.id, cfg.isDefault ? "default" : ""]
                .filter(Boolean)
                .join(" · "),
            })),
            {
              value: "__manual__",
              label: "Enter config ID manually",
              hint: "paste a config ID",
            },
          ],
        });
        if (p.isCancel(configId)) return p.outro("Setup cancelled.");
      }

      if (!configId || configId === "__manual__") {
        configId = await p.text({
          message: "Portkey Config ID",
          placeholder: "pc-xxxxx",
          defaultValue: existing.found ? existing.configId || "" : "",
          validate: (v) => (!v ? "Config ID is required" : undefined),
        });
        if (p.isCancel(configId)) return p.outro("Setup cancelled.");
      }
    }
    extraHeaders = `x-portkey-config:${configId}`;
  }

  // ── Step 4: Anthropic API key (OAuth only) ──────────────────────────────
  if (mode === "oauth") {
    let anthropicKey =
      args.anthropicKey || process.env.ANTHROPIC_API_KEY || "";
    if (!anthropicKey && !args.yes) {
      anthropicKey = await p.password({
        message: "Anthropic API key",
        validate: (v) =>
          !v ? "OAuth mode requires your Anthropic API key" : undefined,
      });
      if (p.isCancel(anthropicKey)) return p.outro("Setup cancelled.");
    }
    if (!anthropicKey) {
      err("OAuth mode requires an Anthropic API key (--anthropic-key).");
      return;
    }
    const configJson = JSON.stringify({
      forward_headers: ["authorization", "anthropic-beta"],
    });
    const configB64 = Buffer.from(configJson).toString("base64");
    extraHeaders = `x-portkey-api-key:${portkeyKey}\nx-portkey-config:${configB64}`;
  }

  // ── Step 5: Where to save ───────────────────────────────────────────────
  const projectRoot = findProjectRoot();
  let location = args.location || "";

  if (!location && args.yes)
    location = existing.found ? existing.location : "env";
  if (!location) {
    const shellRc = detectShellRc();
    const options = [
      {
        value: "env",
        label: "Shell environment",
        hint: `${shellRc} (recommended)`,
      },
    ];
    if (projectRoot) {
      options.push(
        {
          value: "project-local",
          label: "This project, private",
          hint: ".claude/settings.local.json (gitignored)",
        },
        {
          value: "project-shared",
          label: "This project, shared",
          hint: ".claude/settings.json (committed)",
        }
      );
    }
    options.push({
      value: "global",
      label: "All my projects",
      hint: "~/.claude/settings.json",
    });

    // Pre-select existing location, or env by default
    const defaultLoc = existing.found ? existing.location : "env";

    location = await p.select({
      message: "Where should we save the config?",
      initialValue: defaultLoc,
      options,
    });
    if (p.isCancel(location)) return p.outro("Setup cancelled.");
  }

  // Validate project-level choices
  let resolvedProjectRoot = projectRoot;
  if (location.startsWith("project") && !resolvedProjectRoot) {
    warn("No project root found (no .claude/ or .git/ above cwd)");
    const useCwd = await p.confirm({
      message: `Use current directory (${process.cwd()}) as project root?`,
    });
    if (p.isCancel(useCwd)) return p.outro("Setup cancelled.");
    if (useCwd) {
      resolvedProjectRoot = process.cwd();
    } else {
      info("Falling back to global config.");
      location = "global";
    }
  }

  // ── Step 6: Advanced settings (from flags) ─────────────────────────────
  let model = args.model || "";
  let opusModel = args.opusModel || "";
  let sonnetModel = args.sonnetModel || "";
  let haikuModel = args.haikuModel || "";
  let setModelMappings = !!(opusModel || sonnetModel || haikuModel);
  const isBedrock = BEDROCK_VERTEX_TYPES.has(providerType);

  // Pre-fill model from existing config
  if (!model && existing.found && existing.model) {
    model = existing.model;
  }

  // Bedrock/Vertex with flags: apply mappings directly
  if (isBedrock && setModelMappings) {
    opusModel = opusModel || "claude-opus-4-20250514";
    sonnetModel = sonnetModel || "claude-sonnet-4-20250514";
    haikuModel = haikuModel || "claude-haiku-4-20250514";
  }

  // ── Step 7: Summary + Write or Advanced ──────────────────────────────────
  const buildSummary = () =>
    [
      `${c.bold}Mode${c.reset}      ${mode}`,
      mode === "provider" ? `${c.bold}Provider${c.reset}  @${providerSlug}` : null,
      mode === "config" ? `${c.bold}Config${c.reset}    ${configId}` : null,
      model ? `${c.bold}Model${c.reset}     ${model}` : null,
      setModelMappings
        ? `${c.bold}Mappings${c.reset}  opus=${opusModel} sonnet=${sonnetModel} haiku=${haikuModel}`
        : null,
      `${c.bold}Gateway${c.reset}   ${gateway}`,
      `${c.bold}Location${c.reset}  ${targetFile}`,
    ]
      .filter(Boolean)
      .join("\n");

  const targetFile = getSettingsPath(location, resolvedProjectRoot);
  const resolvedHeaders = extraHeaders.replace(
    /\$\{PORTKEY_API_KEY\}/g,
    portkeyKey
  );

  // Show summary
  p.note(buildSummary(), "Configuration");

  // Decide: write now, advanced settings, or cancel
  let ready = false;
  if (args.dryRun) {
    dim("[dry-run] Would write to " + targetFile);
    ready = false; // skip write
  } else if (args.yes) {
    // For Bedrock/Vertex in --yes mode, auto-apply model mappings if not set
    if (isBedrock && !setModelMappings) {
      setModelMappings = true;
      // Resolve models from background fetch to get actual model names
      if (typeof modelsPromise !== "undefined") {
        const { data: fetchedModels } = await modelsPromise;
        if (fetchedModels && fetchedModels.length > 0) {
          // Auto-select first model of each tier
          opusModel = fetchedModels.find((m) => m.id.toLowerCase().includes("opus"))?.id || opusModel;
          sonnetModel = fetchedModels.find((m) => m.id.toLowerCase().includes("sonnet"))?.id || sonnetModel;
          haikuModel = fetchedModels.find((m) => m.id.toLowerCase().includes("haiku"))?.id || haikuModel;
        }
      }
      opusModel = opusModel || "claude-opus-4-20250514";
      sonnetModel = sonnetModel || "claude-sonnet-4-20250514";
      haikuModel = haikuModel || "claude-haiku-4-20250514";
      ok(`Auto-selected model mappings for ${providerType}`);
    }
    ready = true;
  } else {
    // For Bedrock/Vertex, force model selection before allowing write
    let forcedAdvanced = false;
    if (isBedrock && !setModelMappings && !model) {
      warn("Bedrock/Vertex requires model configuration to work with Claude Code.");
      forcedAdvanced = true;
    }

    // Loop: user can go into advanced, come back, and write
    while (!ready) {
      const hasAdvancedContent = model || setModelMappings;
      
      // For Bedrock/Vertex without model config, don't show "Write config" option
      const canWrite = !isBedrock || setModelMappings || model;
      
      const options = [];
      if (canWrite) {
        options.push({
          value: "write",
          label: "Write config",
          hint: "save and finish",
        });
      }
      options.push(
        {
          value: "advanced",
          label: canWrite ? "Advanced settings" : "Configure model (required)",
          hint: canWrite
            ? ["model", "model mappings"].join(", ")
            : "Bedrock/Vertex needs model names",
        },
        { value: "cancel", label: "Cancel" }
      );

      const action = forcedAdvanced
        ? "advanced"
        : await p.select({ message: "Next step", options });
      
      forcedAdvanced = false; // Only auto-advance once
      
      if (p.isCancel(action) || action === "cancel")
        return p.outro("Setup cancelled.");

      if (action === "write") {
        ready = true;
      } else if (action === "advanced") {
        // ── Advanced: model ─────────────────────────────────────────
        // Resolve models from background fetch (if provider mode)
        let availableModels = [];
        if (typeof modelsPromise !== "undefined") {
          const s = p.spinner();
          s.start("Loading models...");
          const { data: fetchedModels, error: modelsErr } =
            await modelsPromise;
          if (fetchedModels && fetchedModels.length > 0) {
            availableModels = fetchedModels;
            s.stop(`Found ${availableModels.length} Claude models`);
          } else {
            s.stop(modelsErr ? `Could not load models: ${modelsErr}` : "No models found");
          }
          // Reset so we don't await again on loop
          modelsPromise = Promise.resolve({ data: availableModels, error: null });
        }

        if (availableModels.length > 0) {
          // Build select options: aliases first, then available models
          const modelOptions = [
            { value: "", label: "Skip", hint: "no default model" },
            { value: "opus", label: "opus", hint: "latest Opus" },
            { value: "sonnet", label: "sonnet", hint: "latest Sonnet" },
            { value: "haiku", label: "haiku", hint: "latest Haiku" },
            { value: "opusplan", label: "opusplan", hint: "Opus plans, Sonnet executes" },
            ...availableModels.map((m) => ({
              value: m.id,
              label: m.id,
              hint: m.canonicalSlug !== m.id ? m.canonicalSlug : undefined,
            })),
          ];
          model = await p.select({
            message: "Default model",
            initialValue: model || (existing.found ? existing.model || "" : ""),
            options: modelOptions,
          });
          if (p.isCancel(model)) return p.outro("Setup cancelled.");
        } else {
          model = await p.text({
            message: "Default model",
            placeholder: "opus | sonnet | haiku | opusplan (Enter to skip)",
            defaultValue: model || (existing.found ? existing.model || "" : ""),
          });
          if (p.isCancel(model)) return p.outro("Setup cancelled.");
        }

        // ── Advanced: model mappings ────────────────────────────────
        setModelMappings = true;

        // Auto-detect best defaults from available models
        const findModel = (tier) =>
          availableModels.find((m) => m.id.toLowerCase().includes(tier))?.id || "";
        const defaultOpus = opusModel || findModel("opus") || "claude-opus-4-20250514";
        const defaultSonnet = sonnetModel || findModel("sonnet") || "claude-sonnet-4-20250514";
        const defaultHaiku = haikuModel || findModel("haiku") || "claude-haiku-4-20250514";

        // If we have models, let user pick from list; otherwise text input
        if (availableModels.length > 0) {
          // Sort models with the relevant tier on top
          const sortedForTier = (tier) =>
            [...availableModels].sort((a, b) => {
              const aMatch = a.id.toLowerCase().includes(tier);
              const bMatch = b.id.toLowerCase().includes(tier);
              if (aMatch && !bMatch) return -1;
              if (!aMatch && bMatch) return 1;
              return 0;
            }).map((m) => ({ value: m.id, label: m.id }));

          opusModel = await p.select({
            message: "Opus model name",
            initialValue: defaultOpus,
            options: sortedForTier("opus"),
          });
          if (p.isCancel(opusModel)) return p.outro("Setup cancelled.");

          sonnetModel = await p.select({
            message: "Sonnet model name",
            initialValue: defaultSonnet,
            options: sortedForTier("sonnet"),
          });
          if (p.isCancel(sonnetModel)) return p.outro("Setup cancelled.");

          haikuModel = await p.select({
            message: "Haiku model name",
            initialValue: defaultHaiku,
            options: sortedForTier("haiku"),
          });
          if (p.isCancel(haikuModel)) return p.outro("Setup cancelled.");
        } else {
          const mappings = await p.group({
            opus: () =>
              p.text({
                message: "Opus model name",
                placeholder: "claude-opus-4-20250514",
                defaultValue: defaultOpus,
              }),
            sonnet: () =>
              p.text({
                message: "Sonnet model name",
                placeholder: "claude-sonnet-4-20250514",
                defaultValue: defaultSonnet,
              }),
            haiku: () =>
              p.text({
                message: "Haiku model name",
                placeholder: "claude-haiku-4-20250514",
                defaultValue: defaultHaiku,
              }),
          });
          if (p.isCancel(mappings)) return p.outro("Setup cancelled.");
          opusModel = mappings.opus;
          sonnetModel = mappings.sonnet;
          haikuModel = mappings.haiku;
        }

        opusModel = opusModel || "claude-opus-4-20250514";
        sonnetModel = sonnetModel || "claude-sonnet-4-20250514";
        haikuModel = haikuModel || "claude-haiku-4-20250514";

        // Show updated summary and loop back
        p.note(buildSummary(), "Updated configuration");
      }
    }
  }

  if (!args.dryRun && ready) {

    if (location === "env") {
      const envVars = {
        PORTKEY_API_KEY: portkeyKey,
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
      ok(`Written to ${targetFile}`);

      let reloadHint;
      if (isFish) {
        reloadHint = `source ${targetFile}`;
      } else if (isPwsh) {
        reloadHint = `. ${targetFile}`;
      } else {
        reloadHint = `source ${targetFile}`;
      }
      p.note(
        `Run this in your terminal, or open a new terminal:\n\n  ${reloadHint}`,
        "Next step"
      );
    } else {
      // Write config to settings.json
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
      ok(`Updated ${targetFile}`);

      // Also write ANTHROPIC_AUTH_TOKEN to shell RC so Claude Code
      // skips the OAuth login gate (it checks env before reading settings.json)
      const shellRc = detectShellRc();
      const isFish = shellRc.endsWith("config.fish");
      const isPwsh = shellRc.endsWith(".ps1");
      const isNu = shellRc.endsWith(".nu");

      let exportLine;
      if (isFish) {
        exportLine = `set -gx ANTHROPIC_AUTH_TOKEN "${portkeyKey}"`;
      } else if (isPwsh) {
        exportLine = `$env:ANTHROPIC_AUTH_TOKEN = "${portkeyKey}"`;
      } else if (isNu) {
        exportLine = `$env.ANTHROPIC_AUTH_TOKEN = "${portkeyKey}"`;
      } else {
        exportLine = `export ANTHROPIC_AUTH_TOKEN="${portkeyKey}"`;
      }

      const shellBlock = [
        `# ── Portkey + Claude Code (v${VERSION}) ──`,
        exportLine,
        "# ── End Portkey + Claude Code ──",
      ].join("\n");

      writeShellRc(shellRc, shellBlock);
      ok(`Also added ANTHROPIC_AUTH_TOKEN to ${shellRc}`);

      let reloadHint;
      if (isPwsh) {
        reloadHint = `. ${shellRc}`;
      } else {
        reloadHint = `source ${shellRc}`;
      }
      p.note(
        `Open a new terminal, or run:\n\n  ${reloadHint}`,
        "Next step"
      );
    }
  }

  p.outro(
    `${c.dim}Dashboard: ${PORTKEY_DASHBOARD}/logs${c.reset}`
  );
}
