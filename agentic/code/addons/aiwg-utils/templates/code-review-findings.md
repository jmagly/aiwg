---
name: code-review-findings
description: Provider-neutral code review findings with severity, source locations, verification and disposition.
outputKind: report.review
aliases:
  - code review findings report
  - code review findings
  - review report
---

# Code review findings

Fill every required section with observed facts. Write "Not applicable" with a
reason where needed; mark unknown or unrun items explicitly. Remove these
instructions and frontmatter from the final output.

## Scope

<Repository, base and head revisions, reviewed paths and review criteria.>

## Findings

| ID | Severity | Location | Observed problem and impact | Evidence | Recommended action |
|---|---|---|---|---|---|
| <ID> | <severity> | <path:line> | <trigger and behavior> | <check or source> | <fix> |

If no findings were observed, state that explicitly and describe the reviewed scope.
Separate confirmed defects from open questions.

## Verification

<Exact commands and pass/fail counts; distinguish executed checks from inspection.>

## Disposition and follow-up

<Finding owner, open/resolved/deferred status, rationale and retest references.>

## Limitations

<Unreviewed paths, unrun checks, assumptions and remaining risks.>
