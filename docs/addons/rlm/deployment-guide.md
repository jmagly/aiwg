# RLM Addon Deployment Guide

**Version**: 1.0.0
**Addon ID**: `rlm`
**Issue**: #328

## Overview

The RLM (Recursive Language Models) addon provides recursive context decomposition for processing arbitrarily large codebases and document corpora through programmatic sub-agent delegation. This guide documents resource deployment across AIWG's 13 named provider integrations; runtime delegation depends on provider capability.

### What Gets Deployed

| Artifact Type | Count | Names |
|---------------|-------|-------|
| **Agents** | 1 | `rlm-agent` |
| **Commands** | 3 | `rlm-query`, `rlm-batch`, `rlm-status` |
| **Skills** | 1 | `rlm-mode` |
| **Rules** | 1 | `rlm-context-management` |

**Total**: 6 artifacts

### Deployment Command

```bash
# Deploy to default provider (Claude Code)
aiwg use rlm

# Deploy to specific provider
aiwg use rlm --provider codex
aiwg use rlm --provider copilot
aiwg use rlm --provider factory
aiwg use rlm --provider cursor
aiwg use rlm --provider opencode
aiwg use rlm --provider warp
aiwg use rlm --provider windsurf

# Deploy to all providers
for provider in claude codex copilot factory cursor opencode warp windsurf; do
  aiwg use rlm --provider $provider
done
```

## Deployment Matrix

### Full Cross-Provider Deployment Table

| Artifact | Claude Code | Codex | Copilot | Factory | Cursor | OpenCode | Warp | Windsurf |
|----------|-------------|-------|---------|---------|--------|----------|------|----------|
| **rlm-agent.md** | `.claude/agents/` | `.codex/agents/` | `.github/agents/` | `.factory/droids/` | `.cursor/agents/` | `.opencode/agent/` | `.warp/agents/` + WARP.md | AGENTS.md |
| **rlm-query.md** | `.claude/commands/` | `~/.codex/prompts/` | `.github/agents/` (YAML) | `.factory/commands/` | `.cursor/commands/` | `.opencode/commands/` | `.warp/commands/` + WARP.md | `.windsurf/workflows/` |
| **rlm-batch.md** | `.claude/commands/` | `~/.codex/prompts/` | `.github/agents/` (YAML) | `.factory/commands/` | `.cursor/commands/` | `.opencode/commands/` | `.warp/commands/` + WARP.md | `.windsurf/workflows/` |
| **rlm-status.md** | `.claude/commands/` | `~/.codex/prompts/` | `.github/agents/` (YAML) | `.factory/commands/` | `.cursor/commands/` | `.opencode/commands/` | `.warp/commands/` + WARP.md | `.windsurf/workflows/` |
| **rlm-mode.md** | `.claude/skills/` | `.agents/skills/` with `--copy-all` | `.github/skills/` | `.factory/skills/` | `.cursor/skills/` | `.opencode/skill/` | `.warp/skills/` | `.windsurf/skills/` |
| **rlm-context-management.md** | `.claude/rules/` | `.codex/rules/` | `.github/copilot-rules/` | `.factory/rules/` | `.cursor/rules/` | `.opencode/rule/` | `.warp/rules/` | `.windsurf/rules/` |

### Provider-Specific Path Details

#### Claude Code
```
.claude/
├── agents/
│   └── rlm-agent.md
├── commands/
│   ├── rlm-query.md
│   ├── rlm-batch.md
│   └── rlm-status.md
├── skills/
│   └── rlm-mode.md
└── rules/
    └── rlm-context-management.md
```

#### Codex (OpenAI)
```
# Project-local
.codex/
├── agents/
│   └── rlm-agent.md
└── rules/
    └── rlm-context-management.md

.agents/
└── skills/
    └── rlm-mode/
        ├── SKILL.md
        └── agents/openai.yaml

# User-level (home directory)
~/.codex/
├── prompts/
│   ├── rlm-query.md
│   ├── rlm-batch.md
│   └── rlm-status.md
```

**Special Handling**: Commands remain user-level prompts. Codex-native skills
use the project `.agents/skills/` path and include `agents/openai.yaml` UI
metadata. AIWG copies kernel skills there by default; add `--copy-all` when the
standard `rlm-mode` skill must also appear as a native `$` skill. Otherwise,
RLM remains available through AIWG discovery and its command prompts.

#### GitHub Copilot
```
.github/
├── agents/
│   ├── rlm-agent.md
│   ├── rlm-query.yml        # Command converted to YAML
│   ├── rlm-batch.yml        # Command converted to YAML
│   └── rlm-status.yml       # Command converted to YAML
├── skills/
│   └── rlm-mode.md
└── copilot-rules/
    └── rlm-context-management.md
```

**Special Handling**: Commands are converted to YAML agent format and deployed alongside agents.

#### Factory AI
```
.factory/
├── droids/
│   └── rlm-agent.md
├── commands/
│   ├── rlm-query.md
│   ├── rlm-batch.md
│   └── rlm-status.md
├── skills/
│   └── rlm-mode.md
└── rules/
    └── rlm-context-management.md
```

#### Cursor
```
.cursor/
├── agents/
│   └── rlm-agent.md
├── commands/
│   ├── rlm-query.md
│   ├── rlm-batch.md
│   └── rlm-status.md
├── skills/
│   └── rlm-mode.md
└── rules/
    └── rlm-context-management.md
```

#### OpenCode
```
.opencode/
├── agent/              # Singular!
│   └── rlm-agent.md
├── command/            # Singular!
│   ├── rlm-query.md
│   ├── rlm-batch.md
│   └── rlm-status.md
├── skill/              # Singular!
│   └── rlm-mode.md
└── rule/               # Singular!
    └── rlm-context-management.md
```

**Special Handling**: OpenCode uses singular directory names, not plural.

#### Warp Terminal
```
# Discrete files
.warp/
├── agents/
│   └── rlm-agent.md
├── commands/
│   ├── rlm-query.md
│   ├── rlm-batch.md
│   └── rlm-status.md
├── skills/
│   └── rlm-mode.md
└── rules/
    └── rlm-context-management.md

# Aggregated file (project root)
WARP.md  # Contains rlm-agent + all commands
```

**Special Handling**: Agents and commands are also aggregated into single-file `WARP.md` for quick context loading.

#### Windsurf
```
# Aggregated agents file (project root)
AGENTS.md  # Contains rlm-agent

# Discrete artifacts
.windsurf/
├── workflows/
│   ├── rlm-query.md
│   ├── rlm-batch.md
│   └── rlm-status.md
├── skills/
│   └── rlm-mode.md
└── rules/
    └── rlm-context-management.md
```

**Special Handling**: Agents are aggregated into `AGENTS.md` at project root. Commands deploy to `.windsurf/workflows/`.

## Provider-Specific Deployment Details

### Claude Code

**Installation**:
```bash
aiwg use rlm
```

**What Happens**:
- Copies all 6 artifacts to `.claude/` directories
- No transformations needed
- Native support for all artifact types

**Verification**:
```bash
ls .claude/agents/rlm-agent.md
ls .claude/commands/rlm-*.md
ls .claude/skills/rlm-mode.md
ls .claude/rules/rlm-context-management.md
```

**Sub-Agent Spawning**:
```bash
# RLM uses Claude CLI for sub-agents
claude -p "sub-task query"
```

### Codex (OpenAI)

**Installation**:
```bash
aiwg use rlm --provider codex
```

**What Happens**:
- Agents → `.codex/agents/`
- Commands → `~/.codex/prompts/` (home directory)
- Kernel skills → `.agents/skills/` (project-local)
- Standard RLM skill → AIWG discovery by default, or `.agents/skills/rlm-mode/` with `--copy-all`
- Rules → `.codex/rules/`

**Why the split**:
Codex prompts remain user-level, while project-native skills are discovered
from `.agents/skills/`. Keeping standard skills index-driven by default avoids
an unbounded native skill list; `--copy-all` is the explicit opt-in.

**Verification**:
```bash
# Project-local
ls .codex/agents/rlm-agent.md
ls .codex/rules/rlm-context-management.md
ls .agents/skills/aiwg-regenerate/agents/openai.yaml

# User-level commands
ls ~/.codex/prompts/rlm-*.md

# Optional native RLM skill after deployment with --copy-all
ls .agents/skills/rlm-mode/SKILL.md
```

**Sub-Agent Spawning**:
```bash
# RLM uses Codex CLI for sub-agents
codex -q "sub-task query"
```

**Note**: RLM agent definition for Codex must use `codex -q` instead of `claude -p` for sub-agent delegation.

### GitHub Copilot

**Installation**:
```bash
aiwg use rlm --provider copilot
```

**What Happens**:
- Agents → `.github/agents/` (markdown)
- Commands → `.github/agents/` (converted to YAML format)
- Skills → `.github/skills/`
- Rules → `.github/copilot-rules/`

**Command Transformation**:
AIWG automatically converts command markdown to Copilot's YAML agent format:

```yaml
# Example: rlm-query.yml
name: rlm-query
description: Execute recursive query with automatic context decomposition
triggers:
  - /rlm-query
agent_type: command
# ... rest of YAML structure
```

**Verification**:
```bash
ls .github/agents/rlm-agent.md
ls .github/agents/rlm-query.yml
ls .github/agents/rlm-batch.yml
ls .github/agents/rlm-status.yml
ls .github/skills/rlm-mode.md
ls .github/copilot-rules/rlm-context-management.md
```

**Sub-Agent Spawning**:
Limited support. Copilot does not natively support programmatic sub-agent spawning. RLM will operate in degraded mode (no recursive delegation).

### Factory AI

**Installation**:
```bash
aiwg use rlm --provider factory
```

**What Happens**:
- Agents → `.factory/droids/`
- Commands → `.factory/commands/`
- Skills → `.factory/skills/`
- Rules → `.factory/rules/`

**Verification**:
```bash
ls .factory/droids/rlm-agent.md
ls .factory/commands/rlm-*.md
ls .factory/skills/rlm-mode.md
ls .factory/rules/rlm-context-management.md
```

**Sub-Agent Spawning**:
```bash
# Factory AI CLI for sub-agents
factory run --agent rlm-agent --query "sub-task"
```

### Cursor

**Installation**:
```bash
aiwg use rlm --provider cursor
```

**What Happens**:
- Copies all 6 artifacts to `.cursor/` directories
- No transformations needed
- Native support for all artifact types

**Verification**:
```bash
ls .cursor/agents/rlm-agent.md
ls .cursor/commands/rlm-*.md
ls .cursor/skills/rlm-mode.md
ls .cursor/rules/rlm-context-management.md
```

**Sub-Agent Spawning**:
```bash
# Cursor CLI for sub-agents
cursor-agent run "sub-task query"
```

### OpenCode

**Installation**:
```bash
aiwg use rlm --provider opencode
```

**What Happens**:
- Agents → `.opencode/agent/` (singular)
- Commands → `.opencode/commands/` (plural)
- Skills → `.opencode/skill/` (singular)
- Rules → `.opencode/rule/` (singular)

**Verification**:
```bash
ls .opencode/agent/rlm-agent.md
ls .opencode/commands/rlm-*.md
ls .opencode/skill/rlm-mode.md
ls .opencode/rule/rlm-context-management.md
```

**Sub-Agent Spawning**:
```bash
# OpenCode CLI for sub-agents
opencode query "sub-task"
```

### Warp Terminal

**Installation**:
```bash
aiwg use rlm --provider warp
```

**What Happens**:
- Discrete files → `.warp/agents/`, `.warp/commands/`, `.warp/skills/`, `.warp/rules/`
- Aggregated → Appends agent + commands to `WARP.md`

**Verification**:
```bash
# Discrete
ls .warp/agents/rlm-agent.md
ls .warp/commands/rlm-*.md
ls .warp/skills/rlm-mode.md
ls .warp/rules/rlm-context-management.md

# Aggregated
grep -q "# Agent: rlm-agent" WARP.md && echo "Agent aggregated"
grep -q "# Command: rlm-query" WARP.md && echo "Commands aggregated"
```

**Sub-Agent Spawning**:
```bash
# Warp terminal commands for sub-agents
warp run-agent "rlm-agent" --query "sub-task"
```

### Windsurf

**Installation**:
```bash
aiwg use rlm --provider windsurf
```

**What Happens**:
- Agent → Appended to `AGENTS.md` at project root
- Commands → `.windsurf/workflows/`
- Skills → `.windsurf/skills/`
- Rules → `.windsurf/rules/`

**Verification**:
```bash
# Aggregated agent
grep -q "# Agent: rlm-agent" AGENTS.md && echo "Agent aggregated"

# Discrete artifacts
ls .windsurf/workflows/rlm-*.md
ls .windsurf/skills/rlm-mode.md
ls .windsurf/rules/rlm-context-management.md
```

**Sub-Agent Spawning**:
```bash
# Windsurf workflow execution
windsurf exec --workflow "rlm-query" --input "sub-task"
```

## Quick Start by Provider

### Claude Code
```bash
# Install
aiwg use rlm

# Verify
ls .claude/agents/rlm-agent.md

# Use
/rlm-query "Analyze all TypeScript files for async/await patterns"
```

### Codex
```bash
# Install
aiwg use rlm --provider codex

# Verify
ls ~/.codex/prompts/rlm-query.md .agents/skills/aiwg-regenerate/agents/openai.yaml

# Use
codex -q "rlm-query: Analyze all TypeScript files for async/await patterns"
```

### Copilot
```bash
# Install
aiwg use rlm --provider copilot

# Verify
ls .github/agents/rlm-query.yml

# Use (limited - no sub-agent spawning)
# Use GitHub Copilot chat interface to invoke rlm-query command
```

### Factory AI
```bash
# Install
aiwg use rlm --provider factory

# Verify
ls .factory/droids/rlm-agent.md

# Use
factory run --agent rlm-agent --query "Analyze all TypeScript files"
```

### Cursor
```bash
# Install
aiwg use rlm --provider cursor

# Verify
ls .cursor/agents/rlm-agent.md

# Use
# Invoke via Cursor command palette or agent interface
```

### OpenCode
```bash
# Install
aiwg use rlm --provider opencode

# Verify
ls .opencode/agent/rlm-agent.md

# Use
opencode query "rlm-query: Analyze all TypeScript files"
```

### Warp
```bash
# Install
aiwg use rlm --provider warp

# Verify
ls .warp/agents/rlm-agent.md
grep "rlm-agent" WARP.md

# Use
warp run-agent "rlm-agent" --query "Analyze all TypeScript files"
```

### Windsurf
```bash
# Install
aiwg use rlm --provider windsurf

# Verify
grep "rlm-agent" AGENTS.md

# Use
windsurf exec --workflow "rlm-query" --input "Analyze all TypeScript files"
```

## Sub-Agent Spawning Support

RLM's core capability is recursive context decomposition via sub-agent spawning. Provider support varies:

| Provider | Sub-Agent Support | Status | Notes |
|----------|-------------------|--------|-------|
| **Claude Code** | ✅ Full | Native | Uses `claude -p` CLI |
| **Codex** | ✅ Full | Native | Uses `codex -q` CLI |
| **Factory** | ✅ Full | Native | Uses `factory run` CLI |
| **Cursor** | ⚠️ Partial | Limited | Manual invocation only |
| **OpenCode** | ✅ Full | Native | Uses `opencode query` |
| **Warp** | ✅ Full | Native | Uses `warp run-agent` |
| **Windsurf** | ⚠️ Partial | Limited | Workflow-based, not programmatic |
| **Copilot** | ❌ None | Degraded | No sub-agent API |

### Degraded Mode Behavior

For providers without sub-agent spawning support (Copilot):

- RLM operates in **single-agent mode**
- No recursive decomposition
- Processes entire context in one pass
- Still applies RLM's context management rules
- Falls back to traditional chunking if context exceeds limits

## Uninstallation

Remove RLM from a provider:

```bash
# Claude Code
aiwg remove rlm

# Specific provider
aiwg remove rlm --provider codex

# All providers
for provider in claude codex copilot factory cursor opencode warp windsurf; do
  aiwg remove rlm --provider $provider
done
```

**Manual Cleanup**:

If `aiwg remove` fails, manually delete:

| Provider | Files to Delete |
|----------|----------------|
| Claude Code | `.claude/agents/rlm-agent.md`, `.claude/commands/rlm-*.md`, `.claude/skills/rlm-mode.md`, `.claude/rules/rlm-context-management.md` |
| Codex | `.codex/agents/rlm-agent.md`, `~/.codex/prompts/rlm-*.md`, optional `.agents/skills/rlm-mode/` from `--copy-all`, `.codex/rules/rlm-context-management.md` |
| Copilot | `.github/agents/rlm-*.{md,yml}`, `.github/skills/rlm-mode.md`, `.github/copilot-rules/rlm-context-management.md` |
| Factory | `.factory/droids/rlm-agent.md`, `.factory/commands/rlm-*.md`, `.factory/skills/rlm-mode.md`, `.factory/rules/rlm-context-management.md` |
| Cursor | `.cursor/agents/rlm-agent.md`, `.cursor/commands/rlm-*.md`, `.cursor/skills/rlm-mode.md`, `.cursor/rules/rlm-context-management.md` |
| OpenCode | `.opencode/agent/rlm-agent.md`, `.opencode/commands/rlm-*.md`, `.opencode/skill/rlm-mode.md`, `.opencode/rule/rlm-context-management.md` |
| Warp | `.warp/agents/rlm-agent.md`, `.warp/commands/rlm-*.md`, `.warp/skills/rlm-mode.md`, `.warp/rules/rlm-context-management.md`, remove from `WARP.md` |
| Windsurf | Remove from `AGENTS.md`, `.windsurf/workflows/rlm-*.md`, `.windsurf/skills/rlm-mode.md`, `.windsurf/rules/rlm-context-management.md` |

## Verification Checklist

After deploying RLM to any provider:

- [ ] Agent file exists at provider-specific agent location
- [ ] All 3 command files exist at provider-specific command location
- [ ] Skill file exists at provider-specific skill location
- [ ] Rule file exists at provider-specific rule location
- [ ] For Warp: Agent and commands also aggregated in `WARP.md`
- [ ] For Windsurf: Agent aggregated in `AGENTS.md`
- [ ] For Copilot: Commands converted to YAML format
- [ ] For Codex: Commands in `~/.codex/prompts/`; native skills in project `.agents/skills/`
- [ ] Provider-specific CLI command works (if applicable)
- [ ] Sub-agent spawning works (for supported providers)

## Troubleshooting

### Deployment Fails

**Symptom**: `aiwg use rlm --provider <name>` fails

**Check**:
1. Provider name spelled correctly (lowercase)
2. The provider is one of AIWG's 13 named integrations (`aiwg help`)
3. Permissions to write to target directories
4. For Codex: Home prompt directory and project `.agents/skills/` are writable

**Solution**:
```bash
# Verify provider support
aiwg catalog list --type provider

# Check write permissions
mkdir -p .claude/agents && echo "writable" > .claude/agents/test.txt && rm .claude/agents/test.txt
```

### Sub-Agent Spawning Doesn't Work

**Symptom**: RLM tries to spawn sub-agents but fails

**Check**:
1. Provider supports sub-agent spawning (see support table above)
2. Provider CLI installed and in PATH
3. Provider CLI authentication configured

**Solution**:
```bash
# Claude
which claude && claude --version

# Codex
which codex && codex --version

# Factory
which factory && factory --version
```

### Commands Not Found

**Symptom**: Commands don't appear in provider

**Check**:
1. Commands deployed to correct location for provider
2. For Codex: Check `~/.codex/prompts/` not `.codex/prompts/`
3. For Copilot: Check YAML files created in `.github/agents/`
4. For Warp: Check both `.warp/commands/` AND `WARP.md`
5. For Windsurf: Check `.windsurf/workflows/` not `.windsurf/commands/`

**Solution**:
```bash
# Verify command locations per provider (see Deployment Matrix above)
# Re-deploy if needed
aiwg remove rlm --provider <name>
aiwg use rlm --provider <name>
```

### Aggregation Files Not Updated

**Symptom**: Warp `WARP.md` or Windsurf `AGENTS.md` missing RLM content

**Check**:
1. File exists before deployment (if not, AIWG creates it)
2. File is writable
3. Deployment command completed successfully

**Solution**:
```bash
# Warp
if [ ! -f WARP.md ]; then touch WARP.md; fi
aiwg use rlm --provider warp

# Windsurf
if [ ! -f AGENTS.md ]; then touch AGENTS.md; fi
aiwg use rlm --provider windsurf
```

## Limitations by Provider

### Copilot Limitations
- No programmatic sub-agent spawning
- RLM operates in degraded single-agent mode
- Recursive decomposition not available
- Commands must be invoked manually via Copilot chat

### Windsurf Limitations
- Sub-agent spawning is workflow-based, not programmatic
- Limited recursive depth (workflows don't spawn workflows)
- Best for shallow task decomposition

### Cursor Limitations
- Sub-agent invocation requires manual triggering
- No automatic recursive decomposition
- Suitable for single-level task delegation only

## Support

For RLM deployment issues:

- **GitHub Issues**: https://github.com/jmagly/aiwg/issues
- **Discord**: https://discord.gg/BuAusFMxdA
- **Telegram**: https://t.me/+oJg9w2lE6A5lOGFh

## References

- `@$AIWG_ROOT/agentic/code/addons/rlm/manifest.json` - Addon manifest
- `@$AIWG_ROOT/agentic/code/addons/rlm/README.md` - RLM overview
- `@CLAUDE.md` - Multi-platform support table
- `@$AIWG_ROOT/docs/cli-reference.md` - CLI command documentation
- `@$AIWG_ROOT/agentic/code/addons/rlm/agents/rlm-agent.md` - RLM agent definition
- `@$AIWG_ROOT/agentic/code/addons/rlm/commands/` - Command definitions

---

**Last Updated**: 2026-08-02
**Issue**: #328
