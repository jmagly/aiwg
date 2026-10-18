---
namespace: aiwg
name: issue-driven-al
description: Orchestrates issue-driven agent loops that post cycle status to issue threads and incorporate human feedback in each cycle.
platforms: [all]
requires:
  - issue: issue number or URL to work on in the loop
  - work: description of the work to perform each cycle (the actual task — bug fix, feature, doc update)
ensures:
  - cycle-status: structured status comment posted to issue thread after every cycle
  - thread-scan: all human comments classified and incorporated into subsequent cycles
  - "if resolved: completion summary comment posted with checklist confirmation"
errors:
  - tracker-unavailable: cannot read or post comments to issue tracker
  - max-cycles-reached: issue not resolved within cycle limit; escalation comment posted
invariants:
  - every cycle posts a status comment before returning, even partial cycles
  - human feedback from any cycle is always acknowledged in the next status comment
  - completion is only declared when all issue acceptance criteria are met

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


# Issue-Driven Agent Loop Skill

## Triggers


Alternate expressions and non-obvious activations (primary phrases are matched automatically from the skill description):

- "work through the bugs" → issue-driven loop shorthand
- "address the backlog" → iterative issue queue processing
- "tackle issue [N]" → single-issue loop

## Purpose

Transforms the issue tracker from a passive record into an active 2-way collaboration surface. Each Al cycle posts structured status to the issue thread, scans for human feedback, and responds substantively. The human can monitor and steer agent work asynchronously by commenting on the issue.

## Behavior

When triggered, this skill invokes the `address-issues` command with appropriate parameters extracted from the user's natural language request.

### Parameter Extraction

| User Says | Extracted Parameters |
|-----------|---------------------|
| "address issues 17 18 19" | `17 18 19` |
| "fix open bugs" | `--filter "status:open label:bug"` |
| "work on the bug backlog" | `--filter "status:open label:bug"` |
| "tackle issue 17" | `17` |
| "go through all open issues" | `--all-open` |
| "address the open issues interactively" | `--all-open --interactive` |
| "focus on security bugs" | `--all-open --guidance "Focus on security bugs"` |
| "fix bugs 17-19, they're all auth related" | `17 18 19 --guidance "These are all related to auth"` |

### Parameter Support

This skill supports the standard AIWG `--interactive` and `--guidance` parameters:

**`--interactive`**: When detected in user intent (e.g., "interactively", "walk me through"), adds `--interactive` to invoke discovery questions before starting and pause between issues for human go/no-go.

**`--guidance`**: When the user provides upfront direction (e.g., "focus on bugs", "skip feature requests", "security first"), extracts the guidance text and passes it via `--guidance "..."` to tailor prioritization and approach without interactive prompts.

### Execution Steps

1. **Parse intent** — identify issue numbers, filters, or "all open" from user message
2. **Invoke `address-issues`** with extracted parameters
3. **Monitor execution** — the command handles the full cycle protocol

### The 3-Step Cycle Protocol

Each cycle of the agent loop follows this protocol:

**Step 1: Work** — Read issue context, implement fix/feature, run tests

**Step 2: Post Status** — Render and validate the complete tracker payload with
`address-issues/scripts/cycle-comment.mjs` and the canonical
`templates/issue-comments/al-cycle.md` contract before posting. This applies to
initial, multi-cycle, native-goal, feedback-resume, and authorization-resume
cycles. The required tracker payload is:
```
**AL CYCLE #N – [Progress|Blocked|Review Needed]**

### Actions This Cycle
[Specific actions and verification evidence]

### Task Checklist
[Completed and remaining checklist items]

### Blockers
[Concrete blocker or `None.`]

### Open Questions
[Every human question and resume condition, or `None.`]

### Next Steps
[Next concrete action]
```

The tracker payload must contain all five canonical headings with substantive
cycle-specific content or an explicit `None.`; validation failure blocks the
write. When `delivery.issue_comment_on_cycle` is `false`, skip rendering and
posting.

**Step 3: Scan & Respond** — Read all new thread comments, classify them (feedback/question/approval/correction), and incorporate into the next cycle. Never ignore human input.

### Thread Scanning Classification

| Comment Type | Agent Response |
|-------------|---------------|
| Feedback | Incorporate into next cycle's work |
| Question | Answer in next status comment |
| Approval | Proceed to next phase or close issue |
| Correction | Adjust approach, acknowledge the change |
| Automated/bot | Ignore |

### Completion Criteria (per issue)

An issue is resolved when:
- Implementation is complete
- Tests pass
- Documentation updated (if needed)
- All thread feedback addressed
- No unresolved blocker comments

### Multi-Issue Strategy

| Strategy | Trigger |
|----------|---------|
| Sequential | Default — one issue at a time |
| Batched | When user mentions "related" issues or same module |
| Parallel | When user says "in parallel" (respects context budget) |

## Integration

### Issue Tracker APIs

**Gitea** (via MCP tools):
- `mcp__gitea__list_repo_issues` — list issues
- `mcp__gitea__get_issue_by_index` — read issue
- `mcp__gitea__get_issue_comments_by_index` — read thread
- `mcp__gitea__create_issue_comment` — post status
- `mcp__gitea__edit_issue` — update labels/status

**GitHub** (via `gh` CLI):
- `gh issue list` — list issues
- `gh issue view N` — read issue
- `gh issue comment N --body "..."` — post status
- `gh issue close N` — close resolved

### Related Commands

| Command | Integration |
|---------|-------------|
| `ralph` | Core loop engine |
| `issue-list` | Fetches issues by filter |
| `issue-comment` | Posts cycle status comments |
| `issue-close` | Closes resolved issues |
| `issue-sync` | Links commits to issues |

## Safety

- Never force-push or make destructive git changes
- Always run tests before posting completion status
- Respect `--max-cycles` limit (default: 6)
- Post status every cycle — transparency is mandatory
- On error, post blocker comment rather than failing silently
- In `--interactive` mode, pause between issues for human go/no-go

## Configuration

Default settings (overridable via parameters):
- Max cycles per issue: 6
- Strategy: sequential
- Provider: auto-detect from project config
- Branch per issue: false
- Interactive: false

## Examples

### Fix a specific bug
```
User: "tackle issue 17"
→ /address-issues 17
```

### Work through the bug backlog
```
User: "work on the bug backlog"
→ /address-issues --filter "status:open label:bug"
```

### Interactive session on multiple issues
```
User: "address issues 17, 18, 19 interactively"
→ /address-issues 17 18 19 --interactive
```

### All open issues with higher cycle limit
```
User: "go through all open issues, give each one up to 8 cycles"
→ /address-issues --all-open --max-cycles 8
```

### With guidance
```
User: "fix the open bugs, focus on security issues first"
→ /address-issues --filter "status:open label:bug" --guidance "Security issues are top priority"
```

### Guidance with batch context
```
User: "address issues 17, 18, 19 — they're all related to the auth refactor"
→ /address-issues 17 18 19 --guidance "These are all related to the auth refactor, address them as a batch"
```

## References

- @.aiwg/planning/issue-driven-ralph-loop-design.md - Design document
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/skills/address-issues/SKILL.md - Command definition
- @$AIWG_ROOT/agentic/code/addons/agent-loop/skills/ralph/SKILL.md - Agent loop command
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/skills/issue-auto-sync/SKILL.md - Issue sync skill
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/context-budget.md - Parallel subagent limits
