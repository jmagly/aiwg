# aiwg-dev Overview

aiwg-dev is the toolkit for developing and extending AIWG. Use it when you run AIWG from a local checkout (dev mode,
`aiwg --use-dev <path>`), or when you add or validate addons, frameworks, agents, skills, commands, rules, or templates
in an AIWG source tree. It is not installed by default or by `aiwg use all`; install it with `aiwg use aiwg-dev`.

## Common Use Cases

- Validate a new skill, agent, command, or addon before review.
- Scaffold a framework or addon using the expected AIWG directory structure.
- Check distributable `@file` references so source files do not point at provider deployment directories.
- Run development health checks before opening an AIWG source change.

```bash
aiwg use aiwg-dev
```

## What It Provides

### Validation Skills

| Skill | What It Checks |
|-------|---------------|
| `validate-component` | Single skill, agent, or command — completeness, placement, manifest registration, `@file` link classification |
| `validate-addon` | Full addon — all skills, agents, and rules against manifest; orphan detection |
| `dev-doctor` | Full repository health — structure, orphans, placement violations, TypeScript, tests, circular calls |
| `link-check` | `@file` references in distributable source — catches forbidden `.claude/` refs, bare AIWG-core refs, non-normalized `.aiwg/` refs |

### Scaffolding Skills (Devkit)

| Skill | What It Creates |
|-------|----------------|
| `devkit-create-addon` | New addon with `manifest.json`, `README.md`, and directory structure |
| `devkit-create-extension` | New ops-complete extension |
| `devkit-create-framework` | New framework scaffold |
| `devkit-create-agent` | New agent definition with correct YAML frontmatter |
| `devkit-create-command` | New command definition registered in `src/extensions/commands/definitions.ts` |
| `devkit-create-skill` | New skill with `SKILL.md` in the correct location |
| `devkit-validate` | Run all validation checks on the current working directory |
| `devkit-test` | Run the test suite with development-appropriate flags |

### Enforcement Rules

| Rule | What It Prevents |
|------|-----------------|
| `skill-placement` | Skills placed in provider deployment directories (`.claude/skills/`) instead of `agentic/code/` |
| `no-circular-skill-calls` | Skills that invoke themselves via `aiwg <command>` in bash blocks |
| `component-completeness` | Components missing required sections (frontmatter, title, behavior, examples) |
| `addon-boundaries` | Source code mixed with project output (`.aiwg/` content in `agentic/code/`) |
| `aiwg-dir-reference-contract` | Non-normalized `.aiwg/` paths in distributable source (paths that only work in the AIWG repo itself) |

## The Component Validation Model

All validation in aiwg-dev follows the same model: check completeness, check placement, check manifest registration, check `@file` references.

### @file Reference Classification

Every `@<path>` reference in a distributable skill or agent is classified:

| Pattern | Classification | Action |
|---------|---------------|--------|
| `@$AIWG_ROOT/<path>` | PASS | Install-relative AIWG core reference |
| `@.aiwg/<path>` (normalized) | PASS | Project memory reference |
| `@.aiwg/<path>` (non-normalized) | FAIL | Repo-local path — only works in AIWG dev repo |
| `@.claude/<path>` | FAIL | Deployment target — forbidden in source |
| `@agentic/code/<path>` (bare) | WARN | Legacy — migrate to `@$AIWG_ROOT/agentic/code/` |
| `@docs/<path>` (bare) | WARN | Legacy — migrate to `@$AIWG_ROOT/docs/` |

This classification is what the `link-check` skill and Section 4 of `dev-doctor` both use.

### Normalized .aiwg/ Paths

A "normalized" `.aiwg/` path is one that exists (or will exist) in every project that installs AIWG — specifically paths listed in `memory.creates` fields in `manifest.json` files, plus the Tier 1 allowlist (root `AIWG.md`, `.aiwg/frameworks/`; `.aiwg/AIWG.md` is optional operator notes only). Non-normalized paths are repo-local and will break for any user who installs the addon.

## Audience

aiwg-dev is for:
- AIWG contributors adding new addons, frameworks, or skills
- Users who customize AIWG by running it from their own checkout in dev mode
- Developers building custom addons that follow AIWG conventions
- Anyone running pre-PR validation checks on AIWG source changes

If you only use deployed AIWG frameworks and do not change AIWG itself, you do not need it: use `aiwg doctor` (the runtime health check) rather than `dev-doctor` (the source structure check).

## References

- [Quickstart](quickstart.md) — Install and validate your first component
- `@$AIWG_ROOT/agentic/code/addons/aiwg-dev/rules/RULES-INDEX.md` — All enforcement rules
- `@$AIWG_ROOT/agentic/code/addons/aiwg-dev/skills/validate-component/SKILL.md` — Full validation logic
- `@$AIWG_ROOT/agentic/code/addons/aiwg-dev/skills/dev-doctor/SKILL.md` — Full health check logic
