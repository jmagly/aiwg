---
namespace: aiwg
name: ralph-resume
platforms: [all]
description: Resume an interrupted agent loop from last checkpoint
commandHint:
  argumentHint: '[--max-iterations N] [--timeout M --interactive --guidance "text"]'
  allowedTools: "Task, Read, Write, Bash, Glob, Grep, TodoWrite, Edit"
  model: haiku
  category: automation
  orchestration: true
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
> aiwg show skill <name>
> ```
>
> Only kernel-listed skills (`aiwg-doctor`, `aiwg-refresh`, `aiwg-status`, `aiwg-help`, `use`, `steward`) are directly invokable as slash commands. See [skill-discovery rule](https://github.com/jmagly/aiwg/blob/main/agentic/code/addons/aiwg-utils/rules/skill-discovery.md).


# Al Resume

Resume a paused or interrupted agent loop.

## Usage

```
/ralph-resume                       # Resume with existing settings
/ralph-resume --max-iterations 20   # Resume with higher iteration limit
/ralph-resume --timeout 120         # Resume with longer timeout
```

## Parameters

### --max-iterations N
Override the maximum iterations limit. Useful when loop stopped at limit but was making progress.

### --timeout M
Override the timeout in minutes. Useful when loop timed out but task is close to completion.

## Your Actions

### Step 1: Load State

1. Read `.aiwg/ralph/current-loop.json`
2. Verify loop can be resumed (status != 'success', status != 'aborted')
3. Load iteration history and learnings

**If no resumable loop**:
```
No agent loop to resume.

Status: {status}

{If success}: Loop completed successfully. Start a new loop with /ralph
{If aborted}: Loop was aborted. Start fresh with /ralph
{If no state}: No loop found. Start with /ralph "task" --completion "criteria"
```

### Step 2: Update Settings

Apply any parameter overrides:
- Update `maxIterations` if --max-iterations provided
- Update `timeoutMinutes` if --timeout provided
- Reset timeout start time for extended timeout

### Step 3: Resume Execution

Continue the agent loop pattern:

1. Display resume status:
```
Resuming Agent Loop

Task: {task}
Completion: {completion}
Previous iterations: {N}
Remaining iterations: {max - N}

Last result: {lastResult}
Learnings so far: {learnings}

Continuing from iteration {N+1}...
```

2. Execute next iteration with accumulated learnings
3. Follow standard agent loop verification
4. Continue until success or new limits reached

### Step 4: Handle Completion

Same as `ralph` - generate completion report on success or limit.

## Resume Context

When resuming, include in the task context:

```
## Agent Loop Resume Context

**Original Task**: {task}
**Completion Criteria**: {completion}

**Previous Iterations**: {N}
**Accumulated Learnings**:
{for each iteration}
- Iteration {i}: {action} -> {result}. Learned: {learnings}
{end for}

**Current State**:
- Last attempt: {lastResult}
- Key insight: {most recent learning}

**Your Goal**:
Continue iterating from iteration {N+1}.
Apply learnings from previous iterations.
Verify against completion criteria after each attempt.
```

## Error Handling

**Loop completed successfully**:
```
This agent loop already completed successfully.

Final status: SUCCESS
Iterations: {N}
Report: .aiwg/ralph/completion-{timestamp}.md

To run again, start a new loop:
  /ralph "task" --completion "criteria"
```

**Loop was aborted**:
```
This agent loop was aborted and cannot be resumed.

To start fresh with the same task:
  /ralph "{original task}" --completion "{original completion}"
```

**State corrupted**:
```
Agent loop state is corrupted or incomplete.

Options:
1. Start fresh: /ralph "task" --completion "criteria"
2. Clean up: rm -rf .aiwg/ralph/ then start new loop
```

## Example Scenarios

### Max Iterations Override

Previous loop stopped at iteration 10:
```
/ralph-resume --max-iterations 20
```
Continues with 10 more iterations available.

### Timeout Override

Previous loop timed out at 60 minutes:
```
/ralph-resume --timeout 120
```
Continues with fresh 120-minute timeout.

### Simple Resume

Loop interrupted (network, restart, etc.):
```
/ralph-resume
```
Continues from last checkpoint with original settings.

## Related

- `ralph-status` - Check what state the loop is in
- `ralph-abort` - Stop instead of resume
- `ralph` - Start new loop

## References

- @$AIWG_ROOT/${CLAUDE_PLUGIN_ROOT}/README.md — Ralph addon overview and loop executor documentation
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/vague-discretion.md — Loop termination and iteration limit rules
- @$AIWG_ROOT/docs/cli-reference.md — CLI reference for ralph-resume and related commands
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/instruction-comprehension.md — Re-reading original task instructions on resume
