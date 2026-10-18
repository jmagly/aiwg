---
namespace: aiwg
name: mention-lint
platforms: [all]
description: Lint @-mentions for style consistency and correctness
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


# @-Mention Linting

Validate @-mention style and fix common issues.

## Usage

```bash
/mention-lint                    # Lint current directory
/mention-lint --fix              # Auto-fix fixable issues
/mention-lint --strict           # Exit with error on any issue
/mention-lint --rules ML001,ML005  # Run specific rules only
```

## Options

| Option | Default | Description |
|--------|---------|-------------|
| --target | . | Directory to lint |
| --fix | false | Auto-fix fixable issues |
| --strict | false | Exit with error on any issue |
| --rules | all | Comma-separated rule IDs |

## Lint Rules

| Rule | Description | Severity | Auto-fix |
|------|-------------|----------|----------|
| ML001 | @-mention path does not exist | error | no |
| ML002 | @-mention uses wrong case | warning | yes |
| ML003 | Missing required prefix (.aiwg/, src/, test/) | warning | yes |
| ML004 | Uses deprecated path pattern | warning | yes |
| ML005 | Invalid ID format (UC-NNN, ADR-NNN) | warning | yes |
| ML006 | Duplicate @-mentions in same file | info | yes |
| ML007 | @-mention in wrong section | info | no |
| ML008 | Orphan @-mention (no back-reference) | info | no |
| ML009 | Circular @-mention chain | warning | no |
| ML010 | @-mention exceeds max depth (>3 hops) | warning | no |

## Output Example

```
src/services/auth/login.ts
  L3:  ML005 @.aiwg/requirements/UC-3-auth.md should be UC-003 (auto-fixable)
  L5:  ML001 @.aiwg/architecture/adrs/ADR-999.md does not exist

test/integration/auth.test.ts
  L2:  ML003 @auth/login.ts should be @$AIWG_ROOT/src/auth/login.ts (auto-fixable)

.aiwg/architecture/software-architecture-doc.md
  L45: ML008 References @.aiwg/requirements/UC-005.md but no back-reference

Summary: 4 issues (1 error, 2 warnings, 1 info)
         3 auto-fixable (run with --fix)
```

## Rule Details

### ML001: Path Does Not Exist

```
Error: @.aiwg/requirements/UC-999.md → file not found
```
Not auto-fixable. Remove reference or create file.

### ML002: Wrong Case

```
Warning: @.aiwg/Requirements/UC-001.md should be @.aiwg/requirements/UC-001.md
Fix: Correct case to match filesystem
```

### ML003: Missing Prefix

```
Warning: @auth/login.ts should be @$AIWG_ROOT/src/auth/login.ts
Fix: Add appropriate prefix
```

### ML004: Deprecated Pattern

```
Warning: @requirements/UC-001.md should be @.aiwg/requirements/UC-001.md
Fix: Update to current pattern
```

### ML005: Invalid ID Format

```
Warning: UC-3 should be UC-003 (3-digit format)
Warning: ADR-5-auth should be ADR-005-auth
Fix: Zero-pad numeric IDs
```

### ML006: Duplicate Mentions

```
Info: @.aiwg/requirements/UC-001.md appears 3 times
Fix: Remove duplicates, keep first occurrence
```

## CLI Equivalent

```bash
aiwg mention-lint [--target <dir>] [--fix] [--strict]
```

## Related Commands

- `mention-wire` - Add @-mentions
- `mention-validate` - Validate @-mentions exist
- `mention-conventions` - Display conventions

Lint @-mentions for: $ARGUMENTS

## References

- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/README.md — aiwg-utils addon overview
- @$AIWG_ROOT/docs/cli-reference.md — CLI reference for mention-lint command
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/research-before-decision.md — Verify paths exist before referencing
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/README.md — SDLC artifacts that use @-mention conventions
