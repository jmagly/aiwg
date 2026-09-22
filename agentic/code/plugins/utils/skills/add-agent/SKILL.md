---
namespace: aiwg
name: add-agent
platforms: [all]
description: Scaffold a new agent definition file inside an existing addon or framework
---

# Add Agent

Scaffold a new agent definition file inside an existing addon or framework.

## Triggers

Alternate expressions and non-obvious activations (primary phrases are matched automatically from the skill description):

- "I need a new agent" → scaffold agent in specified target
- "build me an agent" → scaffold agent with interactive guidance
- "write an agent for X" → scaffold agent named after the described role
- "agent for <role>" → derive name from role, prompt for target

## Trigger Patterns Reference

| Pattern | Example | Action |
|---------|---------|--------|
| Named add | "add agent security-auditor --to sdlc-complete" | Scaffold directly |
| Role description | "create an agent that reviews PRs" | Derive name, scaffold |
| Interactive | "add agent --interactive" | Guided mode, ask for name/target/template |
| Target omitted | "add agent code-reviewer" | Ask which addon or framework |

## Process

### 1. Parse Arguments

Extract from `$ARGUMENTS`:
- `<name>` — kebab-case agent name (required)
- `--to <target>` — addon or framework directory name (required)
- `--template <type>` — one of `simple` (default), `complex`, `orchestrator`, `validator`
- `--interactive` — enable guided design questions

If either `<name>` or `--to` is missing, ask before proceeding.

### 2. Validate Target

Confirm the target addon or framework exists:

```bash
# Check addons
ls agentic/code/addons/<target>/

# Check frameworks
ls agentic/code/frameworks/<target>/
```

If not found, report available targets and stop.

### 3. Interactive Design (if --interactive)

Ask the following before generating:

1. **Role**: What is this agent's primary role?
2. **Expertise**: What domains or technologies does it specialize in?
3. **Responsibilities**: What are its 3-5 key responsibilities?
4. **Tools needed**: Which tools does it require? (Read, Write, Bash, Grep, WebFetch, Task)
5. **Model tier**: haiku (fast/utility), sonnet (balanced), opus (reasoning-heavy)
6. **Output format**: What structured output should it produce?

### 4. Select Template

| Template | Use When | Default Model | Tools |
|----------|----------|---------------|-------|
| `simple` | Single-purpose utility agent | haiku | Read, Write |
| `complex` | Domain expert, reviewer, analyst | sonnet | Read, Write, Grep |
| `orchestrator` | Coordinates other agents | opus | Task |
| `validator` | Read-only quality/compliance gate | haiku | Read, Grep |

### 5. Run Scaffolding

```bash
aiwg add-agent <name> --to <target> --template <type>
```

This generates `<target>/agents/<name>.md` with the appropriate frontmatter and section stubs.

### 6. Customize the Generated File

The generated agent file requires population of these sections:

```markdown
---
name: <name>
description: <one-sentence purpose>
model: <claude-haiku-4-5|claude-sonnet-5|claude-opus-5>  # Pin specific variant; bare aliases (`sonnet`) inherit the parent session's 1M-context attributes and hit the usage-credit gate on subagent dispatch. See #1442.
tools: <comma-separated tool list>
category: <phase or domain>
---

# Agent Title

[Role description]

## Expertise

[Domain knowledge and skills]

## Responsibilities

[Numbered list of what this agent does]

## Workflow

[How it approaches tasks — research, draft, validate, output]

## Output Format

[Expected structure of deliverables]
```

### 7. Validate Against 10 Golden Rules

After creation, run the agent linter:

```bash
aiwg lint agents <target>/agents/<name>.md --verbose
```

Key checks:
- Single responsibility (no "and" overload in description)
- Minimal tools (0-3 tools, each justified)
- Explicit I/O contract defined
- Model tier matches task complexity

### 8. Update Manifest

The CLI tool updates `<target>/manifest.json` automatically. Verify:

```json
{
  "agents": ["existing-agent", "<name>"]
}
```

## Generated Structure

```
<target>/agents/<name>.md
```

Manifest updated: `<target>/manifest.json`

## Output Format

```
Agent Created: <name>
─────────────────────
Location: <target>/agents/<name>.md
Template:  <type>
Model:     <model>

Created:
  ✓ <target>/agents/<name>.md
  ✓ manifest.json updated

Validation:
  ✓ Single responsibility
  ✓ Tool count within limit
  ✓ I/O contract defined

Next Steps:
  1. Edit Expertise section with domain knowledge
  2. Define Responsibilities (3-5 items)
  3. Specify Output Format structure
  4. Run: aiwg lint agents <target>/agents/<name>.md
```

## Examples

### Example 1: Simple utility agent

**User**: "add agent dependency-auditor --to aiwg-utils"

**Action**:
```bash
aiwg add-agent dependency-auditor --to aiwg-utils
```

**Result**: `agentic/code/addons/aiwg-utils/agents/dependency-auditor.md` scaffolded with simple template (haiku, Read + Grep tools).

### Example 2: Complex domain expert

**User**: "create a threat modeling agent for sdlc-complete"

**Extraction**: name=`threat-modeler`, target=`sdlc-complete`, template=`complex`

**Action**:
```bash
aiwg add-agent threat-modeler --to sdlc-complete --template complex
```

**Result**: `agentic/code/frameworks/sdlc-complete/agents/threat-modeler.md` scaffolded with sonnet model, Read/Write/Grep tools.

### Example 3: Interactive guided creation

**User**: "add agent --interactive --to sdlc-complete"

**Process**: Guided questions gather role, expertise, responsibilities, tools, and model tier before scaffolding.

## References

- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/skills/devkit-create-agent/SKILL.md — Devkit equivalent (interactive design)
- @$AIWG_ROOT/src/cli/handlers/scaffolding.ts — CLI handler implementation
- @$AIWG_ROOT/docs/cli-reference.md — Full CLI reference
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/agents/ — Example agent definitions
