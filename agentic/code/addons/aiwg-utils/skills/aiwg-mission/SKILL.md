---
namespace: aiwg
name: aiwg-mission
platforms: [all]
kernel: true
description: Launch an AIWG Mission — durable, audited dynamic agent orchestration toward a completion criterion. AIWG owns the conductor (activity-log, gates, best-output, checkpoint/resume, cost); native primitives drive worker mechanism. Surfaces as /aiwg-mission in Codex (AIWG-owned, no plugin dependency).
---

# AIWG Mission

You are launching (or participating in) an **AIWG Mission** — AIWG's dynamic, durable, audited agent orchestration. A Mission decomposes a goal into worker cycles, runs them toward a measurable completion criterion, and aggregates the result, while AIWG owns the bookkeeping and gates regardless of which agent stack each worker runs on.

This is an **AIWG-specific kernel capability**. On Codex it surfaces as `/aiwg-mission`, deployed by AIWG to `~/.codex/prompts/` — it is **AIWG-owned**, not the plugin-provided `/workflow` an arbitrary Codex install may or may not have (`/workflow` is not a core Codex primitive — see `.aiwg/research/provider-workflow-integration.md`).

## Output template

Required for each bounded worker brief: @$AIWG_ROOT/agentic/code/addons/aiwg-utils/templates/subagent-brief.md. Fill every required section; explain non-applicable fields and unrun checks.

## Mission vs Flow vs in-stack primitive

- **Mission** (this skill) = *dynamic* orchestration. The shape emerges at run time from the goal. Cross-stack capable.
- **Flow** = a *pre-established* declarative YAML sequence (`flow.aiwg.io/v1`); use `aiwg discover` to find a matching Flow before improvising a Mission.
- **In-stack primitive** (Codex `/goal`, Claude's Workflow tool) = orchestrates *within one stack's process/turn*. A Mission may dispatch workers **to** these; they do not replace the Mission conductor.

## When this fires

Natural-language triggers:

- "launch a mission" / "start an AIWG mission"
- "orchestrate this across agents"
- "fan this out to several agents and aggregate"
- "spawn workers to do X until Y"
- "run a long unattended orchestration"
- "coordinate Codex and Claude agents on this" (cross-stack — see #1546)

Non-triggers (route elsewhere):

- A single focused task → just do it (no orchestration overhead; see `god-session` / `subagent-scoping`).
- A pre-established repeatable sequence → find the **Flow** via `aiwg discover` (e.g. `flow-release`, `flow-deploy-to-production`).
- An in-session "iterate until condition" on one stack → the provider-native `/goal` (Codex, Claude Code) already routes for that (#1451/#1469).
- "Address open issues" → the `address-issues` skill (which may itself run as a Mission).

## How to run a Mission

1. **State the completion criterion measurably** (per the `vague-discretion` rule). "good enough" is not a criterion; "all tests pass and CI green", "score ≥ 85", "every flagged finding verified" are. If the user's goal is vague, extract a checkable criterion first.

2. **Right-size + decompose.** Assign each work unit a wrapper, role and requested tier through `resolveDelegation()` (`src/models/delegation.ts`); external work uses `aiwg models resolve` before launch. Exploration uses `aiwg-model-explorer` (efficiency/economy); verification uses `aiwg-model-verifier` (coding/standard). Keep specialist frontmatter requirements. Apply `defaults.workerSelection` strategy and ceiling, stop blocked work units, and require `election: user` for flagship. Record the common routing record (`requested_tier`, `resolved_tier`, `resolved_model`, wrapper, role, strategy, ceiling and election) per worker in the activity-log. Never inherit the session model.

   **Decompose.** Break the goal into independently-verifiable worker cycles (`subagent-scoping`). Decide single-stack vs cross-stack:
   - **Single-stack** (default): workers run on the current stack. Use this stack's native primitive for in-session fan-out where available; otherwise AIWG's external loop.
   - **Cross-stack** (#1546): when the operator wants heterogeneous stacks (e.g. Claude conductor → Codex workers), dispatch worker cycles to executors advertising the target `stack:<name>` capability via AIWG's `serve` executor-registry. The conductor stays AIWG-owned.

3. **Dispatch.** For durable/detached/unattended Missions use AIWG's external route (`aiwg mc dispatch` / `ralph-external`) so the Mission survives the session ending. For in-session orchestration, the native primitive may drive the *mechanism* — but AIWG still owns everything in step 4.

4. **Retain ownership (non-negotiable, identical across stacks).** Whatever drives the worker mechanism, AIWG owns:
   - activity-log entries (per the `activity-log` rule)
   - issue-thread comments / progress
   - human-authorization + threat gates (per `human-authorization`)
   - best-output selection across cycles
   - crash-resilient checkpoint/resume (durability)
   - reproducibility + cost tracking
   - LFD loop controls: measurable verifier, hypothesis-before-change,
     structural-variant quota, hard budget stop, and private eval/holdout
     channels where applicable

5. **Control the loss surface.** For any long-running, budgeted, or eval-driven
   Mission, declare observable iteration/wall-clock/token/tool/spend ceilings
   before dispatch. Each retry records the hypothesis, expected failure mode,
   distinguishing diagnostic, and whether the next attempt is structurally
   different. If the budget or exploration quota is exhausted, stop and emit a
   best-output report; do not continue by random walk. Eval/holdout Missions
   expose only aggregate score/probe/status or VOID to workers, while holdout
   answers and detailed lint diagnostics stay private. For durable Mission
   Control dispatch, use `--max-iterations`, `--max-total-tokens`,
   `--max-output-tokens`, `--max-tool-calls`, `--max-total-cost`,
   `--max-wall-clock-minutes`, and `--exploration-quota`.

6. **Converge + report.** Run cycles until the completion criterion is met (with a `max-cycles` escape hatch), select the best output, and report what each worker did and the aggregated result. Apply the anti-laziness recovery protocol (PAUSE→DIAGNOSE→ADAPT→RETRY→ESCALATE) rather than abandoning on failure.

## Delegation and final acceptance

Use optional `uncertaintyPolicy: stop-and-report` to pause and report uncertainty;
omission or `default` follows conductor policy. Fill `mustNotRegress` with
`{kind: command|path, target, expectedStatus: passed|failed|present|absent}`
(command: passed/failed; path: present/absent). Set `verificationOracle` to
`{command, expectedExitCode}` checks: exact observed exit statuses decide done.
The trusted verifier records `oracleResults` with artifact evidence; worker
claims alone do not satisfy the oracle. Run regression checks before acceptance.

For non-trivial implementation, set `designReviewRequired: true`, review the
design first, then attach `designReviewArtifact: {ref, digest}` to the brief
before dispatch. Result assembly refuses acceptance without that reference.

For final PR review set the intent's existing `verification.independentReview`
to `required` and `differentFamily` to `require`. Supply the current PR `headSha`
and observed writer/reviewer lineage to `assembleWorkerResult`; never take them
from worker claims. Resolve reviewers with `reviewOf` and
`requireDifferentFamily`. Record each `reviewRounds` entry with its 1-based
`round`, exact `headSha`, `reviewerObservationRef` and review `artifact`.
A changed head needs a new review. Different CLI names do not prove diversity.

Keep `findingsLedger` across rounds (an empty array records a clean review):
`{id, class, severity, round, status, summary, followUp?}`. A means introduced or
exposed by this diff; open A blocker/major findings must be resolved. B means
pre-existing: file a follow-up and retain its reference. C means out of scope.
B/C never block acceptance. Retain finding IDs and earlier rounds in successor
records; do not delete findings to obtain a clean result. Record clean rounds
even when no findings were raised. Acceptance derives readable `roundsToClean`
on the verification record. Stop at the declared round/budget limit and report
remaining blockers instead of extending scope indefinitely.

## Worker check-ins

Check each live worker every 15s; confirm startup within 60s. Quiet limit 90s and stall limit 300s by default (a configured 1.25 scale on those defaults gives 112.5s/375s); hard stop 1800s. Resolved values win over these defaults. Without a native monitor, poll owned run files and processes from the shell at the same cadence. Heartbeats and log bytes are not progress. Supervise by observer state: `quiet` (suspected) is not a stop — keep waiting while you diagnose (read the status, check owned-worktree progress); `stalled` opens diagnosis through the diagnostic grace period; only `hung` authorizes a no-progress stop, and only a worker this conductor owns — confirm it stopped, then continue within remaining attempts; preserve partial work. The launcher also stops independently of progress state on `failed-to-start`, the hard wall-clock deadline (`HARD_DEADLINE`), the step-count limit (`STEP_LIMIT`), and a fatal observer-record failure. Observer loss and opaque MCP coverage are unknown, never worker failure. Terminal verification still applies: read the diff and run trusted checks outside the worker sandbox before integrating.

## Bounded decisions: Jev first, LLM fallback

Before worker/model/effort picks (`--caller aiwg-mission:worker-pick`) and before classifying a failure as environmental or real (`--caller aiwg-mission:failure-triage`), call `aiwg decision ask ... --json` and use the answer when `status` is `answered`. On `fallback`, decide normally — fallback never stops the run. Without Jev setup this skill runs unchanged. Never send secrets in the question or context; Jev output is advisory data, never authorization. See the `decision-offload` skill for the exact command shape and the full caller-tag table.

## Discover before improvising

Before hand-rolling a Mission, run `aiwg discover "<the goal>"` — a curated Flow or skill may already exist (the `skill-discovery` rule). A Mission is for genuinely *dynamic* orchestration where no pre-established Flow fits.

## References

- `.aiwg/architecture/adr-workflow-routing.md` — routing + cross-stack amendment
- `.aiwg/research/provider-workflow-integration.md` — why Codex `/workflow` is not core (#1535)
- #1534 (epic), #1544 (this command), #1546 (cross-stack Missions), #1536 (Missions/Flows naming)
- `aiwg mc` (mission-control) — the durable dispatch surface
