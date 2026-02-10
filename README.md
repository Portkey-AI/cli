# portkey

The Portkey CLI — manage AI gateway integrations.

```bash
npx portkey
```

Or clone and run locally:

```bash
git clone https://github.com/portkey-ai/cli.git && cd cli
npm install
node src/index.js
```

Running `portkey` with no arguments opens the interactive command picker:

```
┌  Portkey CLI v1.0.0
│
◆  Claude Code
│  ● Setup              configure routing through Portkey
│  ○ Discover            audit where config is currently set
│  ○ Verify              test gateway connectivity
│  ○ Uninstall           remove Portkey config
└
```

## Claude Code

Route [Claude Code](https://docs.anthropic.com/en/docs/claude-code) through [Portkey](https://portkey.ai) for observability, caching, rate limiting, and fallbacks.

### Routing Modes

**Provider routing** (default) — requests go through a provider in your [Model Catalog](https://app.portkey.ai/model-catalog). The wizard fetches your providers from the API and lets you pick with arrow keys:

```
◆  Select a provider
│  ● @anthropic       Anthropic Direct · anthropic · My Workspace
│  ○ @bedrock-prod    Bedrock uw1 · bedrock · My Workspace
│  ○ @openai          OpenAI Prod · openai · My Workspace
└
```

**Config routing** (`--config pc-xxxxx`) — uses a [Portkey Config](https://app.portkey.ai/configs) to define fallbacks, load balancing, retries, model routing, and more. Create a config in the dashboard, then pass its ID:

```bash
portkey setup --config pc-xxxxx
```

**OAuth passthrough** (`--mode oauth`) — keeps your Anthropic key, Portkey only logs. Uses `forward_headers` to pass `authorization` and `anthropic-beta` through transparently.

### Config Locations

The wizard writes to Claude Code's native `settings.json` format by default (not shell env vars):

| Location | Flag | File | Notes |
|---|---|---|---|
| Project local | `--location project-local` | `.claude/settings.local.json` | Gitignored, this machine only |
| Project shared | `--location project-shared` | `.claude/settings.json` | Committed, whole team |
| Global | `--location global` | `~/.claude/settings.json` | All projects on this machine |
| Shell env | `--location env` | `~/.bashrc` / `~/.zshrc` | Traditional env vars |

### Model Configuration

The setup wizard optionally lets you set a default model via **Advanced settings**. Supported values:

| Alias | Description |
|-------|-------------|
| `opus` | Latest Opus (complex reasoning) |
| `sonnet` | Latest Sonnet (daily coding) |
| `haiku` | Fast, efficient |
| `opusplan` | Opus for planning, Sonnet for execution |
| `default` | Account-dependent |
| Full name | e.g. `claude-sonnet-4-20250514` |

Use `--model opus` for non-interactive setup.

### CI / Non-Interactive

```bash
# Provider routing, global config
portkey setup --portkey-key pk-xxx --provider anthropic --location global --yes

# With model
portkey setup --portkey-key pk-xxx --provider ant --model opus --location global --yes

# Config routing (fallbacks, load balancing, etc.)
portkey setup --portkey-key pk-xxx --config pc-xxxxx --location global --yes

# OAuth passthrough, project-local
portkey setup --portkey-key pk-xxx --mode oauth --anthropic-key sk-xxx --location project-local --yes

# Bedrock via Portkey
portkey setup --portkey-key pk-xxx --provider bedrock-prod --location global --yes
```

### Commands

```bash
portkey                  # Interactive command picker
portkey setup            # Setup wizard (default)
portkey discover         # Audit all config layers
portkey verify           # Test gateway connectivity
portkey uninstall        # Remove Portkey config
portkey --help           # Full options reference
```

### What Gets Written

For a `settings.json` location (provider mode):
```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.portkey.ai",
    "ANTHROPIC_AUTH_TOKEN": "pk-xxx",
    "ANTHROPIC_CUSTOM_HEADERS": "x-portkey-provider:@anthropic"
  },
  "model": "opus"
}
```

For config routing, `ANTHROPIC_CUSTOM_HEADERS` uses `x-portkey-config:<config-id>` instead of `x-portkey-provider`.

For OAuth passthrough, `ANTHROPIC_CUSTOM_HEADERS` uses `x-portkey-config` with a base64-encoded `forward_headers` config. Claude Code uses `ANTHROPIC_CUSTOM_HEADERS` (not `ANTHROPIC_EXTRA_HEADERS`).

## Requirements

- **Node.js** >= 18 (for Claude Code and this CLI)
- [Portkey account](https://app.portkey.ai)

## Platform Support

Works on **macOS**, **Linux**, and **Windows**. Enterprise config paths are checked for all platforms (macOS `/Library`, Linux `/etc`, Windows `%ProgramData%` / `%LOCALAPPDATA%`).
