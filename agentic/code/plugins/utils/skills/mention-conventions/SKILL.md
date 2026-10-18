---
namespace: aiwg
name: mention-conventions
platforms: [all]
description: Display @-mention naming conventions and placement rules
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


# @-Mention Conventions

Display AIWG @-mention naming conventions and placement rules.

## Usage

```bash
/mention-conventions                  # Show all conventions
/mention-conventions --section naming # Show naming patterns only
/mention-conventions --section placement # Show placement rules only
```

## Naming Patterns

### Requirements

```
@.aiwg/requirements/UC-{NNN}-{slug}.md        # Use cases (UC-001-user-auth.md)
@.aiwg/requirements/NFR-{CAT}-{NNN}.md        # Non-functional (NFR-SEC-001.md)
@.aiwg/requirements/user-stories.md           # User story collection
```

Categories for NFRs:
- `SEC` - Security
- `PERF` - Performance
- `SCAL` - Scalability
- `AVAIL` - Availability
- `MAINT` - Maintainability
- `USAB` - Usability

### Architecture

```
@.aiwg/architecture/adrs/ADR-{NNN}-{slug}.md  # Decision records (ADR-005-jwt-strategy.md)
@.aiwg/architecture/components/{name}.md      # Component specs
@.aiwg/architecture/software-architecture-doc.md  # Main SAD
@.aiwg/architecture/api-contract.md           # API specifications
```

### Security

```
@.aiwg/security/threat-model.md               # Main threat model
@.aiwg/security/TM-{NNN}.md                   # Individual threats (TM-001.md)
@.aiwg/security/controls/{control-id}.md      # Security controls (authn-001.md)
```

### Testing

```
@.aiwg/testing/test-plan.md                   # Master test plan
@.aiwg/testing/test-cases/TC-{NNN}.md         # Individual test cases
@.aiwg/testing/test-results/{run-id}.md       # Test run results
```

### Code References

```
@$AIWG_ROOT/src/{path/to/file}                           # Source files
@test/{path/to/file}                          # Test files
@lib/{path/to/file}                           # Library files
@$AIWG_ROOT/docs/{path/to/file}                          # Documentation
```

## Placement Rules

### In Code Files

Place @-mentions in file header docblock:

```typescript
/**
 * @file Authentication Service
 * @implements @.aiwg/requirements/UC-003-user-auth.md
 * @architecture @.aiwg/architecture/adrs/ADR-005-jwt-strategy.md
 * @security @.aiwg/security/controls/authn-001.md
 * @tests @test/integration/auth.test.ts
 */
export class AuthService {
  // Implementation
}
```

### In Python Files

```python
"""
Authentication Service

@implements: @.aiwg/requirements/UC-003-user-auth.md
@architecture: @.aiwg/architecture/adrs/ADR-005-jwt-strategy.md
@security: @.aiwg/security/controls/authn-001.md
@tests: @test/integration/test_auth.py
"""
```

### In Markdown Documents

Add a References section:

```markdown
## References

- @.aiwg/requirements/user-stories.md - Functional requirements basis
- @.aiwg/architecture/software-architecture-doc.md - Architecture context
- @.aiwg/security/threat-model.md - Security considerations
```

Ordinary relative Markdown links are also indexed as graph edges when they
resolve to another indexed artifact in the same active graph:

```markdown
See [ADR-005](./ADR-005-jwt-strategy.md) for the decision context.
```

Use @-mentions in `References` when you intend durable traceability or
provenance. Use Markdown links for reader navigation. External URLs,
anchor-only links, images, and links to files outside the active graph do not
create artifact dependency edges.

### In Inline Comments

For specific code sections:

```typescript
// Per @.aiwg/security/controls/authn-001.md - validate token expiry
if (token.exp < Date.now()) {
  throw new AuthError('Token expired');
}
```

## ID Format Rules

| Type | Format | Example |
|------|--------|---------|
| Use Case | UC-NNN | UC-001, UC-042 |
| NFR | NFR-CAT-NNN | NFR-SEC-001, NFR-PERF-002 |
| ADR | ADR-NNN | ADR-001, ADR-015 |
| Threat | TM-NNN | TM-001, TM-023 |
| Test Case | TC-NNN | TC-001, TC-150 |

**Rules**:
- Always use 3-digit zero-padded numbers
- Use lowercase for paths
- Use hyphens for slugs (not underscores)

## Best Practices

1. **Be Specific**: Reference exact documents, not directories
2. **Keep Current**: Update @-mentions when files move
3. **Validate Often**: Run `mention-validate` before commits
4. **Lint Style**: Run `/mention-lint --fix` to normalize
5. **Generate Reports**: Use `mention-report` for traceability audits

## CLI Equivalent

```bash
aiwg mention-conventions
```

## Related Commands

- `mention-wire` - Add @-mentions automatically
- `mention-lint` - Validate style conventions
- `mention-validate` - Check all @-mentions resolve

Display conventions: $ARGUMENTS
