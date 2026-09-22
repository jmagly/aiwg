# Windsurf Compatibility (EXPERIMENTAL)

> **WARNING**: Windsurf provider support is experimental and untested.
> Please report issues at: https://github.com/jmagly/aiwg/issues

## Overview

AIWG agents can be deployed to Windsurf using the `--provider windsurf` flag.
Unlike Claude Code and Factory, Windsurf does NOT use separate agent files.
Instead, AIWG generates an aggregated AGENTS.md file that Windsurf reads natively,
plus a `.windsurfrules` file with orchestration context.

## Key Differences

| Feature | Claude Code | Factory | Cursor | Windsurf |
|---------|-------------|---------|--------|----------|
| Agent location | `.claude/agents/*.md` | `.factory/droids/*.md` | `.cursor/agents/*.json` | `AGENTS.md` (aggregated) |
| Config file | `CLAUDE.md` | `AGENTS.md` | `.cursorrules` | `.windsurfrules` |
| Commands | `.claude/commands/` | `.factory/commands/` | Reference only | `.windsurf/workflows/` |
| Format | YAML frontmatter | YAML frontmatter | JSON | Plain markdown |
| Skills | `.claude/skills/` | Reference | Reference | Reference |

## Deployment

```bash
# Deploy SDLC agents to Windsurf
aiwg use sdlc --provider windsurf

# With commands (as workflows)
aiwg use sdlc --provider windsurf --deploy-commands

# Dry run to preview
aiwg use sdlc --provider windsurf --dry-run

# All frameworks
aiwg use all --provider windsurf
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

Windsurf reads AGENTS.md natively for directory-scoped instructions. AIWG generates
this file with all agents in plain markdown format (no YAML frontmatter):

```markdown
# AGENTS.md

> AIWG Agent Directory for Windsurf

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
# AIWG Rules for Windsurf

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

Commands are converted to Windsurf workflow format (plain markdown, no YAML):

```markdown
# Flow: Inception to Elaboration

> Transition from Inception to Elaboration phase

## Instructions

[Workflow instructions...]
```

Note: Windsurf workflows have a 12,000 character limit per file.

## Using Agents in Windsurf

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

AIWG commands deployed as Windsurf workflows can be invoked with:

```
/flow-inception-to-elaboration
/project-status
/security-gate
```

## Models

Windsurf uses Claude models via API. The default model mappings are:

| Role | Model |
|------|-------|
| Reasoning | claude-opus-5 |
| Coding | claude-sonnet-5 |
| Efficiency | claude-haiku-4-5-20251001 |

Override with CLI flags:

```bash
aiwg use sdlc --provider windsurf \
  --reasoning-model claude-opus-5 \
  --coding-model claude-sonnet-5 \
  --efficiency-model claude-haiku-4-5-20251001
```

## Limitations

1. **No individual agent files** - All agents aggregated in AGENTS.md
2. **No dynamic tool selection** - Windsurf manages tool access internally
3. **Character limits** - Workflows limited to 12,000 characters each
4. **Skills not supported** - Reference skill files via @-mentions instead
5. **Experimental** - Format may change based on Windsurf updates

## Skills via Reference

Skills are not directly deployed to Windsurf. Instead, reference skill files in prompts:

```
"Follow @~/.local/share/ai-writing-guide/agentic/code/addons/aiwg-utils/skills/workspace-health/SKILL.md"
"Apply the voice profile at @~/.local/share/ai-writing-guide/agentic/code/addons/voice-framework/voices/templates/technical-authority.yaml"
```

## Differences from Cursor

While Cursor and Windsurf are both VS Code-based AI IDEs, they have different
configuration approaches:

| Aspect | Cursor | Windsurf |
|--------|--------|----------|
| Config file | `.cursorrules` | `.windsurfrules` |
| Agent files | `.cursor/agents/*.json` | None (inline in AGENTS.md) |
| Rules dir | `.cursor/rules/` | `.windsurf/rules/` |
| AGENTS.md | Not native | Native support |
| Workflows | Not supported | `.windsurf/workflows/` |
| Hooks | Not supported | Cascade Hooks (TypeScript) |

## Resources

- **Windsurf Docs**: https://docs.windsurf.com/
- **AGENTS.md Spec**: https://docs.windsurf.com/windsurf/cascade/agents-md
- **Workflows**: https://docs.windsurf.com/windsurf/cascade/workflows
- **AIWG Issues**: https://github.com/jmagly/aiwg/issues
- **AIWG Discord**: https://discord.gg/BuAusFMxdA

## Support

For Windsurf-specific questions:
- **Windsurf Docs**: https://docs.windsurf.com/
- **Windsurf Community**: Check Windsurf documentation for community links

For AIWG integration questions:
- **AIWG Issues**: https://github.com/jmagly/aiwg/issues
- **AIWG Discussions**: https://github.com/jmagly/aiwg/discussions
