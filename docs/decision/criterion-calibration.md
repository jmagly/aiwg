# Offline criterion calibration on composition pilot outputs (#4240)

Owner: `eval-maintainers` (roctinam). The existing owners are
`tools/eval/datasets/contracts.v1.schema.json`, `src/contracts.ts`,
`src/pilot-files.ts`, `src/pilot.ts` and `src/pilot-report.ts` beneath `tools/eval/`.
The existing `eval.contracts` catalog entry owns the additive study/report
projections. There is no new schema family, CLI flag or production gate.

The frozen fixture is `test/fixtures/eval-pilot/calibration.v1.json`. Its criterion
registry adapts section9/research-papers signed commit
`7f92a62b99d62d14b9c3a4fe499087d654cf6234`,
`documentation/references/REF-3175-autorubric-criterion-evaluation.md` and
`documentation/analysis/projectfit-2026-11-16/REF-3175-autorubric-criterion-evaluation.md`.
These supplied analyses describe proposed protocols; they supply no AIWG model
experiment or human judgments. Their reported research results are not AIWG
measurements.

The initial regression run failed all six tests, first because the canonical
contract lacked `CalibrationStudy`, then because the calibration API was absent.
The implemented tests use synthetic votes and labels solely to verify arithmetic
and retention. They do not count as human annotation or reliability evidence.

## Authority and constructs

The existing hidden executable checker retains authority for corpus source/value
matching, coding behavior on edge cases, functional security results, permissions,
effects and transitions. Schema, content commitments, budgets and failed/partial
run status also remain executable. Nothing in the qualitative score changes their
verdicts or the #3315 blocked claim gate.

The existing pilot's asserted success criteria are executable; none is reclassified
as a qualitative judgment. The proposed qualitative measures are explanation support (Q1), faithful policy
explanation (Q2), qualitative scope coverage against an explicit checklist (Q3),
uncertainty communication (Q4), permitted recovery actionability (Q5) and defect
routing (Q6). Executable artifact correctness is excluded from their weights.
The frozen definitions record type, version, evidence, applicability, anchors,
weight and missing-evidence handling. Q1/Q2 are binary; Q3–Q5 use ZERO/HALF/ONE
mapped to 0/0.5/1; Q6 is nominal, weight zero, with no numeric category values.
Only Q5 permits N/A, when a trusted receipt explicitly states recovery is unneeded.
Fabricated evidence remains a separate critical flag.

The pilot's 48 tasks and eight arms yield 384 fixed output bundles, including
failed/partial outputs. They contain artifact responses, not qualitative
explanations. Policy receipts, explicit qualitative checklists, uncertainty
inventories and recovery alternatives are unavailable and recorded as null.
Missing evidence means CANNOT_ASSESS; no labels are fabricated from artifact
success, fluent prose or implicit satisfaction.

## Freeze and blinding

The study commitment covers definitions, prompt, source provenance, dataset
commitment, task contexts, family split and the complete saved-output bundle hash.
Hashes use the existing canonical JSON SHA-256 helper (not file-byte hashes).
Runtime validation rejects changed, duplicate, incomplete or mismatched outputs.
The original H1/H2 split remains intact. Calibration uses corpus-verification
only for development (16 tasks, 128 outputs); coding-repair and security-testing
are locked held-out families (32 tasks, 256 outputs). Related variants never cross
this boundary. Rubric-design and training examples must remain development-only.
Held-out examples in evaluator prompts are rejected, including unknown IDs.
This small, heterogeneous split cannot establish generalization to unseen families.

`blindedPacket(bundle)` exports only an opaque episode ID, evidence digest and
approved evidence. It excludes arm, task/family decoding and model identity.
Two domain-qualified humans must label independently without rubric judgments,
confidence or each other's labels; retain both raw labels. A distinct third
reviewer adjudicates with evidence and rationale. Annotation is NOT RUN here;
software cannot establish that a submitted annotator was human or truly blinded.

## Receipts and statistics

`calibrate(study, fixedRecords)` accepts archived inputs; it never invokes a
provider. The ordinary offline pilot also emits the empty calibration report.
Each evaluator retains observed model/vendor/family/revision, full prompt,
configuration/version, settings, prompt/configuration hashes and development
example IDs. Record the complete provider payload and resolved defaults in
settings; unavailable observations must say unknown. Each vote binds the same
immutable bundle and criterion version and preserves raw response/hash, evidence
IDs, rationale, secondary/critical flags, option order, execution/retry lineage,
tokens, latency and cost. Configuration hashes cover every recorded setting.
Hashes bind data; they do not authenticate a provider identity or a human.

Completed negative labels, NOT_APPLICABLE, CANNOT_ASSESS, provider errors, partial
responses and missing responses stay distinct. Partial/error responses cannot
supply a label. The last attempt in a validated retry chain is selected, and
retrying a completed judgment is forbidden; separately declared configurations
represent repeated-vote treatments. All attempts, including development,
calibration and discarded attempts, remain in raw evidence and total cost.
Never submit an unknown cost as zero; incomplete cost accounting prevents a
cost recommendation.

SKIP scores show original count/weight and retained numeric count/weight; nominal
Q6 never contributes. Empty retained weight yields null. Candidate tables expose
all held-out episodes, coverage, missing episodes, abstentions, all provider-error
and partial *attempt* counts, and paired reference-label denominators separately.
Known human applicability governs coverage; otherwise predicted applicability is
explicitly provisional. Incorrect N/A, unsupported abstention and missed
insufficient-evidence cases are counted separately. Confidence, if supplied for
binary criteria, is the probability of MET; report Brier score and its own n.

Binary metrics include confusion, sensitivity, specificity, precision, exact
agreement and unweighted kappa. Ordinal metrics include the full matrix, exact
and adjacent agreement, quadratic kappa and signed numeric bias. Nominal metrics
include per-class recall and macro-F1 over represented classes. Undefined rates
and degenerate kappa are null. Human agreement is pre-adjudication; raw uncertain
labels remain archived even when excluded from a type-specific confusion matrix.

Paired comparisons use identical saved bundles and report conditional shared
errors. Seeded 2,000-resample 95% percentile intervals resample entire scenario
families, preserving all nested task/arm observations. Two held-out clusters are
too few: intervals are descriptive and explicitly flagged. Separate configuration
IDs identify single-judge, calibration, shuffling, repeated and ensemble
treatments; never infer component effects from a combined treatment. The
standalone majority helper requires an absolute panel majority, counts abstaining
members in the denominator and returns CANNOT_ASSESS on ties. Raw panel-member
votes and membership/rule must be archived in a declared ensemble configuration;
there is no automatic cross-vendor panel or independence assumption.

## Measurement recommendation

**Insufficient evidence; retain executable checks and human assessment.** No
candidate is recommended and the claim gate remains BLOCKED. The fixture has no
observed evaluators, judge votes, human labels or adjudications; total evaluation
cost is $0 because no calls ran. No sensitivity, agreement or reliability estimate
from synthetic tests is presented as empirical evidence. Thresholds are explicitly
not predeclared, so the offline report remains insufficient even with imported
synthetic labels. A future version must preregister criterion-specific sensitivity,
false-positive, coverage and cost/latency bounds before examining locked human
labels, and collect enough independent families. Preserve failed calibration and
unresolved disagreements. Vendor diversity alone cannot qualify an evaluator.

## Collecting judge votes

The collector extends the existing eval CLI. It replays the committed pilot
locally, verifies the frozen rubric and output commitments, and sends only
`blindedPacket(bundle)` plus one versioned criterion. Each configuration gets
one completed judgment per packet/criterion. Repeated-vote experiments require
separate configuration IDs. This command plans 768 calls per configuration on
`dev`, or 1,536 on `heldout`; retry limits increase the maximum attempt count.

```bash
# Offline planning: no judge launches, HTTP requests or run-directory writes.
npx tsx tools/eval/src/index.ts judge-collect --evaluators test/fixtures/eval-pilot/judges.cli.json --run-dir /tmp/pilot-judge-dev --tranche dev --seed 4240 --max-calls 24 --dry-run

# Live collection (conductor only); rerun identically to resume.
npx tsx tools/eval/src/index.ts judge-collect --evaluators test/fixtures/eval-pilot/judges.cli.json --run-dir /tmp/pilot-judge-dev --tranche dev --seed 4240 --max-calls 24

# Raise the cumulative call cap to continue; the frozen configuration stays fixed.
npx tsx tools/eval/src/index.ts judge-collect --evaluators test/fixtures/eval-pilot/judges.cli.json --run-dir /tmp/pilot-judge-dev --tranche dev --seed 4240 --max-calls 48

# Held-out collection uses its own directory, never development prompt examples.
npx tsx tools/eval/src/index.ts judge-collect --evaluators test/fixtures/eval-pilot/judges.cli.json --run-dir /tmp/pilot-judge-heldout --tranche heldout --seed 4240 --max-calls 24

# Optional paid HTTP judge: configure the desired model in a copy of this JSON.
# OPENROUTER_API_KEY must already be exported by the operator; do not put it in JSON.
npx tsx tools/eval/src/index.ts judge-collect --evaluators test/fixtures/eval-pilot/judges.http.json --run-dir /tmp/pilot-judge-http --tranche dev --seed 4240 --max-calls 12 --max-usd 0.50
```

Choose a fresh run directory and keep archives private. Configure the named
AIWG groups and review role before collecting. For every CLI attempt the
collector executes the stdout of this resolver invocation unchanged:

```text
aiwg models resolve --role <role> --task review --group <group> --brief <file> --workdir <dir> --final-output <file> --transport shell --format shell
```

The brief asks for a JSON judgment with `label`, `evidence` (approved span IDs),
`rationale`, `critical_flags`, `secondary_flags` and optional `confidence` (MET
probability). If a CLI enforces the workerClaims wrapper, put this JSON as the
JSON-encoded `summary`. A fresh empty workspace for every attempt keeps local
pilot identities and previous votes outside the judge workdir. Harnesses must
honor that workdir and avoid reading the parent archive.

`study.json` is both the atomic resume state and a `CalibrationStudy` archive
accepted directly by `calibrate(archive, fixedRecords)`. Each attempt directory
also retains the prompt, resolver output, stdout, stderr, final and normalized
vote. Observed identities unavailable through the transport say `unknown`;
requested model names never count as observations. Exact prompts, settings and
raw payloads have canonical JSON SHA-256 hashes in each vote. CLI resource
accounting is unknown unless supplied by a supported transport; zero is never
substituted. A missing final, malformed/partial final, provider error and completed
abstention remain different statuses. All attempts count against `--max-calls`.
`--max-attempts` defaults to two; completed judgments are never retried.

For HTTP, `max_call_usd` is the operator's conservative per-attempt reservation,
not a provider-enforced price guarantee. Before each call the remaining budget
must cover it. Reported cost replaces the reservation; unknown cost consumes the
whole reservation. An unexpectedly higher invoice can exceed the requested cap
by the last call; set a provider account spending limit for a hard monetary
ceiling. Unknown accounting blocks any cost recommendation. Neither authorization
headers nor environment credentials enter the archive. Tests override HTTP only
with a loopback fixture server.

The collector checkpoints before dispatch. After an interrupted process it
recovers a committed `vote.json`; without one it stops with `in-flight` for
operator reconciliation, avoiding a duplicate paid judgment. A leftover
`collector.lock` also requires operator review before removing it. Do not remove
it while the collector is active.

The pilot's executable artifact correctness labels are archived separately as
`executable-reference`, with pinned check references, outcome hash and output
status. They never enter `humans`, adjudications, or Q1–Q6 reference denominators.
None of the frozen qualitative criteria is decidable from those checks; all six
are listed as needing human labels. No human labels are generated, and the
original insufficient-evidence claim gate remains blocked.
