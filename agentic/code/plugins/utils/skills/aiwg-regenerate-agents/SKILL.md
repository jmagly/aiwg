---
namespace: aiwg
name: aiwg-regenerate-agents
platforms: [all]
description: Regenerate AGENTS.md with vendor-neutral content for multi-platform support
---

# Regenerate AGENTS.md

Regenerate the AGENTS.md file, analyzing current project state while preserving team directives and organizational requirements. Supports Devin Desktop and Factory AI (both use AGENTS.md as context file).

**Hook file approach (default):** Generates `AIWG-windsurf.md` or `AIWG-factory.md` (per `--provider`) and adds directive to AGENTS.md. @-link support unverified — defaults to section-style until confirmed (see #444).

**Full inject (`--full-inject`):** Embeds AIWG content inline with AIWG markers.

**Used by:** Factory AI, Cursor, OpenCode, Codex, and other platforms that use AGENTS.md for configuration.

**Vendor-neutral:** This file provides generic agent descriptions and natural language patterns suitable for any platform.

## Core Principle

**Team content is preserved. AIWG content is updated. Content is vendor-neutral.**

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

1. Check if `AGENTS.md` exists
2. If exists, copy to `AGENTS.md.backup-{YYYYMMDD-HHMMSS}`
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

### Step 4: Detect AIWG State

Check installed frameworks by scanning for deployed agents/droids:
- `.factory/droids/` (Factory AI)
- `.opencode/agent/` (OpenCode)
- `.cursor/rules/` (Cursor)
- `.codex/agents/` (Codex)

Read registry for framework versions.

### Step 5: Generate AGENTS.md

**Document Structure:**

```markdown
# AGENTS.md

Project configuration for AI assistance platforms.

## Project Overview

{Description from README.md or package.json}

## Tech Stack

- **Language**: {detected languages}
- **Runtime**: {Node.js, Python, etc.}
- **Framework**: {detected frameworks}
- **Test Framework**: {detected test framework}
- **Package Manager**: {npm/yarn/pip/etc.}

## Development Commands

| Command | Description |
|---------|-------------|
| `npm install` | Install dependencies |
| `npm run build` | Build TypeScript to dist/ |
| `npm test` | Run Vitest test suite |
| `npm run lint` | Run ESLint |

## Project Structure

```
src/           → Source code
test/          → Test files
tools/         → CLI tools and scripts
docs/          → Documentation
.github/       → CI/CD workflows
```

---

## Team Directives

<!-- PRESERVED SECTION -->

{ALL PRESERVED CONTENT}

<!-- /PRESERVED SECTION -->

---

## AIWG Framework

This project uses the AIWG SDLC framework for software development workflows.

### Available Agents

**Architecture & Design:**
- `architecture-designer` - System architecture and technical decisions
- `database-architect` - Database design and optimization
- `api-designer` - RESTful/GraphQL API design

**Development & Implementation:**
- `software-implementer` - Test-first development (TDD)
- `integrator` - Component integration and build management
- `test-engineer` - Comprehensive test suite creation
- `test-architect` - Test strategy and framework design

**Quality & Security:**
- `code-reviewer` - Code quality and security review
- `security-architect` - Security design and threat modeling
- `qa-engineer` - Quality assurance and testing
- `performance-engineer` - Performance optimization

**Operations & Release:**
- `devops-engineer` - CI/CD and deployment automation
- `sre` - Site reliability and monitoring
- `release-manager` - Release coordination and rollout

**Management & Coordination:**
- `project-manager` - Project planning and tracking
- `product-owner` - Product vision and requirements
- `scrum-master` - Agile process facilitation
- `business-analyst` - Requirements gathering and analysis

**Specialized:**
- `technical-writer` - Documentation and content
- `ux-designer` - User experience and interface design
- `data-engineer` - Data pipelines and analytics

**Deployment:** Agents are deployed to platform-specific directories:
- Claude Code: `.claude/agents/`
- GitHub Copilot: `.github/agents/`
- Factory AI: `.factory/droids/`
- Cursor: `.cursor/rules/`

**Full catalog:** @~/.local/share/ai-writing-guide/agentic/code/frameworks/sdlc-complete/agents/

### Workflow Commands

**Intake & Planning:**
- `intake-wizard` - Generate project intake forms
- `intake-from-codebase` - Analyze codebase to generate intake
- `project-status` - Check current project phase
- `project-health-check` - Comprehensive health assessment

**Phase Transitions:**
- `flow-inception-to-elaboration` - Transition to Elaboration
- `flow-elaboration-to-construction` - Transition to Construction
- `flow-construction-to-transition` - Transition to Transition
- `flow-gate-check` - Validate phase gate criteria

**Continuous Workflows:**
- `flow-security-review-cycle` - Security validation
- `flow-test-strategy-execution` - Test execution
- `flow-risk-management-cycle` - Risk management
- `flow-retrospective-cycle` - Retrospective analysis

**Development:**
- `flow-guided-implementation` - Step-by-step implementation
- `generate-tests` - Generate test suite
- `setup-tdd` - Set up test-driven development
- `pr-review` - Pull request review

**Full workflow catalog:** @~/.local/share/ai-writing-guide/agentic/code/frameworks/sdlc-complete/commands/

### Natural Language Requests

Use natural language to request workflows:

| Request | Maps To |
|---------|---------|
| "transition to elaboration" | flow-inception-to-elaboration |
| "run security review" | flow-security-review-cycle |
| "check project status" | project-status |
| "start iteration N" | flow-iteration-dual-track |
| "generate tests for module" | generate-tests + test-engineer |
| "review this PR" | pr-review + code-reviewer |
| "design authentication API" | api-designer |
| "optimize database queries" | database-architect + performance-engineer |

**Natural language guide:** @~/.local/share/ai-writing-guide/agentic/code/frameworks/sdlc-complete/docs/simple-language-translations.md

## Project Artifacts

{If .aiwg/ exists:}

| Category | Location |
|----------|----------|
| Requirements | @.aiwg/requirements/ |
| Architecture | @.aiwg/architecture/ |
| Planning | @.aiwg/planning/ |
| Testing | @.aiwg/testing/ |
| Security | @.aiwg/security/ |
| Deployment | @.aiwg/deployment/ |

## Full Reference

**AIWG Installation:** `~/.local/share/ai-writing-guide/`

**Framework Documentation:**
- SDLC Complete: @~/.local/share/ai-writing-guide/agentic/code/frameworks/sdlc-complete/README.md
- All Workflows: @~/.local/share/ai-writing-guide/agentic/code/frameworks/sdlc-complete/commands/
- All Agents: @~/.local/share/ai-writing-guide/agentic/code/frameworks/sdlc-complete/agents/
- Orchestration: @~/.local/share/ai-writing-guide/agentic/code/frameworks/sdlc-complete/docs/orchestrator-architecture.md

**Core References:**
- Orchestrator: @~/.local/share/ai-writing-guide/agentic/code/addons/aiwg-utils/prompts/core/orchestrator.md
- Agent Design: @~/.local/share/ai-writing-guide/agentic/code/addons/aiwg-utils/prompts/agents/design-rules.md
- Error Recovery: @~/.local/share/ai-writing-guide/agentic/code/addons/aiwg-utils/prompts/reliability/resilience.md

**Platform-specific configurations:**
- Claude Code: CLAUDE.md
- GitHub Copilot: .github/copilot-instructions.md
- Cursor: .cursorrules
- Devin Desktop: .windsurfrules
- Warp: WARP.md

---

<!--
  Add team-specific notes below.
  Content in preserved sections survives regeneration.
-->
```

### Step 6: Write Output

**If `--dry-run`:** Display content, do not write.

**Otherwise:**
1. Write to `AGENTS.md`
2. Report summary

```
AGENTS.md Regenerated
=====================

Backup: AGENTS.md.backup-20260113-153512

Team Content Preserved:
  ✓ Team Directives (2 sections, 21 lines)

AIWG Content Updated:
  ✓ Project commands and structure
  ✓ Agent descriptions (20 agents)
  ✓ Workflow patterns (natural language)
  ✓ Full references included

Vendor-Neutral Content:
  ✓ Generic agent descriptions
  ✓ Natural language patterns
  ✓ No platform-specific syntax
  ✓ Context size optimized: 287 lines

Output: AGENTS.md (287 lines)
```

## Vendor-Neutral Content Rules

**INCLUDE (generic descriptions):**
- Agent purposes and capabilities
- Natural language workflow patterns
- Project structure and commands
- Framework references

**EXCLUDE (platform-specific):**
- Claude Code slash command syntax
- Copilot @-mention examples
- Cursor rule patterns
- Platform-specific invocation methods

**REFERENCE (link to all):**
- Full workflow catalog
- Full agent catalog
- Platform-specific context files
- Framework documentation

**Target size:** 250-350 lines (excluding team content)

## Multi-Platform Support

AGENTS.md serves as a fallback for platforms without dedicated context files:

| Platform | Primary Context | Fallback |
|----------|----------------|----------|
| Claude Code | CLAUDE.md | AGENTS.md |
| GitHub Copilot | .github/copilot-instructions.md | AGENTS.md |
| Cursor | .cursorrules | AGENTS.md |
| Devin Desktop | .windsurfrules | AGENTS.md |
| Warp | WARP.md | AGENTS.md |
| Factory AI | .factory/README.md | AGENTS.md |
| OpenCode | .opencode/README.md | AGENTS.md |
| Codex | ~/.codex/config | AGENTS.md |

## Examples

```bash
# Regenerate AGENTS.md
/aiwg-regenerate-agents

# Preview changes
/aiwg-regenerate-agents --dry-run

# Check preserved content
/aiwg-regenerate-agents --show-preserved

# Full regeneration
/aiwg-regenerate-agents --full
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
