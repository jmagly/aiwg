---
namespace: aiwg
name: aiwg-regenerate-windsurfrules
platforms: [all]
description: Regenerate .windsurfrules for Devin Desktop with preserved team directives
---

# Regenerate Devin Desktop rules

> **Deprecated skill ID:** `aiwg-regenerate-windsurfrules` remains discoverable for legacy installs. New projects use `aiwg-regenerate` with provider `devin`; internal filenames remain unchanged.

Regenerate the `.windsurfrules` file for Devin Desktop integration, analyzing current project state while preserving team directives and organizational requirements.

**Hook file approach (default):** Generates `AIWG-windsurf.md` and adds `@AIWG-windsurf.md` directive. Note: Devin Desktop @-link support is unverified — defaults to full inject until confirmed (see #444).

**Full inject (`--full-inject`):** Embeds AIWG content inline with AIWG markers.

## Parameters

| Flag | Description |
|------|-------------|
| `--no-backup` | Skip creating backup file |
| `--dry-run` | Preview changes without writing |
| `--show-preserved` | List all detected preserved content and exit |
| `--full` | Full regeneration, preserve nothing (destructive) |

## Execution Steps

### Step 1: Create Backup

Unless `--no-backup` specified:

1. Check if `.windsurfrules` exists
2. If exists, copy to `.windsurfrules.backup-{YYYYMMDD-HHMMSS}`
3. Report backup location

### Step 2: Extract Preserved Content

Same preservation patterns as other platforms:

1. **Explicit Preserve Blocks**: `<!-- PRESERVE -->` ... `<!-- /PRESERVE -->`
2. **Preserved Section Headings**: Team *, Org *, Definition of Done, etc.
3. **Inline Directives**: Lines with directive keywords

### Step 3: Analyze Project

- Languages and package managers
- Development commands
- Test framework
- CI/CD configuration
- Directory structure
- Devin Desktop-specific configuration in `.windsurf/`

### Step 4: Detect AIWG State

Check installed frameworks by scanning:
- `.windsurf/workflows/` for workflows
- `.windsurf/rules/` for rules
- `.windsurf/skills/` for skills
- `AGENTS.md` for aggregated agents

Read registry for framework versions.

### Step 5: Generate .windsurfrules

**Document Structure:**

```markdown
# .windsurfrules

Project rules for Devin Desktop AI assistance.

## Project Overview

{Description from README.md or package.json}

## Tech Stack

- **Language**: {detected languages}
- **Framework**: {detected frameworks}
- **Package Manager**: {npm/yarn/pnpm/etc.}

## Development Commands

| Command | Description |
|---------|-------------|
| `npm install` | Install dependencies |
| `npm run build` | Build project |
| `npm test` | Run tests |

## Project Structure

```
src/           → Source code
test/          → Test files
docs/          → Documentation
```

## Code Conventions

{Project-specific conventions}

---

## Team Directives

<!-- PRESERVED SECTION -->

{ALL PRESERVED CONTENT}

<!-- /PRESERVED SECTION -->

---

## AIWG Framework Integration

This project uses AIWG SDLC framework with Devin Desktop.

### Installed Frameworks

| Framework | Agents | Workflows |
|-----------|--------|-----------|
| sdlc-complete | 54 | 42 |

### Using Agents

Agents are available via AGENTS.md (aggregated format).

### Natural Language Mappings

| Request | Maps To |
|---------|---------|
| "run security review" | flow-security-review-cycle |
| "check status" | project-status |
| "start iteration N" | flow-iteration-dual-track |

## Project Artifacts

{If .aiwg/ exists:}

| Category | Location |
|----------|----------|
| Requirements | @.aiwg/requirements/ |
| Architecture | @.aiwg/architecture/ |

## Core References

| Topic | Reference |
|-------|-----------|
| Orchestration | @~/.local/share/ai-writing-guide/agentic/code/addons/aiwg-utils/prompts/core/orchestrator.md |
| Agent Design | @~/.local/share/ai-writing-guide/agentic/code/addons/aiwg-utils/prompts/agents/design-rules.md |

{If SDLC framework installed:}

## SDLC References

| Topic | Reference |
|-------|-----------|
| Natural Language | @~/.local/share/ai-writing-guide/agentic/code/frameworks/sdlc-complete/docs/simple-language-translations.md |

## Resources

- **AIWG Installation**: `~/.local/share/ai-writing-guide`

---

<!--
  Add team-specific notes below.
  Content in preserved sections survives regeneration.
-->
```

### Step 6: Write Output

**If `--dry-run`:** Display content, do not write.

**Otherwise:**
1. Write to `.windsurfrules`
2. Report summary

```
.windsurfrules Regenerated
==========================

Backup: .windsurfrules.backup-20251206-153512

Preserved: 2 sections, 15 lines
Regenerated: Project overview, structure, AIWG integration

Output: .windsurfrules (187 lines)
```

## Examples

```bash
# Regenerate Devin Desktop rules
/aiwg-regenerate-windsurfrules

# Preview changes
/aiwg-regenerate-windsurfrules --dry-run

# Check preserved content
/aiwg-regenerate-windsurfrules --show-preserved

# Full regeneration
/aiwg-regenerate-windsurfrules --full
```

## Related Commands

| Command | Regenerates |
|---------|-------------|
| `/aiwg-regenerate-claude` | CLAUDE.md |
| `/aiwg-regenerate-warp` | WARP.md |
| `/aiwg-regenerate-agents` | AGENTS.md |
| `/aiwg-regenerate-cursorrules` | .cursorrules |
| `/aiwg-regenerate-windsurfrules` | .windsurfrules |
| `/aiwg-regenerate-copilot` | copilot-instructions.md |
| `/aiwg-regenerate` | Auto-detect |

## References

- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/README.md — aiwg-utils addon overview
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/native-ux-tools.md — Platform capability matrix including Devin Desktop
- @$AIWG_ROOT/docs/cli-reference.md — CLI reference for aiwg sync and regenerate commands
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/README.md — SDLC framework context referenced in generated .windsurfrules
