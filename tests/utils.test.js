import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  mask,
  normalizeProvider,
  sortModels,
  isLikelyPortkeyApiKeyPermissionError,
  jsonRead,
  settingsSetEnv,
  settingsRemoveKeys,
  settingsSetMcp,
  settingsRemoveMcp,
  settingsReadMcp,
  writeShellRc,
  removeShellRcBlock,
  writeFileSecure,
} from "../src/utils.js";

function mode(file) {
  return (fs.statSync(file).mode & 0o777).toString(8);
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "portkey-test-"));
}

// ── mask ──────────────────────────────────────────────────────────────────────

describe("mask", () => {
  it("masks empty/falsy input", () => {
    expect(mask("")).toBe("***");
    expect(mask(null)).toBe("***");
    expect(mask(undefined)).toBe("***");
  });

  it("masks long keys showing first 4 and last 4", () => {
    expect(mask("sk-1234567890abcdef")).toBe("sk-1····cdef");
  });

  it("masks medium keys (5-8 chars) showing first 2 and last 2", () => {
    expect(mask("abcde")).toBe("ab····de");
  });

  it("masks short keys (<=4 chars)", () => {
    expect(mask("abcd")).toBe("***");
  });
});

// ── normalizeProvider ─────────────────────────────────────────────────────────

describe("normalizeProvider", () => {
  it("adds @ prefix", () => {
    expect(normalizeProvider("ant")).toBe("@ant");
  });

  it("deduplicates leading @", () => {
    expect(normalizeProvider("@ant")).toBe("@ant");
    expect(normalizeProvider("@@ant")).toBe("@ant");
  });
});

// ── sortModels ────────────────────────────────────────────────────────────────

describe("sortModels", () => {
  it("puts 'latest' models first", () => {
    const models = [
      { id: "claude-3-5-sonnet-20241022" },
      { id: "claude-sonnet-4-latest" },
    ];
    models.sort(sortModels);
    expect(models[0].id).toBe("claude-sonnet-4-latest");
  });

  it("sorts by tier: opus > sonnet > haiku", () => {
    const models = [
      { id: "claude-haiku-4" },
      { id: "claude-opus-4" },
      { id: "claude-sonnet-4" },
    ];
    models.sort(sortModels);
    expect(models.map((m) => m.id)).toEqual([
      "claude-opus-4",
      "claude-sonnet-4",
      "claude-haiku-4",
    ]);
  });

  it("puts non-dated before dated within same tier", () => {
    const models = [
      { id: "claude-sonnet-4-20250514" },
      { id: "claude-sonnet-4" },
    ];
    models.sort(sortModels);
    expect(models[0].id).toBe("claude-sonnet-4");
  });
});

// ── isLikelyPortkeyApiKeyPermissionError ──────────────────────────────────────

describe("isLikelyPortkeyApiKeyPermissionError", () => {
  it("detects 403", () => {
    expect(isLikelyPortkeyApiKeyPermissionError("HTTP 403")).toBe(true);
  });

  it("detects AB03 code", () => {
    expect(isLikelyPortkeyApiKeyPermissionError("Error code AB03")).toBe(true);
  });

  it("detects permission message", () => {
    expect(
      isLikelyPortkeyApiKeyPermissionError("not have enough permissions")
    ).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isLikelyPortkeyApiKeyPermissionError("timeout")).toBe(false);
    expect(isLikelyPortkeyApiKeyPermissionError("")).toBe(false);
    expect(isLikelyPortkeyApiKeyPermissionError(null)).toBe(false);
  });
});

// ── jsonRead ──────────────────────────────────────────────────────────────────

describe("jsonRead", () => {
  let dir;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("reads nested key path", () => {
    const file = path.join(dir, "test.json");
    fs.writeFileSync(file, JSON.stringify({ a: { b: { c: 42 } } }));
    expect(jsonRead(file, "a.b.c")).toBe(42);
  });

  it("returns undefined for missing key", () => {
    const file = path.join(dir, "test.json");
    fs.writeFileSync(file, JSON.stringify({ a: 1 }));
    expect(jsonRead(file, "x.y.z")).toBeUndefined();
  });

  it("returns undefined for missing file", () => {
    expect(jsonRead(path.join(dir, "nope.json"), "a")).toBeUndefined();
  });
});

// ── writeFileSecure (0600 for secret-bearing files) ───────────────────────────

describe("writeFileSecure", () => {
  let dir;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("creates new files with owner-only 0600 permissions", () => {
    const file = path.join(dir, "secret.json");
    writeFileSecure(file, "secret");
    expect(mode(file)).toBe("600");
  });

  it("tightens a pre-existing world-readable (0644) file to 0600", () => {
    const file = path.join(dir, "existing.json");
    fs.writeFileSync(file, "old", { mode: 0o644 });
    expect(mode(file)).toBe("644");
    writeFileSecure(file, "new");
    expect(mode(file)).toBe("600");
  });

  it("is used by settings/mcp/shellrc writers so secrets are never world-readable", () => {
    const settings = path.join(dir, "settings.json");
    settingsSetEnv(settings, { ANTHROPIC_AUTH_TOKEN: "pk-secret" });
    expect(mode(settings)).toBe("600");

    const mcp = path.join(dir, ".mcp.json");
    settingsSetMcp(mcp, { srv: { type: "http", url: "u" } }, { scope: "project" });
    expect(mode(mcp)).toBe("600");

    const rc = path.join(dir, ".bashrc");
    fs.writeFileSync(rc, "# rc", { mode: 0o644 });
    writeShellRc(rc, "export ANTHROPIC_AUTH_TOKEN=pk-secret");
    expect(mode(rc)).toBe("600");
  });
});

// ── settingsSetEnv / settingsRemoveKeys ───────────────────────────────────────

describe("settingsSetEnv + settingsRemoveKeys", () => {
  let dir;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("creates file and sets env pairs", () => {
    const file = path.join(dir, "sub", "settings.json");
    settingsSetEnv(file, { FOO: "bar", BAZ: "qux" });
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(data.env.FOO).toBe("bar");
    expect(data.env.BAZ).toBe("qux");
  });

  it("merges into existing env", () => {
    const file = path.join(dir, "settings.json");
    fs.writeFileSync(file, JSON.stringify({ env: { EXISTING: "yes" } }));
    settingsSetEnv(file, { NEW: "val" });
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(data.env.EXISTING).toBe("yes");
    expect(data.env.NEW).toBe("val");
  });

  it("removes specified keys", () => {
    const file = path.join(dir, "settings.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ env: { A: "1", B: "2", C: "3" } })
    );
    settingsRemoveKeys(file, ["A", "C"]);
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(data.env).toEqual({ B: "2" });
  });

  it("removes env key entirely if all keys removed", () => {
    const file = path.join(dir, "settings.json");
    fs.writeFileSync(file, JSON.stringify({ env: { ONLY: "one" } }));
    settingsRemoveKeys(file, ["ONLY"]);
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(data.env).toBeUndefined();
  });
});

// ── MCP settings helpers ──────────────────────────────────────────────────────

describe("settingsSetMcp + settingsReadMcp + settingsRemoveMcp", () => {
  let dir;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("writes and reads user-scope MCP servers", () => {
    const file = path.join(dir, "claude.json");
    settingsSetMcp(file, {
      "my-server": { type: "http", url: "https://example.com/mcp" },
    });
    const servers = settingsReadMcp(file);
    expect(servers["my-server"].url).toBe("https://example.com/mcp");
  });

  it("writes and reads local-scope (project) MCP servers", () => {
    const file = path.join(dir, "claude.json");
    const projectPath = "/fake/project";
    settingsSetMcp(
      file,
      { "proj-srv": { type: "http", url: "https://proj.com" } },
      { scope: "local", projectPath }
    );

    const localServers = settingsReadMcp(file, {
      scope: "local",
      projectPath,
    });
    expect(localServers["proj-srv"].url).toBe("https://proj.com");

    const userServers = settingsReadMcp(file, { scope: "user" });
    expect(userServers["proj-srv"]).toBeUndefined();
  });

  it("removes MCP servers", () => {
    const file = path.join(dir, "claude.json");
    settingsSetMcp(file, {
      a: { type: "http", url: "https://a.com" },
      b: { type: "http", url: "https://b.com" },
    });
    settingsRemoveMcp(file, ["a"]);
    const servers = settingsReadMcp(file);
    expect(servers.a).toBeUndefined();
    expect(servers.b).toBeDefined();
  });

  it("returns empty object for missing file", () => {
    expect(settingsReadMcp(path.join(dir, "nope.json"))).toEqual({});
  });
});

// ── Shell RC helpers ──────────────────────────────────────────────────────────

describe("writeShellRc + removeShellRcBlock", () => {
  let dir;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("appends Portkey block to shell RC", () => {
    const file = path.join(dir, ".zshrc");
    fs.writeFileSync(file, "# existing stuff\n");
    writeShellRc(file, [
      "# ── Portkey + Claude Code ──",
      'export FOO="bar"',
      "# ── End Portkey + Claude Code ──",
    ].join("\n"));
    const content = fs.readFileSync(file, "utf8");
    expect(content).toContain("# existing stuff");
    expect(content).toContain('export FOO="bar"');
  });

  it("replaces existing Portkey block on re-run", () => {
    const file = path.join(dir, ".zshrc");
    fs.writeFileSync(file, "# existing stuff\n");
    const block = [
      "# ── Portkey + Claude Code ──",
      'export FOO="bar"',
      "# ── End Portkey + Claude Code ──",
    ].join("\n");
    writeShellRc(file, block);
    const block2 = [
      "# ── Portkey + Claude Code ──",
      'export FOO="baz"',
      "# ── End Portkey + Claude Code ──",
    ].join("\n");
    writeShellRc(file, block2);
    const content = fs.readFileSync(file, "utf8");
    expect(content).not.toContain('"bar"');
    expect(content).toContain('"baz"');
  });

  it("removes Portkey block", () => {
    const file = path.join(dir, ".zshrc");
    fs.writeFileSync(
      file,
      '# before\n# ── Portkey + Claude Code ──\nexport X="y"\n# ── End Portkey + Claude Code ──\n# after\n'
    );
    const removed = removeShellRcBlock(file);
    expect(removed).toBe(true);
    const content = fs.readFileSync(file, "utf8");
    expect(content).toContain("# before");
    expect(content).toContain("# after");
    expect(content).not.toContain("Portkey + Claude Code");
  });

  it("returns false when no block to remove", () => {
    const file = path.join(dir, ".zshrc");
    fs.writeFileSync(file, "# nothing here\n");
    expect(removeShellRcBlock(file)).toBe(false);
  });
});
