# Portkey CLI

Wire **[Claude Code](https://docs.anthropic.com/en/docs/claude-code)** or **[OpenAI Codex](https://developers.openai.com/codex)** to **[Portkey](https://portkey.ai)** (routing, logs, guardrails). Optionally add MCP servers and sync team skills from your workspace.

## Run it

[Node.js](https://nodejs.org/) 18+ required. Install and run **from GitHub** (no npm package name to remember):

```bash
npx github:portkey-ai/agent-cli
```

That opens the interactive menu (**Setup Claude Code** or **Setup Codex**). Have your **Portkey API key** ready (or set `PORTKEY_API_KEY` first).

Use the **same prefix** for every subcommand, for example:

```bash
npx github:portkey-ai/agent-cli skills sync
npx github:portkey-ai/agent-cli setup
npx github:portkey-ai/agent-cli status
npx github:portkey-ai/agent-cli mcp add
```

The CLI binary is `**portkey**`; `npx` pulls `github:portkey-ai/agent-cli` and runs it. A `**portkey**` package on npm may follow later for `npx portkey` / global install.

---

## Claude Code

1. Run `**npx github:portkey-ai/agent-cli**` → choose **Setup Claude Code**.
2. Paste your Portkey API key when asked.
3. Pick a **provider** or **Portkey config** for routing.
4. Optionally add **MCP** servers and sync **skills** (prompt partials → `SKILL.md`).

Config goes mainly into your shell profile and/or `.claude/` (the wizard explains each choice). Open a **new terminal** (or `source` your profile) after setup, then run `claude` as usual.

**Later, from your project folder:**

```bash
npx github:portkey-ai/agent-cli skills sync --yes --agent claude
npx github:portkey-ai/agent-cli mcp add
```

---

## Codex

1. Run `**npx github:portkey-ai/agent-cli**` → choose **Setup Codex**.
2. Paste your Portkey API key when asked.
3. Pick routing (**provider** or **config**). The CLI updates `**.codex/config.toml`** with `base_url`, `PORTKEY_API_KEY`, and `**wire_api**` (`chat` = Chat Completions, `responses` = Responses API — same as [Portkey’s Codex guide](https://portkey.ai/docs)).
4. Optionally add **MCP** (same Portkey registry) and sync **skills** into `**.codex/skills/`**.

If you have **several Model Catalog providers**, the wizard can append extra `**[model_providers.portkey-<slug>]`** tables (each with its own `**wire_api**`). Switch the active route by editing `**model_provider**` and `**model**` (`@<slug>/<model-id>`) at the top of the file.

Non-interactive: pass `**--codex-wire-api chat**` or `**--codex-wire-api responses**`.

Then run `**codex**` from that project (or point Codex at the same directory).

**Refresh skills only:**

```bash
cd /path/to/your/project
npx github:portkey-ai/agent-cli skills sync --yes --agent codex
```

---

## Useful commands


| Example                                       | What it does                                                 |
| --------------------------------------------- | ------------------------------------------------------------ |
| `npx github:portkey-ai/agent-cli`             | Interactive menu                                             |
| `npx github:portkey-ai/agent-cli setup`       | Full wizard (Claude Code, Codex, or Cursor skills-only)      |
| `npx github:portkey-ai/agent-cli status`      | Claude + Codex: routing hints and MCP counts                 |
| `npx github:portkey-ai/agent-cli skills sync` | Pull Prompt Partials from Portkey → local `SKILL.md` trees   |
| `npx github:portkey-ai/agent-cli skills list` | List partials in the workspace                               |
| `npx github:portkey-ai/agent-cli mcp add`     | Pick **Claude Code** or **Codex**, then servers from Portkey |


**Skills:** list comes from the **Portkey API** for your workspace. You choose **where files are written** (`.claude/skills`, `.codex/skills`, `.cursor/skills`, project vs `--global`).

**MCP:** same registry on Portkey; Claude uses `**~/.claude.json` / `.mcp.json`**, Codex `**[mcp_servers.*]**` in `**.codex/config.toml**`.

**Non-interactive setup:** add `--yes` and flags such as `--portkey-key`, `--provider`, `--skip-mcp`, `--skip-skills`.

```bash
npx github:portkey-ai/agent-cli --help
```

---

## Links

- [Portkey dashboard](https://app.portkey.ai) · [Docs](https://portkey.ai/docs)

