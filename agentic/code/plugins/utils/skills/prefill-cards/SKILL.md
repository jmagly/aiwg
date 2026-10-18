---
namespace: aiwg
name: prefill-cards
platforms: [all]
description: Auto-populate SDLC artifact metadata headers across all templates using team profile configuration
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


# Prefill Cards

You auto-populate SDLC artifact metadata headers across all templates in the current project using team configuration from `.aiwg/team/team-profile.md`.

## Triggers

Alternate expressions and non-obvious activations (primary phrases are matched automatically from the skill description):

- "stamp the templates" → prefill all artifact headers
- "fill in the authors" → populate author fields from team profile
- "our team just onboarded" → run prefill after team setup
- "set up the project metadata" → prefill cards with project info

## Trigger Patterns Reference

| Pattern | Example | Action |
|---------|---------|--------|
| Prefill request | "prefill cards" | Run `aiwg prefill-cards` |
| Populate request | "populate metadata" | Run `aiwg prefill-cards` |
| Fill templates | "fill sdlc cards" | Run `aiwg prefill-cards` |
| Auto-populate | "auto-populate artifacts" | Run `aiwg prefill-cards` |
| Dry run | "show what prefill would change" | Run `aiwg prefill-cards --dry-run` |
| Specific type | "prefill just the use case cards" | Run `aiwg prefill-cards --type use-cases` |

## Behavior

When triggered:

1. **Extract intent**:
   - Is this a dry run (preview) or should changes be written?
   - Is a specific artifact type mentioned (use cases, ADRs, test plans)?
   - Has the user indicated a specific author or date override?

2. **Run the appropriate command**:

   ```bash
   # Default: prefill all artifact templates
   aiwg prefill-cards

   # Preview only — show what would change
   aiwg prefill-cards --dry-run

   # Limit to a specific artifact type
   aiwg prefill-cards --type use-cases
   aiwg prefill-cards --type adrs
   aiwg prefill-cards --type test-plans

   # Override author (useful when project lead differs from default)
   aiwg prefill-cards --author "Jane Smith"
   ```

3. **Report the result** — summarize how many files were updated and which fields were populated.

## What Gets Populated

Fields populated from `.aiwg/team/team-profile.md`:

| Field | Source |
|-------|--------|
| `author` | Team lead or assigned role member |
| `created` | Current date (ISO 8601) |
| `project` | Project name from team profile |
| `organization` | Org name from team profile |
| `status` | Set to `draft` for new artifacts |
| `version` | Set to `0.1` for new artifacts |

Fields that are NOT overwritten if already set (idempotent behavior).

## Prerequisites

- `.aiwg/team/team-profile.md` must exist and be populated.
- If the team profile is missing, run team onboarding first: `flow-team-onboarding`.

## Examples

### Example 1: Project start after team onboarding

**User**: "We just finished onboarding — go ahead and prefill the cards"

**Extraction**: Full prefill, no overrides

**Action**:
```bash
aiwg prefill-cards
```

**Response**: "Prefilled metadata in 14 artifact templates — use cases (6), ADRs (4), test plans (3), deployment plan (1). Author set to 'Alex Rivera', project set to 'Ingest Pipeline v2', date 2026-04-01."

### Example 2: Preview before committing

**User**: "Show me what prefill-cards would do without changing anything"

**Extraction**: Dry-run requested

**Action**:
```bash
aiwg prefill-cards --dry-run
```

**Response**: "Dry run: would update 14 files. Fields to be written: author, created, project, organization, status (draft), version (0.1). No changes made."

### Example 3: Targeted fill for specific artifact type

**User**: "Just prefill the ADR cards for now"

**Extraction**: Limit to ADR type

**Action**:
```bash
aiwg prefill-cards --type adrs
```

**Response**: "Prefilled metadata in 4 ADR templates. Author set to 'Alex Rivera'."

## References

- @$AIWG_ROOT/src/cli/handlers/utilities.ts — Command handler
- @$AIWG_ROOT/docs/cli-reference.md — CLI reference
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/ — SDLC artifact templates
