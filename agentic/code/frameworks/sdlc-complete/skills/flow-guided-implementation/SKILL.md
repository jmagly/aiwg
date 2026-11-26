---
namespace: aiwg
name: flow-guided-implementation
platforms: [all]
description: Orchestrate autonomous issue-to-code implementation using existing tools and agents with bounded iteration
---

> **Declarative Flow (#1539):** This flow's orchestration is now also expressed as a
> declarative YAML Flow at `flows/flow-guided-implementation.playbook.yaml` (source of truth for the step
> sequence + gates). This SKILL.md remains the discoverable trigger surface and prose
> reference. See epic #1534.

# /flow-guided-implementation

Orchestrate autonomous issue-to-code implementation using existing tools and agents with bounded iteration.

## Delegation

Follow [Worker delegation](references/delegation.md) before every worker launch.

## Usage

```
/flow-guided-implementation [issue-description]
/flow-guided-implementation --issue <url>
/flow-guided-implementation --max-retries 5
```

## Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `[issue-description]` | - | Natural language description of what to implement |
| `--issue <url>` | - | GitHub/Gitea issue URL to fetch |
| `--max-retries` | 3 | Maximum iterations per task before escalating |
| `--skip-review` | false | Skip code review (faster, less safe) |
| `--dry-run` | false | Plan only, don't execute changes |

## Design Principles

From issue requirements:
1. **Run to completion** - Minimal user interaction during execution
2. **Complement existing tools** - Use Grep, Glob, Edit, TodoWrite, Task
3. **Bounded iteration** - Auto-retry up to N times, then escalate
4. **Autonomous decision-making** - Don't ask unless truly blocked

## Workflow

```
┌─────────────────────────────────────────────────────────────────┐
│ PHASE 1: ANALYSIS                                               │
│ Tools: Read, Grep, Glob                                         │
├─────────────────────────────────────────────────────────────────┤
│ 1. Parse issue/requirement                                      │
│ 2. Extract keywords and intent                                  │
│ 3. Search codebase for relevant files:                          │
│    - Grep for keywords in file contents                         │
│    - Glob for naming patterns                                   │
│ 4. Read top candidate files for context                         │
│ 5. Rank files by relevance (keyword density + path match)       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              v
┌─────────────────────────────────────────────────────────────────┐
│ PHASE 2: TASK DECOMPOSITION                                     │
│ Tool: TodoWrite                                                 │
├─────────────────────────────────────────────────────────────────┤
│ 1. Create task per file to modify                               │
│ 2. Include task dependencies (e.g., types before implementation)│
│ 3. Order by dependency graph                                    │
│ 4. Estimate complexity per task                                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              v
┌─────────────────────────────────────────────────────────────────┐
│ PHASE 3: ITERATIVE CODING                                       │
│ Tools: Edit, Bash, Task(agents)                                 │
│ Skill: iteration-control                                        │
├─────────────────────────────────────────────────────────────────┤
│ FOR EACH task (respecting dependencies):                        │
│   iteration = 0                                                 │
│                                                                 │
│   LOOP while iteration < max_retries:                           │
│     ┌─────────────────────────────────────────────────────────┐ │
│     │ STEP 1: LOCATE                                          │ │
│     │ - Grep for specific patterns in target file             │ │
│     │ - Read surrounding context                              │ │
│     │ - Identify line ranges for modification                 │ │
│     └─────────────────────────────────────────────────────────┘ │
│                         │                                       │
│                         v                                       │
│     ┌─────────────────────────────────────────────────────────┐ │
│     │ STEP 2: GENERATE                                        │ │
│     │ Simple change: Edit tool directly                       │ │
│     │ Complex change: Task(software-implementer)              │ │
│     └─────────────────────────────────────────────────────────┘ │
│                         │                                       │
│                         v                                       │
│     ┌─────────────────────────────────────────────────────────┐ │
│     │ STEP 3: VALIDATE                                        │ │
│     │ - Bash: Run tests (npm test, pytest, etc.)              │ │
│     │ - If tests fail: Task(debugger) for diagnosis           │ │
│     │ - If tests pass && !skip_review: Task(code-reviewer)    │ │
│     └─────────────────────────────────────────────────────────┘ │
│                         │                                       │
│                         v                                       │
│     ┌─────────────────────────────────────────────────────────┐ │
│     │ STEP 4: DECIDE (iteration-control skill)                │ │
│     │                                                         │ │
│     │ IF pass + approved: mark task complete, BREAK           │ │
│     │ IF fail + iteration < max: retry with feedback          │ │
│     │ IF fail + iteration >= max: ESCALATE to user            │ │
│     └─────────────────────────────────────────────────────────┘ │
│                                                                 │
│   Mark task complete in TodoWrite                               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              v
┌─────────────────────────────────────────────────────────────────┐
│ PHASE 4: INTEGRATION                                            │
│ Tools: Bash (git)                                               │
├─────────────────────────────────────────────────────────────────┤
│ 1. Verify all tasks complete                                    │
│ 2. Run full test suite                                          │
│ 3. Stage changes: git add                                       │
│ 4. Generate commit message from tasks                           │
│ 5. Commit (or prompt user for /commit-and-push)                 │
└─────────────────────────────────────────────────────────────────┘
```

## Agents Used

| Agent | When | Purpose |
|-------|------|---------|
| `software-implementer` | Complex code generation | TDD cycle, multi-file changes |
| `code-reviewer` | After code passes tests | Quality, security, style review |
| `debugger` | When tests fail | Root cause analysis |
| `test-engineer` | If tests need creation | Generate test coverage |

## Example Session

```
User: /flow-guided-implementation Add refresh token support to authentication

Claude: Starting guided implementation...

## Phase 1: Analysis
Searching for authentication-related files...
- Found: src/auth/authService.ts (high relevance)
- Found: src/auth/tokenService.ts (high relevance)
- Found: src/types/auth.ts (medium relevance)
- Found: src/routes/auth.ts (medium relevance)

## Phase 2: Task Decomposition
Creating tasks:
[1/4] [ ] Add RefreshToken type to src/types/auth.ts
[2/4] [ ] Add refresh config to src/config/auth.ts
[3/4] [ ] Implement refresh in src/auth/tokenService.ts (depends: 1,2)
[4/4] [ ] Add /refresh endpoint to src/routes/auth.ts (depends: 3)

## Phase 3: Iterative Coding

### Task 1: Add RefreshToken type
Locating insertion point... line 15
Generating type definition...
Running tests... PASS
[1/4] [✓] Add RefreshToken type

### Task 2: Add refresh config
Locating config section... line 8
Adding refreshTokenExpiry config...
Running tests... PASS
[2/4] [✓] Add refresh config

### Task 3: Implement refresh in tokenService
Locating token generation... lines 20-35
Generating refresh token logic...
Running tests... FAIL
  - refreshToken is undefined
Iteration 1/3: Retrying with feedback...
  Fixed: Added refreshToken to return object
Running tests... PASS
Code review... APPROVED
[3/4] [✓] Implement refresh in tokenService

### Task 4: Add /refresh endpoint
Locating routes... line 45
Adding POST /refresh handler...
Running tests... PASS
Code review... APPROVED
[4/4] [✓] Add /refresh endpoint

## Phase 4: Integration
All tasks complete. Running full test suite... PASS
Changes ready to commit.

Generated commit message:
  feat(auth): add refresh token support

  - Add RefreshToken type
  - Configure refresh token expiry
  - Implement token refresh in tokenService
  - Add POST /refresh endpoint

Run /commit-and-push to commit, or review changes with `git diff`.
```

## Escalation Example

```
### Task 3: Implement refresh (iteration 3/3)
Running tests... FAIL
  - userId format mismatch

ESCALATION: Max iterations reached

After 3 attempts, the test still fails:
- Iter 1: refreshToken undefined
- Iter 2: refreshToken missing userId
- Iter 3: userId format mismatch (string vs number)

The implementation uses: { userId: "123" } (string)
The test expects: { userId: 123 } (number)

Which format should be used?
1. String - I'll update the test
2. Number - I'll update the implementation
```

## Progress Tracking

Progress tracked via TodoWrite. Check status anytime:

```
User: What's the implementation status?

Claude:
[1/4] [✓] Add RefreshToken type (1 iteration)
[2/4] [✓] Add refresh config (1 iteration)
[3/4] [..] Implement refresh in tokenService (iteration 2/3)
[4/4] [ ] Add /refresh endpoint (pending)

Current: Task 3, waiting for test fix
```

## Traceability

- @research @.aiwg/research/REF-004-magis-multi-agent-issue-resolution.md
- @skill @$AIWG_ROOT/agentic/code/addons/guided-implementation/skills/iteration-control/SKILL.md

## References

- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/agents/software-implementer.md
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/agents/code-reviewer.md
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/agents/debugger.md
