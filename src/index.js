#!/usr/bin/env node

import * as p from "@clack/prompts";
import { VERSION, PORTKEY_DASHBOARD, c } from "./utils.js";
import { doSetup } from "./commands/claude-code/setup.js";
import { doDiscover } from "./commands/claude-code/discover.js";
import { doVerify } from "./commands/claude-code/verify.js";
import { doUninstall } from "./commands/claude-code/uninstall.js";

// ── Arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    command: "",
    subcommand: "",
    portkeyKey: "",
    anthropicKey: "",
    provider: "",
    config: "",
    mode: "",
    location: "",
    model: "",
    opusModel: "",
    sonnetModel: "",
    haikuModel: "",
    gateway: "",
    yes: false,
    dryRun: false,
    skipInstall: false,
  };

  const raw = argv.slice(2);
  for (let i = 0; i < raw.length; i++) {
    const arg = raw[i];
    const next = () => raw[++i] || "";

    switch (arg) {
      // Top-level commands
      case "claude-code":
        args.command = "claude-code";
        break;

      // Subcommands (work with or without "claude-code" prefix)
      case "setup":
        args.subcommand = "setup";
        break;
      case "discover":
      case "diagnose":
        args.subcommand = "discover";
        break;
      case "verify":
        args.subcommand = "verify";
        break;
      case "uninstall":
        args.subcommand = "uninstall";
        break;

      // Legacy flag-style commands (backwards compat)
      case "--setup":
        args.command = "claude-code";
        args.subcommand = "setup";
        break;
      case "--discover":
      case "--diagnose":
        args.command = "claude-code";
        args.subcommand = "discover";
        break;
      case "--verify":
        args.command = "claude-code";
        args.subcommand = "verify";
        break;
      case "--uninstall":
        args.command = "claude-code";
        args.subcommand = "uninstall";
        break;

      case "--help":
      case "-h":
        args.command = "help";
        break;
      case "--version":
      case "-v":
        args.command = "version";
        break;

      // Options
      case "--portkey-key":
        args.portkeyKey = next();
        break;
      case "--anthropic-key":
        args.anthropicKey = next();
        break;
      case "--provider":
        args.provider = next();
        break;
      case "--config":
        args.config = next();
        break;
      case "--mode":
        args.mode = next();
        break;
      case "--location":
        args.location = next();
        break;
      case "--model":
        args.model = next();
        break;
      case "--opus-model":
        args.opusModel = next();
        break;
      case "--sonnet-model":
        args.sonnetModel = next();
        break;
      case "--haiku-model":
        args.haikuModel = next();
        break;
      case "--gateway":
        args.gateway = next();
        break;
      case "--yes":
      case "-y":
        args.yes = true;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--skip-install":
        args.skipInstall = true;
        break;
      case "--no-color":
        process.env.NO_COLOR = "1";
        break;

      default:
        console.error(`${c.red}✘${c.reset} Unknown option: ${arg}`);
        showHelp();
        process.exit(1);
    }
  }

  // If any option flags are passed without a command, infer claude-code setup
  if (
    !args.command &&
    !args.subcommand &&
    (args.portkeyKey || args.provider || args.config || args.mode || args.yes)
  ) {
    args.command = "claude-code";
    args.subcommand = "setup";
  }

  return args;
}

// ── Interactive command picker ───────────────────────────────────────────────

async function pickCommand() {
  p.intro(`${c.bold}Portkey CLI${c.reset} ${c.dim}v${VERSION}${c.reset}`);

  const command = await p.select({
    message: "Claude Code",
    options: [
      {
        value: "claude-code:setup",
        label: "Setup",
        hint: "configure routing through Portkey",
      },
      {
        value: "claude-code:discover",
        label: "Discover",
        hint: "audit where config is currently set",
      },
      {
        value: "claude-code:verify",
        label: "Verify",
        hint: "test gateway connectivity",
      },
      {
        value: "claude-code:uninstall",
        label: "Uninstall",
        hint: "remove Portkey config",
      },
    ],
  });

  if (p.isCancel(command)) {
    p.outro("Bye!");
    return null;
  }

  return command;
}

// ── Help ─────────────────────────────────────────────────────────────────────

function showHelp() {
  console.log(`
  ${c.bold}portkey${c.reset} ${c.dim}v${VERSION}${c.reset}
  The Portkey CLI — manage AI gateway integrations.

  ${c.bold}USAGE${c.reset}
    portkey                              ${c.dim}# interactive command picker${c.reset}
    portkey [command] [options]           ${c.dim}# run a command directly${c.reset}

  ${c.bold}COMMANDS${c.reset}  ${c.dim}(Claude Code)${c.reset}
    setup          Interactive setup wizard ${c.dim}(default)${c.reset}
    discover       Show where config is currently set
    verify         Test gateway connectivity
    uninstall      Remove Portkey config

  ${c.bold}OPTIONS${c.reset}
    --portkey-key K     Portkey API key
    --anthropic-key K   Anthropic API key
    --provider SLUG     Provider from Model Catalog (e.g. anthropic, bedrock-prod)
    --config ID         Portkey Config ID (e.g. pc-xxxxx)
    --mode MODE         ${c.dim}provider${c.reset} | ${c.dim}config${c.reset} | ${c.dim}oauth${c.reset}
    --location LOC      ${c.dim}project-local${c.reset} | ${c.dim}project-shared${c.reset} | ${c.dim}global${c.reset} | ${c.dim}env${c.reset}
    --model M           Default model: ${c.dim}opus${c.reset} | ${c.dim}sonnet${c.reset} | ${c.dim}haiku${c.reset} | ${c.dim}opusplan${c.reset} | full name
    --opus-model M      Full model name for opus alias (Bedrock/Vertex)
    --sonnet-model M    Full model name for sonnet alias
    --haiku-model M     Full model name for haiku alias
    --gateway URL       Private Portkey gateway URL
    --yes               Auto-confirm (CI mode)
    --dry-run           Preview without writing
    --skip-install      Don't install Claude Code
    --no-color          Plain output

  ${c.bold}EXAMPLES${c.reset}
    portkey                                        ${c.dim}# interactive${c.reset}
    portkey setup                                  ${c.dim}# setup wizard${c.reset}
    portkey setup --provider ant --yes             ${c.dim}# non-interactive${c.reset}
    portkey setup --config pc-xxxxx                ${c.dim}# config routing${c.reset}
    portkey discover                               ${c.dim}# audit config${c.reset}

  ${c.bold}DOCS${c.reset}  https://portkey.ai/docs    ${c.bold}DASHBOARD${c.reset}  ${PORTKEY_DASHBOARD}
`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);

  // Direct commands
  if (args.command === "help") return showHelp();
  if (args.command === "version")
    return console.log(`portkey v${VERSION}`);

  // Subcommand without prefix → infer claude-code (only product today)
  if (!args.command && args.subcommand) {
    args.command = "claude-code";
  }

  // If no command at all, show interactive picker
  if (!args.command && !args.subcommand) {
    const picked = await pickCommand();
    if (!picked) return;
    const [cmd, sub] = picked.split(":");
    args.command = cmd;
    args.subcommand = sub;
  }

  // Default subcommand for claude-code is setup
  if (args.command === "claude-code" && !args.subcommand) {
    args.subcommand = "setup";
  }

  // Route to command
  if (args.command === "claude-code") {
    switch (args.subcommand) {
      case "setup":
        return await doSetup(args);
      case "discover":
        return await doDiscover();
      case "verify":
        return await doVerify();
      case "uninstall":
        return await doUninstall(args);
      default:
        console.error(
          `${c.red}✘${c.reset} Unknown claude-code command: ${args.subcommand}`
        );
        showHelp();
        process.exit(1);
    }
  }
}

main().catch((e) => {
  console.error(`${c.red}✘${c.reset} ${e.message}`);
  process.exit(1);
});
