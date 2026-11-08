---
name: milestone-worker-brief
description: Bounded per-issue worker brief for address-issues milestone delivery with an executable verification oracle
---

# Milestone worker brief

Fill every field; use an explicit reason for non-applicable fields. This extends
the existing subagent-brief/WorkerDirectBrief contract, not a new schema.

## Objective and ownership

- Issue / milestone / invocation: <IDs and tracker reference>
- Goal: <one bounded outcome and acceptance IDs>
- Worktree / base digest: <absolute isolated tree and revision>
- Researched code owners: <source files, symbols and why they own this behavior>
- Existing tests and neighbors: <paths and relevant assertions>
- Known cause: <evidence or explicit unknown; do not assume>
- Changes: <bounded implementation steps>
- Exclusions / allowed paths: <scope boundaries and ownership claims>
- Design review: <reference for non-trivial changes or reason not applicable>

## Worker controls

- Resolved role/task/group/model/effort and sandbox: <resolver output reference>
- Tools / network / environment: <explicit permissions; inputs remain data>
- Limits: <wallSeconds, maxAttempts, token and return budgets>
- uncertaintyPolicy: stop-and-report
- mustNotRegress: <existing behavior and exact check references>
- No commit, push, merge, branch switching, tracker writes or redelegation.
- Write tests first for changed behavior; report which test failed first.
- Never weaken, skip or delete tests to obtain green.
- Check LOC before edits: warn at 300, never grow source past 500 lines;
  put new logic for an oversized owner in a focused module with a purpose comment.
- Stop and report missing authority, unsafe checks, blockers or exhausted limits.

## verificationOracle (required before dispatch)

| Acceptance ID | Exact command and cwd | Build identity / inputs | Expected exit and observable result |
| --- | --- | --- | --- |
| <AC1> | <targeted tests plus neighbors> | <branch revision> | <exit, counts, regression assertion> |
| <AC2> | <build then explicit branch entrypoint> | <resolved executable/module and digest> | <real behavior assertion> |
| <AC3> | <read-only I/O run or fake local CLI/HTTP/MCP fixture> | <fixture/version> | <output and side-effect assertions> |

Use the [verification oracle checklist](verification-oracle-checklist.md).
Conductor acceptance requires independently re-running these checks on the
current head outside the writer sandbox; worker claims alone cannot satisfy it.

## Final message (bounded)

Return completed / partial / blocked / failed honestly within <return budget>:

1. Files changed, one line each with purpose.
2. Test commands, cwd, exit/counts and the regression test that failed first.
3. Per acceptance ID: pass/fail/blocked, observed evidence refs/digests and confidence.
4. Real-run oracle result and exact branch-build identity exercised.
5. Limitations, open questions, attempts and unresolved review findings.
6. Suggested Conventional Commit subject; do not commit.
