---
namespace: aiwg
name: aiwg-refresh
platforms: [all]
kernel: true
description: Update AIWG CLI and redeploy frameworks/tools to current project without leaving the session
script:
  entrypoint: run.sh
  runtime: bash
  cwd: project-root
  argsHint: '[--update-cli] [--all] [--provider <name>] [--dry-run] [--channel <name>]'
---

> **Deterministic execution (#1267)**: this skill has a `script:` entrypoint
> that shells out to `aiwg refresh "$@"`. Prefer
> `aiwg run skill aiwg-refresh -- <flags>` when a platform supports it; on
> platforms without a deployed command stub (e.g. hermes) invoke the CLI
> directly. The CLI owns the deterministic execution step: version/channel
> resolution, CLI update, framework redeploy, provider detection, and exit
> codes. The skill owns the agentic layer around that step: intent alignment,
> output formatting, workspace-state reconciliation, summary, next actions,
> gates, and recovery. Do not reimplement the refresh manually or add
> redundant permission prompts before calling the CLI for execution.

# Refresh AIWG Deployment

Update the AIWG CLI and/or redeploy frameworks, agents, commands, and tools to the current
project without leaving the agentic session.

## Use Cases

- **After AIWG updates**: Get latest framework features without restarting
- **After switching branches**: Ensure deployed content matches expectations
- **After manual edits**: Restore canonical AIWG content
- **Provider switch**: Redeploy for different platform (Claude → Factory)
- **Model selection**: Redeploy with different AI models for each tier

## Parameters

| Flag | Description |
|------|-------------|
| `--update-cli` | Update AIWG CLI to latest version before redeploying |
| `--all` | Redeploy all installed frameworks |
| `--sdlc` | Redeploy SDLC framework only |
| `--marketing` | Redeploy Marketing framework only |
| `--utils` | Redeploy aiwg-utils addon only |
| `--provider <name>` | Target platform: claude, factory, openai, cursor, warp (default: auto-detect) |
| `--reasoning-model <name>` | Override model for reasoning agents (opus tier) |
| `--coding-model <name>` | Override model for coding agents (sonnet tier) |
| `--efficiency-model <name>` | Override model for efficiency agents (haiku tier) |
| `--filter <pattern>` | Only deploy agents matching glob pattern (e.g., `*architect*`) |
| `--filter-role <role>` | Only deploy agents of specified role: reasoning, coding, efficiency |
| `--save` | Persist model selection to project models.json |
| `--force` | Force redeploy even if already up-to-date |
| `--dry-run` | Show what would be done without executing |

## Execution Steps

Any removal list requires explicit human review of the listed removals before execution.
Authorization lookup must never bypass that review, even with a receipt for other effects.

### Step 1: Show Current Status

Run status check and report current state:

```bash
aiwg -status
```

Report:

```text
AIWG Refresh - Current Status
==============================

CLI Version: 1.2.3 (stable channel)
Workspace: /path/to/project/.aiwg

Installed Frameworks:
  - sdlc-complete v1.0.0 (58 agents, 48 commands)
  - aiwg-utils v1.0.0 (3 agents, 25 commands)

Platform: Claude Code (.claude/)
  - Agents: 61 deployed
  - Commands: 73 deployed
```

### Step 2: Update CLI (if --update-cli)

If `--update-cli` flag is set:

```bash
aiwg -update
```

Report update status:

```text
Checking for updates...
  Current: 1.2.3
  Latest:  1.2.5

Updating AIWG CLI...
✓ Updated to v1.2.5

Changes in v1.2.5:
  - New mutation-analyst agent
  - Testing-quality addon
  - Bug fixes
```

If already up-to-date:

```text
AIWG CLI is up-to-date (v1.2.3)
```

### Step 3: Determine What to Redeploy

Based on flags, determine scope:

| Flags | Action |
|-------|--------|
| No flags | Show status only, prompt for action |
| `--all` | Redeploy all installed frameworks |
| `--sdlc` | Redeploy sdlc-complete only |
| `--marketing` | Redeploy media-marketing-kit only |
| `--utils` | Redeploy aiwg-utils addon only |
| Multiple | Redeploy specified frameworks |

If no framework flags and not `--dry-run`, ask user:

```text
What would you like to refresh?

[1] All frameworks (sdlc-complete, aiwg-utils)
[2] SDLC framework only
[3] Utils addon only
[4] Just show status (no changes)

Choice:
```

### Step 4: Detect Target Platform

If `--provider` not specified, auto-detect:

1. Check existing deployments:
   - `.claude/agents/` exists → claude
   - `.factory/droids/` exists → factory
   - `.codex/agents/` exists → openai
   - `.cursor/rules/` exists → cursor

2. If multiple detected, ask user:

   ```text
   Multiple platforms detected:
   [1] Claude Code (.claude/)
   [2] Factory AI (.factory/)

   Which platform to refresh?
   ```

3. If none detected, default to claude

Report:

```text
Target platform: Claude Code
Deployment paths:
  - Agents: .claude/agents/
  - Commands: .claude/commands/
```

### Step 5: Execute Redeploy

For each framework to deploy:

```bash
# SDLC Framework
aiwg use sdlc --provider <platform> --force [model-flags] [filter-flags]

# Marketing Framework
aiwg use marketing --provider <platform> --force [model-flags] [filter-flags]

# Utils (included with sdlc)
# No separate command needed
```

**Model flags** (if specified):
- `--reasoning-model <name>` - applies to all opus-tier agents
- `--coding-model <name>` - applies to all sonnet-tier agents
- `--efficiency-model <name>` - applies to all haiku-tier agents

**Filter flags** (if specified):
- `--filter <pattern>` - only deploys matching agents
- `--filter-role <role>` - only deploys agents of specified role

**If `--dry-run`:**
Show commands without executing:

```text
Dry Run - Would execute:
========================

1. aiwg use sdlc --provider claude --force --reasoning-model opus-4-2
   → Deploy 58 agents to .claude/agents/ (reasoning tier with opus-4-2)
   → Deploy 48 commands to .claude/commands/

2. aiwg use marketing --provider claude --force --reasoning-model opus-4-2
   → Deploy 37 agents to .claude/agents/ (reasoning tier with opus-4-2)
   → Deploy 20 commands to .claude/commands/

No changes made (dry run mode)
```

**Progress Reporting:**

```text
Refreshing AIWG Deployment
==========================

[1/2] Deploying sdlc-complete...
  → Copying 58 agents...
  → Copying 48 commands...
  → Copying 12 templates...
  ✓ sdlc-complete deployed

[2/2] Deploying aiwg-utils...
  → Copying 3 agents...
  → Copying 25 commands...
  ✓ aiwg-utils deployed
```

### Step 6: Verify Deployment

After deployment, verify:

```bash
# Count deployed assets
ls .claude/agents/*.md 2>/dev/null | wc -l
ls .claude/commands/*.md 2>/dev/null | wc -l
```

Report:

```text
Verification
============

Deployed Assets:
  - Agents: 95 files
  - Commands: 93 files

Platform Files:
  - CLAUDE.md: Present
  - .claude/settings.local.json: Present

All assets deployed successfully!
```

### Step 7: Summary Report

```text
AIWG Refresh Complete
=====================

CLI:
  Version: 1.2.5 (updated from 1.2.3)

Frameworks Deployed:
  ✓ sdlc-complete v1.0.0 (58 agents, 48 commands)
  ✓ aiwg-utils v1.0.0 (3 agents, 25 commands)

Platform: Claude Code
  - .claude/agents/: 61 files
  - .claude/commands/: 73 files

New capabilities available:
  - /setup-tdd - TDD enforcement setup
  - /flow-test-strategy-execution - Test execution workflow
  - mutation-analyst agent - Test quality analysis

Session ready - new features are now available!
```

If the installation update fails but re-deployment completes, do not use the
unqualified `AIWG Refresh Complete` summary above. Report **AIWG Refresh
Partial Recovery**, repeat the update failure, and warn that AIWG may remain on
the previous version. When relaying quiet output, preserve the CLI status
`refreshed-with-update-failure` so automation can distinguish this result from
a successful package update.

## Examples

```bash
# Check status only
/aiwg-refresh

# Update CLI and redeploy everything
/aiwg-refresh --update-cli --all

# Just redeploy SDLC framework
/aiwg-refresh --sdlc

# Switch to Factory AI deployment
/aiwg-refresh --all --provider factory

# Preview what would happen
/aiwg-refresh --all --dry-run

# Force refresh even if up-to-date
/aiwg-refresh --all --force

# Redeploy with custom reasoning model
/aiwg-refresh --all --reasoning-model claude-opus-4-2

# Redeploy with custom models for all tiers
/aiwg-refresh --all --reasoning-model opus-4-2 --coding-model sonnet-5 --efficiency-model haiku-4

# Redeploy and save model selection for future deploys
/aiwg-refresh --all --coding-model claude-sonnet-5-0 --save

# Only update architect agents with new reasoning model
/aiwg-refresh --sdlc --filter "*architect*" --reasoning-model opus-4-2

# Only update reasoning-tier agents
/aiwg-refresh --all --filter-role reasoning --reasoning-model custom-reasoning
```

## Natural Language Triggers

This command should activate when user says:

- "refresh aiwg" / "update aiwg"
- "redeploy frameworks" / "redeploy agents"
- "get latest aiwg features"
- "update my aiwg tools"
- "sync aiwg deployment"
- "change agent models" / "switch to opus" / "use different model"
- "redeploy with custom models"
- "update reasoning agents" / "update architect agents"

## Error Handling

| Condition | Action |
|-----------|--------|
| AIWG CLI not found | Error: "AIWG CLI not installed. Run: curl -fsSL ... \| bash" |
| Network or package error on update | Warn, continue re-deployment, and report partial recovery with `refreshed-with-update-failure` |
| Framework not installed | Offer to install: "SDLC not installed. Install now? [y/N]" |
| Permission denied | Error with specific file/directory that failed |
| Invalid provider | Error listing valid providers |

## Post-Refresh Recommendations

After refresh, suggest:

```text
Recommended next steps:
1. Review new features: aiwg -help
2. Check framework docs: /aiwg-kb sdlc
3. Run health check: aiwg doctor
```

## References

- @$AIWG_ROOT/docs/development/file-placement-guide.md - Correct file placement workflow
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/commands/aiwg-regenerate.md - Context file regeneration
- @$AIWG_ROOT/docs/CLI_USAGE.md - Full CLI documentation
