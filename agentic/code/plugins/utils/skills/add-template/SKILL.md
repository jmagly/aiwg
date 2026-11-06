---
namespace: aiwg
name: add-template
platforms: [all]
description: Scaffold a new document template inside an existing addon or framework
---

# Add Template

Scaffold a new document template inside an existing addon or framework.

## Triggers

Alternate expressions and non-obvious activations (primary phrases are matched automatically from the skill description):

- "I need a new template" → scaffold template in specified target
- "add a document template" → prompt for name, category, and target
- "create a template for X documents" → derive name from X, prompt for target
- "template for use cases" → name=`use-case`, prompt for target and category

## Trigger Patterns Reference

| Pattern | Example | Action |
|---------|---------|--------|
| Named add | "add template adr --to sdlc-complete" | Scaffold directly |
| Category specified | "add template threat-model --to sdlc-complete --category security" | Place in category subdir |
| Interactive | "add template --interactive --to sdlc-complete" | Guided design mode |
| Target omitted | "add template risk-register" | Ask which addon or framework |

## Process

### 1. Parse Arguments

Extract from `$ARGUMENTS`:
- `<name>` — kebab-case template name (required)
- `--to <target>` — addon or framework directory name (required)
- `--category <category>` — subdirectory within `templates/` (optional; e.g., `requirements`, `architecture`, `security`)
- `--interactive` — enable guided design questions

If either `<name>` or `--to` is missing, ask before proceeding.

### 2. Validate Target

Confirm the target exists:

```bash
# Check addons
ls agentic/code/addons/<target>/templates/

# Check frameworks
ls agentic/code/frameworks/<target>/templates/
```

### 3. Determine Category

If `--category` is not provided and the target has existing category subdirectories, list them and ask. Common categories in sdlc-complete:

| Category | Contents |
|----------|----------|
| `requirements` | Use cases, user stories, NFRs |
| `architecture` | SAD, ADRs, C4 diagrams |
| `security` | Threat models, security gates |
| `testing` | Test plans, test cases, test reports |
| `deployment` | Deployment plans, runbooks |
| `planning` | Phase plans, iteration plans, risk registers |
| `analysis-design` | Domain models, sequence diagrams |

If no category is appropriate, place directly in `templates/`.

### 4. Interactive Design (if --interactive)

Ask before generating:

1. **Purpose**: What SDLC artifact does this template produce?
2. **Audience**: Who fills in this template? (developer, architect, project manager)
3. **Required sections**: What sections must every instance include?
4. **Optional sections**: What sections depend on the specific project?
5. **Variables**: What `{{placeholder}}` variables should be pre-populated by tooling?
6. **Examples**: Should the template include inline examples?

### 5. Run Scaffolding

```bash
aiwg add-template <name> --to <target> [--category <category>]
```

### 6. Customize the Generated Template

Templates use Markdown with YAML frontmatter and `{{variable}}` placeholders:

```markdown
---
template: <name>
version: 1.0.0
category: <category>
description: <one-sentence purpose>
variables:
  - project_name
  - author
  - date
---

# <Template Title>

**Project**: {{project_name}}
**Author**: {{author}}
**Date**: {{date}}
**Version**: 1.0

---

## Purpose

[What this document is for and when to create it]

## Section 1: <Required Section>

[Instructions for completing this section]

> **Guidance**: [What a good answer looks like]

## Section 2: <Required Section>

[Instructions]

## Section 3: <Optional Section> *(if applicable)*

[Instructions]

---

## Review Checklist

Before finalizing this document:

- [ ] All required sections completed
- [ ] Variables replaced with actual values
- [ ] Reviewed by [role]
- [ ] Approved by [role]
```

### 7. Register in Templates Manifest

The CLI tool updates the templates manifest. Verify:

```json
{
  "templates": {
    "<category>": ["existing-template", "<name>"]
  }
}
```

## Generated Structure

```
<target>/templates/<category>/<name>-template.md
```

Or at root if no category:

```
<target>/templates/<name>-template.md
```

Manifest updated: `<target>/manifest.json` (or `<target>/templates/manifest.json` if present)

## Output Format

```
Template Created: <name>
────────────────────────
Location: <target>/templates/<category>/<name>-template.md
Category:  <category>

Created:
  ✓ <name>-template.md

Manifest updated: <target>/manifest.json

Next Steps:
  1. Define required sections and guidance text
  2. Add {{variable}} placeholders for automation
  3. Include review checklist
  4. Test: aiwg template-engine apply <name> --to .aiwg/<category>/
```

## Examples

### Example 1: Architecture decision record

**User**: "add template adr --to sdlc-complete --category governance"

**Action**:
```bash
aiwg add-template adr --to sdlc-complete --category governance
```

**Result**: `agentic/code/frameworks/sdlc-complete/templates/governance/adr-template.md` scaffolded with standard ADR sections (Context, Decision, Consequences, Alternatives).

### Example 2: Security threat model

**User**: "create a threat model template for sdlc-complete"

**Extraction**: name=`threat-model`, target=`sdlc-complete`, category=`security`

**Action**:
```bash
aiwg add-template threat-model --to sdlc-complete --category security
```

### Example 3: Interactive template design

**User**: "add template --interactive --to sdlc-complete"

**Process**: Guided questions establish the artifact type, required sections, variables, and whether examples should be embedded.

## References

- @$AIWG_ROOT/src/cli/handlers/scaffolding.ts — CLI handler implementation
- @$AIWG_ROOT/docs/cli-reference.md — Full CLI reference
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/ — Example templates
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/skills/devkit-create-skill/SKILL.md — Related scaffolding pattern
