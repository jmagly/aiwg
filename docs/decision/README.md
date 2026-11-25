# Normalized decisions and rulesets

AIWG reads both `decision.aiwg.io/v1alpha1` and `decision.aiwg.io/v1alpha2` definitions as an opt-in shared runtime. The
same immutable decision definitions, ruleset, workflow input, and consumer can
run through a Jev binding or an ordinary LLM-subagent binding. Only the binding
changes; probabilistic values and confidence scales are not assumed equal.

The public TypeScript entry point is `aiwg/decision`. It provides schema and
semantic validation, RFC 8785-compatible pins, JSON Pointer projection,
three-valued predicates, deterministic composition, bounded retries and
fallback, receipt replay protection, and both adapter implementations. The
`decision-engine` addon packages the `decision-evaluate` dispatcher for
FlowGraph skill nodes.

Existing workflows are unaffected. Evaluation requires an explicit call and
binding; the packaged dispatcher additionally requires
`AIWG_DECISION_ENABLED=1`. Jev network use needs a logical credential mapping.
The standard test suite uses fixtures only. The live Jev smoke is separately
gated by `AIWG_DECISION_JEV_LIVE_SMOKE=1` and
`AIWG_DECISION_JEV_API_KEY`.

Single-question offload through `aiwg decision ask` is enabled by
`aiwg decision setup jev`; see the [Jev quickstart](jev-quickstart.md).

The dispatcher request is deliberately narrower than the TypeScript library.
Public request JSON can name artifact paths, adapter configuration, projection
policy files, credentials by environment-variable name, and trusted
`hostPolicies` references. Runtime objects such as receipt stores, schedulers,
context estimators, compile-cache implementations, result-cache services,
provider-prefix identity functions, and key services stay library or host
module capabilities. They are selected by trusted host code, not serialized in
model-authored JSON. Unknown or inline advanced policy fields are rejected.

Read the [normative specification](specification.md), [architecture](architecture.md),
[implementation and migration plan](implementation-plan.md), and addon
[operations guide](../../agentic/code/addons/decision-engine/docs/operations.md).

Structured entry fields, version migration, and rollback rules are described in
[structured entries](structured-entries.md).
The research design for [evidence-gated memory and prompt updates](memory-update-controls.md)
maps #3318 onto #3282–#3285 and proposes an H5 experiment with shuffled-memory
and earlier-task retention controls; it reports no measured improvement.
Probabilistic downstream feature export is described in
[feature export](feature-export.md).
The default-off conformal prediction research spike and its open-data v2
artifacts are described in [conformal prediction spike](conformal-spike.md).
Jev request, retry, cancellation, and egress behavior is documented in the
[transport contract](jev-transport.md). State projection is mandatory for
network-capable adapters; see [state projection](state-projection.md) and the
[threat-control mapping](threat-control-mapping.md). The
[egress live qualification runner](egress-live-qualification.md) prepares the #2680 live
credential, attack-movement and canary evidence; no live run has been performed.

The [ensemble, champion/challenger and drift-response contracts](ensembles.md)
define versioned D17 schemas, pure validators, and an experimental default-off
offline runtime with injected dispatch, registry and telemetry seams. Live
qualification and production rollout evidence remain pending. The
[source-only D17 held-out study](ensemble-heldout-study.md) adds a frozen
synthetic corpus, priced approval and blind-review forms, and paired report
scaffolding. Its only scope is uncalibrated diagnostics; D09 qualification,
calibrated gates and promotion are unavailable. Live observations and calibration
remain pending.

The [routing pilot](routing-pilot.md) defines D28 default-off,
capability-constrained route selection among already-eligible model/subagent
bindings. Shadow mode executes only the existing deterministic route and
records the Jev-assisted choice as a counterfactual. The pilot distinguishes
bounded Jev task-fit evidence from calibrated success probability, and keeps
hard constraints and ordinary authorization dominant over every routing result.

The [offline pattern playground](pattern-playground.md) provides discoverable,
sanitized examples and a governed authoring checklist without requiring network
access or a provider credential.

The [counterfactual sensitivity analyzer](sensitivity.md) defines default-off
experimental plans and reports for bounded policy replay and offline input
reevaluation. Reports are associative diagnostics only: they are not causal
explanations, correctness evidence, or action authorization.

The [issue triage shadow pilot](issue-triage-pilot.md) adds an experimental,
default-off offline harness for Jev issue classification and deterministic
duplicate reranking. It is shadow-only, writes no tracker mutations, and keeps
live holdout, human-review, and promotion evidence pending.
The experimental [SDLC evidence readiness screening](sdlc-screening.md) pack
adds default-off citation and phase-gate advisory screening. Deterministic
gate/citation checks remain authoritative, evidence facts are caller-asserted
and must come from those validators, and promotion needs record-computed
held-out evidence, including paired non-inferiority against the baseline. Live
held-out data is pending.

The [decision-assisted context pruning pilot](context-pruning.md) is
experimental, default-off and shadow-only by default. It implements
deterministic protected-item retention, immutable reversible receipts and
paired-evaluation scaffolding; live/held-out quality and economics evidence
remain pending.

Experimental [multimodal preprocessing lineage](preprocessing-lineage.md)
records how text-only decision input was derived from non-text sources using
recorded OCR, ASR, caption, or image-description fixtures. It is default-off,
does not add native media support to Jev, and stores receipt/trace references
   instead of raw media or derived text bodies.

Decision results are data, not authority. Any workflow action selected from an
outcome must pass the existing AIWG policy and approval gates independently.

[D23 offline comparative replay](comparative-replay.md) provides an experimental,
default-off synthetic report and 44-assessment operator audit scaffold. The
refreshed report passes its diagnostic gates but remains HOLD; independent
integrity and human review remain pending.

The experimental, default-off [shared held-out collector](heldout-collector.md)
provides source-only preparation, bounded synthetic collection and D11 recorded
ledger verification for D17/D29 study modules. Explicit diagnostic, staged
calibration/test, and pre-existing artifact bindings keep collection scope and
scorer identity separate from D09 qualification. Live studies, calibration, human
review and study-specific statistical reports remain pending.

The [D29 synthetic held-out study](d29-heldout-study.md) supplies a seeded
2,000-subject v7 public development demo with disjoint TRAIN/TEST wording
pools: tuning/calibration rows use train wording only, test rows use held-out
test wording only. Train-only passage baseline v3 is the primary comparator;
passage v2 remains as the same-wording solvability-ceiling diagnostic, with
passage v1 and the original baseline secondary. The audit learns singles,
pairs and greedy OR-of-5 lexicon rules on training folds, evaluates them on
held-out folds and the test split, and gates (not just reports) the model
score. The 165-assessment template covers every variant and all 16 train
injection phrasings in 50 development items; test phrasings never appear in
review. Staged calibration and test access still require separate
approvals and a reviewed D09 artifact. Experimental and default-off, the study
rejects public seeds through `d29-study-v7` and their pinned corpus digests for
paid collection. Live observations, calibration qualification and human review
remain pending.

The experimental, default-off [gates capability phase 1 core](gates.md)
adds declarative gate packs, a pure offline evaluator with digest-bound
reports, an exact Clopper-Pearson interval, and canonical-JSON evidence
digests with a versioned legacy mode. Packs are discoverable (`gate-pack`
in `aiwg discover`/`aiwg show`), declared per bundle (`gatePacks` manifest
field, `<bundle>/gate-packs/*.gatepack.yaml|json`) and exercised through
the offline `aiwg gates validate|evaluate|show|list` CLI; the bundled
`aiwg:decision-engine/integrity-ceiling` example pack validates. Project
floors from `aiwg.config` `gates` (including the shipped default
integrity-ceiling floor) are a required evaluator input; the opt-out is
explicit and documented. Addon/extension [bundle
providers](gate-providers.md) load only with an explicit opt-in and a
verified code digest plus review attestation. D29 is the first migrated study (absolute-screening pack, HOLD ceiling);
live criteria remain pending.

## D29 scorer-pin disposition (#3730, 2026-10-28)

The v6, v7 and v8 public synthetic demos were re-frozen because #3730 routes
D29 through the verified holdout entry point. The scorer pin changed from
`sha256:5f7d99de6c72c8ef6eb0dcf686e75c7e11990db2d638b08c5e673e4da0ddfc47` to
`sha256:90f899c3e6c02ae1107fef81ba2ff3992a5c3377a15c1e08ae2fb3e1b144fa49` in all three versions.
It is the SHA-256 of the current `tools/decision/studies/d29.mjs` bytes for
**every seed**. That entry embeds checked SHA-256 pins for the two modules extracted from it,
`d29-gates.mjs` and `d29-provenance.mjs`. Other modules on the scoring path
(the shortcut audits, calibration, generators and `src/decision/sdlc-screening.ts`)
are not covered by this pin; the shortcut audits carry their own per-version
`shortcutAudit.sourceDigest`.
The exact current-byte assertion in `V8-07` remains enforced.

Regeneration used the existing `prepare('d29-study-v6' | 'd29-study-v7' |
'd29-study-v8')` and `dryRun(prepared)` exports from that study, the same
path exercised by `V6-04`/`V6-05`, `V7-06` and `V8-07`. It made zero provider
calls. No corpus, gold, labels, analysis, memberships or review content changed.
Only these fields changed: `preregistration.json:/scorerDigest`,
`approval-template.json:/preregistrationDigest`, and
`dry-run.json:/scorerDigest,/preregistrationDigest,/approvalTemplateDigest`.
The fixture manifest (`test/fixtures/decision/qualification-fixtures-v1.json`)
changes only the nine corresponding file-byte digests.

For each file below, all JSON content outside those explicitly listed fields
compared equal before and after regeneration. `Byte-identical` also means the
full raw-file SHA-256 below is equal before and after. Paths are relative to
`test/fixtures/decision/`; SHA-256 values omit the `sha256:` prefix.

| Fixture file | Comparison | Unchanged file SHA-256 |
|---|---|---|
| `d29-synthetic-v6/analysis.json` | Byte-identical | `105994561813bf651bef885604e96841219b5e00a9913eae683f84feec453eb6` |
| `d29-synthetic-v6/approval-template.json` | Only `/preregistrationDigest`; remainder equal | — |
| `d29-synthetic-v6/corpus.json` | Byte-identical | `2a4ad43416dc3448e56d08287fec7e75b77bc7cbfce396f6308df7347fcae06d` |
| `d29-synthetic-v6/dry-run.json` | Only `/approvalTemplateDigest`, `/preregistrationDigest`, `/scorerDigest`; remainder equal | — |
| `d29-synthetic-v6/gold.json` | Byte-identical | `a81b0c8e25c670b48cb6e0a53fefa8073e7445138a29821b4775c85c8839e93b` |
| `d29-synthetic-v6/preregistration.json` | Only `/scorerDigest`; remainder equal | — |
| `d29-synthetic-v6/reviews.json` | Byte-identical | `53cddbb8a165cf8da2c391b2ecc2b11678c193a47bb4b262d6599a4d701b1ced` |
| `d29-synthetic-v7/analysis.json` | Byte-identical | `ddfee68203c5320aaca9651cdf1497c75cd4ba61c116a4c9ead6ef6fa1559b9d` |
| `d29-synthetic-v7/approval-template.json` | Only `/preregistrationDigest`; remainder equal | — |
| `d29-synthetic-v7/dry-run.json` | Only `/approvalTemplateDigest`, `/preregistrationDigest`, `/scorerDigest`; remainder equal | — |
| `d29-synthetic-v7/preregistration.json` | Only `/scorerDigest`; remainder equal | — |
| `d29-synthetic-v7/reviews.json` | Byte-identical | `9b5abd4311cb0aaf62e0691958d194516542310bab72944e9fa43fc2af57ef5f` |
| `d29-synthetic-v8/analysis.json` | Byte-identical | `3bd663e4d9fd33f6e8c70c409e496c872a1b5dc10b940e4674bb0b66370cfdff` |
| `d29-synthetic-v8/approval-template.json` | Only `/preregistrationDigest`; remainder equal | — |
| `d29-synthetic-v8/dry-run.json` | Only `/approvalTemplateDigest`, `/preregistrationDigest`, `/scorerDigest`; remainder equal | — |
| `d29-synthetic-v8/preregistration.json` | Only `/scorerDigest`; remainder equal | — |
| `d29-synthetic-v8/reviews.json` | Byte-identical | `0c1f3dc4d78b94d5d9dd1ee2f89f6402f056d653b6792b56020ddb68a7d887e9` |

Full regenerated corpus and gold rows are intentionally not added to the slim
fixtures. Their canonical digests reproduced the **pre-amendment** dry-run pins
below; gold includes every label. Analysis likewise reproduced its old pin
and is also byte-identical on disk, as shown above.

| Version | Unchanged corpus digest | Unchanged gold/labels digest |
|---|---|---|
| v6 | `sha256:4635395bac1c4efc036729879a831d8fd827b8b00d5b3e704b614135123c6549` | `sha256:cc96a3359b53cab0b20d083fb9fba11ac8fd6d3c7e06c4e943e3b9925536443e` |
| v7 | `sha256:c4a0f5d2a4000091cb435e75a3caca48ae0f4478b03f24a619132ce8bec260de` | `sha256:b175f64db211e5710c3fff11efa479f4797cf631a96913f3a65da366bd70044e` |
| v8 | `sha256:ecf148eaea5e7da9e65e481698e12b7d3ecbc431ded55e61cb2fb97a5f285dcf` | `sha256:bcad081be4d60051190c30f7c8275c73a638f4bd2766bcdeadb276ad6f099306` |

The v6 `corpus.json` and `gold.json` slim headers retain every historical pin.
The v7/v8 corpus and gold remain regenerated from their unchanged generators;
the full-content digest comparisons above cover their absent full fixtures.
Older v2/v3/v4 fixtures remain byte-identical.
