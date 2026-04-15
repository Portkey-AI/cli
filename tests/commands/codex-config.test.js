import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  normalizeCodexWireApi,
  writeCodexPortkeyBundle,
  appendCodexPortkeyProviderBlock,
  codexProviderTableSuffix,
} from "../../src/commands/claude-code/codex-config-toml.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "portkey-codex-cfg-test-"));
}

// ── normalizeCodexWireApi ─────────────────────────────────────────────────────

describe("normalizeCodexWireApi", () => {
  it("normalizes 'responses'", () => {
    expect(normalizeCodexWireApi("responses")).toBe("responses");
    expect(normalizeCodexWireApi("RESPONSES")).toBe("responses");
  });

  it("defaults to 'chat' for anything else", () => {
    expect(normalizeCodexWireApi("chat")).toBe("chat");
    expect(normalizeCodexWireApi("")).toBe("chat");
    expect(normalizeCodexWireApi(null)).toBe("chat");
    expect(normalizeCodexWireApi(undefined)).toBe("chat");
    expect(normalizeCodexWireApi("junk")).toBe("chat");
  });
});

// ── codexProviderTableSuffix ──────────────────────────────────────────────────

describe("codexProviderTableSuffix", () => {
  it("strips @ prefix", () => {
    expect(codexProviderTableSuffix("@ant")).toBe("ant");
    expect(codexProviderTableSuffix("@@ant")).toBe("ant");
  });

  it("sanitizes special characters", () => {
    expect(codexProviderTableSuffix("my provider!")).toBe("my-provider");
  });

  it("returns 'extra' for empty input", () => {
    expect(codexProviderTableSuffix("")).toBe("extra");
    expect(codexProviderTableSuffix(null)).toBe("extra");
  });
});

// ── writeCodexPortkeyBundle ───────────────────────────────────────────────────

describe("writeCodexPortkeyBundle", () => {
  let dir;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("writes a valid config.toml with provider routing", () => {
    const file = path.join(dir, ".codex", "config.toml");
    writeCodexPortkeyBundle(file, {
      gateway: "https://api.portkey.ai",
      providerSlug: "ant",
      modelId: "claude-sonnet-4-20250514",
      wireApi: "chat",
    });
    const content = fs.readFileSync(file, "utf8");
    expect(content).toContain('model_provider = "portkey"');
    expect(content).toContain('model = "@ant/claude-sonnet-4-20250514"');
    expect(content).toContain("[model_providers.portkey]");
    expect(content).toContain('base_url = "https://api.portkey.ai/v1"');
    expect(content).toContain('wire_api = "chat"');
    expect(content).toContain('env_key = "PORTKEY_API_KEY"');
  });

  it("writes config routing mode with plain model", () => {
    const file = path.join(dir, ".codex", "config.toml");
    writeCodexPortkeyBundle(file, {
      gateway: "https://api.portkey.ai",
      providerSlug: "ant",
      modelId: "gpt-4o",
      wireApi: "chat",
      portkeyConfigId: "pc-abc123",
    });
    const content = fs.readFileSync(file, "utf8");
    expect(content).toContain('model = "gpt-4o"');
    expect(content).toContain("# Portkey Config: pc-abc123");
    expect(content).not.toContain("@ant/gpt-4o");
  });

  it("appends /v1 to gateway that lacks it", () => {
    const file = path.join(dir, ".codex", "config.toml");
    writeCodexPortkeyBundle(file, {
      gateway: "https://api.portkey.ai",
      providerSlug: "ant",
      modelId: "test",
      wireApi: "chat",
    });
    const content = fs.readFileSync(file, "utf8");
    expect(content).toContain('base_url = "https://api.portkey.ai/v1"');
  });

  it("does not double-append /v1", () => {
    const file = path.join(dir, ".codex", "config.toml");
    writeCodexPortkeyBundle(file, {
      gateway: "https://api.portkey.ai/v1",
      providerSlug: "ant",
      modelId: "test",
      wireApi: "chat",
    });
    const content = fs.readFileSync(file, "utf8");
    expect(content).toContain('base_url = "https://api.portkey.ai/v1"');
    expect(content).not.toContain("/v1/v1");
  });

  it("preserves existing non-Portkey content", () => {
    const file = path.join(dir, "config.toml");
    fs.writeFileSync(file, '# My custom config\nfoo = "bar"\n');
    writeCodexPortkeyBundle(file, {
      gateway: "https://api.portkey.ai",
      providerSlug: "ant",
      modelId: "test",
      wireApi: "chat",
    });
    const content = fs.readFileSync(file, "utf8");
    expect(content).toContain('foo = "bar"');
    expect(content).toContain("[model_providers.portkey]");
  });

  it("replaces existing Portkey block on re-run", () => {
    const file = path.join(dir, "config.toml");
    writeCodexPortkeyBundle(file, {
      gateway: "https://api.portkey.ai",
      providerSlug: "ant",
      modelId: "old-model",
      wireApi: "chat",
    });
    writeCodexPortkeyBundle(file, {
      gateway: "https://api.portkey.ai",
      providerSlug: "oai",
      modelId: "new-model",
      wireApi: "responses",
    });
    const content = fs.readFileSync(file, "utf8");
    expect(content).not.toContain("old-model");
    expect(content).toContain("new-model");
    expect(content).toContain('wire_api = "responses"');
  });
});

// ── appendCodexPortkeyProviderBlock ───────────────────────────────────────────

describe("appendCodexPortkeyProviderBlock", () => {
  let dir;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("appends a new provider block", () => {
    const file = path.join(dir, "config.toml");
    writeCodexPortkeyBundle(file, {
      gateway: "https://api.portkey.ai",
      providerSlug: "ant",
      modelId: "claude-sonnet-4",
      wireApi: "chat",
    });
    appendCodexPortkeyProviderBlock(file, {
      gateway: "https://api.portkey.ai",
      providerSlug: "oai",
      modelId: "gpt-4o",
      wireApi: "responses",
    });
    const content = fs.readFileSync(file, "utf8");
    expect(content).toContain("[model_providers.portkey]");
    expect(content).toContain("[model_providers.portkey-oai]");
    expect(content).toContain('wire_api = "responses"');
  });

  it("replaces existing extra provider block on re-run", () => {
    const file = path.join(dir, "config.toml");
    writeCodexPortkeyBundle(file, {
      gateway: "https://api.portkey.ai",
      providerSlug: "ant",
      modelId: "claude-sonnet-4",
      wireApi: "chat",
    });
    appendCodexPortkeyProviderBlock(file, {
      gateway: "https://api.portkey.ai",
      providerSlug: "oai",
      modelId: "gpt-4o",
      wireApi: "chat",
    });
    appendCodexPortkeyProviderBlock(file, {
      gateway: "https://api.portkey.ai",
      providerSlug: "oai",
      modelId: "gpt-4o-mini",
      wireApi: "responses",
    });
    const content = fs.readFileSync(file, "utf8");
    expect(content).not.toContain("gpt-4o\n");
    expect(content).toContain("gpt-4o-mini");
  });

  it("throws when file does not exist", () => {
    expect(() =>
      appendCodexPortkeyProviderBlock(path.join(dir, "nope.toml"), {
        gateway: "https://api.portkey.ai",
        providerSlug: "oai",
        modelId: "gpt-4o",
        wireApi: "chat",
      })
    ).toThrow("missing file");
  });
});
