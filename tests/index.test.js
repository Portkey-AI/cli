import { describe, it, expect } from "vitest";
import { parseArgs } from "../src/index.js";

function parse(...args) {
  return parseArgs(["node", "portkey", ...args]);
}

describe("parseArgs", () => {
  it("defaults to empty command and subcommand", () => {
    const a = parse();
    expect(a.command).toBe("");
    expect(a.subcommand).toBe("");
  });

  it("parses setup subcommand", () => {
    const a = parse("setup");
    expect(a.subcommand).toBe("setup");
  });

  it("parses mcp add", () => {
    const a = parse("mcp", "add");
    expect(a.command).toBe("mcp");
    expect(a.subcommand).toBe("add");
  });

  it("parses mcp list", () => {
    const a = parse("mcp", "list");
    expect(a.command).toBe("mcp");
    expect(a.subcommand).toBe("list");
  });

  it("parses mcp remove", () => {
    const a = parse("mcp", "remove");
    expect(a.command).toBe("mcp");
    expect(a.subcommand).toBe("remove");
  });

  it("parses mcp rm as remove", () => {
    const a = parse("mcp", "rm");
    expect(a.command).toBe("mcp");
    expect(a.subcommand).toBe("remove");
  });

  it("parses skills sync", () => {
    const a = parse("skills", "sync");
    expect(a.command).toBe("skills");
    expect(a.subcommand).toBe("sync");
  });

  it("parses skills list", () => {
    const a = parse("skills", "list");
    expect(a.command).toBe("skills");
    expect(a.subcommand).toBe("list");
  });

  it("parses discover", () => {
    const a = parse("discover");
    expect(a.subcommand).toBe("discover");
  });

  it("parses diagnose as discover", () => {
    const a = parse("diagnose");
    expect(a.subcommand).toBe("discover");
  });

  it("parses verify", () => {
    const a = parse("verify");
    expect(a.subcommand).toBe("verify");
  });

  it("parses uninstall", () => {
    const a = parse("uninstall");
    expect(a.subcommand).toBe("uninstall");
  });

  it("parses status", () => {
    const a = parse("status");
    expect(a.subcommand).toBe("status");
  });

  it("parses --help", () => {
    const a = parse("--help");
    expect(a.command).toBe("help");
  });

  it("parses -h", () => {
    const a = parse("-h");
    expect(a.command).toBe("help");
  });

  it("parses --version", () => {
    const a = parse("--version");
    expect(a.command).toBe("version");
  });

  it("parses -v", () => {
    const a = parse("-v");
    expect(a.command).toBe("version");
  });

  it("parses --yes / -y", () => {
    expect(parse("--yes").yes).toBe(true);
    expect(parse("-y").yes).toBe(true);
  });

  it("parses --dry-run", () => {
    expect(parse("--dry-run").dryRun).toBe(true);
  });

  it("parses --portkey-key", () => {
    const a = parse("--portkey-key", "pk-abc");
    expect(a.portkeyKey).toBe("pk-abc");
  });

  it("parses --provider", () => {
    const a = parse("--provider", "ant");
    expect(a.provider).toBe("ant");
  });

  it("parses --config", () => {
    const a = parse("--config", "pc-xyz");
    expect(a.config).toBe("pc-xyz");
  });

  it("parses --gateway", () => {
    const a = parse("--gateway", "https://custom.gw.com");
    expect(a.gateway).toBe("https://custom.gw.com");
  });

  it("parses --model", () => {
    const a = parse("--model", "claude-sonnet-4-20250514");
    expect(a.model).toBe("claude-sonnet-4-20250514");
  });

  it("parses --skip-install, --skip-mcp, --skip-skills", () => {
    const a = parse("--skip-install", "--skip-mcp", "--skip-skills");
    expect(a.skipInstall).toBe(true);
    expect(a.skipMcp).toBe(true);
    expect(a.skipSkills).toBe(true);
  });

  it("parses --agent and --global for skills", () => {
    const a = parse("skills", "sync", "--agent", "cursor", "--global");
    expect(a.command).toBe("skills");
    expect(a.subcommand).toBe("sync");
    expect(a.agent).toBe("cursor");
    expect(a.global).toBe(true);
  });

  it("parses --advanced", () => {
    expect(parse("--advanced").advanced).toBe(true);
  });

  it("parses --probe-mcp", () => {
    expect(parse("--probe-mcp").verifyMcp).toBe(true);
  });

  it("parses legacy --setup flag", () => {
    const a = parse("--setup");
    expect(a.command).toBe("claude-code");
    expect(a.subcommand).toBe("setup");
  });

  it("parses legacy --discover flag", () => {
    const a = parse("--discover");
    expect(a.command).toBe("claude-code");
    expect(a.subcommand).toBe("discover");
  });

  it("parses legacy --verify flag", () => {
    const a = parse("--verify");
    expect(a.command).toBe("claude-code");
    expect(a.subcommand).toBe("verify");
  });

  it("parses legacy --uninstall flag", () => {
    const a = parse("--uninstall");
    expect(a.command).toBe("claude-code");
    expect(a.subcommand).toBe("uninstall");
  });

  it("parses --codex-wire-api", () => {
    const a = parse("--codex-wire-api", "responses");
    expect(a.codexWireApi).toBe("responses");
  });

  it("infers claude-code setup from option flags alone", () => {
    const a = parse("--portkey-key", "pk-abc", "--provider", "ant", "--yes");
    expect(a.command).toBe("claude-code");
    expect(a.subcommand).toBe("setup");
  });

  it("parses --opus-model, --sonnet-model, --haiku-model", () => {
    const a = parse(
      "--opus-model", "claude-opus-4-20250514",
      "--sonnet-model", "claude-sonnet-4-20250514",
      "--haiku-model", "claude-haiku-4-20250514"
    );
    expect(a.opusModel).toBe("claude-opus-4-20250514");
    expect(a.sonnetModel).toBe("claude-sonnet-4-20250514");
    expect(a.haikuModel).toBe("claude-haiku-4-20250514");
  });
});
