---
namespace: aiwg
name: iteration-control
platforms: [all]
description: Manage bounded iteration loops for autonomous implementation — track retries, synthesize failure feedback, and escalate when limits hit
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


# iteration-control

Manages bounded iteration loops for autonomous implementation with escalation.

## Triggers


Alternate expressions and non-obvious activations (primary phrases are matched automatically from the skill description):

- "pause the loop" → loop control signal
- "stop after N cycles" → explicit iteration limit

## Purpose

This skill provides iteration control logic for guided implementation workflows. It tracks retry attempts, synthesizes feedback from failures, and decides whether to retry autonomously or escalate to the user.

Based on MAGIS research finding: Developer-QA iteration loops with bounds improve code quality while preventing infinite loops.

## Behavior

When invoked during a validation loop:

1. **Track iteration state**:
   - Current iteration count
   - Maximum allowed iterations (default: 3)
   - Task identifier

2. **Evaluate validation results**:
   - Test results (pass/fail)
   - Review results (approve/reject/feedback)
   - Error messages and stack traces

3. **Synthesize feedback** (on failure):
   - Extract actionable items from test output
   - Extract specific issues from review feedback
   - Prioritize by severity

4. **Decide action**:
   - `proceed`: Validation passed, continue to next task
   - `retry`: Validation failed, iteration < max, retry with feedback
   - `escalate`: Validation failed, iteration >= max, pause for user

5. **Format escalation** (when needed):
   - Summary of attempts made
   - Consolidated feedback from all iterations
   - Specific question or decision needed from user

## Decision Logic

```
IF test_result == PASS AND review_result == APPROVE:
  RETURN { action: "proceed" }

IF current_iteration >= max_iterations:
  RETURN {
    action: "escalate",
    context: summarize_all_attempts(),
    question: identify_blocking_issue()
  }

IF test_result == FAIL:
  RETURN {
    action: "retry",
    feedback: extract_test_feedback(),
    iteration: current_iteration + 1
  }

IF review_result == REJECT:
  RETURN {
    action: "retry",
    feedback: extract_review_feedback(),
    iteration: current_iteration + 1
  }
```

## Input Format

```yaml
iteration_check:
  task_id: "task-003"
  current_iteration: 2
  max_iterations: 3

  test_result:
    status: "fail"  # pass | fail
    output: |
      FAIL src/auth/login.test.ts
      Expected: token to contain userId
      Received: undefined

  review_result:
    status: "pending"  # approve | reject | pending
    feedback: ""
```

## Output Format

### Proceed

```yaml
decision:
  action: "proceed"
  task_id: "task-003"
  message: "Validation passed. Proceeding to next task."
```

### Retry

```yaml
decision:
  action: "retry"
  task_id: "task-003"
  iteration: 3
  feedback:
    summary: "Test failed: token missing userId"
    actionable_items:
      - "Ensure jwt.sign includes userId in payload"
      - "Check that user object is populated before token generation"
    priority: "high"
```

### Escalate

```yaml
decision:
  action: "escalate"
  task_id: "task-003"
  iteration: 3
  context:
    attempts_summary: |
      Iteration 1: Test failed - undefined token
      Iteration 2: Test failed - token missing userId
      Iteration 3: Test failed - userId present but wrong format

    pattern_detected: "userId format mismatch between token and test expectation"

  question: |
    After 3 attempts, the test still fails due to userId format.

    The token contains: { userId: "123" } (string)
    The test expects: { userId: 123 } (number)

    Which format should be used?
    1. String (update test)
    2. Number (update implementation)
```

## Configuration

Default settings (can be overridden per-flow):

```yaml
iteration_control:
  max_iterations: 3
  auto_retry_on_test_fail: true
  auto_retry_on_review_reject: true
  escalation_includes_diff: true
  feedback_max_length: 500
```

## Integration

Used by `flow-guided-implementation` to wrap the validation loop:

```
FOR EACH task:
  iteration = 0
  LOOP:
    generate_code()
    run_tests() -> test_result
    run_review() -> review_result

    decision = iteration_control(task, iteration, test_result, review_result)

    SWITCH decision.action:
      "proceed": BREAK (next task)
      "retry": apply_feedback(decision.feedback); iteration++; CONTINUE
      "escalate": PAUSE; await_user_input(); CONTINUE or ABORT
```

## Traceability

- @research @.aiwg/research/REF-004-magis-multi-agent-issue-resolution.md

## References

- @.aiwg/working/guided-impl-analysis/SYNTHESIS.md
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/prompts/reliability/resilience.md
