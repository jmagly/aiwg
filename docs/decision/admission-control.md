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

Queued cancellation rejects before an adapter call. Active cancellation uses the evaluator's composed caller, total-deadline, and target-deadline signal. Retry waits and fallback scheduling re-check that same signal and the single invocation attempt budget. Durable receipt v2 has one pending-dispatch slot, so receipt-backed execution deliberately stays at concurrency 1 until a later receipt schema can atomically represent multiple pending dispatches.

Admission controllers are shared for calls that reuse the same scheduler policy object. Long-running hosts should therefore construct a qualified, versioned policy once per workspace/provider profile rather than accepting request-authored profiles.

## Rollout

1. Keep `enabled: false` and binding concurrency 1 by default.
2. Run the pinned offline load manifest below with fake adapters and fake time.
3. Enable a shadow profile and compare queue, retry-amplification, and breaker evidence.
4. Canary a bounded provider profile below its documented capacity.
5. Roll back at a run boundary by restoring the previous policy object or setting `enabled: false`.

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
