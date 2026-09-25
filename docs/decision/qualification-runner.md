# Executable decision qualification

`executeAndEvaluateQualification` is the promotion-capable qualification path. It closes the
gap between a candidate test inventory and evidence by running registered case executors and
gate checks, persisting each result, independently re-reading the artifact, and only then
evaluating G0–G6.

The runner accepts no evidence outcomes, digests, or evidence-flag booleans from its caller.
It derives them from executions. Execution is bounded to 1–32 concurrent cases, per-operation
timeouts of at most ten minutes, and artifacts of at most 4 MiB. Default bounds are four
concurrent cases, 30 seconds, and 256 KiB. Missing executors produce non-executable `skip`
evidence, while exceptions and timeouts produce executable failures. Executor exception
messages are never persisted: artifacts use the fixed `executor-failed` class. Callback
`details` are dropped by default. Callers may select public aggregate fields with
`sanitizeDetails`; a sanitizer exception fails the case without persisting its message.
Synthetic `privacyCanaries` also fail the case and suppress selected details if their
serialized representation contains a canary (including escaped strings). These checks
only protect runner artifacts; stdout/stderr, traces, receipts, snapshots, exports, and
other result surfaces require explicit capture and scanning before promotion. Supply
`privacyCaptures` for all eight named surfaces (including empty observations) and
nonempty `privacyCanaries`; the runner derives `privacy-scan-clean` from
`scanQualificationPrivacy` and ignores any claimed positive flag from a callback.
Absent or invalid captures fail G2 closed. Capturing streams and errors for the
full execution lifetime is still the caller's responsibility; empty synthetic
captures are not proof that a live workload is private.

## Gate evidence: derived flags and backing artifacts

No G0–G6 evidence flag is taken from a caller. `evidenceChecks` callbacks named after any
flag in `DERIVED_GATE_EVIDENCE` are never invoked, and `evaluateQualification` recomputes
those flags from the manifest even when a caller-assembled manifest sets them. Callbacks
remain available for auxiliary flags and for the blocking findings listed below, which can
only make a gate fail.

| Gate | Flag | How it is derived | Backing evidence |
|---|---|---|---|
| G0 | `case-inventory-complete` | `validateCaseInventory` over the run's cases; the G0 gate separately requires a passing, digest-bound artifact for every C01–C42 and TV01–TV25 case | case inventory and case artifacts |
| G1 | `runtime-suite-complete` | every case in `DECISION_GATE_SUITES['runtime-suite-complete']` passed | case artifacts |
| G2 | `security-suite-complete` | every case in the security suite (C29, C30, C32, C34, C36, C39) passed | case artifacts |
| G2 | `privacy-scan-clean` | `scanQualificationPrivacy` over all eight captured surfaces | runner privacy scan |
| G3 | `immutable-splits` | a `decision-binary-benchmark-plan/v1` whose digest recomputes and whose splits pass `verifyQualificationSplits` | split plan artifact |
| G3 | `calibration-qualified` | an approved `decision-calibration-artifact/v1` whose digest recomputes, whose `splitProvenance.hash` is the accepted split-plan digest, that is in effect at `generatedAt`, and whose metrics meet its own profile | calibration artifact |
| G4 | `fault-suite-complete` | every retry, fallback, cancellation and receipt case (C13–C18, C24, C27, C28, C33, C37, C38, C42) passed | case artifacts |
| G4 | `drift-suite-complete` | TV10 passed and its artifact names every `DRF-*` ID in the drift suite | case artifacts |
| G5 | `load-manifest-qualified` | a `decision-load-result/v1` that embeds its load manifest, whose `manifestDigest` is the canonical digest of that manifest, and whose observations are within every bound | load result record |
| G6 | `evidence-hashes-verified` | set only by `evaluateExecutedQualification` after every case and gate artifact re-verifies on disk | verification pass |
| G6 | `review-decision-recorded` | a `decision-qualification-review/v1` with `decision: approve` for the same run ID and source commit and the run's `qualificationOutcomesDigest` | reviewer decision record |

Pass the artifact-backed sources as `gateArtifacts` (a file path per flag). The runner
validates each against the run, copies it to `<runId>/gates/<flag>.json` and pins its
SHA-256 in `manifest.gateArtifacts`. An invalid or absent artifact leaves the flag false.
`verifyQualificationGateArtifacts` re-reads and re-validates the copies, and
`evaluateExecutedQualification` drops any that fail, so tampering after the run fails both
the owning gate and G6. `qualificationOutcomesDigest` covers case IDs, outcomes and named
evidence but not artifact digests, so a reviewer can sign the outcome set before the final run.

Blocking findings (`p0-correctness-failed`, `execution-uncertain`, `privacy-denied`,
`calibration-data-missing`) still fail G1, G2, G3 and G6 when a check reports them.

## Aggregate run

`test/conformance/decision-v1/qualification-aggregate.test.ts` registers every executable
vector module from `test/conformance/decision-v1/vectors/registry.ts` in one run over all 67
cases. It fails when a case with a coverage hint has no registered executor, when an
executor is defined in the decision test trees outside the registry, or when a registered
executor does not pass with a verified digest. Unit tests in
`test/unit/decision/qualification-runner.test.ts` use trivial callbacks to exercise runner
mechanics only; they are not vector evidence.

The aggregate test also runs a full-lifetime privacy scan. `captureQualificationLifetime` records
stdout, stderr (stream writes and console output) and any thrown error for the whole run.
The test adds the other surfaces from real outputs:

- telemetry spans (trace);
- a `FileDecisionReceiptStore` directory (receipt);
- a `decisionResultForExport` copy (export);
- every runner artifact (snapshot);
- the evidence manifest (test report).

It scans all eight surfaces for the credential values handed to adapters. It then derives
`privacy-scan-clean` through `withQualificationPrivacyScan`, so the flag still comes from the
scanner. The capture is process-wide and does not see child processes. Run the
qualification alone and collect child-process output separately.

With every vector registered, the aggregate run passes G0, G1, G2 and G4 from recorded evidence.
G3, G5 and G6 fail because held-out data, a load result and a reviewer decision are live inputs
tracked in #2684. The test builds a release record that must be `HOLD`.

### Retained exact-commit release record

`docs/decision/evidence/d11-aggregate-release-v1/` retains the aggregate release record from one
offline run at commit `e37fdd5ba056f9cd797e1681f349c49a325c943b`. The run used a `git archive`
export of that commit, so the source tree was clean (`dirty: false`). The directory holds:

- `release-record.json`, the `decision-qualification-release/v1` record;
- `evidence-manifest.json`, the evidence manifest for the main run;
- `cache-compilePrefixCache.json`, `cache-receiptReplay.json` and `cache-resultCache.json`, the
  three cache-layer manifests. Each one's SHA-256 is the matching release pin.

`test/conformance/decision-v1/qualification-release-evidence.test.ts` (`D11-REL-01` to
`D11-REL-04`) re-verifies the record's own digest, commit and clean state, and its
regeneration command. It also checks all 67 cases as verified passes and the gate statuses: G0,
G1, G2 and G4 pass, and G3, G5 and G6 fail on the #2684 live inputs, so the decision is `HOLD`.
Finally it checks that the per-case hashes match the evidence manifest and that the cache pins
match their manifests. Every file is in the fixture provenance registry. To regenerate, export a
clean commit, set `AIWG_D11_RELEASE_OUT` and `AIWG_D11_SOURCE_COMMIT`, and run that test file.
The pipeline itself is in `test/conformance/decision-v1/aggregate-release.ts`.

### Wall-clock exemptions (AC5)

Default tests use fake clocks and barriers. Two tests keep a real wall-clock wait because they
wait for another operating-system process:

- `job-crash-process.test.ts` polls until a spawned child has synced its dispatch fence, then
  sends it `SIGKILL`.
- `job-quota.test.ts` waits for a spawned child to publish its lock, then sends it `SIGKILL`.

The child's progress is not driven by the test's clock, so a fake timer cannot advance it. The
timers only bound a hung child and never decide an outcome. Both tests are legitimately
process-based and stay as they are.

### Vendor vectors and named suites

`test/fixtures/decision/vendor-vectors-v1.json` defines TV01–TV25. Each entry has a basis in the
#2604 research text, the assumption it implements, any recorded synthetic exchanges, and the
exact expected normalized outcome or failure class. `vectors/vendor.ts` executes TV02, TV06,
TV07, TV09, TV12–TV21 and TV23–TV25 from that catalog. TV12 is limited offline to the context
planner limits and the retained-comparison gate.

Named suites travel as evidence IDs on the case that runs them. Each gate suite requires its IDs
on passing evidence:

| Suite | Where it runs | Gate |
|---|---|---|
| `CON-*` contract conformance | inside C36 | G0 |
| `BCH-INVALID-ANSWER-01`, `CTX-*` | TV02, TV12 | G1 |
| `SEC-ADV-*` override, false-authority, delimiter and fake-system slices; `SEC-EGRESS-01`, `SEC-RESPONSE-01`, `SEC-REQUEST-ID-01` | TV25, TV21, TV24, TV19 | G2 |
| `RTY-*`, `CAN-*`, `CNC-*` | TV13–TV17 | G4 |
| `DRF-OUTPUT-01`, `DRF-POPULATION-01`, `DRF-LABEL-01`, `DRF-INSUFFICIENT-01` | TV20 | G4 |

`measureCategoricalDrift` reports total variation and a smoothed population stability index
against preregistered bounds. `measureLabelStability` reports repeated-run label movement and
calls it stable or drifting only when the whole 95% Wilson interval is on one side of the bound.
Both return `insufficient-evidence` rather than `stable` for small samples. The M01–M11 amendments
are linked to the G2 and G4 suites through `DECISION_GATE_SUITES[*].amendments`, and
`amendment-traceability.test.ts` checks that link against
`docs/decision/qualification-traceability.md`.

Artifacts use `decision-qualification-artifact/v1`, live below a validated run-id directory,
and are written through a same-directory temporary file and atomic rename. Verification rejects
absolute paths, traversal, symbolic links, non-files, oversized content, digest mismatches, and
artifacts whose run, case, outcome, or schema identity differs from the evidence record.

`executeQualificationPlan` and `verifyQualificationArtifacts` are exposed separately for
orchestrators that persist or transfer a run between phases. `evaluateQualification` remains a
structural report evaluator for compatibility; callers must not treat direct, caller-assembled
manifests as release evidence. Release decisions use the combined executable pipeline or invoke
artifact verification immediately before evaluation.

`freezeQualificationSplit`, `verifyQualificationSplits`, and `evaluateBinaryHeldout` provide
an offline binary-classification slice report over exactly the hashed held-out membership.
They reject overlapping/missing rows, invalid probabilities and negative resource usage;
unknown cost stays unknown, and zero accepted samples have `null` selective risk.
The report includes Brier/log loss, decile calibration error, Wilson error interval,
coverage/review rate, nearest-rank latency quantiles, calls/retries/fallbacks and token/cost
sums. `freezeBinaryBenchmarkPlan` hashes all tuning/calibration/test label and slice
memberships together with preregistered minimum sample counts and maximum selective
risk, review rate and Brier bounds. `evaluatePreregisteredBinaryBenchmark` requires a
**separately anchored** trusted plan digest and rejects label/slice drift before held-out
scoring; too few held-out rows or no accepted samples cannot pass. The digest must be
published by a trusted reviewer before test labels/predictions are available; passing a
self-created plan digest is not independent preregistration or representative evidence. `evaluateOrdinalHeldout` scores exact matches and normalized/absolute level error;
`evaluateRankingHeldout` measures pairwise concordance, counting predicted ties as errors
and reporting `null` when gold has no comparable pairs. These are not calibration
approvals: sample-size, pre-registration, slice adequacy, policy thresholds, and independent
held-out provenance still need qualification before G3 can pass. `measurePairedMovement`
reports changed-output rate with a Wilson interval for matched control/perturbation
or repeated-run IDs; it is not a correctness metric and does not prove that
an injected answer was safe.

The fixture registry at `test/fixtures/decision/qualification-fixtures-v1.json`
records author, date, permission, sanitization, origin, schema, expected outcome,
trace links and SHA-256 for every file under `test/fixtures/decision/`,
`agentic/code/addons/decision-engine/examples/` and `docs/decision/evidence/`.
`fixture-provenance.test.ts` re-hashes each entry. It fails on any
file that is not in the registry and on any entry whose file no longer exists. It also checks that
every source a registered vector binds as evidence is in the registry. Entries whose inputs are
reconstructed carry an `assumptions` list. The vendor vector catalog is one of them: the
source vendor research document is not in the repository.

The generic runner accepts offline, recorded, and shadow executors under the manifest's
selected mode, but does not authenticate their origins. For `live` it deliberately emits
`live-evidence-unavailable` skips without invoking any generic callback: a mock response
cannot be relabelled live. A separate bounded, provider-authenticated live evidence path
is required before live conformance can qualify. Missing live credentials or a provider
cannot be inferred as a pass.

`buildQualificationReleaseRecord` accepts an independently verified runner result
and the serialized #2037/#2048 eval-integrity fields. It binds commands,
environment, source commit/dirty state, reviewer, resource budgets/actuals and
SHA-256 pins for definition/ruleset/binding/adapter/models/policy/calibration/
dataset/split/seed/price catalog. D30 compile/prefix-cache, D03 receipt replay,
and D15 result-cache pins must be distinct. The record carries per-case evidence
hashes, G0–G6 results, an integrity-gated `PROMOTE`/`HOLD`/`ROLLBACK` decision,
and its own SHA-256; `qualificationReleaseSummary` produces a terse human view
without private captures. Promotion additionally requires a passing held-out
benchmark with a matching externally anchored plan digest and preregistered
minimum sample count; missing, mismatched or insufficient benchmark evidence
forces HOLD. It cannot upgrade an integrity HOLD/ROLLBACK or a
compromised/dirty/unverified run. The caller must obtain integrity metadata from
the actual protected artifact snapshot and trusted scoring workflow: synthetic
unit metadata is not release evidence.

The record also serializes the AC8 held-out metrics (`metrics`: overall and per-slice metrics,
repeated-run stability, injection sensitivity) and the protected-artifact snapshot digest
(`integritySnapshot`). Promotion requires both. When `cacheLayers` is supplied,
`deriveCacheLayerPins` derives the `compilePrefixCache`, `receiptReplay` and `resultCache` pins.
Each pin is the digest of a verified evidence manifest from its own run: D30 compile/prefix
reuse, D03 receipt replay and D15 result caching. A supplied pin that disagrees with its
evidence is rejected, and the three layers must come from different runs.
