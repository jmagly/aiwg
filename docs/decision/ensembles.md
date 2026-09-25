# Ensembles, champion/challenger, and drift response (D17 contract)

Status: **contract stable, runtime experimental and disabled.** This page describes the versioned
D17 schemas, pure validators and fixtures. There is no ensemble executor, shadow router, promotion
or rollback orchestrator, or drift-response executor in this package. Nothing described here calls
an adapter, opens a transport or resolves a credential. The runtime work stays tracked on #2611 and
needs separate authorization.

## Contracts

| Schema | Record | Purpose |
|---|---|---|
| [`DecisionEnsemblePolicy.v1`](../../schemas/decision/DecisionEnsemblePolicy.v1.schema.json) | `decision-ensemble-policy/v1` | Members and their pins, primitive, aggregation, disagreement, acceptance and every resource ceiling |
| [`DecisionEnsembleAggregate.v1`](../../schemas/decision/DecisionEnsembleAggregate.v1.schema.json) | `decision-ensemble-aggregate/v1` | Derived result of the reference aggregation over recorded member results |
| [`DecisionChampionChallenger.v1`](../../schemas/decision/DecisionChampionChallenger.v1.schema.json) | `decision-champion-challenger/v1` | Champion and challenger pins over one immutable input set, with preregistered paired thresholds |
| [`DecisionDriftResponse.v1`](../../schemas/decision/DecisionDriftResponse.v1.schema.json) | `decision-drift-response/v1` | Maps each declared drift signal to exactly one configured response |
| [`DecisionEnsembleIntegrityReport.v1`](../../schemas/decision/DecisionEnsembleIntegrityReport.v1.schema.json) | `decision-ensemble-integrity-report/v1` | Extends the #2037/#2048 eval-integrity report and can never upgrade its decision |

All five schemas are registered in `schemas/catalog/domains/decision.json` with `stability:
experimental`. The TypeScript types and validators live in `src/decision/ensemble/` and are
exported from `aiwg/decision`. Each validator runs entry admission and the JSON Schema before
its semantic checks. `EnsembleContractError.layer` reports which of the three layers
(`admission`, `schema`, `semantic`) rejected the input.

## Ensemble policy

A policy has a semantic version, a `mode` (`disabled`, `offline-shadow` or `advisory`; v1 has no
enforced mode), its risk tiers, and the decision definition that every member answers. Each member
declares:

- its **member type**: `model-version`, `provider-backend`, `repeated-sample` or `prompt-adapter`;
- pinned definition, binding, adapter version and provider, backend, requested model and pinned model version;
- its primitive, uncertainty profile, required capabilities and the capabilities its binding supplies;
- an optional D09 calibration artifact pin;
- its sample count, fallback depth, and conservative per-attempt estimates of attempts, tokens, cost and deadline.

`validateEnsemblePolicy` refuses the policy before any adapter could be called when:

- a member's primitive or definition pin differs from the policy;
- the aggregation algorithm or disagreement metric is not defined for the primitive;
- a member's uncertainty profile is not on the policy's allow-list. Algorithms that combine numeric
  uncertainty (`mean-probability-v1`, `jensen-shannon-v1`) also require one shared profile, so a Jev
  distribution is never averaged with an LLM self-report;
- a member lacks a required capability;
- the policy requires calibration and a member has no pinned artifact, or the host supplies D09
  `CompatibilityDecision` pins and a member's pin is not an `allow` for that exact artifact;
- two non-sample members share the same binding, adapter and model identity, which would claim
  independence that does not exist; a `repeated-sample` member has fewer than two samples; or a
  `prompt-adapter` member has no approval reference;
- the budget does not fit (see below).

### Budgets

Budget validation mirrors `GraphBudgetLedger` (#2608). Effective ceilings are the minimum of the
policy's ceilings and every host layer, as in `effectiveGraphCeilings`. Every planned sample becomes
a `{ attempts, tokens, costMicros }` reservation with at least one attempt. Attempts are never
refunded, so an estimate must cover the member's fallback depth. Unknown cost is rejected unless the
policy's `unknownCost` rule reserves an explicit trusted bound per attempt. The whole plan is
admitted all or nothing: the policy is rejected when total members, attempts, tokens, cost, fallback
depth or the conservative deadline exceed a ceiling. The deadline is the slowest sample multiplied by
the number of concurrency waves. `planEnsembleBudget` returns the effective limits, demand and
reservations. This check happens at validation time; it is not a dispatcher.

## Reference aggregation

`aggregateEnsembleResults(policy, results)` is a deterministic library over results that were
already recorded. Each result names its member, sample index, status (`succeeded`, `failed`,
`abstained`), and a digest of the full member `DecisionResult`/attempt lineage, which is retained
separately. Every planned sample must be recorded, failures included. Results are put in canonical
`(memberId, sampleIndex)` order before any arithmetic, so the output is identical for every
permutation of the input.

| Algorithm | Primitives | Output value |
|---|---|---|
| `majority-v1` | Choice, Noul | Plurality label. Noul votes `true` at p >= 0.5. |
| `mean-probability-v1` | Choice, Noul | Choice: argmax of the mean provider distribution. Noul: mean probability. |
| `score-distribution-mean-v1` | Score | Mean score; dispersion is retained. |
| `score-median-v1` | Score | Median score. An even count with distinct middle values is a tie. |

| Disagreement metric | Primitives | Definition (reported in basis points, 0 to 10000) |
|---|---|---|
| `vote-share-v1` | Choice, Noul | 1 minus the winning vote share |
| `normalized-entropy-v1` | Choice, Noul | Vote entropy divided by log2 of the label count |
| `jensen-shannon-v1` | Choice, Noul | Generalized Jensen-Shannon divergence over member distributions, divided by log2(min(members, labels)) |
| `score-dispersion-v1` | Score | Population standard deviation divided by half the level span |

The tie rule is `lowest-canonical-value` (lowest option ID in code-unit order, `false` before `true`,
or the lower middle score), `defer` or `review`. The disposition is chosen in this order: too few
successful members, then a tie under a `defer`/`review` rule, then disagreement above the threshold,
and otherwise `accept`. A non-accepted aggregate carries no outcome value. The aggregate records the
algorithm and metric ID and version, the policy digest, every member result reference, counts and
derived statistics.

## Agreement is not correctness

The aggregate is labelled `semantics: stability-signal-not-correctness` and `provenance: derived`.
Its schema has no calibrated-probability, accuracy or correctness field, and its `correctnessGate`
is the constant `not-satisfied`. Agreement alone never satisfies a correctness or calibration gate.
Meeting such a gate needs separate labelled evaluation evidence.

Warnings make the limits visible:

- `high-agreement-not-correctness`: at least two successful members agree within the policy's
  `highAgreementWarningBps`.
- `shared-systematic-error-risk`: high agreement from members that share one model identity, or that
  are all repeated samples or prompt variants. The `ENS-SHARED-01` fixture shows five agreeing samples
  of one model that are all wrong.
- `member-failures-present` and `uncalibrated-members`.

### Independence limits and shared error

The member types do not have equal independence. Repeated samples from one model share its training
data, prompt and systematic errors, so their agreement measures stability, not truth. Different model
versions of one provider share most of their lineage. Different providers are more independent, but
can still share public training data and the same prompt. Prompt or adapter variants are only
members when explicitly approved. None of these designs is a certificate of correctness, and
black-box sample agreement cannot prove truth.

### Expense

Each member sample is a separate call with its own tokens, cost and latency. An ensemble of k
samples costs roughly k times a single decision and adds latency unless concurrency is available.
Only a workload-specific benefit, measured against that added spend and latency, justifies enforced
use. That measurement is part of the deferred runtime qualification.

### Calibration requirements

Member uncertainty semantics differ and are never flattened into a common calibrated probability.
Calibrated risk comes only from a pinned D09 calibration artifact whose compatibility decision is
`allow` for the exact member identity. A policy with `calibration.requirement: required` rejects any
member without such a pin. An aggregate derived from calibrated members is still not itself a
calibrated estimate.

## Champion and challenger

`DecisionChampionChallenger.v1` pins both roles by D09 identity digest, actual model, binding, adapter,
calibration and optional ensemble policy. It also pins one immutable input set (ID, digest, item count,
freeze time) and the paired metrics `quality`, `calibration`, `risk-coverage`, `abstention`,
`latency`, `tokens`, `cost` and `slice`, each with a comparison, bound and minimum pair count. The
thresholds are preregistered by an order-independent digest before any held-out access. The record
names the required D09 `PromotionEligibility` ID, the eval-integrity report, the approval, and a
rollback target that must be the exact champion alias revision, as `promoteAlias` requires.

`validateChampionChallenger` can also compare the record with the D09 eligibility record and the
immutable alias history. D17 consumes that registry. It does not keep a parallel registry or alias
state machine, and it does not move aliases.

## Eval-integrity report extension

`buildEnsembleIntegrityReport` carries the #2037/#2048 integrity fields unchanged (`sample_n`,
uncertainty, paired baseline, integrity mode and state, fresh-workspace requirement and verification,
compromise labels, trusted score source, weak-signal reason and release gate). It adds the paired
deltas against their preregistered bounds and D17 findings. The decision logic can only keep or tighten
the upstream gate:

- an upstream `ROLLBACK`, or any compromise, gives `ROLLBACK`;
- an upstream `HOLD`, or any D17 finding, gives `HOLD`;
- `PROMOTE` needs an upstream `PROMOTE`, a matching eligible D09 record, verified integrity, and every
  paired delta present, sufficiently sampled and within its bound.

`validateEnsembleIntegrityReport` rejects any report whose decision is less conservative than its
upstream decision.

## Drift response

`DecisionDriftResponse.v1` declares one rule per `(source, metric)`:

| Source | Metrics | Evidence |
|---|---|---|
| `alias-drift` | `identity-change` | D09 `AliasDriftEvent` from `CalibrationRegistry.driftEvents()` |
| `output-distribution` | `jensen-shannon-v1`, `population-stability-index-v1` | Unlabelled warning, not direct evidence of quality loss |
| `label-drift` | `label-error-rate-delta-v1`, `calibration-error-delta-v1` | Labelled quality evidence |

Each rule names exactly one response: `alert`, `reduce-coverage`, `route-to-review`,
`disable-challenger`, `restore-champion` or `require-recertification`. A policy must configure
alias drift, its thresholds are pinned by version and digest, and it names the response for a window
with too few samples. `resolveDriftResponse` returns the configured response for a signal. It rejects
a signal with no configured rule, a different alias, or a different threshold version, so old
thresholds are never reused silently. Values equal to a threshold are within it. The resolver only
reports the response; executing it is deferred runtime work.

## Fixtures

The fixtures in `test/fixtures/decision/ensemble/` are synthetic and repository-authored. They
exercise validation and deterministic plumbing only. They are not quality, calibration or drift
threshold evidence and must not be used to select production thresholds.

- `ensemble-policy.v1.{valid,invalid}.json`, `champion-challenger.v1.{valid,invalid}.json` and
  `drift-response.v1.{valid,invalid}.json`: positive records, plus anti-fixtures written as JSON
  patches against a valid base, each declaring the layer that must reject it.
- `aggregation-vectors.v1.json`: Choice, Noul and Score aggregation, disagreement, stable-tie,
  defer-on-conflict and shared-systematic-error vectors (`ENS-*`).
- `drift-response-table.v1.json`: the signal-to-response table (`DRF-T*`).

## Deferred to the runtime (#2611)

Ensemble and champion/challenger execution, shadow routing on identical inputs, promotion and
rollback orchestration with active-run pinning, drift-response execution, security and privacy
filtering ahead of cost or quality routing, and OpenTelemetry emission are not implemented. The
reserved `decision.drift` metric still has no producer. Live qualification also stays deferred:
paired shadow runs, drift thresholds from D11 frozen splits, the benefit-versus-spend benchmark, and
the cross-provider egress matrix.
