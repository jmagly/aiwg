---
namespace: aiwg
name: aiwg-regenerate-copilot
platforms: [all]
description: Regenerate copilot-instructions.md for GitHub Copilot with vendor-specific content only
---

# Regenerate copilot-instructions.md

Regenerate the `.github/copilot-instructions.md` file for GitHub Copilot integration, analyzing current project state while preserving team directives and organizational requirements.

**Hook file approach (default):** Generates `AIWG-copilot.md` and adds `@AIWG-copilot.md` directive to copilot-instructions.md if @-link is supported. Note: Copilot @-link support is unverified — defaults to full inject until confirmed (see #444).

**Full inject (`--full-inject`):** Embeds AIWG content inline with AIWG markers.

**Vendor-specific filtering:** This command includes ONLY GitHub Copilot patterns and agent references, reducing context pollution. Other vendor content is referenced but not inlined.

## Core Principle

**Team content is preserved. AIWG content is updated. Only Copilot-specific content is inlined.**

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

1. Check if `.github/copilot-instructions.md` exists
2. If exists, copy to `.github/copilot-instructions.md.backup-{YYYYMMDD-HHMMSS}`
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
- CI/CD configuration (especially `.github/workflows/`)
- Directory structure
- Existing `.github/agents/` configuration

### Step 4: Detect AIWG State

Check installed frameworks by scanning:
- `.github/agents/` for custom agents (YAML format)
- `.github/copilot/` for Copilot configuration
- `.github/workflows/` for CI/CD workflows

Read registry for framework versions.

### Step 5: Generate copilot-instructions.md

**Document Structure:**

```markdown
# GitHub Copilot Instructions

Project instructions for GitHub Copilot AI assistance.

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
.github/       → GitHub configuration
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

This project uses AIWG SDLC framework with GitHub Copilot.

### Custom Agents

**Agents are deployed to `.github/agents/` as YAML files.**

Invoke via @-mention in Copilot Chat:

```text
@architecture-designer Design system architecture for authentication
@security-architect Review security implementation
@test-engineer Generate comprehensive test suite
@code-reviewer Review pull request for quality
```

**Available agents:**
- `architecture-designer` - System architecture and technical decisions
- `security-architect` - Security design and threat modeling
- `test-engineer` - Test suite creation and strategy
- `code-reviewer` - Code quality and security review
- `devops-engineer` - CI/CD and deployment automation
- `project-manager` - Project planning and tracking

**Full agent catalog:** .github/agents/ or @~/.local/share/ai-writing-guide/agentic/code/frameworks/sdlc-complete/agents/

### Copilot Coding Agent

For automated issue resolution:
1. Navigate to an issue in GitHub
2. Assign to **Copilot**
3. Copilot analyzes and creates a PR

### Natural Language Workflow Requests

Request AIWG workflows using natural language in Copilot Chat:

| Request | Maps To |
|---------|---------|
| "run security review" | flow-security-review-cycle |
| "check project status" | project-status |
| "transition to elaboration" | flow-inception-to-elaboration |
| "start iteration 2" | flow-iteration-dual-track |
| "generate tests for auth" | generate-tests + test-engineer |
| "review this PR" | pr-review + code-reviewer |

**Full workflow patterns:** @~/.local/share/ai-writing-guide/agentic/code/frameworks/sdlc-complete/docs/simple-language-translations.md

## Project Artifacts

{If .aiwg/ exists:}

| Category | Location |
|----------|----------|
| Requirements | @.aiwg/requirements/ |
| Architecture | @.aiwg/architecture/ |
| Planning | @.aiwg/planning/ |
| Testing | @.aiwg/testing/ |
| Security | @.aiwg/security/ |

## Full Reference

**AIWG Installation:** `~/.local/share/ai-writing-guide/`

**Framework Documentation:**
- SDLC Complete: @~/.local/share/ai-writing-guide/agentic/code/frameworks/sdlc-complete/README.md
- All Workflows: @~/.local/share/ai-writing-guide/agentic/code/frameworks/sdlc-complete/commands/
- All Agents: @~/.local/share/ai-writing-guide/agentic/code/frameworks/sdlc-complete/agents/

**Core References:**
- Orchestrator: @~/.local/share/ai-writing-guide/agentic/code/addons/aiwg-utils/prompts/core/orchestrator.md
- Agent Design: @~/.local/share/ai-writing-guide/agentic/code/addons/aiwg-utils/prompts/agents/design-rules.md

**Multi-vendor setup?**
- Claude Code: CLAUDE.md
- Cursor: .cursorrules
- Warp: WARP.md
- Other platforms: AGENTS.md

---

<!--
  Add team-specific notes below.
  Content in preserved sections survives regeneration.
-->
```

### Step 6: Write Output

**If `--dry-run`:** Display content, do not write.

**Otherwise:**
1. Ensure `.github/` directory exists
2. Write to `.github/copilot-instructions.md`
3. Report summary

```
copilot-instructions.md Regenerated
====================================

Backup: .github/copilot-instructions.md.backup-20260113-153512

Team Content Preserved:
  ✓ Team Directives (2 sections, 15 lines)

AIWG Content Updated:
  ✓ Project overview and structure
  ✓ Copilot agent references (6 listed)
  ✓ Natural language workflow mappings
  ✓ Full references included

Vendor-Specific Filtering:
  ✓ Only Copilot patterns inlined
  ✓ Other vendors referenced for multi-vendor setups
  ✓ Context size optimized: 234 lines

Output: .github/copilot-instructions.md (234 lines)
```

## Vendor-Specific Filtering Rules

**INCLUDE (inline in copilot-instructions.md):**
- GitHub Copilot agent references (YAML in .github/agents/)
- Natural language workflow patterns
- Copilot Chat @-mention examples
- GitHub Actions integration notes
- Issue-to-PR automation patterns

**EXCLUDE (reference only, don't inline):**
- Claude Code slash commands
- Cursor-specific rule syntax
- Warp terminal commands
- Factory droid definitions
- Platform-specific command formats

**REFERENCE (link to, don't detail):**
- Full workflow catalog
- Full agent catalog
- Other vendor context files
- Framework documentation

**Target size:** 200-350 lines (excluding team content)

## Examples

```bash
# Regenerate copilot-instructions.md
/aiwg-regenerate-copilot

# Preview changes
/aiwg-regenerate-copilot --dry-run

# Check preserved content
/aiwg-regenerate-copilot --show-preserved

# Full regeneration
/aiwg-regenerate-copilot --full
```

## Related Commands

| Command | Regenerates |
|---------|-------------|
| `/aiwg-regenerate-claude` | CLAUDE.md (Claude Code) |
| `/aiwg-regenerate-copilot` | copilot-instructions.md (GitHub Copilot) |
| `/aiwg-regenerate-cursorrules` | .cursorrules (Cursor) |
| `/aiwg-regenerate-windsurfrules` | .windsurfrules (Devin Desktop) |
| `/aiwg-regenerate-warp` | WARP.md (Warp Terminal) |
| `/aiwg-regenerate-factory` | .factory/README.md (Factory AI) |
| `/aiwg-regenerate-agents` | AGENTS.md (Multi-vendor) |
| `/aiwg-regenerate` | Auto-detect vendor |

## References

- Base Template: @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/regenerate-base.md
- Vendor Detection: @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/docs/vendor-detection.md
- @implements @.aiwg/requirements/use-cases/UC-019-regenerate-vendor-specific.md
