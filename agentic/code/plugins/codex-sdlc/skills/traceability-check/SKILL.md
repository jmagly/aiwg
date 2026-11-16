---
namespace: aiwg
name: traceability-check
platforms: [all]
description: Verify bidirectional traceability from requirements to code to tests and identify coverage gaps and orphan artifacts

---

# traceability-check

Verify bidirectional traceability from requirements to code to tests.

## Triggers


Alternate expressions and non-obvious activations (primary phrases are matched automatically from the skill description):

- "RTM" → Requirements Traceability Matrix check
- "V&V matrix" → Verification & Validation coverage
- "coverage holes" in requirements context → traceability gap analysis
- "are requirements covered" → traceability validation

## Purpose

This skill ensures complete traceability across the SDLC by:
- Extracting requirement IDs from documentation
- Scanning code for requirement references
- Mapping tests to requirements
- Identifying coverage gaps
- Detecting orphan artifacts

## Behavior

When triggered, this skill uses the `aiwg index` CLI as its primary backend for artifact discovery, falling back to direct file scanning only when the index is unavailable.

### Step 1: Ensure Index Available

```bash
# Check if index exists, build if needed
aiwg index stats --json || aiwg index build
```

### Step 2: Query Requirements Inventory

```bash
# Get all requirement artifacts from the index
aiwg index query --type use-case --json
aiwg index query --type requirement --json
aiwg index query --type nfr --json
```

### Step 3: Check Dependencies for Each Artifact

```bash
# For each requirement, check what depends on it (downstream = code, tests)
aiwg index deps .aiwg/requirements/UC-001.md --direction downstream --json
```

### Step 4: Build Traceability Matrix

Using the dependency graph from `aiwg index deps`, build:
- Bidirectional mapping: requirement <-> code <-> tests
- Calculate coverage percentages
- Identify gaps in each direction

### Step 5: Identify Issues

- Orphan requirements (no downstream code references)
- Untested code (code without test dependents)
- Untested requirements (requirements without test coverage)
- Code without requirements (no upstream requirement references)

### Step 6: Generate Report

- Traceability matrix with coverage statistics
- Gap analysis with prioritized recommendations
- Save to `.aiwg/reports/traceability-{date}.md`

### Fallback Behavior

If `aiwg index` is not available (not installed or index not built), fall back to direct scanning:
- Scan `.aiwg/requirements/` for IDs (UC-*, REQ-*, NFR-*)
- Search source files for requirement ID references
- Search test files for requirement coverage
- Build matrix from raw file scanning results

## Traceability Model

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  REQUIREMENTS   │────▶│      CODE       │────▶│     TESTS       │
│                 │     │                 │     │                 │
│ UC-001          │     │ auth.ts         │     │ auth.test.ts    │
│ UC-002          │     │ user.ts         │     │ user.test.ts    │
│ REQ-001         │     │ api/routes.ts   │     │ api.test.ts     │
│ NFR-001         │     │ perf/cache.ts   │     │ perf.test.ts    │
└─────────────────┘     └─────────────────┘     └─────────────────┘
         │                      │                       │
         │                      │                       │
         └──────────────────────┴───────────────────────┘
                     TRACEABILITY MATRIX
```

## ID Patterns

### Requirement ID Formats

| Type | Pattern | Example |
|------|---------|---------|
| Use Case | UC-NNN | UC-001, UC-042 |
| Requirement | REQ-NNN | REQ-001, REQ-123 |
| Non-Functional | NFR-NNN | NFR-001, NFR-015 |
| User Story | US-NNN | US-001, US-089 |
| Feature | FEAT-NNN | FEAT-001 |

### Code Reference Patterns

```typescript
// In code comments
// Implements: UC-001
// Related: REQ-003, REQ-004

// In JSDoc
/**
 * @requirement UC-001
 * @requirement REQ-003
 */

// In function names
function handleAuthUC001() {}

// In test descriptions
describe('UC-001: User Authentication', () => {
  it('should validate credentials (REQ-001)', () => {});
});
```

## Traceability Matrix Format

### Full Matrix

```markdown
| Requirement | Description | Code Files | Test Files | Status |
|-------------|-------------|------------|------------|--------|
| UC-001 | User login | auth.ts, session.ts | auth.test.ts | ✅ Covered |
| UC-002 | User logout | auth.ts | auth.test.ts | ✅ Covered |
| UC-003 | Password reset | - | - | ❌ Not Implemented |
| REQ-001 | Validate email | user.ts | user.test.ts | ✅ Covered |
| REQ-002 | Hash passwords | auth.ts | - | ⚠️ Untested |
| NFR-001 | < 200ms response | cache.ts | perf.test.ts | ✅ Covered |
```

### Coverage Summary

```markdown
## Coverage Summary

| Category | Total | Implemented | Tested | Coverage |
|----------|-------|-------------|--------|----------|
| Use Cases | 15 | 14 | 12 | 80% |
| Requirements | 42 | 40 | 35 | 83% |
| NFRs | 8 | 6 | 4 | 50% |
| **Total** | **65** | **60** | **51** | **78%** |
```

## Gap Analysis

### Orphan Requirements

Requirements with no code implementation:

```markdown
### Orphan Requirements (No Implementation)

| ID | Description | Priority | Action |
|----|-------------|----------|--------|
| UC-003 | Password reset | High | Implement in Sprint 5 |
| REQ-015 | Export to PDF | Medium | Backlogged |
| NFR-008 | 99.9% uptime | High | Infrastructure ticket |
```

### Untested Code

Code without test coverage:

```markdown
### Untested Code

| File | Functions | Linked Requirements | Action |
|------|-----------|---------------------|--------|
| utils/crypto.ts | hashPassword, verifyHash | REQ-002 | Add unit tests |
| api/export.ts | generateReport | REQ-010 | Add integration test |
```

### Rogue Code

Code with no requirement linkage:

```markdown
### Code Without Requirements (Potential Rogue Features)

| File | Functions | Notes |
|------|-----------|-------|
| legacy/old-auth.ts | * | Deprecated, remove |
| experiments/feature-x.ts | * | Experimental, document or remove |
```

## Validation Rules

### Required Traceability

```yaml
rules:
  requirements_to_code:
    required: true
    min_coverage: 90%
    exceptions:
      - deferred features
      - infrastructure requirements

  code_to_tests:
    required: true
    min_coverage: 80%
    exceptions:
      - generated code
      - type definitions

  requirements_to_tests:
    required: true
    min_coverage: 80%
    exceptions:
      - manual test procedures
```

### Validation Checks

```yaml
checks:
  - name: no_orphan_requirements
    description: All requirements must have implementation
    severity: warning

  - name: no_untested_requirements
    description: All requirements must have tests
    severity: warning

  - name: no_rogue_code
    description: All code must trace to requirements
    severity: info

  - name: coverage_threshold
    description: Meet minimum coverage thresholds
    severity: error
```

## Usage Examples

### Full Traceability Check

```
User: "Check traceability"

Skill scans:
1. Extract 65 requirements from .aiwg/requirements/
2. Scan src/ for requirement references
3. Scan test/ for requirement coverage
4. Build matrix

Output:
"Traceability Analysis Complete

Requirements: 65
Implemented: 60 (92%)
Tested: 51 (78%)

Gaps Found:
- 5 orphan requirements (no code)
- 9 untested requirements
- 3 code files with no requirement links

Report: .aiwg/reports/traceability-20251208.md"
```

### Check Specific Requirement

```
User: "Trace UC-001"

Skill returns:
"UC-001: User Authentication

Implementation:
- src/auth/login.ts (lines 45-120)
- src/auth/session.ts (lines 10-50)

Tests:
- test/auth/login.test.ts (8 test cases)
- test/integration/auth.test.ts (3 scenarios)

Coverage: ✅ Fully traced"
```

### Find Orphans

```
User: "Find orphan requirements"

Skill returns:
"Orphan Requirements (No Implementation):

1. UC-003: Password reset flow
   Priority: High
   Sprint: Backlog

2. REQ-015: Export to PDF
   Priority: Medium
   Sprint: Backlog

3. NFR-008: 99.9% uptime SLA
   Priority: High
   Type: Infrastructure

Total: 3 orphan requirements"
```

## Report Format

```markdown
# Traceability Analysis Report

**Date**: 2025-12-08
**Scope**: Full Project
**Tool**: traceability-check skill

## Executive Summary

| Metric | Value | Target | Status |
|--------|-------|--------|--------|
| Requirements Coverage | 92% | 90% | ✅ Pass |
| Test Coverage | 78% | 80% | ⚠️ Below Target |
| Orphan Requirements | 5 | 0 | ⚠️ Action Needed |
| Rogue Code Files | 3 | 0 | ℹ️ Review |

## Traceability Matrix

[Full matrix table...]

## Gap Analysis

### Critical Gaps
- NFR-001 (Performance) has no test coverage
- UC-012 (Payment) missing integration tests

### Action Items
1. Add performance tests for NFR-001
2. Implement UC-003 (Password reset)
3. Add tests for UC-012

## Recommendations

1. **Immediate**: Address critical test gaps
2. **Short-term**: Implement orphan requirements
3. **Process**: Add traceability to PR checklist
```

## Integration

This skill uses:
- `aiwg index query`: Discover requirement artifacts by type and phase
- `aiwg index deps`: Navigate upstream/downstream dependency graphs
- `aiwg index stats`: Check index health and coverage metrics
- `artifact-metadata`: Get requirement artifact info (fallback)
- `project-awareness`: Find source and test directories (fallback)

## Scanning Configuration

Configure scanning behavior in `.aiwg/config/traceability.yaml`:

```yaml
traceability:
  requirements_dir: .aiwg/requirements/
  source_dirs:
    - src/
    - lib/
  test_dirs:
    - test/
    - __tests__/

  id_patterns:
    - "UC-\\d{3}"
    - "REQ-\\d{3}"
    - "NFR-\\d{3}"
    - "US-\\d{3}"

  code_patterns:
    - "// Implements: {id}"
    - "// Related: {id}"
    - "@requirement {id}"
    - "\\b{id}\\b"  # bare reference

  test_patterns:
    - "describe\\(['\"].*{id}.*['\"]"
    - "it\\(['\"].*{id}.*['\"]"
    - "@covers {id}"

  exclusions:
    - node_modules/
    - dist/
    - "*.generated.*"
```

## Output Locations

- Traceability report: `.aiwg/reports/traceability-{date}.md`
- Traceability matrix: `.aiwg/reports/traceability-matrix.csv`
- Gap analysis: `.aiwg/reports/coverage-gaps.md`

## References

- Requirements artifacts: .aiwg/requirements/
- Traceability template: agentic/code/frameworks/sdlc-complete/templates/management/traceability-matrix-template.csv
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/artifact-discovery.md — Agent protocol for index usage
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/skills/artifact-lookup/SKILL.md — Artifact search skill
- @$AIWG_ROOT/src/artifacts/cli.ts — CLI implementation
