---
namespace: aiwg
name: soul-enable
platforms: [all]
description: Enable soul enforcement by wiring SOUL.md into platform context files and deploying the enforcement rule
commandHint:
  argumentHint: "[--provider claude|warp|copilot|cursor|factory|devin|opencode|codex] [--all] [--agents]"
  allowedTools: Read, Write, Edit, Bash, Glob
  model: haiku
  category: soul-management
  modelRole: efficiency
  modelTier: economy
---

# Soul Enable

You are a Soul Management Specialist responsible for enabling SOUL.md enforcement in platform context files.

## Your Task

Wire a project's SOUL.md into the active context so the agent's identity, worldview, and voice are loaded at every session start. This involves:

1. Adding an `@SOUL.md` directive to the platform context file (same mechanism as `hook-enable`)
2. Deploying the soul enforcement rule to `.claude/rules/`
3. Optionally wiring per-agent soul files

## Parameters

| Flag | Description |
|------|-------------|
| `--provider <name>` | Target specific provider: `claude`, `warp`, `copilot`, `cursor`, `factory`, `devin`, `opencode`, `codex` |
| `--all` | Enable for all installed providers (default if no provider specified) |
| `--agents` | Also wire per-agent `.soul.md` files into their agent definitions |
| `--agent <name>` | Wire soul for a specific agent only |

## Soul File Locations

SOUL.md is looked up in priority order:

1. `SOUL.md` (project root)
2. `.aiwg/SOUL.md`

Per-agent soul files follow the pattern: `<agent-name>.soul.md` alongside the agent definition.

## Directive Map

| Provider | Context File | Directive Added |
|----------|-------------|-----------------|
| Claude Code | `CLAUDE.md` | `@SOUL.md` |
| Warp Terminal | `WARP.md` | `@SOUL.md` |
| Devin Desktop | `AGENTS.md` | `@SOUL.md` |
| GitHub Copilot | `.github/copilot-instructions.md` | `@SOUL.md` |
| Cursor | `.cursorrules` | `@SOUL.md` |
| Factory AI | `AGENTS.md` | `@SOUL.md` |
| OpenCode | `.opencode/context.md` | `@SOUL.md` |
| Codex | `CODEX.md` | Inline injection (no @-link) |

## Workflow

### Step 1: Locate SOUL.md

```bash
# Check for SOUL.md in priority order
ls SOUL.md .aiwg/SOUL.md 2>/dev/null
```

If no SOUL.md found:

```
Error: No SOUL.md found.

Looked in:
  ./SOUL.md
  ./.aiwg/SOUL.md

Create one with: /soul-create
```

### Step 2: Measure Context Cost

Count tokens in the soul file to warn about context budget impact:

```bash
wc -w SOUL.md
```

If over ~3750 words (~5K tokens), warn:

```
Warning: SOUL.md is approximately {N} tokens — this exceeds the recommended 5K limit.
Large soul files strain context budget in multi-agent workflows.
Consider trimming or run /soul-enhance to identify vague sections.

Proceed anyway? [y/n]
```

### Step 3: Determine Target Providers

If `--provider <name>` specified, operate on that provider only.
If `--all` or no flag, detect installed providers by checking for their context files.

```bash
ls CLAUDE.md WARP.md AGENTS.md .github/copilot-instructions.md .cursorrules CODEX.md 2>/dev/null
ls .opencode/context.md 2>/dev/null
```

### Step 4: Check Current State

For each target provider:

1. Check if the context file exists
2. Check if `@SOUL.md` directive is already present

```bash
# Example for Claude Code
grep -q "@SOUL.md" CLAUDE.md && echo "already enabled" || echo "disabled"
```

### Step 5: Add Directive to Context File

If directive is missing, add `@SOUL.md` to the context file.

**Placement**: After any `@AIWG.md` directive if present, otherwise after the repository purpose/overview section.

```markdown
@AIWG.md
@SOUL.md
```

**For Codex** (no @-link support): Insert SOUL.md content between markers:

```markdown
<!-- BEGIN SOUL -->
{SOUL.md content}
<!-- END SOUL -->
```

### Step 6: Deploy Enforcement Rule

Write the soul enforcement rule to `.claude/rules/soul-enforcement.md`:

```bash
# Check if rule already exists
ls .claude/rules/soul-enforcement.md 2>/dev/null
```

If missing, create it from the template at `agentic/code/addons/aiwg-utils/rules/soul-enforcement.md`.

The enforcement rule is short (~15 lines) and ensures the soul file is internalized, not just read.

### Step 7: Wire Per-Agent Soul Files (if --agents)

If `--agents` flag is set:

1. Find all agent definitions in `.claude/agents/`
2. For each agent, check if a companion `.soul.md` file exists
3. If found, add an identity reference to the agent definition

```bash
# Find agent definitions with companion soul files
for agent in .claude/agents/*.md; do
  name=$(basename "$agent" .md)
  soul=".claude/agents/${name}.soul.md"
  if [ -f "$soul" ]; then
    echo "Found soul for: $name"
  fi
done
```

**Identity reference added to agent definition**:

```markdown
## Identity

See .claude/agents/{name}.soul.md (deployed soul file) for this agent's character and voice.
```

If `--agent <name>` is specified, only wire that single agent.

### Step 8: Report Outcome

```
Soul enforcement enabled

Changes made:
  + .claude/rules/soul-enforcement.md (created)
  ~ CLAUDE.md (@SOUL.md directive added)

SOUL.md loaded: ./SOUL.md (~2,847 tokens)
Enforcement rule: 15 lines (~50 tokens per session)

To disable: /soul-disable
To check status: /soul-status
```

If `--agents` was used:

```
Agent soul wiring:
  ~ .claude/agents/test-engineer.md (identity section added)
  ~ .claude/agents/security-auditor.md (identity section added)
  - .claude/agents/api-designer.md (no companion .soul.md found, skipped)
```

## Idempotency

If soul enforcement is already enabled:

```
Soul already enabled for Claude Code
  @SOUL.md directive found in CLAUDE.md
  .claude/rules/soul-enforcement.md exists
  No changes made.
```

## Error Handling

| Condition | Action |
|-----------|--------|
| No SOUL.md found | Fail with message: "No SOUL.md found. Run /soul-create first." |
| SOUL.md over 5K tokens | Warn and prompt for confirmation |
| Context file missing | Skip provider with note: "CLAUDE.md not found — run `aiwg use claude` first." |
| No write permission | Report permission error |
| Enforcement rule already exists | Skip creation, report as already present |

## Examples

```bash
# Enable for Claude Code (default)
/soul-enable

# Enable for specific provider
/soul-enable --provider warp

# Enable with per-agent soul wiring
/soul-enable --agents

# Enable for a specific agent only
/soul-enable --agent test-engineer
```

## Related Commands

- `/soul-disable` — Remove soul enforcement
- `/soul-status` — Show current soul state
- `/soul-create` — Generate a SOUL.md from source material
- `/soul-validate` — Check SOUL.md quality
- `/hook-enable` — Reference implementation (same @-link mechanism)

## References

- #437 — SOUL.md compatibility overview
- #438 — Soul enforcement commands (this command)
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/soul-enforcement.md — Enforcement rule template
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/commands/hook-enable.md — Reference pattern
