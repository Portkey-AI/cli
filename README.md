# Portkey CLI

Wire **[Claude Code](https://docs.anthropic.com/en/docs/claude-code)** or **[OpenAI Codex](https://developers.openai.com/codex)** to **[Portkey](https://portkey.ai)** (routing, logs, guardrails). Optionally add MCP servers and sync team skills from your workspace.

## Install

[Node.js](https://nodejs.org/) 18+ required.

```bash
npx portkey
```

Or install globally:

```bash
npm install -g portkey
portkey
```

That opens the interactive menu (**Setup Claude Code** or **Setup Codex**). Have your **Portkey API key** ready (or set `PORTKEY_API_KEY` first).

Use the **same prefix** for every subcommand:

```bash
npx portkey setup
npx portkey status
npx portkey skills sync
npx portkey mcp add
```

---

## Claude Code

1. Run `npx portkey` → choose **Setup Claude Code**.
2. Paste your Portkey API key when asked.
3. Pick a **provider** or **Portkey config** for routing.
4. Optionally add **MCP** servers and sync **skills** (prompt partials → `SKILL.md`).

Config goes mainly into your shell profile and/or `.claude/` (the wizard explains each choice). Open a **new terminal** (or `source` your profile) after setup, then run `claude` as usual.

> **Shared / committed config (`PORTKEY_API_KEY`).** When you choose a git-tracked destination — `mcp add` → **Repo file (.mcp.json)** or `setup` → **Project (shared)** (`.claude/settings.json`) — the CLI **never** writes your key into the committed file. It writes the reference `"${PORTKEY_API_KEY}"` (Claude Code expands it from the environment at read time) and stores the real key in your shell profile (owner-only, `0600`). Each teammate just exports their own `PORTKEY_API_KEY`:
>
> ```bash
> export PORTKEY_API_KEY="pk-..."   # add to ~/.zshrc, ~/.bashrc, or CI secrets
> ```
>
> All files the CLI writes that hold a secret (shell profile, `~/.claude/settings.json`, `~/.codex/config.toml`) are created with `0600` permissions.

**Later, from your project folder:**

```bash
npx portkey skills sync --yes --agent claude
npx portkey mcp add
```

---

## Codex

1. Run `npx portkey` → choose **Setup Codex**.
2. Paste your Portkey API key when asked.
3. Pick routing (**provider** or **config**). The CLI updates `.codex/config.toml` with `base_url`, `PORTKEY_API_KEY`, and `wire_api` (`chat` = Chat Completions, `responses` = Responses API — same as [Portkey's Codex guide](https://portkey.ai/docs)).
4. Optionally add **MCP** (same Portkey registry) and sync **skills** into `.agents/skills/` (Codex's skill discovery location).

If you have **several Model Catalog providers**, the wizard can append extra `[model_providers.portkey-<slug>]` tables (each with its own `wire_api`). Switch the active route by editing `model_provider` and `model` (`@<slug>/<model-id>`) at the top of the file.

Non-interactive: pass `--codex-wire-api chat` or `--codex-wire-api responses`.

Then run `codex` from that project (or point Codex at the same directory).

**Refresh skills only:**

```bash
cd /path/to/your/project
npx portkey skills sync --yes --agent codex
```

---

## Useful commands


| Example                            | What it does                                                 |
| ---------------------------------- | ------------------------------------------------------------ |
| `npx portkey`                      | Interactive menu                                             |
| `npx portkey setup`                | Full wizard (Claude Code, Codex, or Cursor skills-only)      |
| `npx portkey status`               | Claude + Codex: routing hints and MCP counts                 |
| `npx portkey skills sync`          | Pull Prompt Partials from Portkey → local `SKILL.md` trees   |
| `npx portkey skills list`          | List partials in the workspace                               |
| `npx portkey mcp add`              | Pick **Claude Code** or **Codex**, then servers from Portkey |


**Skills:** list comes from the **Portkey API** for your workspace. You choose **where files are written** (`.claude/skills`, `.agents/skills` for Codex, `.cursor/skills`, project vs `--global`).

**MCP:** same registry on Portkey; Claude uses `~/.claude.json` / `.mcp.json`, Codex `[mcp_servers.*]` in `.codex/config.toml`.

**Non-interactive setup:** add `--yes` and flags such as `--portkey-key`, `--provider`, `--skip-mcp`, `--skip-skills`.

```bash
npx portkey --help
```

---

## Contributing

```bash
git clone https://github.com/portkey-ai/agent-cli.git
cd agent-cli
npm install
npm test
```

---

## Links

- [Portkey dashboard](https://app.portkey.ai) · [Docs](https://portkey.ai/docs)
