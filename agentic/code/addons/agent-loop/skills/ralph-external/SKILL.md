---
namespace: aiwg
name: ralph-external
platforms: [all]
description: Crash-resilient external loop with state persistence and CI/CD integration
commandHint:
  argumentHint: "\"<objective>\" --completion \"<criteria>\" [--max-iterations N] [--timeout M] [--provider <p>] [--no-commit] [--branch <name>] [--quiet]"
  allowedTools: Bash, Read, Write
  model: haiku
  category: automation
  orchestration: true
  platforms: [claude-code, hermes, openclaw]
  modelRole: efficiency
  modelTier: economy
---

<!-- AIWG-SKILL-CALLOUT -->
> **Skill access pattern (post-kernel-pivot, 2026.5+)**
>
> Skill names referenced in this document are AIWG skills, **not slash commands**. Most are not kernel-listed and cannot be invoked as `/skill-name` by the platform. Reach them via:
>
> ```bash
> aiwg discover "<capability>"
> aiwg show skill <name> --body
> ```
>
> Only kernel-listed skills (`aiwg-doctor`, `aiwg-refresh`, `aiwg-status`, `aiwg-help`, `use`, `aiwg-steward-routing` on Claude Code) are directly invokable as slash commands. See [skill-discovery rule](../../../addons/aiwg-utils/rules/skill-discovery.md).


# Al External

**You are the Al External Orchestrator** — launching and managing crash-resilient iterative loops that run outside the AI session for long-running tasks.

## HITL authorization checkpoints

Before any confirmation below, read and apply
[agent-loop authorization checkpoints](../../docs/hitl-authorization.md).
Call `aiwg config authorization check --action-file "$ACTION_FILE" --target "$TARGET_REPO"`
for host-classified effects. Only `auto-authorized` with a signed receipt skips
that workflow prompt; retain existing prompts/refusals otherwise. Platform
prompts are never bypassed. Limits, regression and threat overrides still require review.

## Core Difference from `ralph`

`ralph` runs the loop inside the current AI session. `ralph-external` launches the loop as an external process via `tools/ralph-external/run.sh`, persisting all state to `.aiwg/ralph-external/`. If the session dies mid-loop, the loop survives and can be reattached or resumed.

Use `ralph-external` when:
- The task will take longer than a single session
- You need CI/CD pipeline integration
- You want crash recovery guarantees
- You need to run multiple loops in parallel

## Natural Language Triggers

Users may say:
- "ralph external"
- "external ralph"
- "crash-resilient loop"
- "persistent ralph"
- "long-running ralph task"
- "ralph with crash recovery"
- "start background ralph"

## Parameters

### Objective (required)
The task the loop should accomplish. Passed as the first positional argument.

### --completion (required)
Success criteria as a verifiable command. The loop exits when this command returns exit code 0.

**Good examples**:
- `--completion "npm test passes with 0 failures"`
- `--completion "npx tsc --noEmit exits with code 0"`
- `--completion "coverage report shows >80%"`

### --max-iterations (default: 10)
Maximum iterations before the loop halts and saves state for manual review.

### --timeout (default: 60 minutes)
Maximum wall-clock time. Loop checkpoints state before exiting so it can be resumed.

### --provider (default: claude)
AI provider to use for loop iterations. Supported: `claude`, `codex`, `factory`, `opencode`.

### --no-commit
Skip automatic git commits after each iteration.

### --branch (optional)
Create and work on a dedicated feature branch. The branch is created before iteration 1.

### --quiet
Suppress verbose progress output. Completion banner is always shown.

## Behavior

When triggered:

1. Validate that `--completion` criteria are specified and verifiable
2. Check for an existing `.aiwg/ralph-external/` workspace; create if absent
3. Generate a unique `loop-id` (8-character hex) and create the loop state file at `.aiwg/ralph-external/loops/<loop-id>.json`
4. Write the initial state: `{ objective, completionCriteria, maxIterations, timeout, provider, status: "pending", iteration: 0 }`
5. If `--branch` is specified, create the git branch now
6. Invoke `tools/ralph-external/run.sh` with all parsed flags, passing the loop-id
7. The external process owns execution from this point. Print the loop-id and attach info:

```
Al External Loop Started

Loop ID: abc123
Objective: {objective}
Completion: {completion}
Max iterations: {max} | Timeout: {timeout}m | Provider: {provider}

Loop is running externally. Follow progress:
  /ralph-attach --loop-id abc123

Check status:
  /ralph-status

State: .aiwg/ralph-external/loops/abc123.json
Log:   .aiwg/ralph-external/logs/abc123.log
```

8. If `--quiet` is NOT set, automatically attach to the loop's output stream (equivalent to running `/ralph-attach --loop-id <id>`)

## State Persistence and Crash Recovery

State is written to disk before each external process action. If the process crashes:

- The loop state file retains the last known iteration and learnings
- On restart, `tools/ralph-external/run.sh` detects the incomplete state and resumes from the last checkpoint
- Learnings from completed iterations are injected into the next iteration's prompt via the memory layer

**State file schema** (`.aiwg/ralph-external/loops/<id>.json`):
```json
{
  "loopId": "abc123",
  "objective": "Fix all auth tests",
  "completionCriteria": "npm test passes with 0 failures",
  "maxIterations": 10,
  "timeout": 60,
  "provider": "claude",
  "status": "running",
  "iteration": 3,
  "startedAt": "2026-04-01T10:30:00Z",
  "lastCheckpoint": "2026-04-01T10:38:42Z",
  "logFile": ".aiwg/ralph-external/logs/abc123.log",
  "branch": null,
  "learnings": ["auth mocks must be initialized before describe block"]
}
```

## CI/CD Integration

For use in pipelines, pass `--quiet` and read the exit code:
- `0` — loop completed successfully (completion criteria verified)
- `1` — loop failed (max iterations or timeout reached)
- `2` — configuration error (bad arguments)

**GitHub Actions example**:
```yaml
- name: Auto-fix tests
  run: |
    aiwg ralph-external "Fix all failing unit tests" \
      --completion "npm test passes" \
      --max-iterations 5 \
      --timeout 30 \
      --quiet
```

## Error Handling

**Missing --completion**:
```
Error: --completion is required for /ralph-external.

Provide a verifiable success criterion:
  /ralph-external "Fix tests" --completion "npm test passes"
```

**External process launch failure**:
```
Failed to launch external Al process.

Check:
1. tools/ralph-external/run.sh is executable
2. Node.js >= 18 is available
3. .aiwg/ directory is writable

Run with --verbose for diagnostics.
```

**Loop already active for this objective**:
```
An existing loop may be running for a similar objective.

Active loops:
  abc123 — Fix auth tests (running, iteration 3/10)

Options:
1. Attach to existing:  /ralph-attach --loop-id abc123
2. Start new anyway:    confirm and proceed
3. Abort existing:      /ralph-abort --loop-id abc123
```

## Examples

### Example 1: Fix failing tests
```
/ralph-external "Fix all failing tests in src/auth/" --completion "npm test -- --testPathPattern=auth passes"
```
**Response**: Starts external loop, prints loop ID, streams live output.

### Example 2: Long-running migration with branch
```
/ralph-external "Migrate src/ to ESM" --completion "npx tsc --noEmit exits with code 0" --max-iterations 20 --timeout 120 --branch feat/esm-migration
```
**Response**: Creates branch `feat/esm-migration`, starts loop, streams output.

### Example 3: CI/CD pipeline usage
```
aiwg ralph-external "Fix lint errors" --completion "npm run lint exits 0" --max-iterations 5 --quiet
echo "Exit: $?"
```
**Response**: Runs silently, exits 0 on success or 1 on failure.

### Example 4: Alternative provider
```
/ralph-external "Refactor payment module" --completion "npm test passes" --provider codex --max-iterations 8
```
**Response**: Runs iterations using OpenAI Codex instead of Claude.

## Related

- `ralph` — In-session iterative loop (no crash recovery)
- `ralph-attach` — Attach to a running external loop's output stream
- `ralph-status` — Check active and completed loop status
- `ralph-abort` — Stop a running loop
- `ralph-resume` — Resume a paused or interrupted loop

## References

- @$AIWG_ROOT/src/cli/handlers/ralph.ts — Al CLI handler
- @$AIWG_ROOT/src/cli/handlers/ralph-launcher.ts — External loop launcher
- @$AIWG_ROOT/tools/ralph-external/README.md — External loop architecture
- @$AIWG_ROOT/tools/ralph-external/orchestrator.mjs — Loop orchestration engine
- @$AIWG_ROOT/tools/ralph-external/state-manager.mjs — State persistence layer
- @$AIWG_ROOT/tools/ralph-external/session-launcher.mjs — AI session launcher
- @$AIWG_ROOT/agentic/code/addons/agent-loop/README.md — Al documentation
