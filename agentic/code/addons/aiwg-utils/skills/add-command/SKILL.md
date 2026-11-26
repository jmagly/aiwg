---
namespace: aiwg
name: add-command
platforms: [all]
description: Scaffold a new command definition inside an existing addon or framework
---

# Add Command

Scaffold a new command definition inside an existing addon or framework.

## Triggers

Alternate expressions and non-obvious activations (primary phrases are matched automatically from the skill description):

- "I need a new command" → scaffold command in specified target
- "build a slash command" → scaffold with slash-command template
- "add a flow command" → scaffold with orchestration template
- "new CLI command for X" → derive name, prompt for target

## Trigger Patterns Reference

| Pattern | Example | Action |
|---------|---------|--------|
| Named add | "add command lint-fix --to aiwg-utils" | Scaffold directly |
| Template specified | "add command deploy-all --template orchestration" | Use named template |
| Interactive | "add command --interactive --to sdlc-complete" | Guided mode |
| Target omitted | "add command my-command" | Ask which addon or framework |

## Process

### 1. Parse Arguments

Extract from `$ARGUMENTS`:
- `<name>` — kebab-case command name (required)
- `--to <target>` — addon or framework directory name (required)
- `--template <type>` — one of `utility` (default), `transformation`, `orchestration`
- `--interactive` — enable guided design questions

If either `<name>` or `--to` is missing, ask before proceeding.

### 2. Understand the Command Model

Commands in AIWG are generated from skills at deploy time. The primary source of truth is the skill definition; the command file is the deployable artifact. This skill scaffolds the command `.md` file directly inside the target's `commands/` directory.

Commands differ from skills:
- **Commands**: Invoked explicitly via `/command-name $ARGUMENTS`
- **Skills**: Invoked by natural language pattern matching

Use a command when the user needs explicit control over invocation.

### 3. Validate Target

Confirm the target exists:

```bash
# Check addons
ls agentic/code/addons/<target>/

# Check frameworks
ls agentic/code/frameworks/<target>/
```

### 4. Select Template

| Template | Use When | Structure |
|----------|----------|-----------|
| `utility` | Single action, quick operation | Arguments, Steps, Output |
| `transformation` | Input → processed output pipeline | Input, Pipeline stages, Output format |
| `orchestration` | Multi-agent workflow, phase transitions | Phases, Agent assignments, Gate criteria |

### 5. Interactive Design (if --interactive)

Ask before generating:

1. **Purpose**: What does this command do in one sentence?
2. **Arguments**: What positional inputs does it accept?
3. **Options**: What `--flag` options should it support?
4. **Steps**: What are the 3-7 execution steps?
5. **Output**: What should the success output look like?
6. **Error handling**: What should happen when inputs are invalid?

### 6. Run Scaffolding

```bash
aiwg add-command <name> --to <target> --template <type>
```

### 7. Customize the Generated File

```markdown
---
name: <name>
description: <one-sentence purpose>
args: [<arg>] [--option value]
---

# Command Title

[Description]

## Usage

\`\`\`
/<name> <arg> [--option value]
\`\`\`

## Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| <arg> | Yes | What it controls |

## Options

| Option | Default | Description |
|--------|---------|-------------|
| --option | value | What it controls |

## Execution

1. Validate inputs
2. [Step 2]
3. [Step 3]

## Output

[What success looks like]
```

### 8. Update Manifest

The CLI tool updates `<target>/manifest.json`. Verify:

```json
{
  "commands": ["existing-command", "<name>"]
}
```

## Generated Structure

```
<target>/commands/<name>.md
```

Manifest updated: `<target>/manifest.json`

## Output Format

```
Command Created: <name>
───────────────────────
Location: <target>/commands/<name>.md
Template:  <type>

Created:
  ✓ <target>/commands/<name>.md
  ✓ manifest.json updated

Next Steps:
  1. Define arguments and options
  2. Write execution steps
  3. Specify output format
  4. Deploy: aiwg use <target>
  5. Test: /<name> --help
```

## Examples

### Example 1: Utility command

**User**: "add command validate-intake --to sdlc-complete"

**Action**:
```bash
aiwg add-command validate-intake --to sdlc-complete
```

**Result**: `agentic/code/frameworks/sdlc-complete/commands/validate-intake.md` scaffolded with utility template.

### Example 2: Orchestration workflow command

**User**: "create an orchestration command for running the security review cycle in aiwg-utils"

**Extraction**: name=`security-review-cycle`, target=`aiwg-utils`, template=`orchestration`

**Action**:
```bash
aiwg add-command security-review-cycle --to aiwg-utils --template orchestration
```

### Example 3: Transformation command

**User**: "scaffold a command called convert-voice --to voice-framework --template transformation --interactive"

**Process**: Guided questions clarify input format, transformation pipeline, and output shape before scaffolding.

## References

- @$AIWG_ROOT/src/cli/handlers/scaffolding.ts — CLI handler implementation
- @$AIWG_ROOT/docs/cli-reference.md — Full CLI reference
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/commands/ — Example command definitions
