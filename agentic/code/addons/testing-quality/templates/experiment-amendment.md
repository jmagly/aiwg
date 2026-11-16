---
name: experiment-amendment
description: Amend an experiment or evaluation protocol while preserving baselines, validity and approvals.
outputKind: experiment.amendment
aliases:
  - experiment protocol amendment
  - experiment amendment
  - protocol amendment
---

# Experiment / protocol amendment

Fill every required section with observed facts. Write "Not applicable" with a
reason where needed; mark unknown or unrun items explicitly. Remove these
instructions and frontmatter from the final output.

## Identity and baseline

<Amendment ID, protocol path/version/digest, experiment ID, owner and date.>

## Reason and evidence

<Observed issue, supporting runs, affected hypothesis and why amendment is needed.>

## Proposed change

| Protocol section | Previous rule | Amended rule | Rationale |
|---|---|---|---|
| <section> | <before> | <after> | <reason> |

## Validity and comparability

<Effect on sampling, metrics, thresholds, controls and prior results. Identify
invalidated runs and required reruns. Preserve original results; do not silently
move acceptance thresholds after observing outcomes. Keep holdout data private.>

## Approval and effective scope

<Reviewer, decision, approval reference, effective version and affected future runs.
An unapproved proposal does not authorize execution.>

## Verification and rollback

<Checks proving the amended protocol is implemented, rerun plan, rollback trigger
and restoration steps. Record actual results separately from planned checks.>
