# Regenerate Command Base Template

This template provides the common structure for all vendor-specific regenerate commands.

## Common Elements

All regenerate commands share these elements:

### 1. Frontmatter

```yaml
---
name: aiwg-regenerate-{vendor}
description: Regenerate {context-file} for {Vendor Name} with preserved team directives
args: "[--no-backup] [--dry-run] [--show-preserved] [--full] [--interactive] [--guidance "text"]"
---
```

### 2. Purpose Statement

```markdown
# Regenerate {context-file}

Regenerate the `{context-file}` file for {Vendor Name} integration, analyzing current project state while preserving team directives and organizational requirements.

**Key principle:** Team content is preserved. AIWG content is updated.
```

### 3. Standard Parameters

| Flag | Description |
|------|-------------|
| `--no-backup` | Skip creating backup file |
| `--dry-run` | Preview changes without writing |
| `--show-preserved` | List all detected preserved content and exit |
| `--full` | Full regeneration, preserve nothing (destructive) |
| `--interactive` | Interactive mode with confirmations |
| `--guidance "text"` | Additional guidance for content generation |

### 4. Execution Steps

#### Step 1: Create Backup

Unless `--no-backup` specified:

1. Check if `{context-file}` exists
2. If exists, copy to `{context-file}.backup-{YYYYMMDD-HHMMSS}`
3. Report backup location

#### Step 2: Extract Preserved Content

Identify and preserve:

1. **Explicit Preserve Blocks**: `<!-- PRESERVE -->` ... `<!-- /PRESERVE -->`
2. **Preserved Section Headings**: Team *, Org *, Definition of Done, Security Requirements, API Guidelines, etc.
3. **Inline Directives**: Lines with directive keywords (MUST, NEVER, ALWAYS, etc.)

**Preservation heuristics:**
- Team content uses first-person ("we", "our team")
- Team content references specific business/domain terms
- Team content contains opinions, preferences, rationale
- AIWG content references `~/.local/share/ai-writing-guide`
- AIWG content has structured @-mention tables
- AIWG content lists agents, commands, frameworks

#### Step 3: Analyze Project

Detect and document:

**Languages & Package Managers:**
- `package.json` → Node.js/npm
- `pyproject.toml` / `requirements.txt` → Python
- `go.mod` → Go
- `Cargo.toml` → Rust
- `pom.xml` / `build.gradle` → Java
- `composer.json` → PHP
- `Gemfile` → Ruby

**Development Commands:**
Extract from `package.json` scripts, `Makefile` targets, etc.

**Test Framework:**
Detect from config files and file patterns.

**CI/CD:**
Check for `.github/workflows/`, `.gitlab-ci.yml`, etc.

**Directory Structure:**
Map standard directories and their purposes.

**Project Description:**
Extract from README.md or package.json.

#### Step 4: Detect AIWG State

Check for installed frameworks:

1. Read `.aiwg/frameworks/registry.json` if exists
2. Scan vendor-specific directories for deployed artifacts
3. Read `~/.local/share/ai-writing-guide/registry.json` for global state
4. Count agents and commands deployed

#### Step 5: Generate Context File

**Document structure varies by vendor** (see vendor-specific sections below).

**Common sections:**
- Project overview
- Tech stack
- Development commands
- Testing information
- Architecture/structure
- **[PRESERVED TEAM CONTENT]** (verbatim, in original location)
- Project artifacts (@-mentions to .aiwg/)
- AIWG integration summary
- **Full Reference section** (links only, minimal inline)

#### Step 6: Write Output

**If `--dry-run`:** Display content, do not write.

**Otherwise:**
1. Ensure target directory exists
2. Write generated content to `{context-file}`
3. Verify write succeeded
4. Report summary

### 5. Standard Summary Report

```
{context-file} Regenerated
====================================

Backup: {context-file}.backup-20260113-152233

Team Content Preserved:
  ✓ Team Conventions (18 lines)
  ✓ Definition of Done (9 lines)
  ✓ Security Requirements (7 lines)
  ✓ API Guidelines (12 lines)

AIWG Content Updated:
  ✓ Tech Stack (TypeScript, Node.js 18+)
  ✓ Development Commands (12 scripts)
  ✓ Testing (Vitest)
  ✓ Project Artifacts (@-mentions)
  ✓ AIWG Integration
    - {framework} ({N} agents, {M} commands)
    - {addon} (utilities)

Enhancements Added:
  ✓ Linked Security Requirements → flow-security-review-cycle
  ✓ Linked API Guidelines → architecture docs

Output: {context-file} ({lines} lines, {bytes} bytes)
```

### 6. Error Handling

| Condition | Action |
|-----------|--------|
| No context file exists | Generate fresh document |
| Backup fails | Abort, report error |
| Read error | Report error, suggest --full |
| No AIWG detected | Generate project-only content, warn |
| No package files | Generate minimal structure, warn |
| Ambiguous content | Preserve it (err on side of caution) |

### 7. Related Commands Section

```markdown
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
```

## Vendor-Specific Sections

### VENDOR_COMMANDS Section

**Purpose:** List only commands relevant to this vendor.

**Claude Code:**
```markdown
### Available Commands

Commands are invoked with `/command-name`:

**Intake & Planning:**
- `/intake-wizard` - Generate project intake forms
- `/project-status` - Check current project phase

**Phase Transitions:**
- `/flow-inception-to-elaboration` - Transition to Elaboration
- `/flow-gate-check` - Validate phase gate criteria

**Full command list:** @~/.local/share/ai-writing-guide/agentic/code/frameworks/sdlc-complete/commands/
```

**GitHub Copilot:**
```markdown
### Natural Language Patterns

Request workflows using natural language:

| Request | Maps To |
|---------|---------|
| "run security review" | flow-security-review-cycle |
| "check project status" | project-status |
| "transition to elaboration" | flow-inception-to-elaboration |

**Full pattern list:** @~/.local/share/ai-writing-guide/agentic/code/frameworks/sdlc-complete/docs/simple-language-translations.md
```

**Cursor / Devin Desktop:**
```markdown
### Workflow Requests

Use natural language to request AIWG workflows:

Examples:
- "Run security review for this feature"
- "Check project status and next steps"
- "Generate test strategy for authentication module"

**Full workflow guide:** @~/.local/share/ai-writing-guide/agentic/code/frameworks/sdlc-complete/docs/orchestrator-architecture.md
```

### VENDOR_AGENTS Section

**Claude Code:**
```markdown
### Available Agents

Agents are markdown files in `.claude/agents/`:

**Architecture & Design:**
- `architecture-designer` - System architecture and technical decisions
- `database-architect` - Database design and optimization

**Development:**
- `software-implementer` - Test-first development
- `test-engineer` - Comprehensive test suite creation

**Full agent catalog:** @~/.local/share/ai-writing-guide/agentic/code/frameworks/sdlc-complete/agents/
```

**GitHub Copilot:**
```markdown
### Custom Agents

Agents are YAML files in `.github/agents/`:

Invoke via @-mention in Copilot Chat:
```text
@security-architect Review authentication implementation
@test-engineer Generate unit tests for user service
```

**Agent definitions:** .github/agents/
**Full catalog:** @~/.local/share/ai-writing-guide/agentic/code/frameworks/sdlc-complete/agents/
```

### VENDOR_REFERENCES Section

**Keep this section link-heavy, content-light.**

```markdown
## Full Reference

**AIWG Installation:** `~/.local/share/ai-writing-guide/`

**Framework Documentation:**
- SDLC Complete: @~/.local/share/ai-writing-guide/agentic/code/frameworks/sdlc-complete/README.md
- All Commands: @~/.local/share/ai-writing-guide/agentic/code/frameworks/sdlc-complete/commands/
- All Agents: @~/.local/share/ai-writing-guide/agentic/code/frameworks/sdlc-complete/agents/
- Natural Language Mappings: @~/.local/share/ai-writing-guide/agentic/code/frameworks/sdlc-complete/docs/simple-language-translations.md

**Core Orchestration:**
- Orchestrator Guide: @~/.local/share/ai-writing-guide/agentic/code/addons/aiwg-utils/prompts/core/orchestrator.md
- Agent Design Rules: @~/.local/share/ai-writing-guide/agentic/code/addons/aiwg-utils/prompts/agents/design-rules.md
- Error Recovery: @~/.local/share/ai-writing-guide/agentic/code/addons/aiwg-utils/prompts/reliability/resilience.md

**Multi-vendor setup?**
{Links to other vendor context files if they exist}
```

## Anti-Patterns to Avoid

1. **Don't inline full command definitions** - Link to them instead
2. **Don't duplicate framework docs** - Reference them
3. **Don't include commands for other vendors** - Keep it focused
4. **Don't remove team content** - Preserve everything team-written
5. **Don't generate opinions** - Preserve team's decisions
6. **Don't exceed ~400 lines** - Move detail to separate docs

## Testing Checklist

Before finalizing a regenerate command:

- [ ] Vendor detection works correctly
- [ ] Only vendor-specific commands included
- [ ] Team content preservation works
- [ ] Backup creation works
- [ ] Dry-run mode works
- [ ] Summary report is accurate
- [ ] Links to full docs are correct
- [ ] Context file size is reasonable (<500 lines)
- [ ] Multi-vendor references work
- [ ] Error handling is robust

## Implementation Notes

Each vendor regenerate command should:

1. Import this base template structure
2. Add vendor-specific detection logic (see vendor-detection.md)
3. Customize the VENDOR_COMMANDS section
4. Customize the VENDOR_AGENTS section
5. Customize the VENDOR_REFERENCES section
6. Keep common elements consistent across vendors
7. Test with real projects that have team content

## Version History

- **2026.01.0** - Initial base template with vendor-specific filtering
- Purpose: Reduce context pollution by including only relevant vendor content
