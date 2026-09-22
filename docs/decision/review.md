# Durable decision review

`DecisionReview` is an append-only, project-scoped workflow record between probabilistic evidence and an effect. Evidence and policy pins are immutable. Editing an action creates a new proposal version and invalidates prior proposal approvals.

The review service permits only explicit state-machine operations. Reviewer eligibility and action authorization are separate callbacks and are rechecked at resume time. Approval records accountable human judgment; it does not establish model correctness, grant permission, or bypass current policy.

Resume stores only a SHA-256 digest of its secret token and derives a stable effect ID from the review, continuation, and approved proposal. Executors must honor that effect ID idempotently. A completed effect receipt is returned for every duplicate resume without invoking the executor again. The durable store preserves every authenticated revision, rejects history mutation, and uses atomic publication for concurrent transitions.

Review presentations should contain approved projections and references, not credentials, unrestricted provider payloads, private reasoning, or vault locations. Deployments remain responsible for object-level authorization, retention, deletion/tombstones, legal hold, redaction, and access-audited sensitive views.

Existing callers that stop on a `RulesetResult` with `status: review` remain
unchanged. `durableReviewInputFromRuleset` is an explicit, side-effect-free
migration bridge: it returns null unless enabled, accepts only a review result
with a proposed outcome, and derives immutable source, evidence, and policy
pins. The caller must still authorize and create the durable review through the
service.
