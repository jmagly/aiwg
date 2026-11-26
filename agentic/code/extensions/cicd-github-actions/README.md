# GitHub Actions provider extension

WorkflowExtension v1 for cicd-complete; target `github-actions`.
Discover `cicd-github-actions-workflow`, then read
[the renderer template](templates/cicd-github-actions-workflow.md),
[provider safety rule](rules/cicd-github-actions-safety.md) and
[pin manifest](templates/ci-action-pins.txt). Install with `aiwg use cicd-github-actions`.

The package lives in `agentic/code/extensions/` because
`src/cli/handlers/use-additive-bundles.ts:getAllExtensions` scans exactly that
location for manifest.json. Its disallow set only excludes api-adapter. Nested
framework scaffolds are not discovered by this loader. No registration edit is
needed. Templates are inert agent inputs, not CI hooks; do not use
`--ci-hooks-enabled` or copy these files into AIWG's forge directories.

## Rendering contract (agent-interpreted, D2)

Inputs: reviewed CIPipeline, resolved CIEnvironment resources, installed
OpsCapabilities/GatePacks, project feature_flags.provider, and a reviewed binding
plan for runners, environments, runtime, artifacts and capability implementations.
Validate references, cycles, unique job ids, provider id syntax and required inputs.
Never silently sanitize ids, discard retry policy or choose among environments.
For multiple environments require an explicit per-job binding. Unsupported trigger
filters or native controls are blocking findings, never silently omitted fields.

Emit one job per source job with its exact id. `needs` is the union of job
depends_on and terminal jobs of predecessor stages; add applicable gate jobs.
A stage terminal includes its rollout/gate job. Top-level gates run after all
jobs (including rollout) of their named stage and block all downstream stages.
Rollout-local gates run after their named stage, before promotion; a gate whose
`after` names its own rollout stage runs after that stage's base jobs to avoid
a cycle. A single-job stage has no matrix or synthetic dependency. Allocate helper
ids deterministically (stage + suffix); collision is a blocking finding. Order
jobs topologically, break ties by source order, preserve mapping key order.

Map push/pull_request branches and paths directly; schedule cron becomes a list
entry, manual becomes workflow_dispatch. For manual/schedule branch/path filters,
emit an explicit preflight check against the event revision/changed paths (or block
if history is unavailable). Multiple push/PR definitions need reviewed union
semantics; block if merging branches/paths would broaden their pairwise matches.
Never add pull_request_target. Record input/template/pin/output SHA-256 digests,
versions, bindings, output path and helper-id mapping in the render receipt.
Same reviewed inputs must yield the same bytes.

## Runtime adapter boundary

The fenced workflow is a recipe, not a standalone runnable pipeline. Replace
bracketed placeholders from the binding plan. The `ci/*.mjs` paths denote
**user-owned, reviewed adapters**, not AIWG commands or scripts shipped here.
Stop installation until they exist and provider validation passes. Do not invent
`aiwg ci-render`, an execution engine, or substitute echo/success for a capability.
Adapters must run on a provisioned, version/checksum-pinned Node runtime; checkout
is credential-free. They resolve installed capability definitions and their real
implementations, validate all required inputs, invoke verification and return
nonzero on missing evidence, HOLD, rollback or failure. Reports are sanitized JSON
under ci-evidence/ with immutable revision and digest; never print credentials.

- `ci/capability.mjs`: consumes CI_CAPABILITY, CI_INPUTS JSON, CI_RETRY JSON,
  CI_ENVIRONMENT and CI_BINDINGS (reviewed project path). Merge only explicit
  supplemental bindings; retain original inputs and evidence. Retry never masks
  an earlier test failure; max_attempts is a diagnostic bound, backoff is honored.
- `ci/gate.mjs`: consumes CI_GATE JSON (pack, after, parameters), obtains fresh
  evidence for the exact upstream revision and evaluates the installed GatePack.
  Only PASS exits zero; missing evidence/HOLD/ROLLBACK block dependent jobs.
  Resolve upstream reports by immutable run/revision and digest from the reviewed
  artifact-store binding, never another job's local filesystem or a mutable latest.
- `ci/rollout.mjs`: consumes CI_ROLLOUT JSON, CI_CAPABILITY, CI_ENVIRONMENT and
  CI_BINDINGS. For each ordered step, invoke its capability override or the stage
  default; pass weight/percentage and resolve all required capability inputs.
  Wait the pause and propagation allowance, evaluate the step gate and bound
  health gate with fresh evidence, then advance only on PASS. Use
  CI_HEALTH_GATE or the bound default `aiwg:cicd-complete/progressive-rollout-health`
  for steps without a named gate. For flag, delegate this to progressive-rollout
  (provider from feature_flags.provider); provider none requires recorded manual
  approval per ramp. Missing configuration or experiment safety holds progression.
  A handed-off rollout_ref must reach verified completion before the next ramp.
  HOLD/timeouts stop promotion; ROLLBACK invokes rollback.capability only for
  the configured on signals, supplies last-known-good references and verifies
  restoration. Manual rollback is an authorized operator invocation, never an
  automatic success-path step. No continue-on-error or unconditional promotion.
- `ci/approval.mjs`: checks CI_ENVIRONMENT, CI_PROTECTION JSON, event revision,
  branch and approval identity before any step receives secrets. It implements cicd-gha-environment-protection in addition to native approval.

Persist rollout state by revision and environment so job retries cannot repeat
unsafe promotion. Resolve flag bindings from the existing SDLC card at
`$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/deployment/feature-toggle-card.md`;
never infer a vendor or copy flag lifecycle planning into this extension.

## GitHub protection and runners

Map logical labels to reviewed runner labels; the fixture adds self-hosted to
[linux, ci-runner]. Native hosted labels need explicit operator bindings. Set
permissions: contents: read, with job-specific elevation only if required.
Environment reviewer counts and deployment branch restrictions are repository
settings, not workflow keys: configure and verify them before installation.
If the plan cannot enforce the requested number of distinct reviewers (the fixture
requires two), require an external approval service checked by approval.mjs.
Never equate listing two eligible reviewers with requiring two approvals.
Bind privileged jobs to environment.name. Place secrets only on protected
capability steps, never workflow/job env or PR jobs. Branch guards apply to manual
and scheduled runs too. Isolate caches by trust, OS, runtime and lock digest.

## Golden previews and validation

`test/fixtures/cicd/rendered/github-actions/ci-pipeline-{canary,flag}.yml`
are manually projected previews following this recipe and ci-environment.json.
They preserve partial source inputs; the binding plan must supply required
runtime inputs, artifact references, gate evidence and flag-card bindings before
execution. No runtime adapters or secret values ship with a preview. The canary
uses all four trigger types; flag is the matrix-free single-job stage example.
The Gitea flag fixture explicitly projects the GitHub-only source as a cross-provider
template test; a real render requires the user to add gitea-actions to targets.
The fixture adds the default progressive-rollout-health gate for flag safety.
Run `nice -n 19 npx vitest run test/unit/workflow/cicd-provider-rendering.test.ts --config config/vitest.config.js`.
YAML parsing and static checks do not prove forge acceptance or deployment.
Record provider validator availability and controlled-trial results separately.
