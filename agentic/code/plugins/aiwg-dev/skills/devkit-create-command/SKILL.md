---
namespace: aiwg
name: devkit-create-command
platforms: [all]
description: Create a new slash command with AI-guided behavior definition
---

<!-- AIWG-SKILL-CALLOUT -->
> **Skill access pattern (post-kernel-pivot, 2026.5+)**
>
> Skill names referenced in this document are AIWG skills, **not slash commands**. Most are not kernel-listed and cannot be invoked as `/skill-name` by the platform. Reach them via:
>
> ```bash
> aiwg discover "<capability>"
> aiwg show skill <name>
> ```
>
> Only kernel-listed skills (`aiwg-doctor`, `aiwg-refresh`, `aiwg-status`, `aiwg-help`, `use`, `steward`) are directly invokable as slash commands. See [skill-discovery rule](https://github.com/jmagly/aiwg/blob/main/agentic/code/addons/aiwg-utils/rules/skill-discovery.md).


# Create AIWG Command

Create a new slash command with AI assistance to define arguments, behavior, and output.

## Usage

```
/devkit-create-command <name> --to <target> [options]
```

## Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| name | Yes | Command name (kebab-case recommended) |

## Required Options

| Option | Description |
|--------|-------------|
| --to | Target addon or framework |

## Optional Options

| Option | Description |
|--------|-------------|
| --template | Command template: utility (default), transformation, orchestration |
| --interactive | Enable interactive mode with guided questions |

## Templates

### utility (default)
Simple operation, single action command.
- Best for: Quick tasks, file operations, status checks
- Example: `lint-check`, `deploy-status`

### transformation
Content/code transformation pipeline with input/output handling.
- Best for: Format conversion, code refactoring, content processing
- Example: `convert-format`, `refactor-code`

### orchestration
Multi-agent workflow coordination with phases and parallel execution.
- Best for: Complex workflows, phase transitions, multi-step processes
- Example: `flow-deploy-to-production`, `flow-security-review`

## Interactive Mode

When `--interactive` is specified, I will ask:

1. **Purpose**: What does this command do?
2. **Arguments**: What inputs does it need?
3. **Options**: What configuration options should it support?
4. **Steps**: What are the execution steps?
5. **Output**: What should the output look like?

## Examples

```bash
# Simple utility command
/devkit-create-command lint-fix --to aiwg-utils

# Transformation pipeline
/devkit-create-command convert-docs --to sdlc-complete --template transformation

# Orchestration workflow
/devkit-create-command deploy-all --to sdlc-complete --template orchestration --interactive
```

## Execution

1. **Validate inputs**: Check name and target
2. **Verify target exists**: Ensure addon/framework is installed
3. **Select template**: Use specified or default to utility
4. **Gather behavior**: In interactive mode, ask about command behavior
5. **Generate command file**: Create with frontmatter and sections
6. **Update manifest**: Add command to manifest.json
7. **Report success**: Show location and usage instructions

## Output Location

```
<target>/commands/<name>.md
```

## Command File Structure

```markdown
---
name: command-name
description: Command description
args: [arg1] [--option value --guidance "text"]
---

# Command Title

[Description]

## Usage
[How to invoke]

## Arguments
[Input parameters]

## Options
[Configuration flags]

## Execution
[Step-by-step behavior]

## Output
[What to expect]
```

## CLI Equivalent

```bash
aiwg add-command <name> --to <target> --template <type>
```

## Related Commands

- `devkit-create-agent` - Create an agent
- `devkit-create-skill` - Create an auto-triggered skill
- `devkit-validate` - Validate command structure

## References

- @$AIWG_ROOT/${CLAUDE_PLUGIN_ROOT}/README.md — aiwg-dev addon overview
- @$AIWG_ROOT/docs/extensions/extension-types.md — Extension types including command type
- @$AIWG_ROOT/docs/cli-reference.md — CLI reference including add-command command
- @$AIWG_ROOT/docs/extensions/creating-extensions.md — Guide to building custom extensions
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/README.md — SDLC framework with example commands
