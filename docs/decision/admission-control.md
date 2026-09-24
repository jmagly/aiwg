# Decision scheduler and admission control

Decision evaluation remains serial unless `DecisionEvaluationRequest.scheduler.enabled` is explicitly true. When enabled, adapter calls are bounded by the minimum positive ceiling declared by the binding, caller, graph, authenticated principal, workspace, and provider profile. Completion timing never changes the ruleset's canonical evaluation order.

The host, rather than decision input or model output, supplies `principal.id` and `workspace.id`. These identifiers select fair internal lanes but are never included in evidence or metric labels. Evidence contains only bounded aggregate counts, estimates, queue delay, throttle reason, retry pressure, and circuit state.

Admission occurs before every adapter attempt. The controller applies, independently:

- concurrent-call limits;
- token-bucket request/minute and token/second limits;
- invocation-scoped attempt and monetary budgets, including fail-closed unknown-cost policy;
- batch, request-byte, item, retained-work, waiter, queue-length, and queue-dwell bounds;
- provider-wide `Retry-After` pauses; and
- closed/open/half-open circuit-breaker transitions.

Malformed or negative host estimates fail closed as `invalid-estimate` before queue allocation or budget consumption; their values are not copied into admission evidence. Queued work is revalidated against the current host profile before dispatch, so a tightened policy rejects an item admitted to the queue under an older profile. Requests that cannot ever fit a token bucket (estimate above its per-second capacity) or a zero-request-per-minute bucket are permanently rejected rather than waiting indefinitely; temporary bucket depletion remains deferable.

Admission evidence counts other waiting requests in the principal lane, not the admitted request itself. The offline slow-client and profile-rollback regressions exercise queue expiry, capacity recovery, rejection of already queued work under tightened policy, and restoration for a new run. A real loopback HTTP slow-client test additionally holds an in-flight response, sheds queue overflow before network dispatch, and checks active permits while the slow response is released. These fixtures are not measured live-provider qualification.

Queued cancellation rejects before an adapter call. Active cancellation uses the evaluator's composed caller, total-deadline, and target-deadline signal. Retry waits and fallback scheduling re-check that same signal and the single invocation attempt budget. Durable receipt v2 has one pending-dispatch slot, so receipt-backed execution deliberately stays at concurrency 1 until a later receipt schema can atomically represent multiple pending dispatches.

An admission rejection happens before any adapter call, so the attempt is recorded as not sent. With a durable receipt store the receipt reaches its normal terminal state, and the attempt keeps the typed reason and the admission evidence: request and token buckets map to `rate-limited`, attempt and cost budgets to `budget-exhausted`, deadline and queue expiry to `timeout`, and batch, queue-length, and missing-provider rejections to `overloaded`. A provider named by a binding target but absent from `providers` is rejected as `unconfigured-provider`. Only an attempt that really was dispatched and whose outcome is unknown is recorded as `execution-uncertain`.

### Controller keying

Admission state is keyed by trusted scope, not by the identity of the policy object. The evaluator keeps one controller per `workspace.id` in a process-wide registry. Inside it, concurrency, request and token buckets, attempt and cost budgets, queues, `Retry-After` pauses, and breakers are counted per principal, per workspace, and per provider lane. Structurally equal policies built for each request therefore share every ceiling, and principals with equal limits never share each other's quota. Provider ceilings apply within a workspace. Cross-workspace or cross-process provider coordination is out of scope for the in-process controller.

The most recently registered `profileVersion` supplies a workspace's current limits, and queued work is revalidated against it before dispatch. A given `profileVersion` is immutable: a policy that reuses a revision already registered for the same workspace (or the same principal) with different limits fails closed as `invalid-definition` before any dispatch. Registering an earlier revision again is how a host rolls back.

Migration from object-identity sharing:

- Hosts that already reuse one policy object keep the same behavior.
- Hosts that build a policy per request now get the shared ceilings they declared. Before, each such request received a fresh, unshared controller.
- Every change to limits must publish a new `profileVersion`. Mutating a policy in place, or sending different limits under the same revision, is rejected.
- `principal.id` and `workspace.id` must remain trusted host identities. Two tenants that reuse a workspace ID share its admission state.
- An injected `now` clock is a test seam. Switching to a different clock function restarts the state of an idle workspace scope; a busy scope keeps its clock and counters.

### Retry backoff

In a scheduled run without a receipt store, a retry gives its evaluator scheduler permit back while it sleeps through backoff, and it regains a permit ahead of work that has not started. Another eligible lane can therefore dispatch during the delay, and active adapter calls still never exceed the ceiling. Serial runs and receipt-backed runs keep a strictly serial chronology, and their backoff continues to hold the single permit.

### Reserved capacity and share caps

Shared workspace and provider pools are first come, first served unless the profile says otherwise. Two limits bound a noisy principal whose own ceiling is at or above the shared one:

- `reservedConcurrency` on a principal's limits holds that many workspace and provider permits back for the principal. Other principals cannot take an unused reservation. A principal inside its own reservation needs only one free permit. The registry refuses a profile whose reservations add up to more than the workspace or any provider concurrency.
- `maxPrincipalShare` on workspace or provider limits caps one principal at `floor(share * concurrency)` active permits and `floor(share * maxQueueLength)` queued requests in that pool (at least 1 each). A principal over its queue share is rejected as `queue-full` without affecting other principals' ability to queue.

### Large-token fairness

When a request is deferred on a `tokensPerSecond` bucket, it becomes that bucket's reservation holder. Later requests in any lane must fit their own estimate plus the holder's before they can consume the bucket, so a stream of small requests cannot keep a large one waiting indefinitely. The reservation ends when the holder is admitted, cancelled, rejected, or expires, and the queue-dwell bound still applies to it.

### Breaker and admission telemetry

Each breaker transition (`closed` to `open`, `open` to `half-open`, `half-open` to `closed` or `open`) is recorded on the evidence of the attempt that caused it as `breakerTransitions`, kept in the controller's bounded `breakerTransitions()` history, and delivered to `DecisionAdmissionRegistry.onBreakerTransition` listeners. Each record holds the adapter lane, the states, the failure count, and a timestamp.

With `telemetry` configured, the evaluator emits one metadata-only `decision.admit` span for each attempt that carries admission evidence. The span includes the decision, reason, queue delay, active and queued counts, estimates, retry pressure, breaker status, and adapter ID. Breaker transitions appear as `breaker.transition` events. Its status is `ok` for admit, `unset` for defer, and `error` for reject. Metrics add `decision.admission`, `decision.throttles`, and `decision.breaker_transitions`, with the admission decision, reason, and breaker status as fixed-vocabulary dimensions. No principal or workspace ID reaches a span, an event, or a metric label.

### Profile-change audit

Every change of a workspace's current `profileVersion` produces a `decision-admission-profile-change/v1` record of kind `initial`, `change`, or `rollback`. The record holds the previous and new revision and a sha256 digest of the canonical workspace and provider limits. Registering a revision again for rollback reproduces its original digest. `profileHistory(workspaceId)` returns the bounded history, and `onProfileChange` delivers records to the host's audit log. The approval that goes with each change belongs in that log; see [`RUN-JEV-ADMISSION-v1`](./operations/admission.md).

## Rollout

1. Keep `enabled: false` and binding concurrency 1 by default.
2. Run the pinned offline load manifest below with fake adapters and fake time.
3. Enable a shadow profile and compare queue, retry-amplification, and breaker evidence.
4. Canary a bounded provider profile below its documented capacity.
5. Roll back at a run boundary by registering the previous `profileVersion` or setting `enabled: false`.

No live provider qualification is required in CI, and no vendor ceiling is hard-coded.

## Preregistered offline load manifests

The qualification manifests are [`load-manifest.v1.json`](./load-manifest.v1.json) and [`load-manifest.v2.json`](./load-manifest.v2.json). Their limits are preregistered inputs, not claims of measured provider capacity. A run is valid only when its result records the manifest digest. Changing a bound after observing results requires a new manifest version.

The v1 manifest byte digest is
`sha256:9c6db981b0e1d124e317651ed15e8972fbf27b7a7596b15aa23ea3baac4bb03f`.
Its unit gate expands the declared durations into synthetic arrivals and checks
active-call, canonical-output, and eligible-lane fairness bounds through the
bounded scheduler only.

The v2 manifest byte digest is
`sha256:416a41466dc58063f45b5e5e9a7ad78b011cf6d3be50b081bab6e47c76a28a0c`.
It pins per-scope concurrency, requests per minute, tokens per second, cost,
retained work, queue bounds, reservations, and share caps for one noisy and
four quiet principals over two provider lanes. It also pins a seeded bursty
Poisson arrival model (small and huge token estimates, service times, retryable
failures, cancellations) and bounds for active and queued calls, heap, CPU,
eligible-lane wait, retry amplification, cancellation latency, and the quiet
principals' admission ratio.

`runDecisionLoadHarness` (in `src/decision/qualification/load.ts`) releases
those arrivals on a fake-time timeline. The admission-controller path runs the
full 990-second load, spike, and soak schedule. The evaluator path runs the
first `evaluatorSampleSeconds` (the load phase and the spike) through
`evaluateDecisionRuleset` with fake adapters. Counts, active and queued maxima,
lane wait, retry amplification, and cancellation latency are deterministic under
fake time. Heap and CPU are host samples: heap is the harness isolate's peak,
and CPU is the harness thread's CPU time divided by the virtual timeline, so it
projects one-core utilization at the declared arrival rate. Process RSS is
recorded for information only, because the test runner shares the process.

Each run produces a digest-bound `decision-load-result/v1` record. The
retained records are in `docs/decision/evidence/load-offline-v2/`,
and the unit gate checks that a fresh run reproduces their deterministic
observations. Regenerate them with
`AIWG_DECISION_LOAD_EVIDENCE=write npx vitest run --config config/vitest.config.js test/unit/decision/scheduler-load-harness.test.ts`.

`decisionLoadEvidenceFlags` is the producer for gate G5. Offline
fake-provider records set only `load-manifest-offline-passed`. G5's
`load-manifest-qualified` flag requires a passing `staged-provider` record
bound to its own manifest, which is the staged live run tracked separately.
Offline evidence therefore never promotes G5.

## Test identifiers

Scheduler and admission tests carry stable IDs in their titles:
`CNC-SCHED-*` (bounded scheduler and backoff), `CNC-ADMIT-001`..`021`
(controller ceilings, queues, Retry-After, and breaker), `CNC-ADMIT-RECEIPT-*`
and `CNC-ADMIT-SCOPE-*` (durable receipts and trusted-scope keying),
`CNC-ADMIT-RESERVE-*`, `CNC-ADMIT-SHARE-*`, `CNC-ADMIT-TOKEN-*`,
`CNC-ADMIT-BREAKER-*`, `CNC-ADMIT-TELEMETRY-*`, `CNC-ADMIT-AUDIT-*`,
`CNC-ADMIT-DRILL-*`, and `CNC-LOAD-*`. The conformance suite keeps its
`CNC-ORDER-*` cases. The master test plan that originally listed `CNC-*` IDs is
not in the repository or artifact store, so these IDs have not been reconciled
against it.
