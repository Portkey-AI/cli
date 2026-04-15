#!/usr/bin/env node

import * as p from "@clack/prompts";
import { VERSION, PORTKEY_DASHBOARD, c } from "./utils.js";
import { doSetup }        from "./commands/claude-code/setup.js";
import { doDiscover }     from "./commands/claude-code/discover.js";
import { doVerify }       from "./commands/claude-code/verify.js";
import { doUninstall }    from "./commands/claude-code/uninstall.js";
import { doStatus }       from "./commands/claude-code/status.js";
import { doMcpAdd, doMcpList, doMcpRemove } from "./commands/claude-code/mcp.js";
import { doSkillsSync, doSkillsList }        from "./commands/claude-code/skills.js";

// ── Arg parsing ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    command:     "",
    subcommand:  "",
    // gateway
    portkeyKey:  "",
    anthropicKey:"",
    provider:    "",
    config:      "",
    mode:        "",
    location:    "",
    model:       "",
    opusModel:   "",
    sonnetModel: "",
    haikuModel:  "",
    gateway:     "",
    // setup behaviour
    skipInstall: false,
    skipMcp:     false,
    skipSkills:  false,
    advanced:    false,
    // skills
    agent:       "",
    global:      false,
    // shared
    yes:         false,
    dryRun:      false,
    verifyMcp:   false,
  };

  const raw = argv.slice(2);
  for (let i = 0; i < raw.length; i++) {
    const arg  = raw[i];
    const next = () => raw[++i] || "";

    switch (arg) {
      // Top-level namespaces
      case "claude-code": args.command = "claude-code"; break;

      // Subcommands (work with or without "claude-code" prefix)
      case "setup":     args.subcommand = "setup";    break;
      case "discover":
      case "diagnose":  args.subcommand = "discover"; break;
      case "verify":    args.subcommand = "verify";   break;
      case "uninstall": args.subcommand = "uninstall";break;
      case "status":    args.subcommand = "status";    break;

      // MCP subcommands
      case "mcp":
        args.command = "mcp";
        break;
      case "add":
        if (args.command === "mcp") args.subcommand = "add";
        break;
      case "list":
        if (args.command === "mcp" || args.command === "skills") args.subcommand = "list";
        break;
      case "remove":
      case "rm":
        if (args.command === "mcp") args.subcommand = "remove";
        break;

      // Skills subcommands
      case "skills":
        args.command = "skills";
        break;
      case "sync":
        if (args.command === "skills") args.subcommand = "sync";
        break;

      // Legacy flag-style commands (backwards compat from v1)
      case "--setup":    args.command = "claude-code"; args.subcommand = "setup";    break;
      case "--discover":
      case "--diagnose": args.command = "claude-code"; args.subcommand = "discover"; break;
      case "--verify":   args.command = "claude-code"; args.subcommand = "verify";   break;
      case "--uninstall":args.command = "claude-code"; args.subcommand = "uninstall";break;

      case "--help": case "-h":    args.command = "help";    break;
      case "--version": case "-v": args.command = "version"; break;

      // Gateway options
      case "--portkey-key":   args.portkeyKey  = next(); break;
      case "--anthropic-key": args.anthropicKey = next(); break;
      case "--provider":      args.provider     = next(); break;
      case "--config":        args.config       = next(); break;
      case "--mode":          args.mode         = next(); break;
      case "--location":      args.location     = next(); break;
      case "--model":         args.model        = next(); break;
      case "--opus-model":    args.opusModel    = next(); break;
      case "--sonnet-model":  args.sonnetModel  = next(); break;
      case "--haiku-model":   args.haikuModel   = next(); break;
      case "--gateway":       args.gateway      = next(); break;
      case "--codex-wire-api":
        args.codexWireApi = next();
        break;

      // Behaviour flags
      case "--skip-install":  args.skipInstall = true; break;
      case "--skip-mcp":      args.skipMcp     = true; break;
      case "--skip-skills":   args.skipSkills  = true; break;
      case "--advanced":      args.advanced    = true; break;

      // Skills flags
      case "--agent":  args.agent  = next(); break;
      case "--global": args.global = true;   break;

      // Shared
      case "--yes": case "-y":   args.yes    = true; break;
      case "--dry-run":          args.dryRun = true; break;
      case "--probe-mcp":        args.verifyMcp = true; break; // only meaningful for `verify`
      case "--no-color":         process.env.NO_COLOR = "1"; break;

      default:
        console.error(`${c.red}✘${c.reset} Unknown option: ${arg}`);
        showHelp();
        process.exit(1);
    }
  }

  // Infer claude-code setup from option flags alone (backwards compat)
  if (
    !args.command && !args.subcommand &&
    (args.portkeyKey || args.provider || args.config || args.mode || args.yes)
  ) {
    args.command    = "claude-code";
    args.subcommand = "setup";
  }

  return args;
}

// ── Interactive top-level picker ──────────────────────────────────────────────

async function pickCommand() {
  p.intro(
    `${c.bold}Portkey CLI${c.reset} ${c.dim}v${VERSION}${c.reset}\n` +
    `  ${c.dim}One command. Your AI coding agent, fully configured.${c.reset}`
  );

  const command = await p.select({
    message: "What would you like to do?",
    options: [
      {
        value: "claude",
        label: "Setup Claude Code",
        hint:  "gateway routing + MCP servers + team skills",
      },
      {
        value: "codex",
        label: "Setup Codex",
        hint:  "OpenAI Codex — config.toml + Portkey gateway",
      },
    ],
  });

  if (p.isCancel(command)) { p.outro("Bye!"); return null; }
  return command;
}

// ── Help ──────────────────────────────────────────────────────────────────────

function showHelp() {
  console.log(`
  ${c.bold}portkey${c.reset} ${c.dim}v${VERSION}${c.reset}
  The Portkey CLI — one command to set up your AI coding agent.

  ${c.bold}USAGE${c.reset}
    portkey                          ${c.dim}# interactive menu${c.reset}
    portkey [command] [subcommand]   ${c.dim}# run directly${c.reset}

  ${c.bold}SETUP${c.reset}
    setup                    Interactive wizard: gateway + MCP + skills
    status                   Claude + Codex summary (routing, MCP counts)
    discover                 Audit all config locations
    verify                   Test gateway connectivity  ${c.dim}(add --probe-mcp for MCP URLs)${c.reset}
    uninstall                Remove all Portkey config

  ${c.bold}MCP${c.reset}
    mcp add                  Add MCP (pick Claude Code or Codex; or --agent claude|codex)
    mcp list                 Claude (.claude.json / .mcp.json) + Codex (config.toml)
    mcp remove               Remove MCP servers (Claude scopes only)

  ${c.bold}SKILLS${c.reset}
    skills sync              Pull Prompt Partials from Portkey → local SKILL.md trees
    skills list              Show available skills in workspace

  ${c.bold}SETUP OPTIONS${c.reset}
    --portkey-key KEY        Portkey API key
    --provider SLUG          Provider from Model Catalog (e.g. ant)
    --config ID              Portkey Config ID (e.g. pc-xxxxx)
    --gateway URL            Custom gateway URL
    --location LOC           env | global | project-local | project-shared
    --model M                Default model alias
    --opus-model M           ANTHROPIC_DEFAULT_OPUS_MODEL (alias target)
    --sonnet-model M         ANTHROPIC_DEFAULT_SONNET_MODEL (alias target)
    --haiku-model M          ANTHROPIC_DEFAULT_HAIKU_MODEL (alias target)
    --skip-install           Don't install Claude Code if missing
    --skip-mcp               Skip MCP setup step
    --skip-skills            Skip skills sync step
    --advanced               Show all options (model, location, custom gateway)
    --codex-wire-api MODE    Codex only: chat | responses (OpenAI protocol to Portkey)

  ${c.bold}SKILLS OPTIONS${c.reset}
    --agent NAME             Target agent: claude | cursor | codex | all
    --global                 Write to global user directories (~/...)

  ${c.bold}MCP ADD OPTIONS${c.reset}
    --agent claude|codex     Skip harness prompt (${c.dim}--yes defaults to claude${c.reset})
    --location               Claude: local|project|user  Codex: project|global

  ${c.bold}SHARED OPTIONS${c.reset}
    --yes, -y                Non-interactive: setup adds all MCP + syncs all skills
                             ${c.dim}(use --skip-mcp / --skip-skills to limit)${c.reset}
    --dry-run                Preview without writing
    --no-color               Plain output
    --version, -v            Print version
    --help, -h               Show this help

  ${c.bold}EXAMPLES${c.reset}
    portkey                                ${c.dim}# interactive menu${c.reset}
    portkey setup                          ${c.dim}# full setup wizard${c.reset}
    portkey setup --provider ant --yes     ${c.dim}# non-interactive${c.reset}
    portkey mcp add                        ${c.dim}# add MCP servers${c.reset}
    portkey skills sync                    ${c.dim}# sync team skills${c.reset}
    portkey skills sync --agent cursor     ${c.dim}# sync to Cursor only${c.reset}
    portkey skills sync --yes --global     ${c.dim}# CI / global install${c.reset}
    portkey status                         ${c.dim}# quick health summary${c.reset}
    portkey discover                       ${c.dim}# full config audit${c.reset}
    portkey verify --probe-mcp             ${c.dim}# test MCP initialize vs Portkey${c.reset}
    portkey setup --yes --skip-mcp         ${c.dim}# CI: gateway only${c.reset}

  ${c.bold}DOCS${c.reset}   https://portkey.ai/docs
  ${c.bold}DASH${c.reset}   ${PORTKEY_DASHBOARD}
`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);

  // Direct meta commands
  if (args.command === "help")    return showHelp();
  if (args.command === "version") return console.log(`portkey v${VERSION}`);

  // Subcommand without namespace → infer claude-code
  if (!args.command && args.subcommand) args.command = "claude-code";

  // No command at all → interactive picker (Claude Code vs Codex setup)
  if (!args.command && !args.subcommand) {
    const picked = await pickCommand();
    if (!picked) return;
    args.command    = "claude-code";
    args.subcommand = "setup";
    args.agent      = picked;
  }

  // Default subcommands
  if (args.command === "claude-code" && !args.subcommand) args.subcommand = "setup";
  if (args.command === "mcp"         && !args.subcommand) args.subcommand = "add";
  if (args.command === "skills"      && !args.subcommand) args.subcommand = "sync";

  // Route
  switch (args.command) {
    case "claude-code":
      switch (args.subcommand) {
        case "setup":     return await doSetup(args);
        case "discover":  return await doDiscover();
        case "status":    return await doStatus();
        case "verify":    return await doVerify(args);
        case "uninstall": return await doUninstall(args);
        default:
          console.error(`${c.red}✘${c.reset} Unknown claude-code command: ${args.subcommand}`);
          showHelp(); process.exit(1);
      }
      break;

    case "mcp":
      switch (args.subcommand) {
        case "add":    return await doMcpAdd(args);
        case "list":   return await doMcpList();
        case "remove": return await doMcpRemove(args);
        default:
          console.error(`${c.red}✘${c.reset} Unknown mcp command: ${args.subcommand}`);
          showHelp(); process.exit(1);
      }
      break;

    case "skills":
      switch (args.subcommand) {
        case "sync": return await doSkillsSync(args);
        case "list": return await doSkillsList(args);
        default:
          console.error(`${c.red}✘${c.reset} Unknown skills command: ${args.subcommand}`);
          showHelp(); process.exit(1);
      }
      break;

    default:
      console.error(`${c.red}✘${c.reset} Unknown command: ${args.command}`);
      showHelp();
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(`${c.red}✘${c.reset} ${e.message}`);
  process.exit(1);
});
