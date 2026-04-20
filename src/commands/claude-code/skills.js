import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as p from "@clack/prompts";
import {
  PORTKEY_DASHBOARD,
  c,
  ok,
  err,
  info,
  findProjectRoot,
  detectInstalledAgents,
  AGENT_SKILLS_DIRS,
  AGENTS,
  readExistingConfig,
  MULTISELECT_HINT,
} from "../../utils.js";
import { fetchSkills, fetchSkillContent } from "../../api.js";

// ── Public helpers used by setup.js / list ─────────────────────────────────────

/** Stable id for maps and multiselect (slug when present). */
export function skillStableKey(skill) {
  const id = String(skill?.id || "").trim();
  if (id) return id;
  return String(skill?.name || "untitled").trim();
}

/**
 * Folder name under .../skills/<here>/SKILL.md.
 * Prefers API slug so a display name like "Skills" does not nest as skills/skills/.
 */
export function skillSkillDirName(skill) {
  const fromId = sanitizeSkillFolder(skill?.id);
  if (fromId) return fromId;
  const fromName = sanitizeSkillFolder(skill?.name);
  return fromName || "untitled";
}

function sanitizeSkillFolder(raw) {
  const t = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return t || "";
}

/**
 * Write a single SKILL.md under skillsDir/<folderName>/.
 * Content is written exactly as-is — no modification.
 */
export function writeSingleSkill(skillsDir, folderName, content) {
  const dir = path.join(skillsDir, folderName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), content || "", "utf8");
}

// ── Sync skills ───────────────────────────────────────────────────────────────

export async function doSkillsSync(args) {
  p.intro(`${c.bold}Sync Team Skills${c.reset}`);
  p.note(
    `${c.bold}Source:${c.reset} every skill is fetched from your ${c.bold}Portkey workspace${c.reset} (Prompt Partials API). ` +
      `Nothing is “synced” from random local folders — the CLI downloads the latest content from Portkey.\n` +
      `${c.bold}Destination:${c.reset} you choose which agent(s) get folders like ${c.dim}.claude/skills/<slug>/SKILL.md${c.reset} or ${c.dim}.agents/skills/...${c.reset} (Codex), ` +
      `and whether that is ${c.bold}this repo${c.reset} or ${c.bold}--global${c.reset} (${c.dim}~/...${c.reset}).`,
    "What skills sync does"
  );

  // Resolve API key
  const existing   = readExistingConfig();
  const portkeyKey =
    args.portkeyKey ||
    process.env.PORTKEY_API_KEY ||
    process.env.ANTHROPIC_AUTH_TOKEN ||
    existing.portkeyKey ||
    "";
  const gateway = args.gateway || existing.gateway || "https://api.portkey.ai";

  if (!portkeyKey) {
    err("No Portkey API key found. Run: portkey setup — or set PORTKEY_API_KEY.");
    return;
  }

  // Fetch skills
  const s = p.spinner();
  s.start("Fetching skills from Portkey...");
  const { data: skills, error } = await fetchSkills(portkeyKey, gateway);
  if (error) {
    s.stop(`Failed to load skills: ${error}`);
    return;
  }
  s.stop(`Found ${skills.length} skill${skills.length !== 1 ? "s" : ""}`);

  if (skills.length === 0) {
    info(`No skills found in workspace.`);
    info(`Create one at https://app.portkey.ai/partials`);
    return;
  }

  // Select skills
  let selectedKeys;
  if (args.yes) {
    selectedKeys = skills.map(skillStableKey);
    info(`Syncing all ${skills.length} skills`);
  } else {
    p.note(`${c.dim}${MULTISELECT_HINT}${c.reset}`, "How to pick multiple skills");
    const picked = await p.multiselect({
      message: "Which skills should we sync?",
      options: skills.map((sk) => ({
        value: skillStableKey(sk),
        label: sk.name,
        hint:  `${skillSkillDirName(sk)}  · v${sk.version}`,
      })),
      required: false,
    });

    if (p.isCancel(picked)) return p.outro("Cancelled.");
    if (!picked.length) {
      const skip = await p.confirm({
        message: "Nothing selected — skip skills sync?",
        initialValue: true,
      });
      if (p.isCancel(skip) || skip) return;
      info(`Run ${c.bold}portkey skills sync${c.reset} to sync skills any time.`);
      return;
    }
    selectedKeys = picked;
  }

  const chosenSkills = skills.filter((sk) => selectedKeys.includes(skillStableKey(sk)));

  // Select target agents
  const projectRoot  = findProjectRoot();
  const isGlobal     = args.global || !projectRoot;
  const installed    = detectInstalledAgents(projectRoot);

  let selectedAgents;
  if (args.agent) {
    selectedAgents = args.agent === "all"
      ? Object.keys(AGENTS)
      : args.agent.split(",").map((a) => a.trim()).filter((a) => AGENTS[a]);
  } else if (args.yes) {
    selectedAgents = installed.length ? installed : ["claude"];
  } else {
    const agentOpts = Object.entries(AGENTS).map(([key, agent]) => {
      const dir  = AGENT_SKILLS_DIRS[key](projectRoot, isGlobal);
      const tick = installed.includes(key) ? "  ✓" : "";
      return { value: key, label: agent.label, hint: dir + tick };
    });

    p.note(
      `${c.dim}${MULTISELECT_HINT}${c.reset}\n${c.dim}✓ = agent config folder detected.${c.reset}`,
      "Target agents"
    );
    const picked = await p.multiselect({
      message: "Install skills to which agents?",
      options: agentOpts,
      initialValues: installed.length ? installed : ["claude"],
      required: false,
    });

    if (p.isCancel(picked)) return p.outro("Cancelled.");
    if (!picked.length) {
      const skip = await p.confirm({
        message: "No agents selected — skip?",
        initialValue: true,
      });
      if (p.isCancel(skip) || skip) return;
      info(`Run ${c.bold}portkey skills sync${c.reset} to try again.`);
      return;
    }
    selectedAgents = picked;
  }

  if (args.dryRun) {
    const lines = [];
    for (const agent of selectedAgents) {
      const dir = AGENT_SKILLS_DIRS[agent](projectRoot, isGlobal);
      for (const skill of chosenSkills) {
        lines.push(`${path.join(dir, skillSkillDirName(skill), "SKILL.md")}  (v${skill.version})`);
      }
    }
    p.note(lines.join("\n"), "Dry run — would write");
    return p.outro("No changes made.");
  }

  // Fetch full content for each selected skill, then write
  const written = [];
  const fetchSpinner = p.spinner();
  fetchSpinner.start(`Downloading ${chosenSkills.length} skill${chosenSkills.length !== 1 ? "s" : ""}...`);

  const skillContents = new Map();
  for (const skill of chosenSkills) {
    const { content, error } = await fetchSkillContent(portkeyKey, gateway, skill.id || skill.name);
    if (error) {
      fetchSpinner.stop(`Warning: could not fetch "${skill.name}": ${error}`);
      fetchSpinner.start("Continuing...");
    } else if (!content) {
      // Skip silently — partial is empty in Portkey
    } else {
      skillContents.set(skillStableKey(skill), content);
    }
  }
  fetchSpinner.stop(`Downloaded ${skillContents.size} skill${skillContents.size !== 1 ? "s" : ""}`);

  if (skillContents.size === 0) {
    p.outro("No content returned from Portkey. Check that your prompt partials have content.");
    return;
  }

  for (const agent of selectedAgents) {
    const skillsDir = AGENT_SKILLS_DIRS[agent](projectRoot, isGlobal);
    for (const skill of chosenSkills) {
      const key = skillStableKey(skill);
      const content = skillContents.get(key);
      if (content == null) continue;
      const folder = skillSkillDirName(skill);
      const filePath = path.join(skillsDir, folder, "SKILL.md");
      writeSingleSkill(skillsDir, folder, content);
      written.push({ agent: AGENTS[agent].label, skill: skill.name, file: filePath });
    }
  }

  console.log();
  for (const w of written) {
    console.log(`  ${c.green}✔${c.reset}  ${c.bold}${w.skill}${c.reset}  →  ${c.dim}${w.file}${c.reset}`);
  }
  console.log();

  p.outro(`${written.length} skill${written.length !== 1 ? "s" : ""} synced. Restart your agent to pick them up.`);
}

// ── List available skills ─────────────────────────────────────────────────────

export async function doSkillsList(args) {
  p.intro(`${c.bold}Skills${c.reset}`);

  const existing   = readExistingConfig();
  const portkeyKey =
    args.portkeyKey ||
    process.env.PORTKEY_API_KEY ||
    process.env.ANTHROPIC_AUTH_TOKEN ||
    existing.portkeyKey ||
    "";
  const gateway = args.gateway || existing.gateway || "https://api.portkey.ai";

  if (!portkeyKey) {
    err("No Portkey API key found. Run: portkey setup  or set PORTKEY_API_KEY.");
    return;
  }

  const s = p.spinner();
  s.start("Fetching prompt partials from Portkey...");
  const { data: skills, error } = await fetchSkills(portkeyKey, gateway);
  if (error) {
    s.stop(`Failed: ${error}`);
    return;
  }
  s.stop(`${skills.length} prompt partial${skills.length !== 1 ? "s" : ""} in workspace`);

  if (skills.length === 0) {
    info(`No prompt partials found. Create one in Prompt Engineering Studio:`);
    info(`${PORTKEY_DASHBOARD}/prompts`);
    return;
  }

  const remoteLines = skills.map((sk) =>
    `  ${c.bold}${sk.name}${c.reset}  ${c.dim}v${sk.version}${c.reset}`
  );
  p.note(remoteLines.join("\n"), `Workspace Prompt Partials`);

  // Show locally synced
  const projectRoot = findProjectRoot();
  const localLines  = [];

  for (const [key, agent] of Object.entries(AGENTS)) {
    for (const useGlobal of [false, true]) {
      const dir = AGENT_SKILLS_DIRS[key](projectRoot, useGlobal);
      if (!fs.existsSync(dir)) continue;
      const entries = fs.readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
      if (!entries.length) continue;
      localLines.push(`${c.bold}${agent.label}${c.reset}  ${c.dim}${dir}${c.reset}`);
      for (const name of entries) {
        const synced = skills.some((sk) => skillSkillDirName(sk) === name);
        const marker = synced ? c.green + "✔" : c.yellow + "○";
        localLines.push(`  ${marker}${c.reset}  ${name}`);
      }
    }
  }

  if (localLines.length) {
    p.note(localLines.join("\n"), "Locally Synced");
  } else {
    info(`Nothing synced yet. Run: ${c.bold}portkey skills sync${c.reset}`);
    info(`Create one at https://app.portkey.ai/partials`);
  }

  console.log();
}
