import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchJSON,
  fetchProviders,
  fetchModels,
  fetchMcpServers,
  fetchSkills,
  fetchSkillContent,
  buildClaudeMcpHttpConfig,
  portkeyMcpRequiresOAuth,
} from "../src/api.js";

function mockFetch(body, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ── fetchJSON ─────────────────────────────────────────────────────────────────

describe("fetchJSON", () => {
  it("returns parsed JSON on 200", async () => {
    globalThis.fetch = mockFetch({ data: [1, 2, 3] });
    const result = await fetchJSON("https://api.portkey.ai/v1/test");
    expect(result).toEqual({ data: [1, 2, 3] });
  });

  it("throws on non-OK status", async () => {
    globalThis.fetch = mockFetch({ message: "bad key" }, 401);
    await expect(
      fetchJSON("https://api.portkey.ai/v1/test")
    ).rejects.toThrow("HTTP 401");
  });
});

// ── fetchProviders ────────────────────────────────────────────────────────────

describe("fetchProviders", () => {
  it("returns active providers", async () => {
    globalThis.fetch = mockFetch({
      data: [
        { slug: "ant", name: "Anthropic", status: "active", provider: "anthropic" },
        { slug: "oai", name: "OpenAI", status: "active", provider: "openai" },
        { slug: "disabled", name: "Off", status: "inactive", provider: "x" },
      ],
    });
    const { data, error } = await fetchProviders("pk-test", "https://api.portkey.ai");
    expect(error).toBeNull();
    expect(data).toHaveLength(2);
    expect(data[0].slug).toBe("ant");
    expect(data[1].slug).toBe("oai");
  });

  it("returns error on failure", async () => {
    globalThis.fetch = mockFetch({ message: "unauthorized" }, 401);
    const { data, error } = await fetchProviders("bad-key", "https://api.portkey.ai");
    expect(data).toBeNull();
    expect(error).toContain("401");
  });
});

// ── fetchModels ───────────────────────────────────────────────────────────────

describe("fetchModels", () => {
  it("returns deduplicated short model ids", async () => {
    globalThis.fetch = mockFetch({
      data: [
        { id: "@ant/claude-sonnet-4-20250514", slug: "claude-sonnet-4-20250514" },
        { id: "@ant/claude-opus-4-20250514", slug: "claude-opus-4-20250514" },
        { id: "@ant/claude-sonnet-4-20250514", slug: "claude-sonnet-4-20250514" },
      ],
    });
    const { data, error } = await fetchModels("pk-test", "ant", "https://api.portkey.ai");
    expect(error).toBeNull();
    expect(data.length).toBe(2);
    expect(data.map((m) => m.id)).toContain("claude-opus-4-20250514");
    expect(data.map((m) => m.id)).toContain("claude-sonnet-4-20250514");
  });
});

// ── fetchMcpServers ───────────────────────────────────────────────────────────

describe("fetchMcpServers", () => {
  it("constructs MCP gateway URL from API gateway", async () => {
    globalThis.fetch = mockFetch({
      data: [
        { id: "srv1", name: "Linear", slug: "linear", description: "Linear MCP", auth_type: "oauth_auto", tools: ["create_issue"] },
      ],
    });
    const { data, error } = await fetchMcpServers("pk-test", "https://api.portkey.ai");
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data[0].url).toBe("https://mcp.portkey.ai/linear/mcp");
    expect(data[0].authType).toBe("oauth_auto");
  });
});

// ── fetchSkills ───────────────────────────────────────────────────────────────

describe("fetchSkills", () => {
  it("maps partial fields correctly", async () => {
    globalThis.fetch = mockFetch({
      data: [
        { slug: "my-skill", name: "My Skill", version: 3 },
      ],
    });
    const { data, error } = await fetchSkills("pk-test", "https://api.portkey.ai");
    expect(error).toBeNull();
    expect(data[0]).toEqual({ id: "my-skill", name: "My Skill", version: 3 });
  });
});

// ── fetchSkillContent ─────────────────────────────────────────────────────────

describe("fetchSkillContent", () => {
  it("returns content from nested data.string", async () => {
    globalThis.fetch = mockFetch({
      data: { string: "# My Skill\nDo things." },
    });
    const { content, error } = await fetchSkillContent("pk-test", "https://api.portkey.ai", "my-skill");
    expect(error).toBeNull();
    expect(content).toBe("# My Skill\nDo things.");
  });

  it("returns error on failure", async () => {
    globalThis.fetch = mockFetch({ message: "not found" }, 404);
    const { content, error } = await fetchSkillContent("pk-test", "https://api.portkey.ai", "missing");
    expect(content).toBeNull();
    expect(error).toContain("404");
  });
});

// ── buildClaudeMcpHttpConfig ──────────────────────────────────────────────────

describe("buildClaudeMcpHttpConfig", () => {
  it("builds config with API key header", () => {
    const cfg = buildClaudeMcpHttpConfig(
      { url: "https://mcp.portkey.ai/linear/mcp" },
      "pk-123"
    );
    expect(cfg).toEqual({
      type: "http",
      url: "https://mcp.portkey.ai/linear/mcp",
      headers: { "x-portkey-api-key": "pk-123" },
    });
  });

  it("omits headers when no key", () => {
    const cfg = buildClaudeMcpHttpConfig(
      { url: "https://mcp.portkey.ai/linear/mcp" },
      ""
    );
    expect(cfg).toEqual({
      type: "http",
      url: "https://mcp.portkey.ai/linear/mcp",
    });
  });

  it("uses the env-var reference instead of the live key when keyRef is set (committed scope)", () => {
    const cfg = buildClaudeMcpHttpConfig(
      { url: "https://mcp.portkey.ai/linear/mcp" },
      "pk-secret-123",
      { keyRef: "${PORTKEY_API_KEY}" }
    );
    expect(cfg.headers["x-portkey-api-key"]).toBe("${PORTKEY_API_KEY}");
    expect(JSON.stringify(cfg)).not.toContain("pk-secret-123");
  });
});

// ── portkeyMcpRequiresOAuth ───────────────────────────────────────────────────

describe("portkeyMcpRequiresOAuth", () => {
  it("returns true for oauth_auto", () => {
    expect(portkeyMcpRequiresOAuth({ authType: "oauth_auto" })).toBe(true);
  });

  it("returns true for oauth", () => {
    expect(portkeyMcpRequiresOAuth({ authType: "oauth" })).toBe(true);
  });

  it("returns false for headers", () => {
    expect(portkeyMcpRequiresOAuth({ authType: "headers" })).toBe(false);
  });

  it("returns false for none", () => {
    expect(portkeyMcpRequiresOAuth({ authType: "none" })).toBe(false);
  });
});
