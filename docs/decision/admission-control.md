# Decision scheduler and admission control

Decision evaluation remains serial unless `DecisionEvaluationRequest.scheduler.enabled` is explicitly true. When enabled, adapter calls are bounded by the minimum positive ceiling declared by the binding, caller, graph, authenticated principal, workspace, and provider profile. Completion timing never changes the ruleset's canonical evaluation order.

The host, rather than decision input or model output, supplies `principal.id` and `workspace.id`. These identifiers select fair internal lanes but are never included in evidence or metric labels. Evidence contains only bounded aggregate counts, estimates, queue delay, throttle reason, retry pressure, and circuit state.

Admission occurs before every adapter attempt. The controller applies, independently:

- concurrent-call limits;
- token-bucket request/minute and token/second limits;
- invocation-scoped attempt and monetary budgets, including fail-closed unknown-cost policy;
- an optional invocation-scoped cumulative token reservation (`maxTokens`), which rejects a dispatch without a token estimate as `unknown-tokens` and a dispatch that would exceed the reservation as `tokens`;
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

## Rollout

1. Keep `enabled: false` and binding concurrency 1 by default.
2. Run the pinned offline load manifest below with fake adapters and fake time.
3. Enable a shadow profile and compare queue, retry-amplification, and breaker evidence.
4. Canary a bounded provider profile below its documented capacity.
5. Roll back at a run boundary by registering the previous `profileVersion` or setting `enabled: false`.

No live provider qualification is required in CI, and no vendor ceiling is hard-coded.

## Preregistered offline load manifest

The initial qualification manifest is [`load-manifest.v1.json`](./load-manifest.v1.json). Its limits are preregistered inputs, not claims of measured provider capacity. A run is valid only when its result records the manifest digest before observations are collected. Changing a bound after observing results requires a new manifest version.

The v1 manifest byte digest is
`sha256:9c6db981b0e1d124e317651ed15e8972fbf27b7a7596b15aa23ea3baac4bb03f`.
The scheduler unit gate pins that digest, expands the declared load, spike, and
900-second soak durations into deterministic synthetic arrivals, and checks
active-call, canonical-output, and eligible-lane fairness bounds. It also runs
the 1/2/N/N+1 permit matrix and randomized completion schedules. Resident
memory, CPU utilization, wall-clock cancellation latency, retry amplification,
and provider capacity remain qualification-run observations; the synthetic gate
does not promote them into measured claims.
