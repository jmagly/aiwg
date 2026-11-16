---
name: ci-failure-report
description: Diagnose CI failures and flaky tests with failing runs, root cause and regression verification.
outputKind: report.ci-failure
aliases:
  - flaky test or CI failure report
  - CI failure report
  - flaky test report
---

# CI failure / flaky-test report

Fill every required section with observed facts. Write "Not applicable" with a
reason where needed; mark unknown or unrun items explicitly. Remove these
instructions and frontmatter from the final output.

## Summary and scope

<Failure, affected job/test, impact, owner, revision and environment/runner versions.>

## Failing runs

| Run / attempt | Revision | Exact command | Result | Sanitized log or artifact |
|---|---|---|---|---|
| <run ID/link> | <SHA> | <command> | <exit status and failed cases> | <evidence> |

For suspected flakes include passing attempts, failures/total attempts, and the
conditions that differ. Preserve the original failure before retrying.

## Reproduction and root cause

<Minimal reproduction, expected/observed behavior, causal evidence and confidence.
Mark the cause unknown when evidence is insufficient; distinguish infrastructure
or startup failures from test assertion failures.>

## Fix or mitigation

<Change, why it addresses the cause, temporary workarounds and residual risks.>

## Regression test and verification

<Regression case/path, how it fails before and passes after the fix, exact rerun
commands, pass/fail counts, revision and remaining unrun checks.>

## Follow-up

<Owner, next action, closure criteria and related issue or PR.>
