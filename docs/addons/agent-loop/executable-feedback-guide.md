# Executable Feedback Loop Guide

Practical guide for implementing the execute-before-return pattern in code-generating agents. Based on REF-013 MetaGPT research findings.

## Overview

The executable feedback loop ensures code-generating agents **test their output before returning it**. Research shows this pattern yields +4.2% improvement on HumanEval benchmarks and reduces human revision cost by 63% (from 2.25 revision cycles down to 0.83).

### Core Principle

```
Generate code → Execute tests → Pass? → Return to user
                              → Fail? → Analyze → Fix → Re-execute
```

Never return untested code. Every code artifact must pass through the feedback loop before delivery.

## Quick Start

### Minimal Feedback Loop

For agents generating code, the minimum viable loop:

```yaml
# 1. Generate code
code_artifact:
  path: "src/utils/validate.ts"
  language: typescript
  code_type: new_function

# 2. Generate tests
test_files:
  - "test/unit/utils/validate.test.ts"

# 3. Execute
execution_config:
  test_framework: jest
  test_command: "npx jest test/unit/utils/validate.test.ts"

# 4. Retry on failure (max 3 attempts)
retry_policy:
  max_attempts: 3
  escalation_on_max: true
```

### Integration with Agent Workflow

```
Agent receives task
    │
    ├─ 1. Check debug memory for similar past work
    │     └─ Load patterns from .aiwg/ralph/debug-memory/
    │
    ├─ 2. Generate code
    │     └─ Apply learnings from debug memory
    │
    ├─ 3. Generate tests (if not present)
    │     ├─ Happy path tests
    │     ├─ Edge case tests
    │     └─ Error handling tests
    │
    ├─ 4. Execute tests
    │     ├─ Capture all output
    │     └─ Record in debug memory
    │
    ├─ 5. Analyze results
    │     ├─ PASS → Record success, return code
    │     └─ FAIL → Analyze, fix, re-execute (up to max_attempts)
    │
    └─ 6. Finalize
          ├─ Update debug memory with learnings
          └─ Return code (or escalate if max attempts reached)
```

## Phase-by-Phase Walkthrough

### Phase 1: Pre-Generation (Check Debug Memory)

Before writing code, check for relevant past experience:

```yaml
pre_generation:
  check_history: true
  lookback_window: 10  # Recent executions
  patterns_to_check:
    - similar_file_edits
    - same_test_failures
    - recurring_error_types
  apply_learnings: true
```

**What to look for:**
- Has this file been modified before? What went wrong?
- Are there known patterns for this type of code?
- What error types are common in this module?

**Example:**
```
Debug memory shows: src/auth/*.ts has had 3 past sessions
  - Pattern: "Missing null check" occurred 2 times
  - Fix template: "Add null/undefined guard at function entry"
  - Preemptive action: Include null checks in initial generation
```

### Phase 2: Code Generation

Generate code with awareness of past failures:

```markdown
Agent Thought (Goal): Generate validateInput function for user registration
Agent Thought (Extraction): Debug memory shows null-check pattern for this module
Agent Thought (Reasoning): I'll include null guards upfront to avoid known failure
```

### Phase 3: Test Generation

Generate tests based on code type:

| Code Type | Required Tests |
|-----------|---------------|
| New function | Happy path + edge cases + error handling |
| Bug fix | Regression test for the specific bug |
| Refactor | All existing tests must still pass |
| API endpoint | Integration + error cases + validation |

**Coverage Requirements:**

| Code Type | Minimum Coverage |
|-----------|-----------------|
| New function | 80% |
| Bug fix | 100% of fix |
| Refactor | Match original |
| API endpoint | 90% |

### Phase 4: Test Execution

Execute tests and capture results:

```yaml
execution:
  command: "npx jest test/unit/utils/validate.test.ts --verbose"
  timeout: 120s
  capture:
    - stdout
    - stderr
    - exit_code
    - coverage_report
```

**Record everything** — full output is needed for failure analysis.

### Phase 5: Failure Analysis

When tests fail, perform structured analysis:

```yaml
failure_analysis:
  - test: "test_null_input"
    error_type: "TypeError"
    error_message: "Cannot read property 'length' of null"
    stack_trace_snippet: "at validateInput (src/utils/validate.ts:42)"
    root_cause: "Missing null check in validateInput()"
    fix_strategy: "Add null/undefined guard at line 42"
    confidence: 0.95
```

**Analysis protocol:**

1. **Parse error message** — What type of error? Where did it occur?
2. **Check debug memory** — Has this pattern occurred before?
3. **Identify root cause** — Why did the test fail?
4. **Design fix** — What specific change will resolve it?
5. **Assess confidence** — How sure are we this fix is correct?

**Do NOT:**
- Retry with random changes
- Skip failure analysis
- Apply fixes without understanding root cause
- Ignore patterns from debug memory

### Phase 6: Fix and Verify

Apply targeted fix and re-execute:

```yaml
fix_applied:
  description: "Added null check: if (!input) return { valid: false }"
  diff_summary: "+3/-0 lines"
  files_modified: ["src/utils/validate.ts"]

verification:
  command: "npx jest test/unit/utils/validate.test.ts --verbose"
  result: all_passing
  regression_check: no_new_failures
```

**Regression guard:** If previously passing tests start failing after a fix, ABORT. The fix introduced a regression.

### Phase 7: Completion or Escalation

**On success:**
```yaml
completion:
  status: passed
  attempts_used: 2
  coverage_achieved: 92%
  debug_memory_updated: true
  learnings_recorded:
    - pattern: "Null check at module boundary"
      fix_template: "if (!input) return default"
```

**On max attempts reached:**
```yaml
escalation:
  status: escalated
  attempts_used: 3
  include_in_report:
    - original_code
    - all_test_results
    - failure_analyses
    - fix_attempts
    - debug_memory_summary
  notification:
    channel: issue_comment
    message: |
      ## Execution Feedback Escalation

      **File**: src/utils/validate.ts
      **Attempts**: 3/3

      ### Failures
      [Summary of persistent failures]

      ### Analysis
      [Root cause analysis across attempts]

      ### Attempted Fixes
      [What was tried and why it didn't work]

      **Human review required**
```

## Debug Memory

### Structure

Debug memory persists across sessions in `.aiwg/ralph/debug-memory/`:

```
.aiwg/ralph/debug-memory/
├── session-abc123.yaml      # Individual session records
├── session-def456.yaml
└── patterns/
    └── learned-patterns.yaml # Cross-session learnings
```

### Session Record

Each session records the full execution history:

```yaml
session_id: "abc123"
file_path: "src/utils/validate.ts"
status: passed
created_at: "2026-01-25T10:00:00Z"

executions:
  - attempt: 1
    test_results:
      passed: 6
      failed: 2
    failures:
      - test: "test_null_input"
        error_type: "TypeError"
        root_cause: "Missing null check"
    fix_applied: "Added null guard"

  - attempt: 2
    test_results:
      passed: 8
      failed: 0

learnings:
  patterns_identified:
    - pattern: "Null check missing at module boundary"
      frequency: 1
      fix_template: "Add null/undefined guard at function entry"
```

### Cross-Session Learning

Agents should query debug memory before generating code:

```yaml
pre_generation_query:
  file: "src/utils/validate.ts"
  module: "src/utils/*"

  results:
    past_sessions: 3
    common_patterns:
      - "Null check missing" (frequency: 2)
      - "Edge case not handled" (frequency: 1)
    recommended_preemptive_actions:
      - "Include null/undefined guards"
      - "Add edge case tests for empty string and whitespace"
```

## Integration with Agent Loop

When the executable feedback loop runs inside an agent loop:

```yaml
ralph_integration:
  # Every Al iteration includes code execution
  execution_gate:
    require_passing_tests: true
    allow_skip: false

  # Debug memory persists across Al iterations
  debug_memory:
    persist_per_iteration: true
    cross_iteration_learning: true

  # Test pass rate contributes to Al progress metric
  progress_metric:
    include_test_pass_rate: true
    weight: 0.3
```

**Al + Executable Feedback flow:**

```
Al Iteration 1:
  ├─ Generate code
  ├─ Run executable feedback loop (up to 3 attempts)
  ├─ Tests pass? → Al marks progress
  └─ Tests fail after 3 attempts? → Al escalates

Al Iteration 2:
  ├─ Load debug memory from iteration 1
  ├─ Generate improved code (using learnings)
  ├─ Run executable feedback loop
  └─ Continue...
```

## Escalation Scenarios

### Scenario 1: Simple Fix (Attempt 2 Success)

```
Attempt 1: 6/8 tests pass
  Analysis: Missing null check → Fix: Add guard clause
Attempt 2: 8/8 tests pass ✓
  Result: Return code to user
```

### Scenario 2: Complex Bug (Escalation After 3 Attempts)

```
Attempt 1: 4/10 tests pass
  Analysis: Race condition in async handler → Fix: Add mutex
Attempt 2: 6/10 tests pass (improved but not fixed)
  Analysis: Mutex scope too narrow → Fix: Widen lock scope
Attempt 3: 7/10 tests pass (still failing)
  Analysis: Underlying architecture issue
  Result: ESCALATE to human with full context
```

### Scenario 3: Regression Detected (Immediate Abort)

```
Attempt 1: 8/10 tests pass
  Analysis: Edge case not handled → Fix: Add boundary check
Attempt 2: 7/10 tests pass (REGRESSION: test_basic_flow now failing)
  Result: ABORT — fix introduced regression
  Action: Revert to attempt 1 code, escalate
```

## Metrics Dashboard

Track these metrics to monitor feedback loop effectiveness:

| Metric | Target | Current | Status |
|--------|--------|---------|--------|
| First-attempt pass rate | >70% | — | — |
| Average attempts to pass | <2.0 | — | — |
| Escalation rate | <10% | — | — |
| Debug memory reuse rate | >30% | — | — |
| Coverage met rate | >90% | — | — |

### Metric Definitions

- **First-attempt pass rate**: % of code that passes all tests on first try
- **Average attempts to pass**: Mean attempts before success (excluding escalations)
- **Escalation rate**: % of workflows that exhaust all attempts
- **Debug memory reuse rate**: % of sessions that benefit from past learnings
- **Coverage met rate**: % of code meeting minimum coverage requirements

## Troubleshooting

### "Tests keep failing with the same error"

1. Check if the root cause analysis is correct
2. Review debug memory for similar patterns
3. Verify the fix actually addresses the root cause (not a symptom)
4. If 3 attempts fail: escalate — the issue may be architectural

### "Coverage requirement not met"

1. Check if test generation is comprehensive enough
2. Verify coverage tool is configured correctly
3. Add tests for uncovered branches/paths
4. For refactors: compare against original coverage baseline

### "Regression detected after fix"

1. ABORT immediately — do not attempt further fixes
2. Revert to pre-fix code state
3. Analyze what the fix broke
4. Escalate with both the original failure and regression context

### "Debug memory not finding relevant patterns"

1. Check file path matching (exact vs module-level)
2. Widen search to module or directory level
3. Check error type matching (exact vs category)
4. Debug memory may not have enough history yet

## Anti-Patterns

### 1. Skipping Execution

```
# WRONG — returning code without testing
Generate code → Return to user

# RIGHT — always execute before return
Generate code → Execute tests → Verify → Return to user
```

### 2. Random Retry

```
# WRONG — no analysis before retry
Test failed → Change something random → Retry

# RIGHT — structured analysis then targeted fix
Test failed → Analyze root cause → Design targeted fix → Retry
```

### 3. Ignoring Debug Memory

```
# WRONG — starting fresh every time
Generate code → Hit same null-check bug → Fix → Next session → Same bug

# RIGHT — learn from history
Check debug memory → Known null-check pattern → Include guard → Tests pass first try
```

### 4. Exceeding Retry Limit

```
# WRONG — infinite retries
max_attempts: 999  # Will waste tokens on unfixable issues

# RIGHT — bounded retries with escalation
max_attempts: 3
escalation_on_max: true  # Human takes over
```

## Schema Reference

The executable feedback loop conforms to:
- `@$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/schemas/flows/executable-feedback.yaml` — Workflow schema
- `@$AIWG_ROOT/agentic/code/addons/agent-loop/schemas/debug-memory.yaml` — Debug memory schema
- `@$AIWG_ROOT/agentic/code/addons/agent-loop/schemas/actionable-feedback.yaml` — Feedback schema
- `@$AIWG_ROOT/agentic/code/addons/agent-loop/schemas/iteration-analytics.yaml` — Analytics schema

## References

- @.aiwg/research/findings/REF-013-metagpt.md — MetaGPT research findings
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/executable-feedback.md — Executable feedback rules
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/schemas/flows/executable-feedback.yaml — Workflow schema
- @$AIWG_ROOT/agentic/code/addons/agent-loop/schemas/debug-memory.yaml — Debug memory schema
- @$AIWG_ROOT/agentic/code/addons/agent-loop/docs/reflection-memory-guide.md — Related: Reflexion memory guide
- #101 — Implementation issue
