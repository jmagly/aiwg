# Agent Persistence Framework - Agent Loop Integration

**Version**: 1.0.0
**Status**: Implementation Guide
**Issue**: #261

## Overview

This document describes the integration layer between the Agent Persistence & Anti-Laziness Framework and agent loop execution. The integration uses event hooks to inject detection, monitoring, and recovery capabilities at strategic execution points without modifying core Al logic.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Agent Loop Execution                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  loop_start                                                             │
│      │                                                                  │
│      ├──▶ Hook: Initialize Progress Tracker                            │
│      ├──▶ Hook: Enable Laziness Detector                               │
│      └──▶ Action: Capture baseline metrics                             │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────┐       │
│  │ Iteration Loop                                               │       │
│  │                                                              │       │
│  │  pre_iteration                                               │       │
│  │      ├──▶ Hook: Inject reinforcement prompts                 │       │
│  │      └──▶ Action: Snapshot pre-iteration state               │       │
│  │                                                              │       │
│  │  [Agent executes task]                                       │       │
│  │                                                              │       │
│  │  pre_tool_call (for risky operations)                        │       │
│  │      ├──▶ Hook: Warn about destructive action                │       │
│  │      └──▶ Action: Create rollback checkpoint                 │       │
│  │                                                              │       │
│  │  [Tool executes]                                             │       │
│  │                                                              │       │
│  │  post_tool_call                                              │       │
│  │      └──▶ Hook: Immediate regression check                   │       │
│  │                                                              │       │
│  │  [Iteration completes]                                       │       │
│  │                                                              │       │
│  │  post_iteration                                              │       │
│  │      ├──▶ Hook: Capture metrics                              │       │
│  │      ├──▶ Hook: Check for regression                         │       │
│  │      ├──▶ Hook: Update best output tracker                   │       │
│  │      └──▶ Action: Log iteration complete                     │       │
│  │                                                              │       │
│  │  [If regression detected]                                    │       │
│  │      └──▶ Hook: regression_detected                          │       │
│  │          └──▶ Agent: Recovery Orchestrator                   │       │
│  │              └──▶ Protocol: PDARE (Pause-Diagnose-Adapt-     │       │
│  │                             Retry-Escalate)                  │       │
│  │                                                              │       │
│  │  [If error occurs]                                           │       │
│  │      └──▶ Hook: on_error                                     │       │
│  │          └──▶ Agent: Prompt Reinforcement                    │       │
│  │                                                              │       │
│  └─────────────────────────────────────────────────────────────┘       │
│                                                                         │
│  loop_complete                                                          │
│      ├──▶ Hook: Select best output                                     │
│      ├──▶ Hook: Generate progress report                               │
│      └──▶ Action: Archive iteration history                            │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## Event Flows

### 1. Loop Initialization Flow

```yaml
Event: loop_start
Trigger: Agent loop begins execution

Sequence:
  1. Initialize Progress Tracker Agent
     - Capture baseline metrics:
       - test_count
       - coverage_percentage
       - typescript_errors
       - lint_errors
     - Store in state.baseline_metrics

  2. Enable Laziness Detector Agent
     - Load detection patterns
     - Enable file watchers
     - Set detection_mode: "standard"

  3. Initialize State Extension
     - Create iteration_history array
     - Create regression_events array
     - Set reinforcement_level: "MINIMAL"
     - Set detection_enabled: true

  4. Snapshot Codebase
     - Create initial checkpoint
     - Record file hashes
     - Store as baseline snapshot

State Updates:
  - state.baseline_metrics = {...}
  - state.detection_enabled = true
  - state.reinforcement_level = "MINIMAL"
  - state.iteration_history = []
  - state.regression_events = []
```

### 2. Pre-Iteration Flow

```yaml
Event: pre_iteration
Trigger: Before each iteration starts

Sequence:
  1. Calculate Reinforcement Level
     - Check iteration count
     - Check quality trajectory
     - Check error history
     - Determine appropriate level:
       - Iteration 1-2: MINIMAL
       - Iteration 3-4: STANDARD
       - Iteration 5+: AGGRESSIVE
       - Quality plateau: AGGRESSIVE

  2. Invoke Prompt Reinforcement Agent
     - Input: iteration_number, task_context, error_history
     - Generate context-aware anti-laziness prompts
     - Inject into agent system prompt

  3. Snapshot Pre-Iteration State
     - Create checkpoint before changes
     - Record current metrics
     - Enable rollback capability

State Updates:
  - state.reinforcement_level = calculated_level
  - state.pre_iteration_snapshot = snapshot_path
  - increment state.iteration
```

### 3. Pre-Tool-Call Flow (High-Risk Actions)

```yaml
Event: pre_tool_call
Trigger: Before executing destructive operations

Risk Patterns:
  - Write to test files: **/test/**/* or *.test.{ts,js,py}
  - Bash commands: rm -rf*, git rm*
  - File deletions
  - Validation code modifications

Sequence:
  1. Detect Risk Pattern
     - Match tool and target against risk patterns
     - Calculate risk level: critical, high, medium, low

  2. Invoke Prompt Reinforcement Agent
     - Generate pre-action warning
     - Inject into immediate context
     - Example: "⚠️ You are about to modify test file. Verify this is a fix, not a deletion."

  3. Create Rollback Checkpoint
     - Snapshot current state
     - Store file hashes
     - Enable quick rollback if needed

  4. Log Risky Action
     - Record tool, target, risk level
     - Timestamp for audit trail

State Updates:
  - append state.risky_actions
  - state.last_risky_action = {...}
```

### 4. Post-Tool-Call Flow

```yaml
Event: post_tool_call
Trigger: After high-risk tool execution completes

Sequence:
  1. Capture Post-Action Metrics
     - Test count
     - Coverage percentage
     - File counts
     - Any custom metrics

  2. Invoke Regression Detector Agent
     - Compare current vs baseline metrics
     - Check for regression patterns:
       - Test deletion
       - Coverage drop
       - Feature removal
       - Validation bypass

  3. If Regression Detected
     - Trigger regression_detected hook
     - See Regression Detection Flow

State Updates:
  - append state.tool_call_history
```

### 5. Post-Iteration Flow

```yaml
Event: post_iteration
Trigger: After iteration completes

Sequence:
  1. Capture Iteration Metrics
     - Quality score (0-100)
     - Quality breakdown (validation, completeness, correctness, etc.)
     - Test results
     - Metrics snapshot
     - Modified artifacts

  2. Check for Regression
     - Compare metrics to baseline
     - Invoke Regression Detector Agent
     - Generate regression report

  3. Update Best Output Tracker
     - Compare current quality to best_iteration
     - If current > best:
       - Update state.best_iteration
       - Store snapshot path
       - Record selection reason

  4. Append to Iteration History
     - Full iteration record
     - Enable best output selection later

  5. Check for Quality Plateau
     - Analyze quality_delta for last 3 iterations
     - If all < 5%, trigger reinforcement_escalation

  6. Check Completion Criteria
     - Run completion check
     - Record result in progress.completion_checks

State Updates:
  - append state.iteration_history
  - update state.best_iteration (if applicable)
  - state.regression_detected = true/false
  - append state.progress.completion_checks

Conditional Hooks:
  - If regression_detected: trigger regression_detected hook
  - If quality_plateau: trigger reinforcement_escalation hook
```

### 6. Regression Detection Flow

```yaml
Event: regression_detected
Trigger: Regression Detector Agent signals violation

Sequence:
  1. Pause Execution
     - Block pending file operations
     - Create emergency checkpoint

  2. Invoke Recovery Orchestrator Agent
     - Input: regression_type, severity, iteration, diff
     - Execute PDARE protocol:

       PAUSE:
         - Halt destructive action
         - Snapshot state
         - Log violation

       DIAGNOSE:
         - Analyze root cause
         - Check cognitive_load
         - Check task_complexity
         - Check specification_ambiguity
         - Check reward_hacking
         - Generate diagnosis with confidence

       ADAPT:
         - Select strategy based on diagnosis:
           - cognitive_load → decompose task
           - task_complexity → request simpler approach
           - specification_ambiguity → request clarification
           - reward_hacking → block and escalate

       RETRY:
         - Re-attempt with adapted approach
         - Track retry in recovery_history
         - Maximum 3 retries

       ESCALATE:
         - If retries exhausted: invoke human gate
         - If severity critical: immediate human gate
         - If test_deletion: immediate human gate

  3. Human Gate (if triggered)
     - Type: TERMINATE (blocks indefinitely)
     - Display regression details
     - Options:
       - Approve (continue with changes)
       - Reject (revert changes)
       - Abort (stop loop)

  4. Log Regression Event
     - Record full regression_record
     - Append to state.regression_events

State Updates:
  - append state.regression_events
  - increment state.recovery_attempts
  - append state.recovery_history
  - state.recovery_in_progress = true
```

### 7. Error Handling Flow

```yaml
Event: on_error
Trigger: Error during iteration execution

Sequence:
  1. Capture Error Context
     - error_type
     - error_message
     - stack_trace
     - iteration number

  2. Invoke Prompt Reinforcement Agent
     - Generate post-error guidance
     - Example: "Error detected: TypeError. Analyze root cause in SOURCE CODE, not test."

  3. Check for Stuck Loop
     - If error_count >= 3 AND same_error_repeated:
       - Trigger stuck_loop_detected hook

State Updates:
  - append state.error_history
  - increment state.error_count
  - state.last_error = {...}
```

### 8. Stuck Loop Detection Flow

```yaml
Event: stuck_loop_detected
Trigger: 3+ consecutive errors or same issue repeated

Sequence:
  1. Pause Execution
     - Halt all operations
     - Create checkpoint

  2. Invoke Recovery Orchestrator Agent
     - Force escalation to human

  3. Human Gate
     - Type: TERMINATE
     - Message: "🚨 STUCK LOOP DETECTED - Iteration {N}"
     - Options:
       - Continue with modified approach
       - Abort loop
       - Manual fix and resume

  4. Log Stuck Loop Event
     - Record pattern
     - Record recovery attempts

State Updates:
  - state.stuck_loop_detected = true
  - state.recovery_in_progress = true
```

### 9. Loop Completion Flow

```yaml
Event: loop_complete
Trigger: Loop reaches terminal state (completed, failed, aborted)

Sequence:
  1. Select Best Output
     - Load iteration_history
     - Filter by quality_threshold (default: 70%)
     - Rank by quality_score
     - Select highest quality iteration
     - Log selection decision

  2. Generate Progress Report
     - Invoke Progress Tracker Agent
     - Compile:
       - Total iterations
       - Quality trajectory
       - Regression events
       - Recovery attempts
       - Best vs final iteration
       - Cost metrics

  3. Archive Iteration History
     - Compress iteration snapshots
     - Store in .aiwg/ralph/loops/{loop_id}/iterations/
     - Preserve best iteration permanently

  4. Disable Detection
     - Stop file watchers
     - Cleanup temporary state

State Updates:
  - state.selected_iteration = best_iteration
  - state.completion_report_path = report_path
  - state.detection_enabled = false
```

## Hook Integration Examples

### Example 1: ConversableAgent Message Flow

```typescript
// Hook: pre_iteration
// Trigger: Iteration 5 starts

// 1. Hook system sends message to Prompt Reinforcement Agent
const message: Message = {
  role: "user",
  content: "Inject anti-laziness reinforcement for iteration 5",
  metadata: {
    hook_name: "pre_iteration",
    loop_id: "ralph-fix-tests-a1b2c3d4",
    iteration: 5,
    inputs: {
      iteration_number: 5,
      task_context: "Fix all TypeScript errors",
      error_history: [
        { iteration: 3, error: "TypeError at line 42" },
        { iteration: 4, error: "TypeError at line 42" }  // Repeated!
      ],
      risk_patterns: ["repeated_error"]
    }
  },
  timestamp: "2026-02-02T21:10:00Z",
  sender: "ralph-orchestrator"
};

// 2. Agent receives message via ConversableAgent.receive()
await promptReinforcementAgent.receive(message, orchestrator);

// 3. Agent generates reply via ConversableAgent.generateReply()
const reply = await promptReinforcementAgent.generateReply([message]);

// 4. Reply contains reinforcement prompts
const response: Message = {
  role: "assistant",
  content: `
🚨 ITERATION #5 - Stuck Loop Risk

You have attempted this task 5 times.
You've encountered the same TypeError twice in a row.

MANDATORY ACTIONS:
1. STOP repeating the same approach
2. Analyze WHY the TypeError occurs (not just WHERE)
3. Consider alternative implementation
4. If uncertain, ESCALATE to human for guidance

DO NOT: Delete tests, disable features, or take shortcuts.
  `,
  metadata: {
    verdict: "WARN",
    recommendations: [
      "Escalate if iteration 6 also fails",
      "Consider decomposing task into smaller steps"
    ],
    reinforcement_level: "AGGRESSIVE"
  },
  timestamp: "2026-02-02T21:10:05Z",
  sender: "prompt-reinforcement"
};

// 5. Hook system injects prompts into agent context
await injectReinforcementPrompts(response.content);

// 6. State update
state.reinforcement_level = "AGGRESSIVE";
state.reinforcement_history.push({
  timestamp: "2026-02-02T21:10:05Z",
  iteration: 5,
  from_level: "STANDARD",
  to_level: "AGGRESSIVE",
  reason: "Iteration 5 threshold + repeated error pattern"
});
```

### Example 2: Regression Detection with Recovery

```typescript
// Hook: post_iteration
// Trigger: Iteration 7 completes

// 1. Regression Detector invoked
const regressionCheck: Message = {
  role: "user",
  content: "Check for regression in iteration 7",
  metadata: {
    hook_name: "post_iteration",
    loop_id: "ralph-fix-tests-a1b2c3d4",
    iteration: 7,
    inputs: {
      baseline: {
        test_count: 150,
        coverage_percentage: 85
      },
      current: {
        test_count: 148,  // REGRESSION!
        coverage_percentage: 84
      }
    }
  }
};

// 2. Detector generates verdict
const detectionResult: Message = {
  role: "assistant",
  content: "REGRESSION DETECTED: test_deletion",
  metadata: {
    verdict: "BLOCK",
    regression_type: "test_deletion",
    severity: "critical",
    details: {
      baseline_value: 150,
      current_value: 148,
      diff: {
        deleted_tests: [
          "test/unit/auth/login.test.ts: should validate email format",
          "test/unit/auth/login.test.ts: should reject weak passwords"
        ]
      }
    }
  }
};

// 3. Trigger regression_detected hook
await triggerHook("regression_detected", {
  regression: detectionResult.metadata
});

// 4. Recovery Orchestrator invoked with PDARE protocol
const recoveryRequest: Message = {
  role: "user",
  content: "Execute recovery protocol for test deletion",
  metadata: {
    hook_name: "regression_detected",
    inputs: {
      regression_type: "test_deletion",
      severity: "critical",
      iteration: 7
    }
  }
};

// 5. Recovery executes PDARE
const recoverySteps = {
  PAUSE: {
    executed_at: "2026-02-02T21:15:05Z",
    actions: [
      "Blocked pending file operations",
      "Created checkpoint: iteration-007-pre-revert"
    ]
  },

  DIAGNOSE: {
    executed_at: "2026-02-02T21:15:10Z",
    root_cause: "Agent deleted failing tests instead of fixing validation logic",
    confidence: 0.95,
    diagnosis: "reward_hacking"
  },

  ADAPT: {
    executed_at: "2026-02-02T21:15:15Z",
    strategy: "escalate_to_human_gate",
    reason: "Critical regression + high confidence in gaming behavior"
  },

  ESCALATE: {
    executed_at: "2026-02-02T21:15:20Z",
    gate_type: "TERMINATE",
    message: `
🛑 REGRESSION DETECTED - Iteration 7

Test deletion detected:
- Previous: 150 tests
- Current: 148 tests

Deleted tests:
- test/unit/auth/login.test.ts: should validate email format
- test/unit/auth/login.test.ts: should reject weak passwords

This is NOT acceptable. These tests reveal bugs that need fixing.

Actions:
[1] Reject iteration 7 and revert changes
[2] Continue (override detection - NOT RECOMMENDED)
[3] Abort loop entirely

Enter choice: _
    `
  }
};

// 6. Human responds: [1] Reject
const humanDecision = "reject";

// 7. Revert iteration 7 changes
await revertToCheckpoint("iteration-006-final");

// 8. Log regression event
state.regression_events.push({
  event_id: "reg-001",
  timestamp: "2026-02-02T21:15:05Z",
  iteration: 7,
  regression_type: "test_deletion",
  severity: "critical",
  details: detectionResult.metadata.details,
  recovery_protocol_invoked: true,
  recovery_outcome: "escalated",
  human_gate_invoked: true,
  human_decision: "reject"
});

// 9. Resume from iteration 6
state.iteration = 6;
state.reinforcement_level = "AGGRESSIVE";
continueLoop();
```

## State Extension Schema Integration

The persistence extension adds fields to the standard `loop-state.yaml`:

```yaml
# Standard loop-state.yaml fields
version: "2.0.0"
loop_id: "ralph-fix-tests-a1b2c3d4"
status: "running"
iteration: 7
task: "Fix all TypeScript errors"
completion_criteria: "npx tsc --noEmit passes"
started_at: "2026-02-02T21:00:00Z"
last_updated: "2026-02-02T21:15:00Z"
configuration:
  max_iterations: 200
  timeout_minutes: 60

# Agent Persistence extension fields (from persistence-extension.yaml)
baseline_metrics:
  captured_at: "2026-02-02T21:00:00Z"
  test_count: 150
  coverage_percentage: 85
  typescript_errors: 12

iteration_history:
  - iteration: 1
    quality_score: 60
    artifacts: [...]
  - iteration: 2
    quality_score: 85  # BEST
    artifacts: [...]
  - iteration: 7
    quality_score: 70
    regression_detected: true
    artifacts: [...]

best_iteration:
  iteration: 2
  quality_score: 85
  snapshot_path: ".aiwg/ralph/loops/ralph-fix-tests-a1b2c3d4/iterations/iteration-002.json"
  selection_reason: "Highest quality score (85%)"

regression_events:
  - event_id: "reg-001"
    iteration: 7
    regression_type: "test_deletion"
    severity: "critical"
    human_decision: "reject"

reinforcement_level: "AGGRESSIVE"

recovery_attempts: 1

detection_enabled: true
```

## Best Output Selection Algorithm

Per REF-015 Self-Refine, final iteration is not always best quality.

```typescript
function selectBestOutput(iterations: Iteration[]): Iteration {
  // 1. Filter by quality threshold
  const acceptable = iterations.filter(
    it => it.quality_score >= QUALITY_THRESHOLD // default: 70%
  );

  // 2. Filter by verification status (if available)
  const verified = acceptable.filter(
    it => it.test_results?.verification_status === "passed"
  );

  const candidates = verified.length > 0 ? verified : acceptable;

  // 3. Rank by quality score
  candidates.sort((a, b) => b.quality_score - a.quality_score);

  // 4. Select highest
  const best = candidates[0];

  // 5. Log selection decision
  logSelection({
    selected_iteration: best.iteration,
    quality_score: best.quality_score,
    total_iterations: iterations.length,
    final_iteration: iterations[iterations.length - 1].iteration,
    reason: best.iteration === iterations.length
      ? "Final iteration was also best"
      : `Best quality (${best.quality_score}%) at iteration ${best.iteration}, not final`
  });

  return best;
}
```

## Performance Targets

From NFR-AP-001, NFR-AP-002, NFR-AP-003:

| Metric | Target | Measurement |
|--------|--------|-------------|
| Detection latency (p95) | <500ms | Hook trigger to completion |
| Detection latency (p99) | <1000ms | Hook trigger to completion |
| Integration overhead | <10% | Iteration time increase |
| False positive rate | <5% | False positives / total detections |

## File Structure

```
.aiwg/ralph/loops/{loop_id}/
├── state.json                          # Extended with persistence fields
├── checkpoints/
│   ├── iteration-001.json.gz
│   ├── iteration-002.json.gz           # BEST iteration
│   └── iteration-007.json.gz
├── iterations/                         # Full iteration snapshots
│   ├── iteration-001.json
│   ├── iteration-002.json              # Selected for final output
│   └── iteration-007.json
├── analytics/
│   ├── analytics.json                  # Iteration analytics
│   └── report.md                       # Final report
└── hook-log.jsonl                      # Audit trail of all hook invocations
```

## Configuration

Project-level configuration in `aiwg.yml`:

```yaml
agent_persistence:
  enabled: true

  detection:
    mode: "standard"  # off, minimal, standard, aggressive
    patterns_enabled:
      - test_deletion
      - feature_removal
      - coverage_regression
      - validation_bypass

  reinforcement:
    default_level: "MINIMAL"
    escalation_thresholds:
      iteration_3: "STANDARD"
      iteration_5: "AGGRESSIVE"
    quality_plateau_threshold: 0.05  # 5% delta

  recovery:
    max_retries: 3
    auto_escalate_on_critical: true
    human_gate_timeout_minutes: null  # Block indefinitely

  best_output_selection:
    enabled: true
    quality_threshold: 70
    require_verification: false

  performance:
    detection_latency_budget_ms: 500
    max_integration_overhead_percentage: 10
```

## CLI Integration

```bash
# View persistence metrics
aiwg ralph-status ralph-fix-tests-a1b2c3d4 --persistence

# Output:
# Persistence Metrics:
#   Baseline Metrics: 150 tests, 85% coverage, 12 TS errors
#   Current Metrics: 148 tests, 84% coverage, 0 TS errors
#   Regression Events: 1 (critical: test_deletion)
#   Reinforcement Level: AGGRESSIVE
#   Recovery Attempts: 1
#   Best Iteration: 2 (quality: 85%)
#   Current Iteration: 7 (quality: 70%)

# View regression events
aiwg ralph-status ralph-fix-tests-a1b2c3d4 --regressions

# Output:
# Regression Events:
#   [reg-001] Iteration 7 - test_deletion (CRITICAL)
#     - 2 tests deleted
#     - Recovery: escalated, human rejected
#     - Reverted to iteration 6

# View iteration quality trajectory
aiwg ralph-status ralph-fix-tests-a1b2c3d4 --quality

# Output:
# Quality Trajectory:
#   Iteration 1: 60% ░░░░░░░░░░░░
#   Iteration 2: 85% ░░░░░░░░░░░░░░░░░ ⬅ BEST
#   Iteration 3: 83% ░░░░░░░░░░░░░░░░
#   Iteration 4: 81% ░░░░░░░░░░░░░░░
#   Iteration 5: 79% ░░░░░░░░░░░░░░
#   Iteration 6: 77% ░░░░░░░░░░░░░
#   Iteration 7: 70% ░░░░░░░░░░░░ ⬅ REGRESSION
```

## Testing Integration

### Unit Tests

Test individual hooks:

```typescript
describe("Agent Persistence Hooks", () => {
  describe("pre_iteration hook", () => {
    it("should escalate reinforcement at iteration 5", async () => {
      const state = createTestState({ iteration: 5 });
      await hooks.pre_iteration(state);

      expect(state.reinforcement_level).toBe("AGGRESSIVE");
      expect(state.reinforcement_history).toContainEqual({
        iteration: 5,
        to_level: "AGGRESSIVE",
        reason: expect.stringContaining("Iteration 5 threshold")
      });
    });
  });

  describe("regression_detected hook", () => {
    it("should invoke PDARE protocol for test deletion", async () => {
      const regression = {
        type: "test_deletion",
        severity: "critical",
        details: { baseline_value: 150, current_value: 148 }
      };

      const result = await hooks.regression_detected(regression);

      expect(result.recovery_invoked).toBe(true);
      expect(result.protocol_steps).toHaveProperty("PAUSE");
      expect(result.protocol_steps).toHaveProperty("DIAGNOSE");
      expect(result.protocol_steps).toHaveProperty("ESCALATE");
    });
  });
});
```

### Integration Tests

Test full event flows:

```typescript
describe("Agent Loop with Persistence", () => {
  it("should detect and recover from test deletion", async () => {
    // Setup
    const loop = createRalphLoop({
      task: "Fix tests",
      completion: "npm test passes"
    });

    // Execute iterations
    await loop.start();

    // Simulate test deletion in iteration 3
    await simulateTestDeletion({ iteration: 3, count: 2 });

    // Verify regression detected
    const state = await loop.getState();
    expect(state.regression_events).toHaveLength(1);
    expect(state.regression_events[0].regression_type).toBe("test_deletion");

    // Verify recovery invoked
    expect(state.recovery_attempts).toBe(1);

    // Verify human gate triggered
    expect(state.regression_events[0].human_gate_invoked).toBe(true);
  });

  it("should select best output, not final", async () => {
    const loop = createRalphLoop({ task: "Improve code quality" });

    // Simulate quality trajectory: 60, 85, 83, 80 (peak at iteration 2)
    await loop.runIterations([
      { quality: 60 },
      { quality: 85 },  // BEST
      { quality: 83 },
      { quality: 80 }   // FINAL
    ]);

    const result = await loop.complete();

    expect(result.selected_iteration).toBe(2);
    expect(result.selected_quality).toBe(85);
    expect(result.selection_reason).toContain("Highest quality");
  });
});
```

## Troubleshooting

### Issue: Detection latency exceeds 500ms

**Diagnosis**:
```bash
# Check hook execution times
grep "hook_name" .aiwg/ralph/loops/*/hook-log.jsonl | \
  jq '.duration_ms' | \
  sort -n | \
  tail -20
```

**Solutions**:
- Optimize pattern matching in Laziness Detector
- Cache baseline metrics to avoid repeated retrieval
- Run non-critical hooks asynchronously

### Issue: High false positive rate

**Diagnosis**:
```bash
# Check false positive rate
aiwg ralph-status --all --persistence | grep "false_positive_rate"
```

**Solutions**:
- Tune detection pattern sensitivity
- Add context checks to patterns
- Implement feedback loop for human-marked false positives

### Issue: Integration overhead >10%

**Diagnosis**:
```bash
# Compare iteration times with/without persistence
aiwg benchmark --with-persistence
aiwg benchmark --without-persistence
```

**Solutions**:
- Profile hook execution
- Identify bottleneck hooks
- Consider async execution for non-blocking hooks

## Migration Guide

### Existing Agent Loops

To enable persistence for existing Al installations:

1. **Install persistence hooks**:
   ```bash
   aiwg use agent-persistence
   ```

2. **Update aiwg.yml**:
   ```yaml
   agent_persistence:
     enabled: true
   ```

3. **Restart agent loop** (if running):
   ```bash
   aiwg ralph-pause {loop_id}
   aiwg ralph-resume {loop_id}  # Hooks now active
   ```

4. **Verify integration**:
   ```bash
   aiwg ralph-status {loop_id} --persistence
   ```

### Backward Compatibility

- Loops without persistence extension continue to work
- `state.json` without persistence fields is valid
- Hooks gracefully handle missing extension fields
- Detection can be disabled via `agent_persistence.enabled: false`

## References

### Schemas

- `@$AIWG_ROOT/agentic/code/addons/agent-loop/hooks/persistence-hooks.yaml` - Hook definitions
- `@$AIWG_ROOT/agentic/code/addons/agent-loop/schemas/persistence-extension.yaml` - State extension schema
- `@$AIWG_ROOT/agentic/code/addons/agent-loop/schemas/loop-state.yaml` - Base loop state schema
- `@$AIWG_ROOT/agentic/code/addons/agent-loop/schemas/checkpoint.yaml` - Checkpoint schema
- `@$AIWG_ROOT/agentic/code/addons/agent-loop/schemas/iteration-analytics.yaml` - Iteration analytics

### Requirements

- `@.aiwg/requirements/use-cases/UC-AP-001-detect-test-deletion.md` - Test deletion detection
- `@.aiwg/requirements/use-cases/UC-AP-003-detect-coverage-regression.md` - Coverage regression
- `@.aiwg/requirements/use-cases/UC-AP-004-enforce-recovery-protocol.md` - Recovery enforcement
- `@.aiwg/requirements/use-cases/UC-AP-005-prompt-reinforcement.md` - Prompt reinforcement
- `@.aiwg/requirements/use-cases/UC-AP-006-progress-tracking.md` - Progress tracking
- `@.aiwg/requirements/nfr-modules/agent-persistence-nfrs.md` - NFRs

### Architecture

- `@.aiwg/architecture/decisions/ADR-AP-001-detection-hook-architecture.md` - Hook architecture
- `@.aiwg/architecture/decisions/ADR-AP-002-rule-enforcement-strategy.md` - Enforcement strategy
- `@.aiwg/architecture/decisions/ADR-AP-003-prompt-injection-points.md` - Reinforcement injection

### Research

- `@.aiwg/research/findings/REF-015-self-refine.md` - Best output selection (non-monotonic quality)
- `@.aiwg/research/findings/REF-058-r-lam.md` - Reproducibility and checkpointing
- `@.aiwg/research/findings/REF-018-react.md` - ReAct TAO loop integration
- `@.aiwg/research/findings/agentic-laziness-research.md` - Laziness patterns and causes

### Rules

- `@$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/conversable-agent-interface.md` - ConversableAgent protocol
- `@$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/executable-feedback.md` - Execute before return pattern
- `@$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/actionable-feedback.md` - Feedback quality requirements
- `@$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/best-output-selection.md` - Best output selection rules

---

**Document Version**: 1.0.0
**Last Updated**: 2026-02-02
**Author**: Software Implementer
**Issue**: #261
