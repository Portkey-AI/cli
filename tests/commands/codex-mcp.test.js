import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  codexMcpTableId,
  writeCodexMcpServersToml,
  countCodexMcpServerTables,
  listCodexMcpServerTableNames,
  codexTomlMentionsPortkey,
} from "../../src/commands/claude-code/codex-mcp-toml.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "portkey-codex-mcp-test-"));
}

// ── codexMcpTableId ───────────────────────────────────────────────────────────

describe("codexMcpTableId", () => {
  it("prefixes with portkey-", () => {
    expect(codexMcpTableId("linear")).toBe("portkey-linear");
  });

  it("sanitizes special characters", () => {
    expect(codexMcpTableId("my server!")).toBe("portkey-my-server");
  });

  it("handles empty slug", () => {
    expect(codexMcpTableId("")).toBe("portkey-server");
    expect(codexMcpTableId(null)).toBe("portkey-server");
  });

  it("collapses repeated dashes", () => {
    expect(codexMcpTableId("a---b")).toBe("portkey-a-b");
  });
});

// ── writeCodexMcpServersToml ──────────────────────────────────────────────────

describe("writeCodexMcpServersToml", () => {
  let dir;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("writes MCP server tables to a new file", () => {
    const file = path.join(dir, ".codex", "config.toml");
    writeCodexMcpServersToml(file, [
      { slug: "linear", url: "https://mcp.portkey.ai/linear/mcp" },
      { slug: "slack", url: "https://mcp.portkey.ai/slack/mcp" },
    ]);
    const content = fs.readFileSync(file, "utf8");
    expect(content).toContain("[mcp_servers.portkey-linear]");
    expect(content).toContain("[mcp_servers.portkey-slack]");
    expect(content).toContain("https://mcp.portkey.ai/linear/mcp");
    expect(content).toContain("https://mcp.portkey.ai/slack/mcp");
    expect(content).toContain("x-portkey-api-key");
  });

  it("appends to existing content", () => {
    const file = path.join(dir, "config.toml");
    fs.writeFileSync(file, '# existing\nmodel = "gpt-4o"\n');
    writeCodexMcpServersToml(file, [
      { slug: "linear", url: "https://mcp.portkey.ai/linear/mcp" },
    ]);
    const content = fs.readFileSync(file, "utf8");
    expect(content).toContain('model = "gpt-4o"');
    expect(content).toContain("[mcp_servers.portkey-linear]");
  });

  it("replaces existing Portkey MCP block on re-run", () => {
    const file = path.join(dir, "config.toml");
    writeCodexMcpServersToml(file, [
      { slug: "linear", url: "https://mcp.portkey.ai/linear/mcp" },
    ]);
    writeCodexMcpServersToml(file, [
      { slug: "slack", url: "https://mcp.portkey.ai/slack/mcp" },
    ]);
    const content = fs.readFileSync(file, "utf8");
    expect(content).not.toContain("portkey-linear");
    expect(content).toContain("portkey-slack");
  });
});

// ── countCodexMcpServerTables ─────────────────────────────────────────────────

describe("countCodexMcpServerTables", () => {
  it("counts [mcp_servers.*] tables", () => {
    const toml = `
[mcp_servers.portkey-linear]
url = "https://example.com"

[mcp_servers.portkey-slack]
url = "https://example.com"
`;
    expect(countCodexMcpServerTables(toml)).toBe(2);
  });

  it("returns 0 for no tables", () => {
    expect(countCodexMcpServerTables("")).toBe(0);
    expect(countCodexMcpServerTables(null)).toBe(0);
    expect(countCodexMcpServerTables('model = "gpt-4o"')).toBe(0);
  });
});

// ── listCodexMcpServerTableNames ──────────────────────────────────────────────

describe("listCodexMcpServerTableNames", () => {
  it("extracts table names", () => {
    const toml = `
[mcp_servers.portkey-linear]
url = "x"

[mcp_servers.portkey-slack]
url = "y"
`;
    expect(listCodexMcpServerTableNames(toml)).toEqual([
      "portkey-linear",
      "portkey-slack",
    ]);
  });

  it("returns empty array for no tables", () => {
    expect(listCodexMcpServerTableNames("")).toEqual([]);
    expect(listCodexMcpServerTableNames(null)).toEqual([]);
  });
});

// ── codexTomlMentionsPortkey ──────────────────────────────────────────────────

describe("codexTomlMentionsPortkey", () => {
  it("detects Portkey comment marker", () => {
    expect(codexTomlMentionsPortkey("# ── Portkey + Codex ──")).toBe(true);
  });

  it("detects model_providers.portkey table", () => {
    expect(codexTomlMentionsPortkey("[model_providers.portkey]")).toBe(true);
  });

  it("detects model_provider = portkey", () => {
    expect(codexTomlMentionsPortkey('model_provider = "portkey"')).toBe(true);
  });

  it("returns false for unrelated content", () => {
    expect(codexTomlMentionsPortkey('model = "gpt-4o"')).toBe(false);
    expect(codexTomlMentionsPortkey("")).toBe(false);
    expect(codexTomlMentionsPortkey(null)).toBe(false);
  });
});
