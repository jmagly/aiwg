# Decision context planning

`src/decision/context-plan.ts` provides an offline, transport-independent preflight for Jev-compatible requests. Call it after authorized state projection and compatible-batch formation, but before credential resolution, provider admission, or network dispatch.

The planner consumes a versioned provider profile and an estimator with an exact identity/version match. It calculates the aggregate `state + all questions + envelope` constraint independently from `state + longest question + envelope`, applies a recorded safety margin to each limit, and splits only on question boundaries. Limits belong in the provider profile; current vendor values such as 64,000 and 32,000 are configuration, not constants in the planner.

Independent questions are canonically ordered by stable ID. Compatibility keys prevent unlike envelopes from sharing a request. Declared dependencies become deterministic execution waves, so partitioning cannot turn a dependent question into speculative same-wave execution. Every partition repeats the same authorized-state digest and subject identity.

Oversized state or single-question inputs raise `ContextPlanError` synchronously. Nothing is truncated, summarized, or dropped. `incompleteContext` remains visible in the plan and forces `automaticActionAllowed: false`.

Before dispatch, call `assertContextPlanCurrent`. Any authorized-input, authorization-digest, estimator, profile-version, limit, margin, or envelope change produces `stale-plan`; replan rather than dispatching stale assumptions. After a provider response, `recordContextActualUsage` creates separate estimate-versus-actual evidence linked to the immutable plan digest.

Integration points still required in the shared runtime are:

1. Convert each eligible Jev batch group into `ContextPlanInput`, using projected-state evidence for `subject`, `authorizationDigest`, and `incompleteContext`.
2. Resolve a qualified `ContextProviderProfile` from the provider registry.
3. Plan and validate before credential lookup or adapter invocation.
4. Dispatch partitions in ascending wave order; resolve each partition's stable question IDs from the unchanged source group.
5. Prohibit automatic outcome application when `automaticActionAllowed` is false.
6. Attach the plan and `ContextActualUsageEvidence` to the sanitized decision receipt; neither contains state or question bodies.
