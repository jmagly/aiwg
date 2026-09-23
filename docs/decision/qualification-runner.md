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
other result surfaces still require independent canary scans before promotion.

Artifacts use `decision-qualification-artifact/v1`, live below a validated run-id directory,
and are written through a same-directory temporary file and atomic rename. Verification rejects
absolute paths, traversal, symbolic links, non-files, oversized content, digest mismatches, and
artifacts whose run, case, outcome, or schema identity differs from the evidence record.

`executeQualificationPlan` and `verifyQualificationArtifacts` are exposed separately for
orchestrators that persist or transfer a run between phases. `evaluateQualification` remains a
structural report evaluator for compatibility; callers must not treat direct, caller-assembled
manifests as release evidence. Release decisions use the combined executable pipeline or invoke
artifact verification immediately before evaluation.

The runner is adapter-neutral. TV01–TV25 can be registered as live, recorded, shadow, or offline
executors under the manifest's selected mode. A missing live credential or provider is evidence
absence/failure, never an inferred pass.
