---
namespace: aiwg
name: scaffold-extension
platforms: [all]
description: Create a new extension package inside an existing framework's extensions/ directory. Use when authoring an expansion (extension) for AIWG.
triggers:
  - author an expansion
  - build an extension
  - create an extension package
  - expansion authoring
  - scaffold extension
  - new expansion
---

# Scaffold Extension

Create a new extension package inside an existing framework's `extensions/` directory.

## Triggers

Alternate expressions and non-obvious activations (primary phrases are matched automatically from the skill description):

- "I need a new extension" → scaffold extension in specified framework
- "create an extension package" → prompt for name and parent framework
- "add Python support to sdlc-complete" → derive name=`python`, scaffold in sdlc-complete
- "new language extension" → clarify name and framework, scaffold

## Trigger Patterns Reference

| Pattern | Example | Action |
|---------|---------|--------|
| Named scaffold | "scaffold extension python --to sdlc-complete" | Scaffold directly |
| Language extension | "add Go support to sdlc-complete" | Derive name=`go`, confirm |
| Interactive | "scaffold extension --interactive --to sdlc-complete" | Guided design mode |
| Target omitted | "scaffold extension typescript" | Ask which framework |

## Understanding Extensions

Extensions are language- or ecosystem-specific capability packages nested inside a framework. They augment framework agents and rules with toolchain-specific knowledge. Examples:

| Extension | Framework | Provides |
|-----------|-----------|---------|
| `python/` | `sdlc-complete` | Python testing patterns, type hint rules, pip/poetry guidance |
| `javascript/` | `sdlc-complete` | npm/pnpm workflows, ESLint integration, Jest patterns |
| `github/` | `sdlc-complete` | GitHub Actions, PR review workflows, release automation |
| `terraform/` | `sdlc-complete` | IaC patterns, state management, plan review agents |

Extensions differ from addons:
- **Extensions**: Nested within a specific framework, language/ecosystem-scoped
- **Addons**: Standalone, cross-cutting, installed alongside any framework

Extensions cannot contain skills (skills require standalone functionality). They contain agents, rules, and templates scoped to their ecosystem.

## Process

### 1. Parse Arguments

Extract from `$ARGUMENTS`:
- `<name>` — kebab-case extension name (required; often a language or ecosystem name)
- `--to <framework>` — parent framework directory name (required)
- `--description "<text>"` — short description (optional)
- `--interactive` — enable guided design questions

If either `<name>` or `--to` is missing, ask before proceeding.

### 2. Validate Parent Framework

Confirm the parent framework exists:

```bash
ls agentic/code/frameworks/<framework>/
```

Check if an `extensions/` directory exists; if not, it will be created.

Check for name conflicts:

```bash
ls agentic/code/frameworks/<framework>/extensions/ 2>/dev/null
```

### 3. Interactive Design (if --interactive)

Ask before generating:

1. **Ecosystem**: What language, platform, or ecosystem does this extension target?
2. **Capabilities**: What ecosystem-specific capabilities does it add? (linting rules, test patterns, deployment agents)
3. **Agents**: What specialist agents should be scaffolded? (e.g., `python-test-engineer`, `go-module-auditor`)
4. **Rules**: What ecosystem-specific rules should be defined? (e.g., type safety, package management)
5. **Templates**: What ecosystem-specific document templates are needed?
6. **Compliance/domain**: What domain, requirements, or standards does it cover?
   - Compliance examples: GDPR, HIPAA, SOX, PCI-DSS, FTC
   - Domain examples: healthcare, fintech, government
7. **Checklists**: What verification checklists are needed?
8. **Dependencies**: Does it depend on other extensions?

### 4. Run Scaffolding

```bash
aiwg scaffold-extension <name> --to <framework> [--description "..."]
```

### 5. Customize Generated Files

**manifest.json** — The extension's registry entry:

```json
{
  "name": "<name>",
  "version": "1.0.0",
  "description": "<ecosystem-specific capabilities>",
  "parentFramework": "<framework>",
  "agents": [],
  "rules": [],
  "templates": []
}
```

**README.md** — Document the ecosystem targeted, capabilities provided, and activation conditions.

### 6. Add Ecosystem-Specific Components

After scaffold:

```bash
# Add ecosystem-specific agent
aiwg add-agent <name>-specialist --to <framework>/extensions/<name>
# Note: --to path traversal not yet supported; create agent file directly

# Create agent file
# <framework>/extensions/<name>/agents/<role>.md

# Create rules
# <framework>/extensions/<name>/rules/<rule-id>.md

# Create templates
# <framework>/extensions/<name>/templates/<template>-template.md
```

Offer to create the initial templates and verification checklists identified during design.
Document any extension dependencies and activation instructions in the generated README;
add domain-specific checklists under `checklists/` when needed.

### 7. Register with Parent Framework

Ensure the parent framework's manifest references the extension:

```json
{
  "extensions": ["existing-extension", "<name>"]
}
```

The CLI tool handles this automatically.

## Generated Structure

```
agentic/code/frameworks/<framework>/extensions/<name>/
├── README.md          # Extension documentation
├── manifest.json      # Extension configuration
├── agents/            # Ecosystem-specific agent definitions
├── rules/             # Ecosystem-specific rule files
└── templates/         # Ecosystem-specific document templates
```

Parent framework manifest updated: `agentic/code/frameworks/<framework>/manifest.json`

## Output Format

```
Extension Created: <name>
─────────────────────────
Location: agentic/code/frameworks/<framework>/extensions/<name>/
Parent:    <framework>

Created:
  ✓ README.md
  ✓ manifest.json
  ✓ agents/
  ✓ rules/
  ✓ templates/

Parent manifest updated: <framework>/manifest.json

Next Steps:
  1. Edit README.md with ecosystem description
  2. Add ecosystem agents: create agents/<role>.md
  3. Add ecosystem rules:  create rules/<rule-id>.md
  4. Add templates:        create templates/<name>-template.md
  5. Deploy parent:        aiwg use <framework>
```

## Examples

### Example 1: Language extension

**User**: "scaffold extension python --to sdlc-complete"

**Action**:
```bash
aiwg scaffold-extension python --to sdlc-complete
```

**Result**: `agentic/code/frameworks/sdlc-complete/extensions/python/` created with full structure. Parent manifest updated with `"extensions": ["python"]`.

### Example 2: Platform extension with description

**User**: "create a GitHub Actions extension for sdlc-complete"

**Extraction**: name=`github-actions`, target=`sdlc-complete`

**Action**:
```bash
aiwg scaffold-extension github-actions --to sdlc-complete \
  --description "GitHub Actions workflow generation and PR automation"
```

### Example 3: Interactive extension design

**User**: "scaffold extension --interactive --to sdlc-complete"

**Process**: Guided questions identify ecosystem (e.g., Terraform), capabilities, agents (infrastructure-reviewer, plan-analyzer), and rules (state-management, variable-validation).

## References

- @$AIWG_ROOT/src/cli/handlers/scaffolding.ts — CLI handler implementation
- @$AIWG_ROOT/docs/cli-reference.md — Full CLI reference
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/extensions/ — Existing extension examples
