# Calibration registry and runtime compatibility

Calibration artifacts are immutable, reviewed evidence records keyed by the complete evidence-producing identity: provider, backend, actual model, primitive, definition digest, adapter version, dataset and slice hashes, and calibrator parameters. A compatibility relation is the only supported way to reuse an artifact for a different identity.

`evaluateDecisionRuleset` can be given a `calibrationCompatibility` runtime binding. After an adapter reports its actual model, but before primitive acceptance runs, the evaluator resolves and pins a compatibility decision for that invocation and evaluation alias. An `exact` or `approved-compatible` decision with action `allow` may retain calibrated risk only when its reference names the pinned artifact ID or digest. Unknown, drifted, expired, insufficient, retired, or otherwise non-allow decisions remove only the derived calibrated-risk field. Raw probability, confidence, and distributions remain intact. A policy requiring calibrated risk therefore follows its explicit non-action route.

Compatibility decisions are included in `DecisionResult.spec.calibrationCompatibility`. Telemetry exposes the bounded state, action, artifact pin, alias revision, and reason count; it does not export dataset contents, prompts, calibration parameters, or individual examples. Registry resolution is credential-free and deterministic. The registry pins by the evaluator's run, invocation, and alias scope, so later alias movement cannot alter an active result.

## Limitations

- Calibration is a population estimate, not a correctness guarantee for an individual decision.
- Vendor confidence and a low expected calibration error are not sufficient evidence for automated action.
- Dataset leakage, public-corpus contamination, selection bias, distribution shift, and thin slices can invalidate measured performance even when registry identity matches.
- The deterministic fixtures exercise plumbing only. They are not product-quality evidence and must not be used to select production thresholds.
- Production use requires representative held-out workflow data, preregistered total and per-slice sample or power rules, confidence intervals, selective-risk and calibration bounds, explicit approval, and expiry.
- Model discovery endpoints are observations, not compatibility authority. The immutable registry and reviewed relations are authoritative.
- This layer records compatibility and enforces threshold eligibility. It does not run benchmark qualification or operational promotion, shadowing, drift response, or rollback workflows. The D17 contracts that consume its eligibility, rollback and drift records are described in [ensembles and drift response](ensembles.md); their runtime is not implemented.

## Promotion and rollback evidence

`CalibrationGovernanceReceipt.v1` is the durable handoff between registry eligibility and the
operational workflow owned by D17. Each receipt records the exact alias revisions and identity
digests moved between, the reviewed evaluation-integrity report, calibration artifact, optional
compatibility relation, approval, action, reasons, and time. The file store uses exclusive
sequence publication, fsync, and a previous-receipt digest chain. Existing records are never
rewritten; a sequence race, gap, changed payload, or broken chain fails closed. These receipts
are evidence of an authorized registry transition, not permission for this package to execute
deployment or routing changes.

Qualification artifacts carry named `CAL-*` and `DRF-*` IDs from their case's `evidenceIds`.
The verifier compares those IDs with the digest-protected artifact, preventing a manifest from
claiming calibration or drift coverage that the runner did not persist.

The checked-in [cross-product fixture](../../test/fixtures/decision/calibration-compatibility-cross-product-v1.json),
[qualification manifest](evidence/calibration-qualification-v1/qualification-manifest.json), its retained
[evaluation report](evidence/calibration-qualification-v1/evaluation-report.json),
[calibration artifact](evidence/calibration-qualification-v1/calibration-artifact.json),
[compatibility relation](evidence/calibration-qualification-v1/compatibility-relation.json), and
[rollout record](evidence/calibration-rollout-v1.json) are the retained offline qualification sources
for D09. The executable TV-10 case changes every compatibility-key dimension, retains the
requested alias and both observed model versions, and links its named `CAL-*`/`DRF-*` evidence to
those sources by digest. The rollout record pins the observed champion, shadow candidate, immutable
held-out inputs, preregistered and observed sample counts, approval, limitations, and the append-only
promotion/rollback receipts. Every record is explicitly fixture-only and makes no production
calibration or safety claim.
