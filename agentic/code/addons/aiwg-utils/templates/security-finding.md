---
name: security-finding
description: Record a security finding with affected scope, reproduction, impact, remediation and verification.
outputKind: report.security
aliases:
  - security finding report
  - security finding
  - security report
---

# Security finding

Fill every required section with observed facts. Write "Not applicable" with a
reason where needed; mark unknown or unrun items explicitly. Remove these
instructions and frontmatter from the final output.

## Summary and handling

<Finding ID, title, severity with rationale, status, owner and approved audience.
Follow the project's private disclosure policy for sensitive findings.>

## Affected scope

<Component, versions/revisions, environment, trust boundary and prerequisites.>

## Evidence and reproduction

<Sanitized observations, source locations, exact reproduction steps and expected
versus observed behavior. Keep secrets and private exploit material out of public output.>

## Impact and confidence

<Reachability, affected data or capabilities, likelihood, confidence and unknowns.>

## Remediation

<Proposed fix, mitigations, accountable owner and residual risk.>

## Verification

<Regression test, exact checks and results, verified revision and retest status.>

## References and follow-up

<Restricted evidence references, related cases, disclosure decisions and next actions.>
