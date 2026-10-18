---
namespace: aiwg
name: mention-report
platforms: [all]
description: Generate traceability report from @-mentions
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


# @-Mention Traceability Report

Generate traceability report showing relationships between artifacts.

## Usage

```bash
/mention-report                      # Markdown report to stdout
/mention-report --format json        # JSON format
/mention-report --format csv         # CSV for spreadsheets
/mention-report --output .aiwg/reports/traceability.md
```

## Options

| Option | Default | Description |
|--------|---------|-------------|
| --target | . | Directory to analyze |
| --format | md | Output format: md, json, csv |
| --output | stdout | Write to file |

## Report Sections

### Requirements Coverage

```markdown
## Requirements Coverage

| Requirement | Implemented | Tested | Documented |
|-------------|-------------|--------|------------|
| UC-001 | ✓ src/auth/ | ✓ test/auth/ | ✓ docs/ |
| UC-002 | ✓ src/api/ | ✗ | ✗ |
| UC-003 | ✗ | ✗ | ✗ |

Coverage: 67% implemented, 33% tested, 33% documented
```

### Architecture Traceability

```markdown
## Architecture Traceability

| ADR | Referenced By | Implementation |
|-----|---------------|----------------|
| ADR-001 | 3 files | src/db/ |
| ADR-002 | 5 files | src/auth/, src/api/ |
| ADR-003 | 1 file | src/cache/ |
```

### Security Controls

```markdown
## Security Control Coverage

| Control | Implementation | Verification |
|---------|----------------|--------------|
| AUTHN-001 | src/auth/middleware.ts | test/security/ |
| AUTHZ-001 | src/auth/permissions.ts | ✗ |
```

### Dependency Graph

```markdown
## Dependency Graph

UC-001 (User Authentication)
├── ADR-005-jwt-strategy.md
├── src/services/auth/
│   ├── login.ts
│   ├── logout.ts
│   └── refresh.ts
├── test/integration/auth/
└── docs/api/auth.md
```

## JSON Format

```json
{
  "generated": "2025-01-15T10:30:00Z",
  "summary": {
    "total_mentions": 142,
    "requirements": { "total": 15, "covered": 12 },
    "adrs": { "total": 8, "referenced": 6 }
  },
  "traceability": [
    {
      "artifact": ".aiwg/requirements/UC-001.md",
      "type": "requirement",
      "referenced_by": ["src/auth/login.ts", "test/auth/login.test.ts"],
      "coverage": { "implemented": true, "tested": true, "documented": true }
    }
  ]
}
```

## CLI Equivalent

```bash
aiwg mention-report [--format md|json|csv] [--output <file>]
```

## Related Commands

- `mention-wire` - Add @-mentions
- `mention-validate` - Validate @-mentions
- `check-traceability` - Full traceability verification

Generate report for: $ARGUMENTS

## References

- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/README.md — aiwg-utils addon overview
- @$AIWG_ROOT/docs/cli-reference.md — CLI reference for mention-report command
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/research-before-decision.md — Scan codebase before reporting
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/README.md — SDLC artifact structure for traceability reporting
