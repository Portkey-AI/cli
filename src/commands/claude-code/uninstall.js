import fs from "node:fs";
import * as p from "@clack/prompts";
import {
  c,
  ok,
  info,
  findProjectRoot,
  detectShellRc,
  settingsRemoveKeys,
  removeShellRcBlock,
  jsonRead,
} from "../../utils.js";

const ENV_KEYS_TO_REMOVE = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_AUTH_TOKEN",
  "PORTKEY_API_KEY",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
];

export async function doUninstall(args) {
  p.intro(`${c.bold}Removing Portkey Config${c.reset}`);

  // ── Shell RC ──────────────────────────────────────────────────────────────
  const shellRc = detectShellRc();
  try {
    const content = fs.readFileSync(shellRc, "utf8");
    if (content.includes("# ── Portkey + Claude Code")) {
      const remove =
        args.yes ||
        (await p.confirm({
          message: `Remove Portkey block from ${shellRc}?`,
          initialValue: true,
        }));
      if (!p.isCancel(remove) && remove) {
        removeShellRcBlock(shellRc);
        ok(`Removed from ${shellRc}`);
      }
    }
  } catch {
    // no shell rc
  }

  // ── Settings files ────────────────────────────────────────────────────────
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const projectRoot = findProjectRoot();
  const settingsFiles = [`${home}/.claude/settings.json`];
  if (projectRoot) {
    settingsFiles.push(
      `${projectRoot}/.claude/settings.json`,
      `${projectRoot}/.claude/settings.local.json`
    );
  }

  for (const f of settingsFiles) {
    if (!fs.existsSync(f)) continue;
    const hasPortkey =
      jsonRead(f, "env.ANTHROPIC_BASE_URL") ||
      jsonRead(f, "env.ANTHROPIC_CUSTOM_HEADERS");
    if (!hasPortkey) continue;

    const remove =
      args.yes ||
      (await p.confirm({
        message: `Remove Portkey env vars from ${f}?`,
        initialValue: true,
      }));
    if (p.isCancel(remove)) break;
    if (remove) {
      settingsRemoveKeys(f, ENV_KEYS_TO_REMOVE);
      ok(`Cleaned ${f}`);
    }
  }

  // Clean current session env
  for (const k of [
    "PORTKEY_API_KEY",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_CUSTOM_HEADERS",
    "ANTHROPIC_AUTH_TOKEN",
  ]) {
    delete process.env[k];
  }

  p.outro("Done.");
}
