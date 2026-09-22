# Factory AI Droid Compatibility

## Overview

The agent Markdown format in this repository is fully compatible with Factory AI's custom droid system. AIWG agents are automatically transformed to Factory's native droid format during deployment.

## Format Differences

### AIWG/Claude Format

```yaml
---
name: architecture-designer
description: Designs scalable, maintainable system architectures
model: claude-opus-5
---

[System prompt...]
```

### Factory Droid Format

```yaml
---
name: Architecture Designer
description: Designs scalable, maintainable system architectures and makes critical technical decisions for software projects
model: claude-opus-5
tools: ["Read", "LS", "Grep", "Glob", "Edit", "Create", "Execute"]
---

[System prompt...]
```

**Key Differences:**
- Factory requires explicit `tools` array
- Factory uses full Claude model identifiers (not shorthand)
- Factory supports both project (`.factory/droids/`) and personal (`~/.factory/droids/`) locations

## Models

- **AIWG defaults (Claude shorthand)**:
  - reasoning: `opus`
  - coding: `sonnet`
  - efficiency: `haiku`
  
- **Factory defaults (full identifiers)**:
  - Defined in: `agentic/code/frameworks/sdlc-complete/config/models.json`
  - Current defaults (see config file for latest):
    - reasoning: Claude Opus (latest stable)
    - coding: Claude Sonnet (latest stable)
    - efficiency: Claude Haiku (latest stable)

**Model Configuration**:
- Models are loaded from `models.json` configuration file
- Priority: Project `models.json` > User `~/.config/aiwg/models.json` > AIWG defaults
- Users can customize models without editing deployment scripts

Model mapping is automatic during deployment. The deploy script detects the original model type and maps to the appropriate Factory model using the configuration.

## Deployment

Use the deployment script to deploy agents for Factory:

```bash
# Deploy to current project
aiwg -deploy-agents --provider factory --mode sdlc

# Deploy commands too
aiwg -deploy-commands --provider factory --mode sdlc

# Or deploy everything at once
aiwg -deploy-agents --provider factory --mode both --deploy-commands
```

### Custom Model Mapping

Override model mappings if needed:

```bash
aiwg -deploy-agents --provider factory --mode sdlc \
  --reasoning-model claude-opus-5 \
  --coding-model claude-sonnet-5 \
  --efficiency-model claude-haiku-4-5
```

### Global (Personal) Deployment

Deploy to your personal droids directory for cross-project use:

```bash
aiwg -deploy-agents --provider factory --mode sdlc --target ~/.factory
```

## Paths

- **AIWG/Claude**: `.claude/agents/*.md`
- **OpenAI/Codex**: `.codex/agents/*.md`
- **Factory** (project): `.factory/droids/*.md`
- **Factory** (personal): `~/.factory/droids/*.md`

## Tools

Factory droids require explicit tool declarations. AIWG **automatically maps Claude Code tools to Factory equivalents** during deployment.

### Tool Mapping

**Claude Code → Factory (Anthropic Tools):**

Factory uses Anthropic's tool naming conventions. AIWG maps Claude Code tools to these standard names:

| Claude Code | Factory/Anthropic Equivalent | Notes |
|-------------|------------------------------|-------|
| `Bash` | `Execute` | Shell command execution |
| `Write` | `Create`, `Edit` | File creation and modification |
| `WebFetch` | `FetchUrl`, `WebSearch` | Web content retrieval |
| `MultiEdit` | `MultiEdit`, `ApplyPatch` | Multiple file edits and patch application |
| `Read`, `Grep`, `Glob`, `LS` | Same names | Already Anthropic tools |

**Note:** Factory respects Anthropic's tool naming, so all mapped tools use standard Anthropic tool IDs.

### Automatic Tool Enhancements

**Orchestration agents** automatically receive additional tools:
- **Task** - Invoke other droids as subagents
- **TodoWrite** - Track progress and coordinate work

**Orchestration agents include:**
- executive-orchestrator
- intake-coordinator
- documentation-synthesizer
- project-manager
- deployment-manager
- test-architect
- architecture-designer
- requirements-analyst
- security-architect
- technical-writer

### Example Transformation

**Original (Claude Code):**
```yaml
---
name: Architecture Designer
description: Designs scalable, maintainable system architectures
model: claude-opus-5
tools: Bash, Glob, Grep, MultiEdit, Read, WebFetch, Write
---
```

**Deployed (Factory):**
```yaml
---
name: Architecture Designer
description: Designs scalable, maintainable system architectures
model: claude-opus-5
tools: ["ApplyPatch", "Create", "Edit", "Execute", "FetchUrl", "Glob", "Grep", "MultiEdit", "Read", "Task", "TodoWrite", "WebSearch"]
---
```

**Changes:**
- ✅ `Bash` → `Execute` (Anthropic tool)
- ✅ `Write` → `Create` + `Edit` (Anthropic tools)
- ✅ `WebFetch` → `FetchUrl` + `WebSearch` (Anthropic tools)
- ✅ `MultiEdit` → `MultiEdit` + `ApplyPatch` (Anthropic tools)
- ✅ Added `Task` (Factory tool for invoking subagents)
- ✅ Added `TodoWrite` (Anthropic tool for progress tracking)

### Customizing Tools Post-Deployment

You can further restrict tools after deployment:

```bash
# Edit a droid
code .factory/droids/architecture-designer.md

# Modify tools array in frontmatter
tools: ["Read", "LS", "Grep", "Glob", "Edit", "Create"]  # Removed Execute
```

**Common tool restrictions:**
- **Read-only droids**: `["Read", "LS", "Grep", "Glob"]`
- **Documentation droids**: `["Read", "LS", "Grep", "Glob", "Edit", "Create", "ApplyPatch"]`
- **Code modification droids**: `["Read", "LS", "Grep", "Glob", "Edit", "Create", "MultiEdit", "ApplyPatch", "Execute"]`
- **Orchestration droids**: `["Read", "LS", "Grep", "Glob", "Edit", "Create", "MultiEdit", "ApplyPatch", "Execute", "Task", "TodoWrite"]`
- **Full access droids**: `["Read", "LS", "Grep", "Glob", "Edit", "Create", "MultiEdit", "ApplyPatch", "Execute", "Task", "TodoWrite", "WebSearch", "FetchUrl"]`

**All tools are Anthropic standard tools**, ensuring compatibility across Factory and other Anthropic-based platforms.

## Using Factory Droids

### Direct Invocation

Factory droids can be invoked directly via natural language:

```text
"Use architecture-designer to create the SAD"
"Ask security-architect to review authentication"
"Have test-engineer create test plan"
```

### Multi-Agent Orchestration

Factory handles multi-agent workflows automatically:

```text
"Create architecture baseline"
→ Factory coordinates:
  1. architecture-designer (draft)
  2. security-architect (review)
  3. test-architect (review)
  4. requirements-analyst (review)
  5. documentation-synthesizer (merge)
```

### Task Tool

Factory provides a Task tool for explicit droid invocation with structured prompts.

## Differences from Claude Code

**Claude Code:**
- Agents in `.claude/agents/`
- XML-style invocation via `<agent>` tags
- No built-in orchestration
- Single location

**Factory:**
- Droids in `.factory/droids/` (project) or `~/.factory/droids/` (personal)
- Natural language invocation
- Built-in multi-agent orchestration
- Project and personal droid locations

## Differences from OpenAI/Codex

**OpenAI/Codex:**
- Agents in `.codex/agents/`
- Can aggregate to single AGENTS.md file
- Primarily gpt-* models
- No built-in orchestration

**Factory:**
- Droids in `.factory/droids/`
- Individual droid files (not aggregated)
- Claude models (opus, sonnet, haiku)
- Built-in multi-agent orchestration

## Quick Start

See the comprehensive Factory quickstart guide:

**Location**: `docs/integrations/factory-quickstart.md`

**Quick Commands**:

```bash
# Install AIWG
curl -fsSL https://raw.githubusercontent.com/jmagly/ai-writing-guide/main/tools/install/install.sh | bash

# Deploy to Factory project
cd /path/to/project
aiwg -deploy-agents --provider factory --mode sdlc --deploy-commands

# Verify deployment
ls .factory/droids/    # Should show 53 SDLC droids
ls .factory/commands/  # Should show 42+ commands
```

## Resources

- **Factory AI Documentation**: https://docs.factory.ai/
- **Factory Quickstart**: `docs/integrations/factory-quickstart.md`
- **AIWG Repository**: https://github.com/jmagly/aiwg
- **Deployment Script**: `tools/agents/deploy-agents.mjs`

## Support

For Factory-specific questions:
- **Factory AI Docs**: https://docs.factory.ai/
- **Factory GitHub**: Check Factory AI documentation for issue tracker

For AIWG integration questions:
- **AIWG Issues**: https://github.com/jmagly/aiwg/issues
- **AIWG Discussions**: https://github.com/jmagly/aiwg/discussions
