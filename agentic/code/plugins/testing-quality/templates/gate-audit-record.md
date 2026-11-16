---
name: gate-audit-record
description: Audit an evaluation or delivery gate with criteria, evidence, outcomes, exceptions and approval.
outputKind: report.audit
aliases:
  - evaluation gate audit record
  - gate audit record
  - audit report
  - audit record
---

# Gate audit record

Fill every required section with observed facts. Write "Not applicable" with a
reason where needed; mark unknown or unrun items explicitly. Remove these
instructions and frontmatter from the final output.

## Identity and scope

<Gate/audit ID, criteria or protocol version/digest, audited revision, owner and date.>

## Criteria and evidence

| Criterion | Required condition | Observed evidence / exact check | Result | Limitation |
|---|---|---|---|---|
| <ID> | <threshold> | <artifact or command, counts and revision> | <pass/fail/unknown> | <gap> |

## Decision and rationale

<Pass, conditional, fail or incomplete; explain how criteria determine the outcome.
Unknown or unrun checks cannot count as passed.>

## Exceptions and approvals

<Exception, impact, approving authority, approval reference, expiry and conditions.
Record none when no exceptions exist.>

## Remediation and follow-up

<Failed/unknown criterion, action, owner and executable recheck.>

## Audit trail

<Source runs, review references, prior audit/superseding record and retained evidence.>
