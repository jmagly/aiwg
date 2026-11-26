# Jev confidence under wording shift (#2872)

Decision recorded 2026-11-23: **Keep the `aiwg decision ask` default threshold
at 0.8 and document the wording-shift caveat.** Per-shape thresholds are not supported
by the available evidence. Retaining 0.8 preserves the existing routing policy;
it does not establish an 80% correctness guarantee.

## Evidence available in this checkout

The cited `.aiwg/research/d17-multifact-results-2026-10-06.md` is
missing from this checkout. No equivalent D17-MF observations are committed under
`docs/decision/evidence/`. This is the spend-free caveat-only disposition required
when those results are unavailable, not a completed offline re-analysis.

Recovery audit, 2026-11-25: searched the current repository, including ignored
paths (excluding dependencies, build output and credentials), and all locally
reachable git refs. `.aiwg/research/` is absent. The exact report path has no
history in `git log --all --oneline -- <path>`. Searching D17, multifact,
`score.json` and observation paths in `git rev-list --objects --all` found
source, schemas, study documentation and synthetic tests, but no run observations
or score artifact. Deleted `.aiwg/research/` paths include the corpus
externalization commit `bb5da2652`, but no D17-MF report or run data. Nothing was
recovered from that history. This audit cannot establish absence on other hosts,
in external storage or in unreachable git objects; the 2026-10-30 issue comment
reports the rows and `score.json` missing on both titan and noodle.

The following are **issue-reported, unverified observations** from #2872, retained
to explain the risk; they have not been independently reproduced here:

| Reported slice | Raw accuracy | Calibrated accuracy | Mean calibrated confidence | Calibrated ECE |
| --- | --- | --- | --- | --- |
| Overall | not supplied | 0.8835 | 0.9629 | 0.0794 |
| pool-c, 1-hop, yes | 0.7727 | 0.3455 (95% interval 0.2632–0.4382) | 0.9286 | 0.6748 |
| Faithful `halts` cell | not supplied | 0.10 | not supplied (confidence minus accuracy +0.7629) | not supplied |

The issue reports nine unreliable calibrated cells: confidence minus accuracy
exceeds 0.10 and the calibrated-accuracy upper bound is below mean confidence.
The pool-c example shows that applying the pool-b member calibrator can reduce
accuracy under wording shift. Overall averages cannot establish reliability in
each pool. These summaries do not provide row-level confidence or accepted-answer
risk at any candidate `ask` threshold.

## Native confidence and question shapes

Source owners inspected before this decision:

- `src/decision/ensemble-study/multifact.ts`: pools and the two-option `yes`/`no`
  choice definition. D17-MF tests binary entailment through a choice primitive;
  it does not directly test `ask --yes-no` or general multi-option choices.
- `src/decision/ensemble-study/multifact-study.ts`: raw accuracy uses native
  P(yes), while mean confidence and ECE in the reported calibrated section use
  the registered mapping. Its pool-b fit is explicitly documented in source.
- `src/decision/ask.ts`: native yes-no confidence is `max(p, 1-p)`; native
  choice confidence is the selected option's distribution mass, falling back
  to provider confidence. `ask` does not apply the D17 member calibrator.
  Confidence acceptance checks agreement and mean confidence against 0.8.
  Reported aggregate confidence is their product, a stability signal.
- `tools/decision/d17-multifact.mjs`: offline study CLI and sealed-source,
  calibration-binding and expiry checks.

Native `ask --yes-no` reliability across pool-a, pool-b and pool-c is unknown.
Native `ask` multi-option choice reliability across those pools is unknown.
The supplied calibrated metrics must not be relabeled as native-confidence
measurements. Repeated agreement also cannot establish calibrated correctness:
repeated requests can share the same wording-sensitive error.

The 2026-10-07 issue comment supplies four native `ask` field outcomes on
jev-1.13.0: one evidence-matching choice answered at 0.93, one security-sensitive
choice fell back, and a review-sufficiency judgment fell back in both yes-no and
three-way choice wording. These are reported routing outcomes, with no correctness
labels or native confidence values for the fallbacks. They cannot estimate
accuracy, calibration, or error risk conditional on acceptance, nor prove a
difference between factual and judgment-shaped questions.

## Operational caveat and threshold decision

Wording-shift caveat: confidence does not transfer across wording; do not use it
as a calibrated probability of correctness. A high-confidence answer can be wrong after a paraphrase,
including when the intended facts and answer shape are unchanged. Treat `ask`
confidence as a routing signal. Use independent answer validation or ordinary
local reasoning for unfamiliar wording or consequential decisions; do not let a
threshold replace deterministic checks or required approvals.

Neither increasing the global threshold nor choosing a per-shape threshold is
justified by these aggregate calibrated summaries. A higher cutoff can still
accept confident errors, and the accepted subset's risk is unknown. No threshold,
configuration, CLI behavior, or other provider behavior changes in this decision.
Revisit the default only after native-confidence risk/coverage curves are
available for each question shape and wording pool with held-out uncertainty
bounds and an explicit acceptable error rate.

## Recalibration and expiry follow-up

The documented registered D17 artifact expired at **2026-11-01T10:02:34.263Z**;
see [D17-MF calibrated evaluation](d17-multifact-study.md#calibrated-evaluation).
Do not extend or backdate that artifact to use it now. Existing collection and
scoring expiry checks remain authoritative. This expiry concerns the D17
calibrator, not the native `ask` score, which does not load that artifact.
Any renewed collection needs a newly reviewed preregistration and expiry binding;
preserve the historical D17-MF expiry pins rather than bypassing their guards.

Wording-diverse recalibration is warranted for any renewed claim that a D17
mapping transfers across pools. It is not evidence for fitting or deploying a
new `ask` calibrator now. The follow-up design is:

1. If the original report and sealed attempts are recovered, recompute native
   and mapped accuracy, confidence gaps, ECE, and accepted-answer
   risk/coverage by pool and shape offline. Keep binary-choice study results
   separate from native yes-no and multi-option choice results; mark absent
   observations unknown. Preserve the original report and artifact identities.
   If recovery remains impossible, retain this caveat-only decision and plan a
   separately approved new study; never reconstruct observations from aggregates.
2. Specify separate development, calibration and held-out evaluation sets with
   disjoint latent subjects and wording templates. Include pool-a/b/c grammar
   families plus unseen paraphrases, negation, contrastive and non-connective
   relations, missing links, relay-off, faithful controls and multiple hop counts.
   Balance labels within pools. Cover native yes-no and multi-option choices
   separately, varying option count, order and descriptions. Choose sample counts
   before collection to meet the existing profile minima and per-slice risk
   interval precision; never tune on held-out wording.
   Freeze the corpus, oracle labels, slice counts, acceptance error target and
   analysis plan before any new collection. Synthetic entailment can use the
   existing text oracle; subjective review/worker choices need independent human
   correctness labels. Retain per-row native scores, answers, labels, wording
   pool and shape, attempt and model identities, plus the scored report and digests.
3. Refit the existing member mapping on the diverse calibration split, pin
   model/adapter/definition, dataset and mapping digests, and compare with native
   scores on untouched held-out pools. Register a replacement only after the
   existing calibration profile and review gates pass, including worst-slice
   risk at proposed cutoffs. Failed or unsupported slices stay unqualified.
4. Give the replacement a new effective time and at most the existing 30 days
   lifetime. Revalidate before expiry and on model, adapter, definition or
   wording-population changes; refit and review a new artifact when needed.
   Expiry or failed qualification means no calibrated-routing claim for that
   artifact, not automatic renewal.

No new collection, model calls, training or artifact renewal was performed.
New collection needs operator approval and provider access/spend; subjective
labels need human annotators. These are future prerequisites, not work run here.
The missing report and attempts block the native per-pool characterization and
any evidence-derived numeric threshold recommendation.
