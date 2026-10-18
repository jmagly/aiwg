---
namespace: aiwg
name: mention-validate
platforms: [all]
description: Validate all @-mentions resolve to existing files
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


# @-Mention Validation

Validate that all @-mentions in codebase resolve to existing files.

## Usage

```bash
/mention-validate                    # Validate current directory
/mention-validate --strict           # Fail on any broken mention
/mention-validate --output report.md # Write report to file
```

## Options

| Option | Default | Description |
|--------|---------|-------------|
| --target | . | Directory to validate |
| --strict | false | Exit with error on broken mentions |
| --output | stdout | Write report to file |

## Process

1. **Scan** all files for @-mention patterns
2. **Extract** @-mention paths
3. **Resolve** paths relative to repo root
4. **Report** broken/valid mentions

## Output Format

```
@-Mention Validation Report
===========================

✓ Valid Mentions: 42
✗ Broken Mentions: 3

Broken Mentions:
  src/auth/login.ts:5
    @.aiwg/requirements/UC-999.md → NOT FOUND

  .aiwg/architecture/sad.md:23
    @.aiwg/requirements/NFR-PERF-005.md → NOT FOUND

  test/integration/api.test.ts:12
    @$AIWG_ROOT/src/services/api-old.ts → NOT FOUND (deleted?)

Summary: 3 broken mentions in 3 files
```

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | All mentions valid |
| 1 | Broken mentions found (with --strict) |

## CLI Equivalent

```bash
aiwg validate-mentions [--target <dir>] [--strict]
```

## Related Commands

- `mention-wire` - Add @-mentions
- `mention-lint` - Lint @-mention style
- `mention-report` - Generate traceability report

Validate @-mentions for: $ARGUMENTS

## References

- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/README.md — aiwg-utils addon overview
- @$AIWG_ROOT/docs/cli-reference.md — CLI reference for validate-mentions command
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/research-before-decision.md — Verify before reporting validity
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/README.md — SDLC artifact paths validated by this skill
