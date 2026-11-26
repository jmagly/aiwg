---
name: cicd-github-actions-workflow
title: GitHub Actions CI workflow renderer
description: Agent-interpreted CIPipeline rendering recipe with protected rollout jobs for github-actions.
outputKind: ci-provider-workflow
aliases:
  - cicd-github-actions
  - render github actions pipeline
---

# GitHub Actions rendering recipe

Read [the binding and adapter contract](../README.md) first. Version: 1.0.0.
Apply `cicd-github-actions-safety` and the existing rules by name:
`ci-action-pinning`, `dev-pipeline-safety`, `dev-secret-hygiene`,
`dev-idempotent-builds`, `dev-ci-self-contained`.
Bracketed values are agent substitutions, not a template language or CLI.
Copy only triggers requested by the source. Emit optional cache/upload steps
only with reviewed paths, retention and runtime/lock bindings; no secret artifacts.
The pin manifest beside this template is authoritative; update pins, comments and
manifest together. The following fragments combine into one workflow mapping.

```yaml
name: "[pipeline.metadata.name]"
on:
  push:
    branches: ["[trigger.branches]"]
    paths: ["[trigger.paths]"]
  pull_request:
    branches: ["[trigger.branches]"]
  schedule:
    - cron: "[trigger.cron]"
  workflow_dispatch: {}
permissions:
  contents: read
jobs:
  # Repeat for each exact source job id; no strategy.matrix.
  ci-source-job:
    runs-on: ["[reviewed runner labels]"]
    # Omit needs when empty; expand stage dependencies to terminal jobs.
    needs: ["[job dependencies and applicable gate jobs]"]
    steps:
      - uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd # v5.0.1
        with:
          persist-credentials: false
      - uses: actions/cache@5a3ec84eff668545956fd18022155c47e93e2684 # v4.2.3
        with:
          path: .ci-cache
          key: ${{ runner.os }}-[trust-pool]-[runtime]-${{ hashFiles('package-lock.json') }}
      - name: Invoke reviewed capability implementation
        env:
          CI_CAPABILITY: "[job.capability]"
          CI_INPUTS: '[job.inputs JSON]'
          CI_RETRY: '[job.retry JSON or max_attempts=1]'
          CI_BINDINGS: ci/bindings.json
        run: node ci/capability.mjs
      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
        with:
          name: "[pipeline-job-revision]"
          path: ci-evidence/
          retention-days: 7
          if-no-files-found: error
  ci-stage-gate-1:
    runs-on: ["[isolated validation runner labels]"]
    needs: ["[all terminal jobs of gate.after stage]"]
    steps:
      - uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd # v5.0.1
        with:
          persist-credentials: false
      - env:
          CI_GATE: '[pack, after, parameters JSON]'
          CI_BINDINGS: ci/bindings.json
        run: node ci/gate.mjs
  ci-stage-rollout:
    if: ${{ github.event_name != 'pull_request' && (github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/heads/release/')) }}
    runs-on: ["[privileged runner labels]"]
    needs: ["[stage base jobs and all applicable gate jobs]"]
    environment:
      name: "[resolved CIEnvironment.metadata.name]"
    steps:
      - uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd # v5.0.1
        with:
          persist-credentials: false
      - name: Verify protected environment approval
        env:
          CI_ENVIRONMENT: "[CIEnvironment.metadata.name]"
          CI_PROTECTION: '[CIEnvironment.spec.protection JSON]'
          CI_BINDINGS: ci/bindings.json
        run: node ci/approval.mjs
      - name: Evaluate rollout entry gates
        env:
          CI_GATE: '[rollout.gates entry JSON; repeat per gate]'
          CI_BINDINGS: ci/bindings.json
        run: node ci/gate.mjs
      - name: Execute gated rollout and verified rollback on failure
        env:
          CI_ENVIRONMENT: "[CIEnvironment.metadata.name]"
          CI_CAPABILITY: "[progressive-rollout for flag; ci-deploy-handoff otherwise]"
          CI_ROLLOUT: '[entire stage.rollout JSON, including steps/gates/rollback]'
          CI_BINDINGS: ci/bindings.json
          CI_TOKEN: ${{ secrets.CI_TOKEN }}
        run: node ci/rollout.mjs
```

Resolve each CIEnvironment secret reference to the forge/broker secret name;
never copy its ref URI or resolved value into YAML. CI_TOKEN above illustrates
name-only binding. Repeat approval and protected-branch guards for **all** jobs
using secrets, deploy handoff, registry pushes or flag operations, even without
a rollout. Choose CIEnvironment per reviewed binding. Render branch restrictions
from the protection patterns, not the illustrative main/release guard verbatim.

For canary, blue-green and rolling, use the same protected rollout job shape,
CI_CAPABILITY=ci-deploy-handoff and preserve strategy in CI_ROLLOUT. The project
adapter binds traffic increments, slot swaps or batch updates respectively to
reviewed implementations. For flag, CI_CAPABILITY=progressive-rollout; explicit
step.capability overrides the default. All four strategies require gates and
verified rollback; do not reduce rollout to an unguarded shell deployment.

Concrete strategy substitutions for the protected rollout fragment (JSON env
values, not extra workflow keys):

| strategy | CI_CAPABILITY | CI_ROLLOUT step interpretation |
|---|---|---|
| canary | ci-deploy-handoff | `{"strategy":"canary","steps":[{"weight":10,"pause":"5m"},{"weight":100}]}` — hand off each traffic weight to the bound receiver. |
| blue-green | ci-deploy-handoff | `{"strategy":"blue-green","steps":[{"weight":0,"pause":"5m"},{"weight":100}]}` — validate the inactive slot, then switch only after health PASS. |
| rolling | ci-deploy-handoff | `{"strategy":"rolling","steps":[{"percentage":25,"pause":"5m"},{"percentage":100}]}` — bind percentages to reviewed batch counts. |
| flag | progressive-rollout | `{"strategy":"flag","steps":[{"percentage":5,"pause":"10m"},{"percentage":100}]}` — resolve flag cards/provider, gate each exposure ramp. |

These abbreviated substitutions illustrate strategy only. Preserve the source's
full gates and rollback policy in CI_ROLLOUT as the YAML fragment requires;
require the bound default health gate when a step has no named gate. Missing
health observations or last-known-good rollback bindings block installation.
