# OpenAI/Codex Agent Compatibility

## Overview

The agent Markdown format in this repository is compatible with OpenAI/Codex-style agents with minimal changes. The
primary difference is the `model` value in the YAML frontmatter.

## Models

- Defaults (Claude):
  - reasoning: `opus`
  - coding: `sonnet`
  - efficiency: `sonnet`
- Defaults (OpenAI/Codex):
  - reasoning: `gpt-5.6-sol`
  - coding: `gpt-5.6-terra`
  - efficiency: `gpt-5.6-luna`

Use the CLI to deploy agents for your target provider while overriding model names if needed:

```bash
# Claude
aiwg -deploy-agents --provider claude

# OpenAI/Codex (writes to .codex/agents)
aiwg -deploy-agents --provider openai

# Aggregate into a single AGENTS.md for Codex
aiwg -deploy-agents --provider openai --as-agents-md

# Custom model mapping (example)
aiwg -deploy-agents --provider openai \
  --reasoning-model gpt-5.6-sol \
  --coding-model gpt-5.6-terra \
  --efficiency-model gpt-5.6-luna
```

## Paths

- Claude: `.claude/agents/*.md`
- OpenAI/Codex: `.codex/agents/*.md`

For more details on Codex sub-agents and mechanics, see: <https://codexlog.io/mechanics/agents/sub-agents.html>
