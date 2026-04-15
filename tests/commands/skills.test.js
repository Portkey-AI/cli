import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  skillStableKey,
  skillSkillDirName,
  writeSingleSkill,
} from "../../src/commands/claude-code/skills.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "portkey-skills-test-"));
}

// ── skillStableKey ────────────────────────────────────────────────────────────

describe("skillStableKey", () => {
  it("returns id when present", () => {
    expect(skillStableKey({ id: "my-skill", name: "My Skill" })).toBe("my-skill");
  });

  it("falls back to name when id is empty", () => {
    expect(skillStableKey({ id: "", name: "Fallback" })).toBe("Fallback");
  });

  it("returns 'untitled' when both are empty", () => {
    expect(skillStableKey({ id: "", name: "" })).toBe("untitled");
    expect(skillStableKey({})).toBe("untitled");
  });

  it("trims whitespace", () => {
    expect(skillStableKey({ id: "  spaced  " })).toBe("spaced");
  });
});

// ── skillSkillDirName ─────────────────────────────────────────────────────────

describe("skillSkillDirName", () => {
  it("sanitizes id to lowercase slug", () => {
    expect(skillSkillDirName({ id: "My Cool Skill!" })).toBe("my-cool-skill");
  });

  it("collapses multiple dashes", () => {
    expect(skillSkillDirName({ id: "a---b---c" })).toBe("a-b-c");
  });

  it("strips leading/trailing dashes", () => {
    expect(skillSkillDirName({ id: "-leading-trailing-" })).toBe("leading-trailing");
  });

  it("falls back to name when id produces empty", () => {
    expect(skillSkillDirName({ id: "!!!", name: "Good Name" })).toBe("good-name");
  });

  it("returns 'untitled' when both are empty", () => {
    expect(skillSkillDirName({ id: "", name: "" })).toBe("untitled");
  });

  it("handles special characters", () => {
    expect(skillSkillDirName({ id: "hello@world#2024" })).toBe("hello-world-2024");
  });
});

// ── writeSingleSkill ──────────────────────────────────────────────────────────

describe("writeSingleSkill", () => {
  let dir;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("creates SKILL.md in nested directory", () => {
    writeSingleSkill(dir, "my-skill", "# Hello\nThis is a skill.");
    const file = path.join(dir, "my-skill", "SKILL.md");
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("# Hello\nThis is a skill.");
  });

  it("overwrites existing skill content", () => {
    writeSingleSkill(dir, "my-skill", "v1");
    writeSingleSkill(dir, "my-skill", "v2");
    const content = fs.readFileSync(path.join(dir, "my-skill", "SKILL.md"), "utf8");
    expect(content).toBe("v2");
  });

  it("handles empty content", () => {
    writeSingleSkill(dir, "empty-skill", "");
    const content = fs.readFileSync(path.join(dir, "empty-skill", "SKILL.md"), "utf8");
    expect(content).toBe("");
  });

  it("handles null content", () => {
    writeSingleSkill(dir, "null-skill", null);
    const content = fs.readFileSync(path.join(dir, "null-skill", "SKILL.md"), "utf8");
    expect(content).toBe("");
  });
});
