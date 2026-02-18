# Portkey CLI

Route [Claude Code](https://docs.anthropic.com/en/docs/claude-code) through [Portkey](https://portkey.ai) for logging, caching, and guardrails.

## Quick Start

```bash
npx portkey setup
```

That's it! The wizard will:
1. Ask for your Portkey API key
2. Let you pick a provider from your Model Catalog
3. Write the config to your shell

Then run `source ~/.zshrc` (or open a new terminal) and start using Claude Code.

## Commands

```bash
npx portkey setup       # Configure Claude Code → Portkey
npx portkey discover    # See where config is set
npx portkey verify      # Test the connection
npx portkey uninstall   # Remove Portkey config
```

## Options

For CI or scripting:

```bash
npx portkey setup --portkey-key pk-xxx --provider ant --yes
```

| Flag | Description |
|------|-------------|
| `--portkey-key` | Portkey API key |
| `--provider` | Provider slug from Model Catalog (e.g., `ant`) |
| `--config` | Use a Portkey Config instead of provider |
| `--gateway` | Custom gateway URL |
| `--location` | Where to save: `env`, `global`, `project-local`, `project-shared` |
| `--advanced` | Show all options (model, location, gateway) |
| `--yes` | Skip confirmations |

## Bedrock / Vertex AI

For Bedrock or Vertex providers, the wizard will ask you to select model names since they differ from Anthropic's naming.

## Requirements

- Node.js >= 18
- [Portkey account](https://app.portkey.ai)
