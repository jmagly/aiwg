---
namespace: aiwg
name: add-skill
platforms: [all]
description: Scaffold a new SKILL.md inside an existing addon or framework
---

# Add Skill

Scaffold a new SKILL.md inside an existing addon or framework.

## Triggers

Alternate expressions and non-obvious activations (primary phrases are matched automatically from the skill description):

- "I need a new skill" → scaffold skill in specified target
- "make a skill that does X" → derive name from description, prompt for target
- "add a natural language skill" → clarify name and target, then scaffold
- "skill for X" → derive name, prompt for target

## Trigger Patterns Reference

| Pattern | Example | Action |
|---------|---------|--------|
| Named add | "add skill voice-apply --to voice-framework" | Scaffold directly |
| Description-driven | "create a skill that validates metadata" | Derive name=`validate-metadata`, prompt target |
| Interactive | "add skill --interactive --to aiwg-utils" | Guided design mode |
| Target omitted | "add skill my-skill" | Ask which addon or framework |

## Process

### 1. Parse Arguments

Extract from `$ARGUMENTS`:
- `<name>` — kebab-case skill name (required)
- `--to <target>` — addon or framework directory name (required; skills cannot be added to extensions)
- `--interactive` — enable guided design questions

If either `<name>` or `--to` is missing, ask before proceeding.

**Note**: Skills cannot be added to extensions. Extensions provide language/ecosystem-specific capabilities; skills require standalone, cross-cutting functionality.

### 2. Validate Target

Confirm the target addon or framework exists:

```bash
# Check addons
ls agentic/code/addons/<target>/

# Check frameworks
ls agentic/code/frameworks/<target>/
```

If target is an extension directory, explain the constraint and suggest using an addon instead.

### 3. Interactive Design (if --interactive)

Guide through skill design before generating:

1. **Purpose**: What does this skill do in one sentence?
2. **Trigger phrases**: What natural language phrases activate it?
   - Provide 3-5 examples covering common variations
3. **Input**: What does the skill need? (content, file path, parameters)
4. **Process**: What are the 3-7 execution steps?
5. **Output**: What does it produce? (transformed content, report, status)
6. **Reference materials**: Does it need supporting docs in `references/`?
7. **Platform targeting**: Which platforms should it deploy to?

### 4. Run Scaffolding

```bash
aiwg add-skill <name> --to <target>
```

### 5. Customize SKILL.md

The generated file needs these sections populated. Include required frontmatter:

- `name`: kebab-case skill slug
- `description`: non-empty purpose used for natural language matching; Codex rejects skills without it
- `version`: semver string (for example, `1.0.0`)
- `priority`: `critical`, `high`, `medium`, or `low`, used by corpus gap reports and backlog tooling

Use clear conversational triggers, specific execution steps, and realistic input/output examples.
Skills suit conversational capabilities and cross-cutting concerns; use a command when explicit invocation is needed.

```markdown
---
name: <skill-name>
description: <one-sentence purpose>
version: 1.0.0
priority: medium
platforms: [all]
---

# Skill Name

[One-paragraph description of what the skill does and when it activates]

## Triggers

Alternate expressions and non-obvious activations:

- "<phrase>" → <what happens>
- "<phrase>" → <what happens>

## Trigger Patterns Reference

| Pattern | Example | Action |
|---------|---------|--------|
| <category> | "<example>" | <action> |

## Process

### 1. <Step Name>
[Description and any code blocks]

### 2. <Step Name>
[Description]

## Generated Structure (if applicable)

\`\`\`
<what files are created>
\`\`\`

## Output Format

\`\`\`
<what success output looks like>
\`\`\`

## Examples

### Example 1: <scenario>

**User**: "<trigger phrase>"
**Extraction**: <what was parsed>
**Action**: <what runs>
**Result**: <what happens>

## References

- @path/to/related/file — description
```

### 6. Add Reference Materials (if needed)

If the skill references supporting documentation:

```bash
mkdir -p <target>/skills/<name>/references/
# Create reference files as needed
```

### 7. Update Manifest

The CLI tool updates `<target>/manifest.json`. Verify:

```json
{
  "skills": ["existing-skill", "<name>"]
}
```

## Generated Structure

```
<target>/skills/<name>/
├── SKILL.md           # Main skill definition
└── references/        # Supporting documentation (optional)
```

Manifest updated: `<target>/manifest.json`

## Output Format

```
Skill Created: <name>
─────────────────────
Location: <target>/skills/<name>/

Created:
  ✓ SKILL.md
  ✓ references/ (placeholder)

Manifest updated: <target>/manifest.json

Next Steps:
  1. Edit SKILL.md trigger phrases
  2. Write execution process steps
  3. Add reference materials (if needed)
  4. Test with natural language: "<trigger phrase>"
```

## Examples

### Example 1: Simple skill

**User**: "add skill lint-manifests --to aiwg-utils"

**Action**:
```bash
aiwg add-skill lint-manifests --to aiwg-utils
```

**Result**: `agentic/code/addons/aiwg-utils/skills/lint-manifests/SKILL.md` scaffolded with standard platform frontmatter and section stubs.

### Example 2: Interactive skill with reference materials

**User**: "create a skill voice-apply --to voice-framework --interactive"

**Process**: Guided questions establish trigger phrases ("apply voice", "write in X voice"), process steps (identify voice, load profile, transform), and reference materials needed (voice profile templates).

**Result**: `agentic/code/addons/voice-framework/skills/voice-apply/SKILL.md` plus `references/` directory.

### Example 3: Framework skill

**User**: "scaffold skill requirement-tracer --to sdlc-complete"

**Action**:
```bash
aiwg add-skill requirement-tracer --to sdlc-complete
```

## References

- @$AIWG_ROOT/src/cli/handlers/scaffolding.ts — CLI handler implementation
- @$AIWG_ROOT/docs/cli-reference.md — Full CLI reference
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/skills/ — Example skill definitions
