# Durable decision review

`DecisionReview` is an append-only, project-scoped workflow record between probabilistic evidence and an effect. Evidence and policy pins are immutable. Editing an action creates a new proposal version and invalidates prior proposal approvals.

The review service permits only explicit state-machine operations. Reviewer eligibility and action authorization are separate callbacks and are rechecked at resume time. Approval records accountable human judgment; it does not establish model correctness, grant permission, or bypass current policy.

Resume stores only a SHA-256 digest of its secret token and derives a stable effect ID from the review, continuation, and approved proposal. Executors must honor that effect ID idempotently. A completed effect receipt is returned for every authorized duplicate resume without invoking the executor again. A `resuming` lease prevents concurrent local execution. After its deadline, a restarted service **does not replay** an uncertain effect: the caller must supply a trusted `reconcile(effectId)` callback returning the already completed, identity-matching receipt. Until reconciliation returns such a receipt, resume fails closed and the effect remains uncertain. A stable ID alone cannot prove the remote executor did not already run. The durable store preserves every authenticated revision, rejects history mutation, and uses atomic publication for concurrent transitions. Persisted executor errors use a fixed failure class, never an exception message containing private data.

## Crash recovery audit (opt-in)

The recovery sequence is **crash → refresh the authorized workspace session index → audit the exact prior session → inspect authenticated `.aiwg` effect evidence → reconcile or remain uncertain**. `auditedReviewReconciler` supplies an offline/testable adapter for `resume`'s reconciliation callback. Its host-provided catalog must verify coverage of the *specific* previous session after hydration; a healthy SQLite index or global coverage ratio does not prove that the preceding session was imported. The catalog audit locates a matching effect attempt by workspace, session, review and effect ID. Only a scoped executor-side ledger that authenticates and verifies a completed receipt may attest completion. A transcript claim, a dispatched tool call, a missing event, or a generated candidate cannot establish the result or justify replay.

Use the `aiwg sessions` public API to discover and preview only histories authorized for the workspace, then import the exact reviewed manifest if appropriate. Shared provider roots require separate authorization; do not broaden discovery to fix incomplete coverage. Resolve the canonical artifact destination with `aiwg artifacts path --json --check-write` before inspecting or persisting `.aiwg` payload. Catalog status `partial`, `stale` or `unavailable` for the relevant preceding session, absent/contradictory attempt evidence, or a missing verified ledger receipt leaves the effect unknown and prevents automatic execution. The helper does **not** implement a production catalog importer or ledger; the host must supply both trusted interfaces, including scoped lookup and authentication. The service still checks the receipt's continuation and proposal identity before persisting it. Use only synthetic evidence in offline tests; never replay prior session tool calls.

Review presentations should contain approved projections and references, not credentials, unrestricted provider payloads, private reasoning, or vault locations. Reads and exports are object-authorized; list results are project-scoped and omit unauthorized objects, and all three use non-enumerating null/empty results. Deletion appends a tombstone rather than erasing authenticated history or permitting ID reuse, and is denied under legal hold. Tombstones are hidden from ordinary reads/lists but remain available through explicitly authorized export and audit listing.

Existing callers that stop on a `RulesetResult` with `status: review` remain
unchanged. `durableReviewInputFromRuleset` is an explicit, side-effect-free
migration bridge: it returns null unless enabled, accepts only a review result
with a proposed outcome, and derives immutable source, evidence, and policy
pins. The caller must still authorize and create the durable review through the
service.
