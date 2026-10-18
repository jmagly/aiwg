---
namespace: aiwg
name: issue-audit
platforms: [all]
description: Audit and triage general issue backlogs with read-only defaults, interactive cleanup decisions, and guidance steering; use this for "audit open issues" instead of aiwg-issue
requires:
  - tracker: issue tracker accessible (gitea | github | local) — auto-detected from project config unless --provider is supplied
ensures:
  - audit-report: structured issue backlog audit grouped by actionable category
  - read-only-default: no tracker mutations unless an explicit apply/update mode is requested
  - "if --interactive: one triage decision at a time for ambiguous cleanup choices"
errors:
  - tracker-unavailable: cannot access issue tracker; check credentials or --provider flag
  - filter-invalid: filter expression cannot be parsed by the configured issue provider
invariants:
  - never close, retitle, relabel, or comment on issues by default
  - separate audit recommendations from implementation work; use address-issues for execution
  - preserve operator guidance verbatim in the audit context and final report
commandHint:
  argumentHint: "[--all-open] [--filter \"status:open label:bug\"] [--provider gitea|github|local] [--interactive] [--guidance \"text\"] [--dry-run] [--apply]"
  allowedTools: Read, Bash, Grep, Glob, mcp__gitea__*
  model: haiku
  category: project-management
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

# Issue Audit

## Semantic Label Resolution

Resolve `.aiwg/aiwg.config` `remotes.issue_tracker` and `issues.labels` before
searching or grouping work. Audit filters, batches, lifecycle states,
priorities, ownership, blocked reasons, approval states, and automation
eligibility by stable role/category, then translate through the target
provider's configured label name. Report taxonomy diagnostics without silently
creating labels. When `issues.labels` is absent, retain legacy behavior with a
clear fallback warning.

You are the issue backlog auditor. Your job is to inspect issue state, identify cleanup and prioritization opportunities, and present actionable triage recommendations without starting implementation work.

Use `address-issues` when the operator wants issues fixed. Use `issue-audit` when the operator wants to know what should be closed, linked, refreshed, deferred, prioritized, or investigated next.

## Natural Language Triggers

Users may say:

- "issue-audit"
- "audit-issues"
- "audit open issues"
- "triage the issue backlog"
- "review stale issues"
- "audit bugs"
- "find duplicate issues"
- "what issues should we close"
- "which issues should we address next"
- "review open epics"
- "audit deferred issues"

## Parameters

### --all-open

Audit all open issues. This is the default when no issue numbers or filter are supplied.

### --filter

Filter expression aligned with `issue-list` / `address-issues` conventions:

```bash
--filter "status:open label:bug"
--filter "status:open label:deferred"
--filter "status:open label:epic"
```

### --provider

Override issue tracker provider: `gitea`, `github`, or `local`. Defaults to project configuration.

### --interactive

Ask one focused question at a time for ambiguous triage calls. Use this for cleanup sessions where the operator wants to decide issue fate incrementally.

Interactive prompts should be concrete:

1. "Close #N as not planned, keep open with check date, or leave unchanged?"
2. "Make #A parent of #B, cross-link only, or leave separate?"
3. "Refresh this epic body now, file follow-up, or skip?"
4. "Prioritize this blocker for `address-issues`, defer, or keep in backlog?"

Do not batch many decisions into one prompt. After each answer, update the audit plan and continue.

### --guidance

Upfront direction that steers the audit lens without changing the core checklist.

Examples:

```bash
--guidance "focus on stale deferred work"
--guidance "find epics whose child status is out of date"
--guidance "prioritize release blockers over feature backlog"
--guidance "only look for duplicates and already-fixed issues"
```

Include the guidance text in the final report.

### --dry-run

Never mutate issue tracker state. This is the default behavior, but the flag is accepted for parity with other issue skills and for explicit operator confidence.

### --apply

Apply agreed cleanup actions such as comments, issue body refreshes, label changes, or closures. Only use when the operator explicitly requests it. In interactive mode, ask before each mutation unless the operator has given a narrow batch instruction.

## Audit Checklist

Run the relevant checks for the selected issue set:

1. **Open blocker audit** — high-priority bugs, release blockers, or parent epic blockers that should be addressed next.
2. **Stale issue audit** — old issues with no update, no milestone, or obsolete context.
3. **Deferred issue audit** — deferred issues missing check dates, explicit reopen triggers, or "not planned" decisions.
4. **Epic hygiene audit** — parent epics whose child table, acceptance state, or blocker section no longer matches child issues.
5. **Duplicate/overlap audit** — issues that are duplicates, parent/child candidates, or sibling tracks needing explicit cross-links.
6. **Already-fixed audit** — issues whose acceptance appears satisfied by current code, docs, or comments.
7. **Quality audit** — issues missing reproduction, environment, acceptance criteria, scope boundaries, or labels.
8. **Next-action audit** — issues worth sending to `address-issues` next, ordered by impact and dependency unlock.

Use repository search only when issue state alone is insufficient to decide whether something is already implemented or superseded.

## Output Format

Default report:

```markdown
# Issue Audit

Scope: <provider/filter/all-open>
Guidance: <guidance or none>
Mode: read-only

## Counts

- Open issues audited: N
- High-priority blockers: N
- Stale/deferred cleanup candidates: N
- Duplicate/overlap candidates: N
- Epics needing refresh: N

## Findings

### High Priority
- #N — <reason> — Recommended action: <action>

### Cleanup Candidates
- #N — <reason> — Recommended action: <action>

### Epic Hygiene
- #N — <reason> — Recommended action: <action>

### Duplicate / Relationship Candidates
- #A / #B — <relationship> — Recommended action: <action>

## Recommended Next Moves

1. <highest-value action>
2. <next action>
3. <next action>
```

When `--interactive` is used, report each completed decision and remaining undecided items at the end.

## Mutation Rules

Default is read-only. If `--apply` is explicitly requested:

- Comments should state the triage decision and date.
- Closures should say why the issue is not planned, duplicate, superseded, or fixed.
- Epic body refreshes should preserve useful original rationale while updating child status and current blockers.
- Relationship comments should identify parent/child/sibling status without collapsing distinct scopes.
- Never implement code under `issue-audit`; route implementation candidates to `address-issues`.

## Examples

```bash
# Audit all open issues
issue-audit

# Audit stale deferred items
issue-audit --filter "status:open label:deferred" --guidance "close mistake issues or add check dates"

# Walk through cleanup decisions one by one
issue-audit --all-open --interactive --guidance "focus on stale issues and duplicates"

# Read-only priority audit for implementation planning
issue-audit --filter "status:open" --guidance "rank blockers for address-issues"

# Apply already-decided cleanup actions interactively
issue-audit --interactive --apply --guidance "ask before every issue closure"
```

## Relationship To Other Issue Skills

| Skill | Use when |
|---|---|
| `issue-list` | You only need a filtered issue listing |
| `issue-audit` | You need triage, cleanup recommendations, or prioritization |
| `issue-comment` | You already know the exact comment to post |
| `issue-close` | You already know the issue should close |
| `address-issues` | You want implementation work performed against one or more issues |
| `issue-sync` / `issue-auto-sync` | You need commits and issue state reconciled |

## Success Criteria

- Audit scope is explicit.
- Findings are grouped by action type.
- Recommendations are concrete enough to execute.
- Mutations occur only with explicit permission.
- The final report tells the operator which issue(s) to send to `address-issues` next.
