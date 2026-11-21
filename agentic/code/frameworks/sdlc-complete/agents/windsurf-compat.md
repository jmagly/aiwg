# Devin Desktop Compatibility (EXPERIMENTAL)

> **Deprecated reference ID:** `windsurf-compat` stays discoverable for legacy installs.
> Use the canonical `devin` provider selector; internal paths remain unchanged.

> **WARNING**: Devin Desktop provider support is experimental and untested.
> Please report issues at: https://github.com/jmagly/aiwg/issues

## Overview

AIWG agents can be deployed to Devin Desktop using the `--provider devin` flag.
Unlike Claude Code and Factory, Devin Desktop does NOT use separate agent files.
Instead, AIWG generates an aggregated AGENTS.md file that Devin Desktop reads natively,
plus a `.windsurfrules` file with orchestration context.

## Key Differences

| Feature | Claude Code | Factory | Cursor | Devin Desktop |
|---------|-------------|---------|--------|----------|
| Agent location | `.claude/agents/*.md` | `.factory/droids/*.md` | `.cursor/agents/*.json` | `AGENTS.md` (aggregated) |
| Config file | `CLAUDE.md` | `AGENTS.md` | `.cursorrules` | `.windsurfrules` |
| Commands | `.claude/commands/` | `.factory/commands/` | Reference only | `.windsurf/workflows/` |
| Format | YAML frontmatter | YAML frontmatter | JSON | Plain markdown |
| Skills | `.claude/skills/` | Reference | Reference | Reference |

## Deployment

```bash
# Deploy SDLC agents to Devin Desktop
aiwg use sdlc --provider devin

# With commands (as workflows)
aiwg use sdlc --provider devin --deploy-commands

# Dry run to preview
aiwg use sdlc --provider devin --dry-run

# All frameworks
aiwg use all --provider devin
```

## Generated Structure

After deployment, your project will have:

```
project/
├── AGENTS.md                    # Aggregated agent definitions
├── .windsurfrules               # Orchestration context + key agents
└── .windsurf/
    └── workflows/               # Commands as workflows (if --deploy-commands)
        ├── flow-inception-to-elaboration.md
        ├── flow-security-review-cycle.md
        └── ...
```

## File Formats

### AGENTS.md

Devin Desktop reads AGENTS.md natively for directory-scoped instructions. AIWG generates
this file with all agents in plain markdown format (no YAML frontmatter):

```markdown
# AGENTS.md

> AIWG Agent Directory for Devin Desktop

## Table of Contents
- [architecture-designer](#architecture-designer)
- [requirements-analyst](#requirements-analyst)
...

---

### architecture-designer

> Designs scalable, maintainable system architectures

<capabilities>
- Read
- Write
- Bash
- Grep
</capabilities>

**Model**: opus

[Full agent instructions...]

---
```

### .windsurfrules

Contains orchestration context with natural language commands and key agent summaries:

```markdown
# AIWG Rules for Devin Desktop

<orchestration>
## AIWG SDLC Framework
**58 SDLC agents** | **100+ commands** | **49 skills**

### Natural Language Commands
- "transition to elaboration" | "move to elaboration"
- "run security review" | "validate security"
- "where are we" | "project status"
</orchestration>

<agents>
## Key Agents
### Executive Orchestrator
**Role**: Coordinate multi-agent workflows and phase transitions.
...
</agents>

<references>
- **All Agents**: @AGENTS.md
- **Templates**: @~/.local/share/ai-writing-guide/...
</references>
```

### Workflows

Commands are converted to Devin Desktop workflow format (plain markdown, no YAML):

```markdown
# Flow: Inception to Elaboration

> Transition from Inception to Elaboration phase

## Instructions

[Workflow instructions...]
```

Note: Devin Desktop workflows have a 12,000 character limit per file.

## Using Agents in Devin Desktop

Since agents are in AGENTS.md, invoke them via natural language:

```
"Use the architecture-designer instructions to create a SAD"
"Apply the security-architect guidelines to review this code"
"Follow the test-architect approach to design the test strategy"
```

Or reference the file directly:

```
"Read @AGENTS.md and use the requirements-analyst section"
```

## Workflows (Commands)

AIWG commands deployed as Devin Desktop workflows can be invoked with:

```
/flow-inception-to-elaboration
/project-status
/security-gate
```

## Models

Devin Desktop uses Claude models via API. The default model mappings are:

| Role | Model |
|------|-------|
| Reasoning | claude-opus-5 |
| Coding | claude-sonnet-5 |
| Efficiency | claude-haiku-4-5-20251001 |

Override with CLI flags:

```bash
aiwg use sdlc --provider devin \
  --reasoning-model claude-opus-5 \
  --coding-model claude-sonnet-5 \
  --efficiency-model claude-haiku-4-5-20251001
```

## Limitations

1. **No individual agent files** - All agents aggregated in AGENTS.md
2. **No dynamic tool selection** - Devin Desktop manages tool access internally
3. **Character limits** - Workflows limited to 12,000 characters each
4. **Skills not supported** - Reference skill files via @-mentions instead
5. **Experimental** - Format may change based on Devin Desktop updates

## Skills via Reference

Skills are not directly deployed to Devin Desktop. Instead, reference skill files in prompts:

```
"Follow @~/.local/share/ai-writing-guide/agentic/code/addons/aiwg-utils/skills/workspace-health/SKILL.md"
"Apply the voice profile at @~/.local/share/ai-writing-guide/agentic/code/addons/voice-framework/voices/templates/technical-authority.yaml"
```

## Differences from Cursor

While Cursor and Devin Desktop are both VS Code-based AI IDEs, they have different
configuration approaches:

| Aspect | Cursor | Devin Desktop |
|--------|--------|----------|
| Config file | `.cursorrules` | `.windsurfrules` |
| Agent files | `.cursor/agents/*.json` | None (inline in AGENTS.md) |
| Rules dir | `.cursor/rules/` | `.windsurf/rules/` |
| AGENTS.md | Not native | Native support |
| Workflows | Not supported | `.windsurf/workflows/` |
| Hooks | Not supported | Cascade Hooks (TypeScript) |

## Resources

- **Devin Desktop Docs**: https://docs.windsurf.com/
- **AGENTS.md Spec**: https://docs.windsurf.com/windsurf/cascade/agents-md
- **Workflows**: https://docs.windsurf.com/windsurf/cascade/workflows
- **AIWG Issues**: https://github.com/jmagly/aiwg/issues
- **AIWG Discord**: https://discord.gg/BuAusFMxdA

## Support

For Devin Desktop-specific questions:
- **Devin Desktop Docs**: https://docs.windsurf.com/
- **Devin Desktop Community**: Check Devin Desktop documentation for community links

For AIWG integration questions:
- **AIWG Issues**: https://github.com/jmagly/aiwg/issues
- **AIWG Discussions**: https://github.com/jmagly/aiwg/discussions
