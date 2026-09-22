---
description: Audit and triage issue backlogs without starting implementation work
category: project-management
argument-hint: "[--all-open] [--filter \"status:open label:bug\"] [--interactive] [--guidance \"text\"] [--provider gitea|github|local] [--dry-run] [--apply]"
allowed-tools: Read, Bash, Grep, Glob
model: claude-sonnet-5
---

# Issue Audit

Audit the configured issue tracker and produce a structured triage report. This command is read-only by default.

Use this command when the operator asks to audit open issues, triage the backlog, review stale issues, find duplicate issues, refresh epic hygiene, or rank the next issues for `address-issues`.

## Usage

```bash
/issue-audit
/issue-audit --all-open
/issue-audit --filter "status:open label:bug"
/issue-audit --interactive
/issue-audit --guidance "focus on stale deferred work and duplicate feature tracks"
/issue-audit --provider gitea
/issue-audit --dry-run
```

## Behavior

1. Resolve issue provider using the same conventions as `issue-list` and `address-issues`.
2. Fetch the selected issues.
3. Group findings into actionable categories:
   - high-priority blockers
   - stale/deferred cleanup candidates
   - duplicate or overlapping issues
   - parent epics with stale child state
   - issues likely already fixed or superseded
   - quality gaps such as missing acceptance criteria or labels
4. Produce recommended next actions.
5. Do not mutate the tracker unless `--apply` is explicitly requested.

## Interactive Mode

With `--interactive`, ask one focused decision question at a time. Examples:

- Close, keep with check date, or leave unchanged?
- Parent/child link, cross-link only, or leave separate?
- Refresh epic body now, file follow-up, or skip?
- Prioritize for `address-issues`, defer, or leave in backlog?

## Guidance

`--guidance` steers the audit lens. Preserve the guidance in the report.

## Related Skills

- `issue-list` — filtered issue listing
- `issue-comment` — post known comments
- `issue-close` — close known-resolved issues
- `address-issues` — implement issue fixes
- `issue-sync` / `issue-auto-sync` — reconcile commits and issue state

For full workflow instructions, see `agentic/code/frameworks/sdlc-complete/skills/issue-audit/SKILL.md`.
