---
name: ci-assessment-report-template
description: Inventory workflows, runners, secret references, flakes and delivery cost against pipeline rules.
outputKind: ci-assessment-report
aliases:
  - CI assessment report
  - ci pipeline assessment
---

# CI assessment report

## Assessment context

Fill author, date, intake reference/revision, repositories, sample interval,
collection method and exclusions. Distinguish measured, estimated and unavailable
data; assign a collection owner/date for each unknown.

## Workflow and runner inventory

Add one row per workflow; link provider settings where configuration is not in Git.
Record dependency graphs, privileged boundaries, caches and runner image pins.

| Repo / workflow / revision | Triggers / stages | Runner labels / image / capacity | Permissions / isolation / cache | Owner |
|---|---|---|---|---|
| [reference] | [events and graph reference] | [hosted/self-hosted, pinned image, resources] | [settings reference] | [owner] |

## Secret usage inventory (references only)

Map every consumer to its logical secret name and inventory/store reference.
Assess scope, exposure to untrusted jobs, rotation and logging without retrieving
values. Record missing bindings as gaps with owners.

| Workflow / job / environment | Secret name / reference | Scope / rotation owner | Exposure gap / evidence |
|---|---|---|---|
| [consumer] | [logical name, reference] | [policy, owner] | [redacted configuration link or none] |

## Reliability, duration and cost baseline

Fill counts and denominators for the stated interval, including failed attempts.
Define flake classification and preserve first failures; later success never erases
failure history. Record p50/p95 duration, queue time, runner minutes, unit rate,
currency and cost allocation assumptions; use unavailable + collection plan as needed.

| Metric | Sample / source | Baseline | Target / review date | Owner |
|---|---|---|---|---|
| [failure rate, flakes, duration, queue, cost] | [N runs, interval, dashboard/export ref] | [value + unit] | [numeric threshold + date] | [owner] |

## Flake history and causal work

Add one row per recurring failure signature, with seed/runner/dependency context,
root-cause status and regression-test link. Never recommend re-running to green;
open causal repair work when a flake lacks a reproducer or regression coverage.

| Signature / first failed run | Frequency / impact | Reproduction context | Cause / regression evidence | Action / owner / due |
|---|---|---|---|---|
| [redacted link] | [failures / attempts, blocked releases] | [seed, timing, environment] | [known/unknown, test link] | [work item, owner, date] |

## Gaps against existing rules

Assess each named rule below; link the rule and specific configuration/run evidence
rather than copying its text. For every gap give severity, remediation, owner,
due date and blocking/nonblocking disposition.

| Rule | Pass / gap / unknown | Evidence reference | Severity / remediation / owner / due |
|---|---|---|---|
| dev-pipeline-safety | [status] | [evidence] | [action or none] |
| dev-secret-hygiene | [status] | [evidence] | [action or none] |
| dev-idempotent-builds | [status] | [evidence] | [action or none] |
| dev-ci-self-contained | [status] | [evidence] | [action or none] |
| ci-action-pinning | [status] | [evidence] | [action or none] |

## Recommendation and gate decision

Prioritize design work by measured impact and risk. Link the current spec and
rendered/provider drift findings. Record delivery/repository/environment reviewer,
date, revision, decision and owned conditions using the
[assess gate](../flows/gate-criteria-by-phase.md#assess-gate).
