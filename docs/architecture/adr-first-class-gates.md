# ADR: First-class declarative gates

- Status: **accepted** by the operator on 2026-10-30 (release 17 plan item 15): the ownership and trust boundary as written, with #2834 then #2835 as fixture-parity migrations. #2836 and #2837 stay alternates. Acceptance grants no live-run, promotion or default-activation authority.
- Updated: 2026-10-30, against the 2026.10.16 source tree.
- Tracking: [#2825](https://git.integrolabs.net/roctinam/aiwg/issues/2825);
  parent epic [#2824](https://git.integrolabs.net/roctinam/aiwg/issues/2824);
  follow-ups #2834–#2837.
- Decision owner: the operator. Module ownership below does not confer approval authority.
- Direction: the linked #2824 records roctinam's 2026-10-01 direction that frameworks,
  addons and extensions may define declarative, manifest-driven, schema-first gates.
- Publication: no entry for this ADR in `docs/_manifest.json`; this change adds
  none. Decision-study links use GitHub URLs for docsite compatibility.

## 1. Context and scope

The original #2824 findings described missing shared schemas, discovery and
repeated decision formulas. Those findings are historical motivation. Shared
schemas, the evaluator, discovery, offline CLI, project floors, isolated bundle
providers and D29 adoption now exist. Evaluation remains experimental and opt-in;
it does not enable production decision-runtime pack evaluation. Existing decision
consumers also reuse statistics and severity helpers without adopting bindings.
Sources: `src/gates/index.ts`, `src/gates/stats/index.ts`,
`src/decision/qualification/quality.ts`, `src/decision/qualification/release.ts`,
`src/cli/handlers/gates.ts`, `tools/decision/studies/d29-gates.mjs`.

This records shipped behavior and proposes the remaining migration boundary.
The [gates guide](https://github.com/jmagly/aiwg/blob/main/docs/decision/gates.md)
describes operation. This draft changes no code, thresholds or preregistrations.

## 2. Ownership

| Owner | Responsibility and source of record |
|---|---|
| Gates core | Shapes/admission: `src/gates/types.ts`, `schema.ts`, `schemas/gates/`; composition/policy: `src/gates/registry.ts`, `floors.ts`; evaluation/report replay: `src/gates/evaluate.ts`, `lattice.ts`, `report.ts`. Short filenames in this row are under `src/gates/`. |
| Bundle/discovery owners | Manifest: `src/extensions/manifest.ts`; safe loading: `src/gates/discovery.ts`; searchable packs: `src/artifacts/types.ts`, `src/artifacts/index-builder.ts`; CLI: `src/gates/driver.ts`, `src/cli/handlers/gates.ts`. |
| Provider owners/operator | Metrics and isolated snapshots: `src/gates/providers/`, especially `loader.ts`; project `gates.providers` authorization: `src/gates/floors.ts`. In-bundle review metadata alone is not authorization. |
| Held-out collector | Approval, bundle validation and ordering: `src/decision/heldout/contract.ts`, `calibration.ts`, `collector.ts`; signed access: `access.ts`, all under `src/decision/heldout/`. |
| Protected host/effect ledger | Independent keyring selection, retained approval/access anchors and key lifecycle: `src/effects/host.ts`, `src/effects/keys.ts`, `src/effects/keyring.ts`. Gates does not provision keys. |
| D29 study | Binding/metrics: `tools/decision/studies/d29.mjs`, `d29-preparation.mjs`; reports: `d29-gates.mjs`; authoritative calibration/review/scoring: `d29-scoring.mjs`, all under `tools/decision/studies/`. |
| Other study/runner owners | Existing contracts remain in `src/decision/sensitivity/comparative.ts`, `src/decision/ensemble-study/`, `src/decision/qualification/` and `tools/decision/*-live-qualification.mjs` until migrated (section 11). |

## 3. Shipped artifact model

The closed draft-2020-12 schemas are `schemas/gates/GatePack.v1alpha1.schema.json`,
`GateBinding.v1alpha1.schema.json` and `GateReport.v1alpha1.schema.json`, all
using `gates.aiwg.io/v1alpha1`. Types live in `src/gates/types.ts`.

- **GatePack** declares metrics, parameters, gates, optional pinned inheritance
  and `max-severity` combination. Predicates use the existing three-valued
  `DecisionPredicate`; packs do not contain arbitrary executable code.
- **GateBinding** is the preregistered instance: full pack IDs/versions,
  authored `digest` and composed `resolvedDigest`, qualified
  `<packId>.<param>` values, slices/groups, reference arms, provider pins,
  registration/freeze times, optional data digests and outcome ceiling.
  Provider pins include ID/version/descriptor `sourceDigest`; bundle providers
  additionally require `codeDigest` and input `recordsDigest`.
- **GateReport** carries binding/pack/provider pins, effective metrics digest,
  floors digest or explicit opt-out, holdout seal, gate evidence, references,
  ceilings, decision and evaluation time, covered by a canonical digest.
  `validateGateReport` re-evaluates at the report's evaluation time using trusted
  context and checks identical canonical bytes and ceilings. Resealing a forged
  report is insufficient.

Sources: the three schemas above, `src/gates/registry.ts`,
`src/gates/evaluate.ts`, `src/gates/report.ts`. `sliceGroups` validates inventory
membership but does not itself select gates; named pooled-group selection is
deferred (`src/gates/registry.ts`, `src/gates/evaluate.ts`).

## 4. Inheritance and project policy

Namespaces are `aiwg:`, `framework:`, `addon:`, `extension:` and `project:`.
An `aiwg:` rest-path cannot coexist with a non-`aiwg:` copy; ambiguity among
other namespaces requires full IDs. Bindings always use full IDs. `extends`
pins parent authored bytes; binding pins additionally cover composed bytes,
so changed parent content invalidates old pins. Source: `src/gates/registry.ts`.

Inheritance proves tightening per kind: thresholds follow their declared
direction; support/confidence minima cannot fall; parameter references cannot
be renamed; literals cannot become bindable references. `onFail` can tighten
HOLD to ROLLBACK; `onInsufficient` stays HOLD. Floor gates cannot be removed
or un-floored, but non-floor gates may be removed. Scope changes must preserve
coverage and satisfy the kind-specific aggregation proof; a narrower scope is
not a general tightening rule. Sources: `assertGateTightens`,
`assertScopeTightens`, `applyGateExtends` in `src/gates/registry.ts`.

Binding freedom differs from inheritance: an in-range parameter change creates
a new binding digest but need not tighten the pack default. Project floors
enforce minima against resolved binding values. Callers load trusted policy
from `.aiwg/aiwg.config` through `resolveProjectFloors`; evaluation never fetches
policy itself. Floors are inline `project:` packs or pinned packs, plus ceilings
keyed by exact binding ID and `'*'`. Per-study ceilings require `'*'` and cannot
loosen it. The shipped integrity-ceiling pack supplies the default floor; a
same-ID gate suppresses it only if proven to tighten its all-scoped upstream
semantics. Sources: `src/gates/floors.ts`, `src/gates/registry.ts`,
`agentic/code/addons/decision-engine/gate-packs/integrity-ceiling.gatepack.yaml`.

## 5. Evaluation, insufficiency and refusal

`evaluateGates` accepts a binding, real `GateRegistry`, trusted binding digest,
sealed holdout, metrics, sealed upstream (or null), floors and injected `now`.
It resolves from an authored snapshot through the pure resolver, re-deriving
pins/composition/parameters rather than accepting caller resolution or trusting
overridden registry resolution methods. Core-only evaluation performs no I/O;
bundle providers require isolated re-execution. Source: `src/gates/evaluate.ts`.

The closed kinds are `interval-bound`, `paired-difference`, `bootstrap-bound`,
`count-max`, `count-min`, `value-threshold`, `minimum-n`, `evidence`, `predicate`
and `upstream-ceiling`. Intervals use Wilson/Clopper-Pearson, paired intervals
Newcombe/Tango, and bootstrap a pinned seed. Confidence levels are two-sided
levels whose interval edge is used as a bound. Sources: `src/gates/types.ts`,
`src/gates/evaluate.ts`, `src/gates/stats/`.

- Pass contributes PROMOTE; observed failure takes `onFail` (HOLD or ROLLBACK);
  insufficient observations and unknown predicates contribute HOLD. Invalid
  proportion counts or inconsistent paired support are insufficient. Empty
  scopes cannot promote vacuously. Sources: `src/gates/evaluate.ts`,
  `src/gates/registry.ts`, `schemas/gates/GatePack.v1alpha1.schema.json`.
- Severity combines as `PROMOTE < HOLD < ROLLBACK`. The maximum of gate outcomes,
  upstream integrity and binding ceiling wins. Upstream-ceiling gates mirror
  integrity: compromise rolls back, allowlist deficiencies hold, clean may
  promote. Their `onFail` cannot soften or escalate that verdict. Sources:
  `src/gates/lattice.ts`, `src/gates/upstream-ceiling.ts`, `src/gates/evaluate.ts`.
- References are reported, not extra gates. A paired gate's `statistic.vs`
  names its reference; the observation already contains the contrast. Evaluation
  does not reconstruct pairs from reference metrics. Sources:
  `src/gates/registry.ts`, `src/gates/evaluate.ts`.
- Preconditions **refuse** with an error instead of manufacturing HOLD: bad
  schema/pins/policy, unpinned metric sections, caller resolution, missing floors,
  bad seals/times and absent upstream when a resolved gate requires it. Floors
  may be `'none-explicit-opt-out'` for documented test/legacy use; omission
  refuses. Sources: `src/gates/schema.ts`, `src/gates/registry.ts`, `src/gates/evaluate.ts`.

Binding `holdoutAccessedAt` is deprecated and ignored. The sealed holdout's
`frozenDigest` is the **binding** digest and must match its trusted pin. Freeze
must strictly precede access; neither may follow evaluation. Null access is
allowed only without split/corpus/gold digests. `sealGateHoldout` and
`sealUpstream` are unkeyed integrity seals, not authentication; these low-level
inputs remain caller-trusted. Sources: `src/gates/types.ts`, `src/gates/evaluate.ts`.

## 6. HeldoutFrozen entry point (shipped)

`src/gates/heldout.ts` exports `sealGateHoldoutFromFrozen` and
`evaluateGatesFromHeldoutFrozen`. The latter overrides caller binding-pin and
holdout inputs with values derived from verified records. The adapter checks:

1. `frozen.digest === heldoutDigest(frozen.bundle)`.
2. The analysis containing `gateBinding` matches preregistration's
   `studyAnalysisDigest`.
3. The signed access record matches independently retained `trustedAccessDigest`,
   analysis digest, frozen-bundle digest and approval run ID, then verifies its
   signature against the host-selected keyring.

It derives the binding digest from `analysis.gateBinding`, seals it with
`access.firstTestAccessAt`, then calls the core evaluator. Frozen-bundle and
binding digests are different anchors. Historical HeldoutFrozen bytes are not
changed. Source: `src/gates/heldout.ts`.

These checks do not replace full collector approval, corpus or calibration
validation. `readHeldoutFrozen` validates the bundle; D29 scoring verifies
prepared study/context. Sources: `src/decision/heldout/calibration.ts`,
`src/decision/heldout/contract.ts`, `tools/decision/studies/d29-scoring.mjs`.
See [the boundary guide](https://github.com/jmagly/aiwg/blob/main/docs/decision/heldout-gate-boundary.md).

## 7. Signed first access (#3747, shipped in 2026.10.16)

The governed `decision-d29-access/v2` record contains `runId`, `analysisDigest`,
`frozenBundleDigest`, `anchoredAt`, `firstTestAccessAt`, `reference` and
`signature: { keyid, sig }`. All fields except `signature` are canonicalized
and signed using existing effect-ledger `LedgerSigningKey.signPae` and DSSE
payload type `application/vnd.aiwg.decision-d29-access+json`. Sources:
`schemas/decision/D29Study.v10.schema.json`, `src/decision/heldout/access.ts`,
`src/effects/keys.ts`.

For staged D29 test collection, the collector signs and durably writes
`access.json` before dispatch. `anchoredAt` comes from the verified calibration
phase seal. Configured delivery-ledger trust supplies the key; absent/inactive
trust refuses. Offline fixtures inject throwaway trust. Scoring verifies
existing records and never signs or repairs them. Sources:
`src/decision/heldout/collector.ts`, `src/decision/heldout/calibration.ts`,
`src/decision/heldout/journal.ts`, `src/decision/heldout/access.ts`,
`tools/decision/studies/d29-scoring.mjs`.

Signatures are checked against key validity/revocation at `firstTestAccessAt`.
Unsigned historical v1, unknown keys, invalid signatures/keyrings and
out-of-window keys refuse; rotations preserve earlier valid signatures. The
protected host must independently select the keyring and retain anchors. This
authenticates what that host recorded, not an independent clock, absence of
earlier access, or protection from signer backdating/key compromise. Sources:
`src/decision/heldout/access.ts`, `src/gates/heldout.ts`, `src/effects/keyring.ts`,
`test/unit/gates/heldout.test.ts`, `test/unit/decision/d29-access.test.ts`.

## 8. D29 adoption and limits

D29 is the shipped study adopter. Its v6/v7/v8 preparation embeds absolute
screening bindings over `aiwg:decision-engine/absolute-screening` and
`aiwg:decision-engine/integrity-ceiling`, using `decision.screening/v1`.
Criteria include absolute error/coverage/accuracy/support bounds, blocking-slice
zero-false-ready ROLLBACK, calibration evidence and a HOLD ceiling. `always-review`
is the reference; passage baselines remain diagnostic. This is not a shipped
paired non-inferiority gate against always-review. Sources:
`tools/decision/studies/d29.mjs`, `tools/decision/studies/d29-preparation.mjs`,
`agentic/code/addons/decision-engine/gate-packs/absolute-screening.gatepack.yaml`.

`evaluateStudyGates` uses HeldoutFrozen and loads project floors, rejecting caller
floors/opt-outs. `buildReport` caps native fail/insufficient at HOLD, preserving
gate ROLLBACK. Its offline calibration attestation is caller-asserted;
authoritative `score` derives attestation through D09 qualification and requires
project config, review and protected anchors. Sources:
`tools/decision/studies/d29-gates.mjs`, `tools/decision/studies/d29-scoring.mjs`,
`tools/decision/studies/d29-provenance.mjs`. These controls do not certify live
success or permit public seed collection; see
[signed-access disposition](https://github.com/jmagly/aiwg/blob/main/docs/decision/d29-signed-access-disposition.md)
and `src/decision/heldout/contract.ts`.

## 9. Discovery, CLI and providers

`gatePacks` / `entry.gatePacks` and `gate-packs/*.gatepack.yaml|yml|json`
contribute packs for frameworks/addons/extensions. HITL `gates/*.yaml` is
separate. Safe paths, realpath containment, regular-file and size checks guard
loading. Sources: `src/extensions/manifest.ts`, `src/gates/discovery.ts`,
`src/artifacts/index-builder.ts`.

`aiwg gates validate|evaluate|show|list|coverage` and discover/show `gate-pack`
ship offline. Unverified `--pack-dir` inputs cannot impersonate shipped
namespaces; an explicit `--aiwg-root` override refuses evaluation. CLI evaluation
uses caller-pinned binding/sealed files, loads floors and labels reports
`offline-cli`. Report-file validation without trusted replay context is not
full replay validation. Sources: `src/gates/driver.ts`,
`src/cli/handlers/gates.ts`, `src/gates/report.ts`.

Five core metric providers ship (`src/gates/providers/index.ts`). Bundle
`gateProviders` require explicit opt-in and project allowlist matching
bundle/provider/code digest/reviewer/time. The loader snapshots static relative
`.mjs` dependencies into permission-restricted child execution. Evaluation
re-runs pinned code on pinned records, replacing caller metrics; missing runtime
coverage refuses. Live qualification and CLI records-file re-execution remain
pending. Sources: `src/extensions/manifest.ts`, `src/gates/floors.ts`,
`src/gates/providers/loader.ts`, `src/gates/providers/isolated-child-source.ts`,
`src/gates/evaluate.ts`, `src/gates/driver.ts`.

## 10. Verification ownership

Core/schema/inheritance/floor/provider/discovery contracts live under
`test/conformance/gates-v1/`. Public heldout/access boundary regressions live in
`test/unit/gates/heldout.test.ts`, `test/unit/decision/d29-access.test.ts` and
`test/unit/decision/d29-gates.test.mjs`. These synthetic/offline contracts do not
establish live qualification. Future migrations must preserve historical
decision/integrity fixtures as parity evidence.

## 11. Still proposed: study, qualification and runner bindings

| Issue | Existing owner and proposed change | Required boundary |
|---|---|---|
| #2834 D23 | `src/decision/sensitivity/comparative.ts`, `tools/decision/comparative-replay.ts`: express comparative replay non-inferiority/error bounds/integrity as a GateBinding. | Same retained-corpus decisions; preserve slice/support/budget/reproduction checks, reviewer-pending HOLD and compromise ROLLBACK. Helper reuse is not binding adoption. |
| #2835 D17 | `src/decision/ensemble-study/protocol.ts`, `schemas/decision/D17StudyProtocol.v1.schema.json`, `src/decision/ensemble-study/score.ts`: remove duplicated threshold ownership through bindings. | Historical artifacts stay reproducible; diagnostic study stays never-PROMOTE. Its separate calibrated D09 promotion route does not upgrade the study verdict. |
| #2836 qualification | `src/decision/qualification/gates.ts`, `manifest.ts`, `runner.ts` in that directory: express G0–G6 through bindings. | Offline fixture parity; retain derived evidence/hash verification, mandatory missing-evidence failure and release integrity ceilings (`src/decision/qualification/release.ts`). No live-qualification claim. |
| #2837 runners | `tools/decision/context-live-qualification.mjs`, `dag-live-qualification.mjs`, `egress-live-qualification.mjs` and their `src/decision/` qualification owners: bind existing runner criteria. | Retained/synthetic fixture parity; preserve approval, privacy, spend, freshness and integrity boundaries. No live dispatch/default activation follows from ADR acceptance. |

Shared statistics/lattice/upstream imports do not complete these migrations.
Release-plan items 16/17 follow operator acceptance of item 15; #2836/#2837
remain alternates. Authoring/rule coverage already exist
(`docs/decision/gate-pack-authoring.md`, `src/rules/gate-references.ts`,
`src/rules/gate-coverage.ts`); ecosystem rollout/live evidence remain outside
this draft.

## 12. Open operator decisions

1. **Accept this ownership/trust boundary?** Options: accept, request amendments
   or defer. **Recommendation:** accept after review while retaining experimental
   opt-in operation and the distinction between caller-trusted core inputs and
   verified HeldoutFrozen entry. Accepted by the operator on 2026-10-30.
2. **Approve D23/D17 migration scope?** Options: fixture-parity migrations in
   that order, defer, or expand behavior. **Recommendation:** #2834 then #2835
   after acceptance, preserving historical decisions, integrity ceilings and
   D17's diagnostic never-PROMOTE boundary (section 11).
3. **Schedule qualification/runner adoption?** Options: take #2836/#2837 as
   offline parity follow-ups, retain as release alternates, or expand to live
   work under separate approval. **Recommendation:** retain as alternates with
   offline parity scope; approve scheduling separately. Acceptance supplies no
   live-run, promotion or default-activation authority.
