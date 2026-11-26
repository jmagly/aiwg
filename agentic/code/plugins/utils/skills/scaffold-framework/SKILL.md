---
namespace: aiwg
name: scaffold-framework
platforms: [all]
description: Create a complete framework package structure inside agentic/code/frameworks/. Use when authoring an expansion (framework) for AIWG.
triggers:
  - author a framework
  - create a framework
  - build a framework package
  - framework authoring
  - scaffold framework
  - new expansion
---

# Scaffold Framework

Create a complete framework package structure inside `agentic/code/frameworks/`.

## Triggers

Alternate expressions and non-obvious activations (primary phrases are matched automatically from the skill description):

- "I need a new framework" → scaffold framework with guided design
- "create an AIWG framework" → prompt for name, scaffold
- "build a lifecycle framework for X" → derive name from X, scaffold with interactive mode
- "new framework package" → prompt for name and description

## Trigger Patterns Reference

| Pattern | Example | Action |
|---------|---------|--------|
| Named scaffold | "scaffold framework legal-ops" | Scaffold directly |
| Interactive | "scaffold framework --interactive" | Full guided design mode |
| Described | "create a framework for content production pipelines" | Derive name=`content-production`, confirm |
| Phased | "scaffold framework data-science --phases discovery,analysis,modeling,deployment" | Scaffold with custom phases |

## Understanding Frameworks

Frameworks are major capability bundles that model complete operational lifecycles. They contain everything a team needs to manage a specific type of work end-to-end. Examples:

| Framework | Purpose | Scale |
|-----------|---------|-------|
| `sdlc-complete` | Software development lifecycle | ~58 agents, 100+ templates |
| `media-marketing-kit` | Marketing operations | ~37 agents, campaign lifecycle |
| `forensics-complete` | Digital forensics and IR | Investigation lifecycle |
| `research-complete` | Research workflow automation | Research phases |

Frameworks differ from addons:
- **Frameworks**: Define a complete lifecycle with phases, transitions, and gate criteria
- **Addons**: Provide cross-cutting feature bundles installed alongside any framework

Framework creation is a significant undertaking. Study existing frameworks before building new ones. Start with core agents per phase, then expand.

## Process

### 1. Parse Arguments

Extract from `$ARGUMENTS`:
- `<name>` — kebab-case framework name (required)
- `--description "<text>"` — short description (optional; prompted if absent)
- `--phases "<p1,p2,...>"` — comma-separated phase list (optional; defaults to `inception,elaboration,construction,transition`)
- `--author "<name>"` — author name (optional)
- `--interactive` — enable guided design questions

If `<name>` is missing, ask before proceeding.

### 2. Validate Name

- Must be kebab-case
- Must not conflict with existing frameworks:

```bash
ls agentic/code/frameworks/
```

### 3. Interactive Design (if --interactive)

This is the recommended path for first-time framework creation. Ask:

1. **Lifecycle**: What lifecycle does this framework manage? (software dev, marketing, legal, research)
2. **Target audience**: Who uses this framework? (engineering teams, marketing departments, legal firms)
3. **Phase structure**: What phases does this lifecycle include?
   - Default: inception → elaboration → construction → transition
   - Custom examples: discovery → analysis → synthesis → publication
4. **Phase gates**: What criteria must be met to transition between phases?
5. **Agent categories**: What specialist roles are needed per phase?
   - Analysis (analysts, researchers, planners)
   - Design (architects, designers, strategists)
   - Execution (developers, writers, implementers)
   - Quality (reviewers, testers, validators)
   - Coordination (managers, orchestrators, leads)
6. **Template categories**: What artifact types will this framework produce?
   - Planning, requirements, design, implementation, quality, and deployment artifacts
7. **Core commands**: What phase-execution and transition commands are needed?

### 4. Run Scaffolding

```bash
aiwg scaffold-framework <name> \
  --description "<description>" \
  --phases "<phase1,phase2,...>"
```

### 5. Customize Generated Files

**manifest.json** — Framework registry entry:

```json
{
  "name": "<name>",
  "version": "1.0.0",
  "description": "<description>",
  "author": "<author>",
  "phases": ["<phase1>", "<phase2>"],
  "agents": [],
  "commands": [],
  "skills": [],
  "rules": [],
  "templates": {}
}
```

**README.md** — Framework overview: purpose, phases, agent catalog, quick start.

**actors-and-templates.md** — Maps roles to artifacts per phase. Critical for orchestration.

**plan-act-`<name>`.md** — Master plan-and-act document defining framework behavior.

### 6. Populate Phase Flows

Each phase gets a flow definition in `flows/`:

```markdown
# <Phase> Phase Flow

## Objectives
[What this phase accomplishes]

## Entry Criteria
[What must be true to begin this phase]

## Activities
[What happens in this phase]

## Artifacts Produced
[Documents and deliverables]

## Exit Criteria / Gate
[What must be true to leave this phase]

## Agents
[Which agents are active in this phase]
```

### 7. Build Agent Catalog (Priority Order)

After scaffold, build agents in this order:

1. **Phase 1**: 2-3 core agents per phase (primary authors)
2. **Phase 2**: Reviewer agents and other specialized agents as needed for each phase
3. **Phase 3**: Orchestration agents for phase transitions

```bash
aiwg add-agent <role> --to <name> --template complex
```

### 8. Build Command Set (Priority Order)

1. **Phase execution**: `flow-<phase>` commands
2. **Phase transitions**: `flow-<phase>-to-<next>` commands
3. **Utilities**: `project-status`, `gate-check`, `health-check`

```bash
aiwg add-command flow-<phase> --to <name> --template orchestration
```

### 9. Build Template Set (Priority Order)

1. Create 2-3 key templates per phase
2. Add specialized templates as needed
3. Add cross-cutting templates shared across phases

Review `actors-and-templates.md` first so the initial agents and templates cover the key artifacts.

### 10. Deploy and Validate

```bash
# Deploy framework to active provider
aiwg use <name>

# Validate structure and metadata
aiwg validate-metadata

# Health check
aiwg doctor
```

## Generated Structure

```
agentic/code/frameworks/<name>/
├── README.md                  # Framework documentation
├── manifest.json              # Framework configuration and registry
├── plan-act-<name>.md         # Master plan-and-act document
├── actors-and-templates.md    # Role-to-artifact mapping
├── agents/                    # Agent definitions (.md files)
├── skills/                    # Skill definitions
├── commands/                  # Slash command definitions
├── rules/                     # Framework-specific rules
├── templates/                 # Document templates (by category)
├── flows/                     # Phase flow definitions
│   ├── <phase1>.md
│   ├── <phase2>.md
│   └── ...
└── docs/                      # Framework documentation
    ├── orchestrator-architecture.md
    └── agent-catalog.md
```

## Output Format

```
Framework Created: <name>
─────────────────────────
Location: agentic/code/frameworks/<name>/

Phases: <phase1> → <phase2> → ... → <phaseN>

Created:
  ✓ README.md
  ✓ manifest.json
  ✓ plan-act-<name>.md
  ✓ actors-and-templates.md
  ✓ agents/
  ✓ skills/
  ✓ commands/
  ✓ rules/
  ✓ templates/
  ✓ flows/<phase>.md  (for each phase)
  ✓ docs/

Next Steps:
  1. Define actors:   Edit actors-and-templates.md
  2. Add agents:      aiwg add-agent <role> --to <name>   (2-3 per phase)
  3. Add commands:    aiwg add-command flow-<phase> --to <name>
  4. Add templates:   aiwg add-template <artifact> --to <name> --category <phase>
  5. Deploy:          aiwg use <name>
  6. Validate:        aiwg validate-metadata

Reference frameworks:
  - sdlc-complete:        58 agents, ~100 templates (comprehensive)
  - media-marketing-kit:  37 agents, marketing-focused
```

## Examples

### Example 1: Standard lifecycle framework

**User**: "scaffold framework legal-ops"

**Action**:
```bash
aiwg scaffold-framework legal-ops \
  --description "Legal operations and case management lifecycle" \
  --phases "intake,investigation,analysis,drafting,review,close"
```

**Result**: `agentic/code/frameworks/legal-ops/` created with six phase flow files and full directory structure.

### Example 2: Interactive framework design

**User**: "scaffold framework --interactive"

**Process**: Guided questions establish the lifecycle type (e.g., content production), phases (ideation, research, writing, editing, publication), agent categories, and initial agent/command stubs.

### Example 3: Research workflow framework

**User**: "create a new AIWG framework called data-science-ops"

**Action**:
```bash
aiwg scaffold-framework data-science-ops \
  --description "Data science project lifecycle management" \
  --phases "discovery,data-preparation,modeling,evaluation,deployment"
```

## References

- @$AIWG_ROOT/src/cli/handlers/scaffolding.ts — CLI handler implementation
- @$AIWG_ROOT/docs/cli-reference.md — Full CLI reference
- @$AIWG_ROOT/docs/development/framework-creation-guide.md — Detailed framework authoring guide
- @$AIWG_ROOT/docs/development/devkit-overview.md — Developer toolkit overview
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/ — Primary reference implementation
- @$AIWG_ROOT/agentic/code/frameworks/media-marketing-kit/ — Alternative reference implementation
