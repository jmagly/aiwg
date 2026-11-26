---
namespace: aiwg
name: scaffold-addon
platforms: [all]
description: Create a complete addon package structure inside agentic/code/addons/. Use when authoring an expansion (addon) for AIWG.
triggers:
  - author an addon
  - create an addon
  - build an expansion addon
  - addon authoring
  - scaffold addon
  - new expansion
---

# Scaffold Addon

Create a complete addon package structure inside `agentic/code/addons/`.

## Triggers

Alternate expressions and non-obvious activations (primary phrases are matched automatically from the skill description):

- "I need a new addon" → scaffold addon with given name
- "create an addon package" → prompt for name, scaffold
- "build a new AIWG addon" → prompt for name and description
- "new feature bundle" → clarify as addon, prompt for name

## Trigger Patterns Reference

| Pattern | Example | Action |
|---------|---------|--------|
| Named scaffold | "scaffold addon security-scanner" | Scaffold directly |
| Interactive | "scaffold addon --interactive" | Guided design mode |
| Description-driven | "create an addon for Python linting" | Derive name=`python-lint`, confirm |
| With description | "scaffold addon metrics --description 'Cost and token tracking'" | Scaffold with description pre-set |

## Understanding Addons

Addons are self-contained feature bundles that extend AIWG without belonging to a specific lifecycle framework. Examples:

| Addon | Purpose |
|-------|---------|
| `aiwg-utils` | Core meta-utilities (this addon) |
| `voice-framework` | Voice profiles and writing style enforcement |
| `testing-quality` | Test quality validation agents |
| `rlm` | Reflection-learning memory patterns |
| `ring-methodology` | Ring-based development methodology |

Addons differ from frameworks:
- **Addons**: Cross-cutting feature bundles, installed alongside frameworks
- **Frameworks**: Complete lifecycle management systems (sdlc-complete, media-marketing-kit)

## Process

### 1. Parse Arguments

Extract from `$ARGUMENTS`:
- `<name>` — kebab-case addon name (required)
- `--description "<text>"` — short description (optional; prompted if absent)
- `--author "<name>"` — author name (optional)
- `--interactive` — enable guided design questions
- `--core` — mark as core addon (auto-installed with every AIWG install)

If `<name>` is missing, ask before proceeding.

### 2. Validate Name

- Must be kebab-case (lowercase letters and hyphens only)
- Must not conflict with existing addons:

```bash
ls agentic/code/addons/
```

If conflict found, report existing addons and stop.

### 3. Interactive Design (if --interactive)

Ask before generating:

1. **Purpose**: What is the primary purpose of this addon? (1-2 sentences)
2. **Capabilities**: What specific capabilities will it provide? (list)
3. **Target users**: Who benefits from this addon? (developers, architects, writers)
4. **Core status**: Should this auto-install with every AIWG installation?
5. **Initial agents**: Should starter agent files be scaffolded?
6. **Initial skills**: Should starter skill directories be scaffolded?
7. **Initial rules**: Should starter rule files be scaffolded?
8. **Initial commands**: Should starter commands be scaffolded?

### 4. Run Scaffolding

```bash
aiwg scaffold-addon <name> [--description "..."] [--author "..."]
```

### 5. Customize Generated Files

**manifest.json** — The addon's registry entry:

```json
{
  "name": "<name>",
  "version": "1.0.0",
  "description": "<description>",
  "author": "<author>",
  "core": false,
  "autoInstall": false,
  "agents": [],
  "commands": [],
  "skills": [],
  "rules": [],
  "templates": [],
  "behaviors": []
}
```

**README.md** — Document the addon's purpose, capabilities, and usage.

### 6. Add Initial Components (if interactive)

After scaffold, offer to create starter components:

```bash
# Add a starter agent
aiwg add-agent <role> --to <name>

# Add a starter command
aiwg add-command <action> --to <name>

# Add a starter skill
aiwg add-skill <capability> --to <name>

# Add a starter rule
# (create manually: <name>/rules/<rule-id>.md)
```

### 7. Verify Structure

```bash
ls agentic/code/addons/<name>/
```

All required files must be present before deploying.

## Generated Structure

```
agentic/code/addons/<name>/
├── README.md          # Addon documentation
├── manifest.json      # Addon configuration and component registry
├── agents/            # Agent definitions (.md files)
├── skills/            # Skill definitions (<skill>/SKILL.md)
├── rules/             # Rule files (.md files)
└── templates/         # Document templates
```

## Output Format

```
Addon Created: <name>
─────────────────────
Location: agentic/code/addons/<name>/

Created:
  ✓ README.md
  ✓ manifest.json
  ✓ agents/
  ✓ skills/
  ✓ rules/
  ✓ templates/

Next Steps:
  1. Edit README.md with addon purpose and usage
  2. Update manifest.json (description, author, core flag)
  3. Add agents:    aiwg add-agent <name> --to <addon>
  4. Add skills:    aiwg add-skill <name> --to <addon>
  5. Add commands:  aiwg add-command <action> --to <addon>
  6. Add rules:     create <addon>/rules/<rule-id>.md
  7. Deploy:        aiwg use <addon>
  8. Validate:      aiwg validate-metadata
```

## Examples

### Example 1: Simple addon

**User**: "scaffold addon security-scanner"

**Action**:
```bash
aiwg scaffold-addon security-scanner
```

**Result**: `agentic/code/addons/security-scanner/` created with full directory structure and empty manifests.

### Example 2: Addon with description

**User**: "create a new addon package called cost-tracking with description 'Token usage and cost monitoring'"

**Action**:
```bash
aiwg scaffold-addon cost-tracking --description "Token usage and cost monitoring"
```

### Example 3: Interactive guided creation

**User**: "scaffold addon --interactive"

**Process**: Guided questions establish purpose, capabilities, target users, core status, and initial components. Starter agents and skills scaffolded automatically based on answers.

## References

- @$AIWG_ROOT/src/cli/handlers/scaffolding.ts — CLI handler implementation
- @$AIWG_ROOT/docs/cli-reference.md — Full CLI reference
- @$AIWG_ROOT/agentic/code/addons/ — Existing addon examples
