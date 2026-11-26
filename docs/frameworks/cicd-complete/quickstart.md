# CI/CD Complete quickstart

Ask your assistant to assess a pipeline, design its replacement, and prepare
provider workflow files you can review. This walkthrough uses a fictional
`orders-api` service; replace its paths, owners and targets with your own.

> First time using AIWG? Follow [Install, Connect, and Verify](../../getting-started/install-connect-verify.md)
> first. You need AIWG installed, an assistant connected to your project, and
> permission to read its workflow files. No working CI pipeline is required.

## Install in your project

Tell your assistant:

```text
Set up cicd-complete for this project and the provider extension for our forge.
We use Gitea Actions. Show what was installed and any assistant reload step.
```

The equivalent terminal commands, run from your project root, are:

```bash
aiwg use cicd-complete
aiwg use cicd-gitea-actions
```

For GitHub Actions, use this extension instead of the Gitea extension:

```bash
aiwg use cicd-github-actions
```

These install assistant guidance and templates. They do not create or execute
project workflows. Follow any reload instructions printed by installation, then
ask the assistant to find `cicd-quickref` and your provider workflow template.
If either is unavailable, resolve the installation before rendering.

## Give the assistant enough context

A useful prompt names the repository, current provider, desired outcome,
evidence, and allowed changes. Give file paths and redacted run records rather
than credentials. State measurable targets and ask the assistant to identify
unknowns instead of filling them with guesses.

Work in reviewable steps: assess, accept the design, review the rendered diff,
then authorize installation and a controlled trial separately. Carry the saved
artifact paths and revisions into each follow-up prompt so a new session can
continue the same design.

Before saving project artifacts, the assistant resolves the writable artifact
root using the command in the reference below. All paths here beginning
`.aiwg/frameworks/cicd-complete/` are logical paths: with an external artifact
root, `frameworks/cicd-complete/` lives under that root. The filenames below are
suggested names to request, not fixed outputs created by a CLI command.

## 1. Assess my current CI

```text
Use cicd-intake and ci-assess for orders-api. Read our current workflow files,
package scripts and the redacted run records in ci-history/. Baseline the last
30 days: failures, flakes, queue time and duration. Our target is builds under
600 seconds and coverage at least 80%. Save intake.md and assessment.md under
the CI/CD artifact directory. Rank improvements with evidence and owners;
record missing measurements. Assessment only; leave CI files and runs alone.
```

**What the agent does:** inventories triggers, jobs, runners, artifact flow,
secret references and environment protections. It compares dated observations
with your targets and separates missing evidence from confirmed defects.
`ci-architect` supports the assessment; a project with no existing CI gets an
explicitly missing baseline and a collection plan.

**Files you get:** `intake.md` from `cicd-intake-template` and `assessment.md`
from `ci-assessment-report-template`, under the logical CI/CD artifact directory.

**What to review:** repository and environment scope, sample period and size,
first failures retained in the sample, release ownership, and ranked risks.
Agree the [assess gate](phases/assess.md) before continuing.

## 2. Design a canary pipeline with gates

```text
Use ci-pipeline-design and our reviewed intake.md and assessment.md. Draft
pipeline.yaml, environments/production.yaml and environment-plan.md for
orders-api. Target gitea-actions. Separate untrusted validation from protected
deployment. Require coverage >=80% and build duration <=600 seconds after
verification. Plan a 10%, 50%, 100% canary with five-minute observation pauses,
error fraction <=0.01 and p95 latency <=500 ms. Name the health evidence source,
rollback capability, last-known-good artifact and operator. Validate schemas,
resolve every reference and reject cycles. Report missing implementations.
```

**What the agent does:** models a `CIPipeline` and matching `CIEnvironment`
resources, using `ci-architect` and the pipeline/environment templates. It
selects capabilities, connects dependencies, and plans gate and rollback
bindings. It uses the shipped packs `aiwg:cicd-complete/coverage-floor`,
`aiwg:cicd-complete/build-time-budget` and
`aiwg:cicd-complete/progressive-rollout-health`. Relevant parameter names are
`minCoveragePercent`, `maxBuildSeconds`, `maxErrorRate` and `maxLatencyMs`.
A template's example capability names must be replaced with resolved definitions
and actual project implementations.

**Files you get:** `pipeline.yaml`, `environments/production.yaml` and
`environment-plan.md` in the artifact directory, with validation results and
unresolved prerequisites. Set `render.targets` to `github-actions` if that is
your selected provider.

**What to review:** exact trigger filters, dependency order, runner bindings,
secret references only, reviewer counts and branch restrictions. Each ramp
needs fresh health observations, propagation time and a blocking gate; absent
evidence holds promotion. Review rollback authority and verification. Schema
success alone does not resolve references or prove deployability. Accept the
[design gate](phases/design.md) before requesting a render.

## 3. Render for Gitea or GitHub Actions

```text
Use ci-render on the accepted pipeline.yaml and production environment document.
Use the installed cicd-gitea-actions-workflow template. Prepare a preview for
.gitea/workflows/orders-api.yml and a runbook.md with the render receipt, input,
template, pin and output digests, bindings, validation and rollback copy. Show
me the diff. Identify every missing runtime adapter and provider setting;
stop installation if a required implementation or validation is missing.
```

For GitHub, substitute `cicd-github-actions-workflow` and
`.github/workflows/orders-api.yml`, with `github-actions` in `render.targets`.

**What the agent does:** `ci-renderer` interprets the selected extension recipe,
validates references and inputs, builds a preview and checks repeat-render
consistency. It preserves requested controls or reports a blocking gap.
`supply-chain-guard` reviews pins and trust boundaries.

**Files you get:** the workflow preview in the artifact directory, a proposed
diff against the target path, and `runbook.md` from
`ci-pipeline-runbook-template`. The receipt records source-to-output mappings,
versions and digests. Project-owned capability, gate, rollout and approval
adapters are prerequisites, not scripts supplied by this framework. The recipe's
`ci/*.mjs` paths describe those adapters; placeholders are not executable code.

**What to review:** no unresolved placeholders, verified action pins, runtime
and artifact-store bindings, gate dependencies, secret placement and environment
approvals. Gitea requires server/act_runner compatibility checks and an explicit
approval adapter; GitHub reviewer counts and branch restrictions require actual
repository settings, with external enforcement if native controls cannot meet
the requested count. Listing two eligible reviewers does not require two approvals.

Once the diff and prerequisites are accepted, give scoped authorization:

```text
Install only the reviewed orders-api workflow diff identified in runbook.md.
Validate the installed file with the available provider validator and report
its result. Keep pipeline dispatch and publication pending.
```

Then agree a controlled trial on a non-production target, with publication
disabled, an operator and rollback authority. Authorize that specific trial
through your existing provider tooling. Retain proof that a failed health gate
blocks promotion and rollback restores the recorded artifact. The
[implement gate](phases/implement.md) requires provider validation and trial
evidence; a YAML parse or preview does not satisfy it. Review rendered files
before committing them.

## 4. Triage a failing or flaky job

```text
Use ci-failure-triage for orders-api revision <commit>, run <run-id>, job
<job-id>, attempt <attempt>. Read the redacted logs in ci-history/failure/.
Preserve the first failure. Save incident.md with hypotheses, a bounded
reproduction plan and a proposed causal fix plus regression test. If intermittent,
use ci-flake-hunt to compare seed, order, clock, concurrency and runner state.
Record every diagnostic outcome; ask before dispatching runs or applying fixes.
```

**What the agent does:** `ci-doctor` classifies code/test, cache, runner,
dependency, permissions and provider causes. Flake diagnosis uses controlled
experiments with an attempt budget and stop condition. A later pass does not
erase the original failure or prove a repair.

**Files you get:** `incident.md` from `ci-pipeline-incident-template`, including
run identities, sanitized evidence, hypotheses, experiment matrix, proposed patch
and verification status. Any patch remains proposed until authorized.

**What to review:** causal evidence, alternative explanations, regression failure
before repair and success after, neighboring checks, and remaining uncertainty.
Do not substitute retries, skipped tests or weaker assertions for a fix. Carry
accepted procedures into `runbook.md` for the [operate phase](phases/operate.md).

## 5. Plan progressive delivery with feature flags

```text
Extend the reviewed design for the existing new-checkout flag and its SDLC
feature-toggle card. Read feature_flags.provider from project configuration.
Plan strategy: flag with 5%, 25%, 100% exposure, both-state tests, code-reference
checks and fresh health gates after propagation. Resolve provider capabilities
and required flag bindings. If provider is none, require recorded manual
approval at each flag-dependent gate/ramp. Do not change flags. Save the revised
pipeline, flag-delivery-plan.md and runbook preview for review.
```

**What the agent does:** considers `flag-check`, `flag-states-test`,
`flag-coderefs-scan`, `progressive-rollout` and `flag-cleanup-handoff`. For flag
steps, consumers resolve an omitted capability to `progressive-rollout`.
The health pack describes propagation allowance, polling/backoff and timeout;
the implementation must perform them. Missing observations or timeout HOLD;
observed health failure signals ROLLBACK. A provider-native long-running rollout
may return `handed-off` with a `rollout_ref`; later steps must verify completion.

Flag lifecycle decisions, creation and retirement belong to **sdlc-complete**
flag planning and its feature-toggle card. Vendor operations belong to the
selected provider addon/skills through **`feature_flags.provider`**. CI/CD consumes
those decisions and observed state; this prompt does not authorize flag mutation.
Provider `none` means a manual approval gate with recorded evidence, never an
automatic pass. Missing or unknown configuration blocks progress pending a
decision. A CI forge extension does not select a feature-flag vendor.

**Files you get:** revised `pipeline.yaml`, `flag-delivery-plan.md` linking the
existing SDLC card, and a revised runbook/workflow preview. Cleanup is a lifecycle
handoff rather than deletion of the flag.

**What to review:** flag/environment identity, provider binding, both-state tests,
health window freshness, experiment-linked rollout safety, last-known-good
state, approval records and rollback verification. Revisit design and implement
gates before trialing the revised delivery path.

## 6. Migrate providers

```text
Use ci-migrate to move orders-api from Gitea Actions to GitHub Actions. Preserve
the accepted spec, required checks, gate semantics and artifact identities.
Prepare migration.md with a parity matrix for triggers, runners, caches,
secrets references and environment protections. Use the installed GitHub
extension for target previews. Plan publication-disabled trials, explicit
cutover ordering, duplicate-publish prevention and rollback. Leave source
triggers and feature_flags.provider unchanged until their own approved change.
```

**What the agent does:** inventories source behavior, maps target capabilities,
reports unsupported controls, and uses design/render skills for previews.
Installing the target extension is a prerequisite. A schema target of
`gitlab-ci` exists, but these first-wave extensions cover only Gitea and GitHub;
a missing target extension blocks rendering and cutover.

**Files you get:** `migration.md` from `ci-migration-report-template`, revised
pipeline/environment drafts, target workflow previews and runbook updates.

**What to review:** parity on the same revision/artifact, provider trust and
protection differences, retained source configuration, rollback ordering and
which provider alone may publish. Approve the concrete target diff, controlled
trial, and trigger cutover separately. Record trial results and acceptance before
retiring the source path; migration never implicitly changes flag configuration.

## Command and discovery reference

Use these when the assistant needs help locating guidance. Skill names in prompts
are assistant workflows, not standalone CLI subcommands.

```bash
aiwg artifacts path --json --check-write
aiwg discover "cicd-quickref" --limit 3
aiwg show skill cicd-quickref --body
aiwg discover "assess my CI pipeline" --limit 3
aiwg discover "design CI pipeline specs" --limit 3
aiwg discover "render my CI pipeline" --limit 3
aiwg discover "cicd-gitea-actions-workflow" --limit 3
aiwg discover "cicd-github-actions-workflow" --limit 3
aiwg discover "triage a failed CI job" --limit 3
aiwg discover "hunt a flaky CI test" --limit 3
aiwg discover "progressive-rollout" --limit 3
aiwg discover "migrate my CI provider" --limit 3
```

Read the [overview](overview.md) for ownership and execution boundaries and the
[schema contracts](ci-schema-contracts.md) for the document shapes. Keep the
accepted artifacts, rendered revision, validation results and rollback procedure
together so another operator can pick up the pipeline safely.
