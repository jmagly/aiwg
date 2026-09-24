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

The initial checked-in fixture registry at
`test/fixtures/decision/qualification-fixtures-v1.json` records author, date,
permission, sanitization, origin, schema, expected outcome, trace links and
SHA-256 for five repository-authored goldens. The conformance suite re-hashes
all listed files; unlisted future fixtures must be added with their own
provenance before being used as release evidence.

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
