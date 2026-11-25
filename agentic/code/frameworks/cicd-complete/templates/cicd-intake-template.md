---
name: cicd-intake-template
description: Capture repository delivery needs, existing CI and progressive-delivery constraints by reference.
outputKind: cicd-intake
aliases:
  - CI/CD intake
  - cicd delivery intake
---

# CI/CD intake

## Scope and ownership

Fill project, date, delivery owner, reviewers, reason for change, in/out-of-scope
services and links to existing SDLC intake. Identify which decisions need approval.

## Repositories and current CI

Add one row per repository; use explicit none/unknown with a collection owner
instead of leaving blanks. Link configuration and run metadata, never credentials.

| Repository / owner | Forge / CI provider | Workflow paths / triggers | Current problems / run-history reference |
|---|---|---|---|
| [URL, revision, owner] | [forge and provider/version] | [paths and events, or none] | [problem and redacted evidence] |

## Deploy targets and environments

List each environment and deployment destination, dependencies, protection,
runner needs and responsible operator. Link existing environment definitions.

| Environment | Target / region | Runner / network needs | Protection / operator | Definition reference |
|---|---|---|---|---|
| [name] | [platform, service] | [labels, capacity, connectivity] | [reviewers, branches, owner] | [path/revision] |

## Secrets inventory (references only)

Record logical names, approved secret-store references, consumers, access/rotation
owners and trust boundaries. Never insert values, exports, tokens or secret logs.

| Name | Store reference | Consuming job / environment | Access scope / rotation owner |
|---|---|---|---|
| [logical name] | [store URI or inventory record] | [job, environment] | [scope, owner, policy reference] |

## Release cadence and progressive delivery

Fill release frequency/window, approval authority, artifact registry/retention,
rollback objective and dependent-team coordination. Describe canary, blue-green,
rolling or flag rollout needs, observation windows and measurable stop conditions;
record not applicable with a reason for unused strategies.

## Feature flags (consume the SDLC decision)

Record the existing `feature_flags.provider` value (or unset) and its project
configuration reference. Link the existing SDLC flag-fit decision; if absent,
route to SDLC planning and record an owner instead of re-asking flag-fit questions.
Link completed cards using the canonical
SDLC feature-toggle card (`$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/deployment/feature-toggle-card.md`).
Do not duplicate flag lifecycle, vendor configuration or card fields here.

| feature_flags.provider | Configuration reference | SDLC flag-fit decision | Completed feature-toggle card references |
|---|---|---|---|
| [existing value / unset] | [path/revision, no secrets] | [decision link / missing + owner] | [artifact links / not applicable + reason] |

## Constraints, measures and acceptance

Fill budget, duration/queue/failure targets, compliance constraints and prioritized
risks. Name the five rules reviewed in the assessment. Record stakeholder approval,
date, artifact revision and unresolved questions with owner/due date. Check the
[assess gate](../flows/gate-criteria-by-phase.md#assess-gate) before design.

## Existing planning reference

Link the completed pipeline planning artifact derived from
SDLC CI/CD pipeline template (`$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/deployment/ci-cd-pipeline-template.md`).
Reuse its stage/artifact requirements by reference; record only CI/CD-specific
decisions and deltas here.
