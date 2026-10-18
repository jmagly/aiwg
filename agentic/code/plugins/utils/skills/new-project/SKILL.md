---
namespace: aiwg
name: new-project
platforms: [all]
description: Scaffold a new AIWG-managed project with .aiwg/ directory structure, starter CLAUDE.md, and framework registry. Use when creating or scaffolding a new project.
triggers:
  - scaffold a project
  - create a project
  - new project
  - aiwg new
  - project scaffolding
  - project-local bundle
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


# New Project

You scaffold a new AIWG-managed project, creating the `.aiwg/` directory structure, deploying a starter CLAUDE.md, and initialising the framework registry.

## Triggers

Alternate expressions and non-obvious activations (primary phrases are matched automatically from the skill description):

- "start a new project" → scaffold with default template
- "set up aiwg for my project" → scaffold in current directory
- "bootstrap project" → scaffold with default template
- "create aiwg project" → scaffold with default template

## Trigger Patterns Reference

| Pattern | Example | Action |
|---------|---------|--------|
| Named project | "new project my-app" | Run `aiwg new my-app` |
| With template | "create project my-app using research template" | Run `aiwg new my-app --template research` |
| With provider | "scaffold project my-app for copilot" | Run `aiwg new my-app --provider copilot` |
| In-place | "set up aiwg here" | Run `aiwg new .` |
| Template list | "what project templates are available?" | Run `aiwg new --list-templates` |

## Behavior

When triggered:

1. **Extract arguments**:
   - What is the project name or target directory?
   - Is a specific template requested? (default: `sdlc`)
   - Is a specific provider requested? (default: `claude-code`)
   - Is this in-place (`.`) or creating a new directory?

2. **Run the appropriate command**:

   ```bash
   # Default: create named project directory
   aiwg new <project-name>

   # With a specific template
   aiwg new <project-name> --template research

   # With a specific provider
   aiwg new <project-name> --provider copilot

   # In the current directory
   aiwg new .

   # Combined
   aiwg new my-app --template sdlc --provider cursor
   ```

3. **What the command creates**:
   - `.aiwg/` with subdirectories: `intake/`, `requirements/`, `architecture/`, `planning/`, `risks/`, `testing/`, `security/`, `deployment/`, `working/`, `reports/`
   - `.aiwg/frameworks/registry.json` — installed framework registry
   - `CLAUDE.md` (or provider-equivalent) — starter instructions
   - Initial framework deployment for the selected provider

4. **Report the result** — confirm directories created, files written, and next recommended step (`aiwg use sdlc` or `intake-wizard`).

## Examples

### Example 1: Basic new project

**User**: "Create a new project called customer-portal"

**Extraction**: Project name `customer-portal`, default template, default provider

**Action**:
```bash
aiwg new customer-portal
```

**Response**: "Created `customer-portal/` with `.aiwg/` structure (10 subdirectories), starter `CLAUDE.md`, and empty framework registry. Next step: run `aiwg use sdlc` inside the project to deploy the SDLC framework."

### Example 2: In-place scaffold

**User**: "Set up AIWG in the current directory"

**Extraction**: In-place scaffold (`.`), default template

**Action**:
```bash
aiwg new .
```

**Response**: "Initialised `.aiwg/` in the current directory. Starter `CLAUDE.md` written. Run `aiwg use sdlc` to deploy frameworks."

### Example 3: Research project with specific provider

**User**: "Bootstrap a new project called signal-study using the research template for Cursor"

**Extraction**: Project name `signal-study`, template `research`, provider `cursor`

**Action**:
```bash
aiwg new signal-study --template research --provider cursor
```

**Response**: "Created `signal-study/` with research-template `.aiwg/` structure and deployed research-complete framework to `.cursor/`. Open the project and run `intake-wizard` to begin."

### Example 4: List available templates

**User**: "What templates can I use when creating a project?"

**Extraction**: Template listing request

**Action**:
```bash
aiwg new --list-templates
```

**Response**: Lists available templates (e.g., `sdlc`, `research`, `forensics`, `marketing`) with one-line descriptions.

## Clarification Prompts

If the user's intent is ambiguous:

- "What should the project be called, or should I scaffold in the current directory?"
- "Which template would you like — `sdlc` (default), `research`, `forensics`, or `marketing`?"
- "Which provider should I target? (detected: claude-code)"

## References

- @$AIWG_ROOT/src/cli/handlers/subcommands.ts — `new` command handler
- @$AIWG_ROOT/docs/cli-reference.md — CLI reference
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/README.md — SDLC framework overview
