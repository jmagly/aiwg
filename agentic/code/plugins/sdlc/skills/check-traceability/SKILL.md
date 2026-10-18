---
namespace: aiwg
name: check-traceability
platforms: [all]
description: Verify the full refinement chain from use cases through behavioral specs, pseudo-code specs, code, and tests — report coverage at each layer and identify gaps
commandHint:
  argumentHint: '[path-to-project] [--layer all|uc|behavioral|pseudo|code|test] [--format table|csv|json] [--interactive] [--guidance "text"]'
  allowedTools: 'Read, Write, Glob, Grep'
  model: haiku
  category: documentation-tracking
  modelRole: efficiency
  modelTier: economy
---

# Check Traceability

This verification workflow remains active. Dataset Intelligence can project
links into its ledger, but a mention is not verified traceability and a
verified link without a run identity remains inferred. See the [dataset
migration guide](https://github.com/jmagly/aiwg/blob/main/agentic/code/addons/dataset-intelligence/docs/migration-guide.md).

## Task

Verify the full specification-to-code refinement chain and report coverage at each layer. The traceability chain has 5 layers:

```
Layer 1: Use Cases (UC-NNN)
    └── Layer 2: Behavioral Specs (DES-UCR-NNN, DES-SM-NNN, DES-DT-NNN, DES-MIC-NNN)
         └── Layer 3: Pseudo-Code Specs (DES-PSC-NNN)
              └── Layer 4: Source Code (src/*)
                   └── Layer 5: Tests (test/*)
```

## Natural Language Triggers

Users may say:
- "Check traceability"
- "Are all requirements traced?"
- "Show traceability coverage"
- "What use cases are missing specs?"
- "Traceability report"
- "Are there gaps in the spec chain?"
- "Which UCs don't have realizations?"

## Parameters

### --layer (optional, default: all)
Check a specific layer or all layers:
- `all` — full chain (default)
- `uc` — use cases only (are they well-formed?)
- `behavioral` — UC → behavioral spec coverage
- `pseudo` — behavioral → pseudo-code coverage
- `code` — pseudo-code → source code coverage
- `test` — code → test coverage

### --format (optional, default: table)
Output format: `table` (markdown), `csv`, or `json`.

### --guidance (optional)
Focus traceability on specific areas:
```
--guidance "Focus on authentication module"
--guidance "Only check high-priority use cases"
--guidance "Exclude test layer, just check specs"
```

### --interactive (optional)
Ask questions before starting:
1. Which use cases should we check? (all, by priority, by module)
2. Should we check the full chain or specific layers?
3. Are there known gaps we should flag as expected?

## Execution Steps

### Step 1: Discover Artifacts

Scan `.aiwg/` for artifacts at each layer:

```
Layer 1 — Use Cases:
  Glob: .aiwg/requirements/UC-*.md
  Glob: .aiwg/requirements/use-case-*.md

Layer 2 — Behavioral Specs:
  Glob: .aiwg/requirements/realizations/DES-UCR-*.md
  Glob: .aiwg/architecture/state-machines/DES-SM-*.md
  Glob: .aiwg/architecture/decision-tables/DES-DT-*.md
  Glob: .aiwg/architecture/method-contracts/DES-MIC-*.md
  Glob: .aiwg/architecture/activity-diagrams/DES-ACT-*.md
  Glob: .aiwg/architecture/data-flows/DES-DFS-*.md

Layer 3 — Pseudo-Code Specs:
  Glob: .aiwg/architecture/pseudo-code/DES-PSC-*.md
  Also check: Traceability section of DES-MIC files for PSC references

Layer 4 — Source Code:
  Read pseudo-code spec Traceability sections for "Source Code:" references
  Grep source files for traceability comments (e.g., @spec DES-PSC-NNN)

Layer 5 — Tests:
  Read pseudo-code spec Traceability sections for "Tests:" references
  Grep test files for traceability comments (e.g., @spec DES-PSC-NNN)
```

### Step 2: Build Traceability Matrix

For each use case found, trace forward through all layers:

```
UC-001 (Place Order)
  ├── DES-UCR-001 (realization) ✓
  │    ├── DES-SM-001 (Order state machine) ✓
  │    ├── DES-DT-001 (Discount calculation) ✓
  │    ├── DES-MIC-010 (calculateOrderTotal) ✓
  │    │    ├── DES-PSC-010 (pseudo-code) ✓
  │    │    │    ├── src/order/pricing.ts ✓
  │    │    │    └── test/order/pricing.test.ts ✓
  │    │    └── DES-PSC-011 (pseudo-code) ✗ MISSING
  │    └── DES-MIC-013 (submitOrder) ✓
  │         └── DES-PSC-013 (pseudo-code) ✓
  │              ├── src/order/service.ts ✓
  │              └── test/order/service.test.ts ✗ MISSING
  └── DES-ACT-001 (activity diagram) ✓
```

### Step 3: Calculate Coverage

Report coverage percentage at each layer:

| Layer | Total | Covered | Coverage | Status |
|-------|-------|---------|----------|--------|
| UC → Behavioral | 12 UCs | 10 have realizations | 83% | PASS (≥80%) |
| Behavioral → Pseudo-code | 25 methods | 20 have specs | 80% | PASS (≥80%) |
| Pseudo-code → Code | 20 specs | 18 have source | 90% | PASS |
| Code → Test | 18 modules | 15 have tests | 83% | PASS (≥80%) |

### Step 4: Identify Gaps

For each gap, report:
- **What's missing**: specific artifact ID and type
- **Parent artifact**: what it should trace from
- **Priority**: based on parent UC priority
- **Impact**: what's affected downstream

### Step 5: Generate Report

Output to `.aiwg/reports/traceability-report.md`:

```markdown
# Traceability Report

**Date**: YYYY-MM-DD
**Scope**: All use cases / filtered set
**Overall Status**: PASS | GAPS | FAIL

## Coverage Summary

| Layer Transition | Total | Covered | Gaps | Coverage | Threshold | Status |
|-----------------|-------|---------|------|----------|-----------|--------|
| UC → Behavioral | N | N | N | N% | 80% | PASS/FAIL |
| Behavioral → Pseudo-code | N | N | N | N% | 80% | PASS/FAIL |
| Pseudo-code → Code | N | N | N | N% | — | INFO |
| Code → Test | N | N | N | N% | 80% | PASS/FAIL |

## Gap Details

### Missing Behavioral Specs
| Use Case | Priority | Expected Artifact | Status |
|----------|----------|-------------------|--------|
| UC-NNN | High | DES-UCR-NNN | MISSING |

### Missing Pseudo-Code Specs
| Interface Contract | Method | Expected Artifact | Status |
|-------------------|--------|-------------------|--------|
| DES-MIC-NNN | methodName | DES-PSC-NNN | MISSING |

### Missing Tests
| Source File | Pseudo-Code Spec | Expected Test | Status |
|-------------|-----------------|---------------|--------|
| src/path.ts | DES-PSC-NNN | test/path.test.ts | MISSING |

## Direct-Jump Detection

Use cases that skip specification layers (jump from UC directly to code):
| Use Case | Has Behavioral? | Has Pseudo-code? | Has Code? | Has Tests? | Issue |
|----------|-----------------|------------------|-----------|------------|-------|
| UC-NNN | NO | NO | YES | YES | Skips Layer 2+3 |

## Recommendations
- Priority 1: Create behavioral specs for high-priority UCs missing them
- Priority 2: Create pseudo-code specs for methods in critical paths
- Priority 3: Add tests for untested code files
```

## Backward Compatibility

Projects without the specification-complete layer (no behavioral or pseudo-code specs) continue to work:
- If no `.aiwg/requirements/realizations/` directory exists, skip Layer 2 check
- If no pseudo-code specs exist, skip Layer 3 check
- Report the simpler UC → code → test chain with a note that spec layers are not present
- Never fail a project for missing spec layers if they haven't adopted the specification-complete workflow

## Output

- `.aiwg/reports/traceability-report.md` — full traceability report with coverage and gaps

## References

- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/research-before-decision.md — Read the traceability matrix and all linked artifacts before reporting gaps
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/human-authorization.md — Report gaps and await owner assignment; do not autonomously close or resolve traceability issues
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/provenance-tracking.md — Traceability requirements and provenance standards this skill enforces
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/skills/security-gate/SKILL.md — Security gate references traceability as a prerequisite criterion
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/flows/gate-criteria-by-phase.md — Gate criteria that reference traceability thresholds
