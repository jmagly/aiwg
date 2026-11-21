# AIWG File Placement Guide

**CRITICAL**: This guide explains where AIWG content belongs and the correct workflow for making changes.

## The Golden Rule

**Never directly edit platform-specific folders** (`.claude/`, `.factory/`, `.codex/`, `.cursor/`, `.opencode/`).

These folders are deployment targets, not source locations. The AIWG CLI manages them.

## Architecture Overview

```
Source (you edit here)                CLI Deploy          Platform Folders (don't edit)
─────────────────────────────────────────────────────────────────────────────────────────
agentic/code/frameworks/             ───────────>        .claude/agents/
agentic/code/frameworks/             ───────────>        .factory/droids/
agentic/code/addons/                 ───────────>        .codex/agents/
agentic/code/agents/                 ───────────>        .cursor/rules/
                                                         .opencode/agent/

.aiwg/.project/agents/               ───────────>        .claude/agents/{namespace}/
.aiwg/.project/skills/               ───────────>        .claude/skills/{namespace}/
```

There are two source tiers:

1. **Framework source** (`agentic/code/`) — ships with AIWG; editing here changes the framework for all projects
2. **Project-local source** (`.aiwg/.project/`) — lives in your project repo; deploys project-specific customizations alongside the framework assets

## Where Content Lives

### Source Locations (Edit These)

**Framework source** — ships with AIWG, available in all projects:

| Content Type | Source Location | Example |
|--------------|-----------------|---------|
| SDLC Agents | `agentic/code/frameworks/sdlc-complete/agents/` | `test-architect.md` |
| SDLC Commands | `agentic/code/frameworks/sdlc-complete/commands/` | `flow-gate-check.md` |
| SDLC Templates | `agentic/code/frameworks/sdlc-complete/templates/` | `test-plan.md` |
| Marketing Agents | `agentic/code/frameworks/media-marketing-kit/agents/` | `campaign-strategist.md` |
| Marketing Commands | `agentic/code/frameworks/media-marketing-kit/commands/` | `campaign-kickoff.md` |
| Addon Agents | `agentic/code/addons/{addon}/agents/` | `writing-validator.md` |
| Addon Commands | `agentic/code/addons/{addon}/commands/` | `commit-and-push.md` |
| Addon Skills | `agentic/code/addons/{addon}/skills/` | `tdd-enforce/SKILL.md` |
| General Agents | `agentic/code/agents/` | `prompt-optimizer.md` |

**Project-local source** — lives in your project repo, specific to this project:

| Content Type | Source Location | Example |
|--------------|-----------------|---------|
| Project agents | `.aiwg/.project/agents/` | `corpus-curator.md` |
| Project skills | `.aiwg/.project/skills/{name}/SKILL.md` | `paper-intake/SKILL.md` |
| Project scripts | `.aiwg/.project/scripts/` | `import-data.sh` |
| Container manifest | `.aiwg/.project/manifest.json` | — |

Project-local assets deploy into a namespace subdirectory (e.g., `.claude/agents/corpus/`) so they do not conflict with framework assets. See [Project-Local Customization](../project-local/overview.md) for the full guide.

### Deployment Targets (Never Edit Directly)

| Platform | Deployment Target | Created By |
|----------|-------------------|------------|
| Claude Code | `.claude/agents/`, `.claude/commands/` | `aiwg use sdlc` |
| GitHub Copilot | `.github/agents/`, `copilot-instructions.md` | `aiwg use sdlc --provider copilot` |
| Warp | `WARP.md` | `aiwg use sdlc --provider warp` |
| Factory AI | `.factory/droids/`, `AGENTS.md` | `aiwg use sdlc --provider factory` |
| OpenCode | `.opencode/agent/`, `AGENTS.md` | `aiwg use sdlc --provider opencode` |
| Cursor | `.cursor/rules/`, `AGENTS.md` | `aiwg use sdlc --provider cursor` |
| OpenAI/Codex | `.codex/agents/`, `AGENTS.md` | `aiwg use sdlc --provider codex` |
| Devin Desktop | `.windsurfrules` | `aiwg use sdlc --provider devin` |

## Correct Workflow

### Adding New Content

1. **Create in AIWG source location**
   ```bash
   # Create new command in SDLC framework
   touch agentic/code/frameworks/sdlc-complete/commands/my-command.md

   # Create new skill in addon
   mkdir -p agentic/code/addons/my-addon/skills/my-skill
   touch agentic/code/addons/my-addon/skills/my-skill/SKILL.md
   ```

2. **Update AIWG locally** (if developing in the AIWG repo)
   ```bash
   # For local development, AIWG repo IS the source
   # Changes are already in place
   ```

3. **Deploy to platform folders**
   ```bash
   # Deploy to .claude/ for testing
   aiwg -deploy-agents
   aiwg -deploy-commands

   # Or deploy to specific provider
   aiwg -deploy-agents --provider factory
   ```

### Modifying Existing Content

1. **Find the source file** (not the deployed copy)
   ```bash
   # Wrong: editing .claude/commands/setup-tdd.md
   # Right: editing agentic/code/frameworks/sdlc-complete/commands/setup-tdd.md
   ```

2. **Make changes in source**

3. **Re-deploy to see changes**
   ```bash
   aiwg -deploy-agents
   ```

## Why This Matters

### Consistency Across Platforms

Changes in source are deployed to ALL platforms consistently. Direct edits to `.claude/` don't propagate to `.factory/` or other providers.

### Version Control

- Source files are tracked in git
- Platform folders can be gitignored (they're generated)
- Changes are traceable to source

### Avoiding Conflicts

When `aiwg -deploy-agents` runs, it overwrites platform folders. Direct edits get lost.

## Common Mistakes

### Mistake 1: Creating Commands in .claude/

```bash
# WRONG
touch .claude/commands/my-command.md

# RIGHT
touch agentic/code/frameworks/sdlc-complete/commands/my-command.md
aiwg -deploy-commands
```

### Mistake 2: Editing Deployed Agents

```bash
# WRONG
vim .claude/agents/test-engineer.md

# RIGHT
vim agentic/code/frameworks/sdlc-complete/agents/test-engineer.md
aiwg -deploy-agents
```

### Mistake 3: Adding Skills to .claude/

```bash
# WRONG
mkdir -p .claude/skills/my-skill

# RIGHT
mkdir -p agentic/code/addons/my-addon/skills/my-skill
```

## Dogfooding AIWG

When working on the AIWG repository itself:

1. The repo contains BOTH source and deployed files
2. Source changes go in `agentic/code/`
3. Run `aiwg -deploy-agents` to update `.claude/` for testing
4. Commit BOTH source and deployed files if they should ship together

## Quick Reference

| If you want to... | Edit this location | Then run |
|-------------------|--------------------|---------:|
| Add SDLC command | `agentic/code/frameworks/sdlc-complete/commands/` | `aiwg -deploy-commands` |
| Add SDLC agent | `agentic/code/frameworks/sdlc-complete/agents/` | `aiwg -deploy-agents` |
| Add marketing command | `agentic/code/frameworks/media-marketing-kit/commands/` | `aiwg -deploy-commands` |
| Add addon skill | `agentic/code/addons/{addon}/skills/` | `aiwg -deploy-agents` |
| Modify any deployed file | Find source in `agentic/code/` | Re-deploy |
| Add **project-specific** agent | `.aiwg/.project/agents/` | `aiwg use` |
| Add **project-specific** skill | `.aiwg/.project/skills/{name}/SKILL.md` | `aiwg use` |

## See Also

- [Devkit Overview](devkit-overview.md) - Creating new addons, frameworks, extensions
- [Addon Creation Guide](addon-creation-guide.md) - Step-by-step addon development
- [Contributor Quickstart](../contributing/contributor-quickstart.md) - Full contribution workflow
