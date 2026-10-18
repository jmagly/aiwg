# aiwg-dev Quickstart

> **First time using AIWG?** Begin with [Install, Connect, and
Verify](https://github.com/jmagly/aiwg/blob/main/docs/getting-started/install-connect-verify.md). This guide assumes AIWG is connected to the target project
and your provider session can read the deployed context.

Enable the developer toolkit and validate one AIWG component before review.

## Who This Is For

aiwg-dev is for contributors working on AIWG source code — adding addons, frameworks, agents, skills, or commands. If you are an end user of deployed AIWG frameworks, use `aiwg doctor` instead.

## Enable If Needed

```bash
aiwg use aiwg-dev

# Confirm it's active
aiwg list
# aiwg-dev    installed
```

## Validate the Repository

Before making changes, get a baseline health report:

```
Run dev doctor
```

Or trigger it with any of these phrases:
- "run dev doctor"
- "check aiwg dev health"
- "is the repo in a good state?"
- "pre-commit health check"

The report covers:

1. **Structure** — All addons and frameworks have `manifest.json` and `README.md`
2. **Orphans** — Skills/agents in manifests that have no file, and files that have no manifest entry
3. **Placement** — Components in provider directories (`.claude/`, `.cursor/`, etc.) with no source in `agentic/code/`
4. **@file references** — Forbidden refs, bare AIWG-core refs, non-normalized `.aiwg/` paths
5. **TypeScript** — `npx tsc --noEmit` passes
6. **Tests** — `npm test` passes
7. **Circular calls** — Skills that invoke themselves via the CLI

A clean repo shows `Overall: PASS` with all sections green.

## Validate a Single Component

When you create or modify a skill, agent, or command:

```
Validate this skill
```

```
Validate component at agentic/code/addons/my-addon/skills/my-skill
```

The validation checks:
- Required frontmatter fields present
- Required sections (`## Process` or `## Behavior`, `## Examples`)
- File lives in `agentic/code/` (not a provider directory)
- Listed in the parent addon's `manifest.json`
- All `@file` references classified (no forbidden or non-normalized paths)

Example passing output:

```
Component Validation: my-skill (skill)
Path: agentic/code/addons/my-addon/skills/my-skill/SKILL.md

Checks:
  PASS  description frontmatter present
  PASS  title section present
  PASS  behavior section present
  PASS  examples section present
  PASS  listed in manifest.json
  PASS  lives in agentic/code/

Result: PASS — all checks passed
```

## Create a New Addon

```
Create a new addon called "my-analytics"
```

The `devkit-create-addon` skill scaffolds:

```
agentic/code/addons/my-analytics/
├── manifest.json      # Pre-filled with id, type, name, version, description
├── README.md          # Template README
├── skills/            # Empty, ready for skills
├── agents/            # Empty, ready for agents
└── rules/             # Empty, ready for rules
```

Fill in the description and start adding components.

## Create a New Skill

```
Create a new skill called "analyze-coverage" in the my-analytics addon
```

The `devkit-create-skill` skill creates:

```
agentic/code/addons/my-analytics/skills/analyze-coverage/
└── SKILL.md    # Template with required frontmatter and sections
```

And adds `"analyze-coverage"` to `manifest.json`'s `skills` array.

## Check @file Links

To check only the reference links in distributable source (no TypeScript or test run):

```
Check @file references in agentic/code/addons/my-analytics
```

Or run a focused check on a single file:

```
Link check agentic/code/addons/my-analytics/skills/analyze-coverage/SKILL.md
```

The most common issues caught:

| Issue | Fix |
|-------|-----|
| `@.claude/skills/foo` | Change to `@$AIWG_ROOT/agentic/code/...` |
| `@agentic/code/foo` (bare) | Change to `@$AIWG_ROOT/agentic/code/foo` |
| `@.aiwg/planning/my-design.md` | Remove, or add path to `memory.creates` in manifest |

## Pre-PR Checklist

Before opening a PR:

```
Run pre-commit health check
```

Or explicitly:

```
Run dev doctor
```

All sections must pass. Fix any failures before submitting. The `FAIL` items in the dev-doctor output include specific remediation steps — follow them.

TypeScript (`tsc --noEmit`) and `npm test` must both pass. UAT (`npm run uat`) is not run by dev-doctor — that is a pre-release gate, not a development check.

## Focused Checks

Run individual check sections:

```
Check for placement violations
Find orphaned skills
Does TypeScript compile?
Find circular skill calls
```

Success means the report names the checked component or repo scope, shows the
failing validations if any, and points to the next file or manifest change.

## References

- `@$AIWG_ROOT/${CLAUDE_PLUGIN_ROOT}/docs/overview.md` — What aiwg-dev provides
- `@$AIWG_ROOT/${CLAUDE_PLUGIN_ROOT}/skills/validate-component/SKILL.md` — Full component validation logic
- `@$AIWG_ROOT/${CLAUDE_PLUGIN_ROOT}/skills/dev-doctor/SKILL.md` — Full dev-doctor logic
- `@$AIWG_ROOT/${CLAUDE_PLUGIN_ROOT}/rules/RULES-INDEX.md` — Enforcement rules
