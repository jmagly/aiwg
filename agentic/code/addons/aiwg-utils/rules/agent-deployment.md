---
enforcement: high
paths:
  - ".claude/agents/**"
  - ".factory/droids/**"
  - ".codex/agents/**"
  - ".opencode/agent/**"
  - "agentic/**"
  - "AGENTS.md"
---

# Agent Deployment Rules

**Enforcement Level**: HIGH
These rules apply when working with agent definitions and multi-provider deployment.

## Agent Ecosystem

### Categories

**General-Purpose Writing Agents** (`agentic/code/agents/`):
- `writing-validator` - Validates voice consistency and authenticity
- `prompt-optimizer` - Enhances prompts using AIWG principles
- `content-diversifier` - Generates varied examples and perspectives

**SDLC Framework Agents** (`agentic/code/frameworks/sdlc-complete/agents/`):
- 64 specialized agents covering all SDLC phases
- See `@$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/agents/manifest.json` for complete list

**Marketing Agents** (`agentic/code/frameworks/media-marketing-kit/agents/`):
- 37 marketing-focused agents covering campaign lifecycle
- See `@$AIWG_ROOT/agentic/code/frameworks/media-marketing-kit/agents/manifest.json` for complete list

## Multi-Provider Support

### Deployment Commands

```bash
# Claude Code (default - creates .claude/agents/)
aiwg -deploy-agents --mode sdlc

# GitHub Copilot (creates .github/agents/*.yaml + copilot-instructions.md)
aiwg -deploy-agents --provider copilot --mode sdlc

# Factory AI (creates .factory/droids/ + AGENTS.md)
aiwg -deploy-agents --provider factory --mode sdlc --deploy-commands --create-agents-md

# OpenCode (creates .opencode/agent/ + AGENTS.md)
aiwg -deploy-agents --provider opencode --mode sdlc --deploy-commands --create-agents-md

# Cursor (creates .cursor/rules/ + AGENTS.md)
aiwg -deploy-agents --provider cursor --mode sdlc --deploy-commands --create-agents-md

# OpenAI/Codex (creates .codex/agents/)
aiwg -deploy-agents --provider openai

# As single AGENTS.md file
aiwg -deploy-agents --provider openai --as-agents-md
```

### Model Override

Default models defined in `agentic/code/frameworks/sdlc-complete/config/models.json`.

```bash
aiwg -deploy-agents --provider factory \
  --reasoning-model <your-reasoning-model> \
  --coding-model <your-coding-model> \
  --efficiency-model <your-efficiency-model>
```

### Provider-Specific Guidance

- **Factory AI**: See `agentic/code/frameworks/sdlc-complete/agents/factory-compat.md`
- **OpenCode**: See `docs/integrations/opencode-quickstart.md`
- **Cursor**: See `docs/integrations/cursor-quickstart.md`
- **OpenAI/Codex**: See `agentic/code/frameworks/sdlc-complete/agents/openai-compat.md`

## Agent Definition Format

### Metadata Structure

```yaml
---
name: agent-name
description: Brief agent description
model: claude-sonnet-5|claude-opus-5|claude-haiku-4-5  # Pin variant. Bare aliases inherit parent-context attributes — under a 1M-context parent (`claude-opus-5[1m]`), subagent dispatch hits the usage-credit gate. See aiwg #1442.
tools: Read, Write, MultiEdit, Bash, WebFetch, Glob, Grep
orchestration: true|false
category: sdlc-setup|sdlc-orchestration|sdlc-management|...
---

# Agent Name

[Agent instructions and capabilities]
```

### Model Variant Pinning (CRITICAL)

Always pin a specific model variant in agent/skill/command frontmatter. Bare aliases (`sonnet`, `opus`, `haiku`) are resolved by the parent platform session. When the parent runs on a 1M-context variant such as `opus[1m]`, the alias resolution inherits 1M-context attributes and any subagent dispatch hits the credit-gated path:

```
API Error: Usage credits required for 1M context · run /usage-credits to turn them on, or /model to switch to standard context
```

Use the pinned 500K-context variants for AIWG agents:

| Bare alias (forbidden) | Pinned variant (required) | Notes |
|---|---|---|
| `model: sonnet` | `model: claude-sonnet-5` | Default balanced workhorse |
| `model: opus` | `model: claude-opus-5` | Complex reasoning (non-1M) |
| `model: haiku` | `model: claude-haiku-4-5` | Fast/simple tasks |

`aiwg doctor` flags any agent/skill/command frontmatter using a bare alias.

### Tool Selection Guidelines

| Task Type | Recommended Tools |
|-----------|------------------|
| Code analysis | Read, Glob, Grep |
| Code modification | Read, Write, MultiEdit |
| Build/test execution | Bash |
| Research | WebFetch, WebSearch |
| File discovery | Glob, Grep |

## Working with Agents

### Parallel Execution Pattern

Launch multiple agents in a single message:

```
Task(security-architect) -> Security validation
Task(test-architect) -> Testability review
Task(requirements-analyst) -> Requirements traceability
Task(technical-writer) -> Clarity and consistency
```

### Agent Isolation

All agents work independently with isolated contexts regardless of platform. Each agent:
- Has its own context window
- Cannot directly communicate with other agents
- Returns results to the orchestrator for synthesis
