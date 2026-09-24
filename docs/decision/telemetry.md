# Decision telemetry contract

`decision-telemetry/v1` is a dependency-free OpenTelemetry-compatible mapping for the decision lifecycle. It is an explicit hook, not implicit logging: an evaluator may emit spans through `DecisionTelemetryHook`, but exporter failure cannot change a decision, authorize an action, or replace the durable receipt.

## Span hierarchy and correlation

One W3C trace covers a workflow invocation. `decision.workflow` is the root; children may include `resolve`, `validate`, `project`, `admit`, `batch.request`, `attempt`, `normalize`, `accept`, `compose`, and `persist`. Review, cache, durable job, evaluation, continuation, and approved-action audit records use span links so they remain one audit chain without creating a second identity universe.

AIWG trace and span IDs are random W3C IDs. Provider request IDs are bounded opaque attributes only: they are never trace IDs, metric dimensions, authorization material, or public-export fields.

The evaluator records spans live. `evaluateDecisionRuleset()` opens `decision.workflow` before validation, opens each `decision.attempt` before dispatch and closes it when the adapter observation arrives, and opens `decision.batch.request` before a shared native-batch transport call. `normalize` and `accept` are recorded when each evaluation result is produced; `compose`, `review` and `persist` are recorded with the terminal result. Spans are buffered in start order and flushed once, after the result is final, so an exporter never observes a partial trace. An attempt whose outcome is never observed (for example an execution-uncertain dispatch) is closed with status `error` and the workflow's terminal reason rather than being dropped. A result-cache hit records only `decision.workflow` and `decision.cache`: historical attempts are not replayed as new work.

Propagation crosses these boundaries:

- **Adapter and transport.** `DecisionAdapterRequest.traceContext` carries the live attempt span's `traceparent`; `DecisionAdapterBatchRequest.traceContext` carries the batch request span's. The Jev adapter forwards a well-formed `traceparent` header and drops anything else. Vendor `tracestate` never crosses a provider boundary.
- **Durable invocation receipt.** When telemetry is enabled, the D03 invocation receipt records the workflow span's `traceparent` as the optional `traceParent` field at acquisition. The field is immutable across transitions, is validated as W3C `traceparent`, and is covered by `FileDecisionReceiptStore`'s HMAC. An invocation that replays an existing receipt links its workflow span to that origin (`relationship: continuation`).
- **Durable batch receipt.** A batch receipt created with telemetry enabled stores the workflow span's `traceparent` as the immutable `traceParent` field. A later invocation that replays the receipt dispatches nothing and links its workflow span back to that origin (`relationship: batch`).
- **Async job item.** A host continues a job item by passing the dispatching `decision.job` span context as `telemetry.parent`; the item's workflow becomes its child.
- **Review continuation.** `DecisionReviewService` spans use the configured `telemetry.parent` (normally the originating workflow or its `decision.review` span).

## Field dictionary

| Attribute | Source | Meaning |
|---|---|---|
| `aiwg.run.id`, `aiwg.invocation.id` | client-derived | Workflow identities |
| `aiwg.decision.id/version`, `aiwg.ruleset.id/version`, `aiwg.binding.id/version` | client-derived | Immutable artifact pins |
| `aiwg.adapter.id/version` | client-derived | Selected adapter pin |
| `gen_ai.request.model` | client-derived | Requested alias/model |
| `gen_ai.response.model` | provider-fact or unknown | Actual served model |
| `aiwg.provider.request_id` | provider-fact or unknown | Sanitized internal correlation only |
| `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` | provider-fact or unknown | Provider request usage |
| `aiwg.usage.cost_usd` | provider-fact, client-derived, estimate, or unknown | Cost; provenance is mandatory |
| `aiwg.decision.status/reason` | client-derived | Terminal status and reason |
| `aiwg.acceptance.*` | client-derived | Versioned acceptance route |
| `aiwg.batch.id/mode` | client-derived | Batch correlation, never a body-derived ID |
| `aiwg.usage.scope` | client-derived | `shared-request` on the batch request span that owns usage; `batch-answer` on answer spans that carry none |
| `aiwg.route.fallback` | client-derived | True on an attempt or batch request that used a fallback target |
| `aiwg.review.id/status/event/revision` | client-derived | Durable review lifecycle |
| `aiwg.operator_decision.event_id` | client-derived | #1567 operator-audit event ID on review spans for approval, denial, escalation and authorization denial, and on the action span for the approval that authorized it |
| `aiwg.link.state`, `aiwg.link.tombstone` | client-derived | `deleted` or `orphaned` link marker and its tombstone reference |

Unknown values remain `null`; they are never rewritten to zero. Derived cost must name its catalog version. Per-answer allocation is optional, marked `estimate`, names its allocation method/version, and must reconcile exactly. Shared provider usage is recorded once on `decision.batch.request`, while answer spans link to it.

`recordBatchReceiptTrace()` is the bridge from the durable batch receipt to telemetry, and the evaluator calls it for every batch plan that owns a durable receipt. It emits one request span for each dispatched attempt, including consumed failed retry/fallback attempts, and no usage for a `not-sent` attempt. When the evaluator already opened a live request span for an attempt, the bridge fills that span, so the `traceparent` sent to the transport and the span that holds the receipt's accounting are the same. Without a durable receipt, the live request span records the single transport response's shared usage. Each answer's `decision.attempt` span links to its request span with `aiwg.usage.scope = batch-answer` and no token, cost or provider request fields. Provider-authoritative and client-derived costs retain distinct provenance; bounded or unknown costs remain `null`. Question and answer identifiers are represented only by bounded counts, so request-level accounting cannot become duplicated per-answer telemetry.

## Privacy and redaction

Metadata-only is the default. Only schema-declared attribute keys cross the boundary; arbitrary keys are dropped even if they appear harmless. Attribute keys matching state, question, prompt, response/answer body, authorization, API key, credential, vault locator/hash, secret, cookie, access token, or private reasoning are dropped. Values are control-character stripped and bounded. Public export removes provider request IDs and vendor `tracestate`, drops unrecognized event names (only `retry.scheduled` and `attempt.terminated` are exported), and removes matching canaries from span attributes, event/link attributes and tombstones when supplied to `sanitizedTelemetryExport()`. Configure canary scanning on disclosure; without supplied canaries, the scanner cannot detect arbitrary PII hidden in an otherwise allowed metadata field.

Sensitive debug capture is disabled unless a policy is explicitly authorized and specifies encryption, an opaque key reference, access-audit sink, confidential/restricted classification, positive TTL, and deletion support. A trace may contain only the sidecar's opaque reference. Never record chain-of-thought.

## Metrics and exporter behavior

Metrics use fixed names and bounded dimensions. Supply `telemetry.metrics` with a `BoundedDecisionMetrics` instance to record workflow throughput/duration, attempt/retry/fallback/error counts, known request-level token/cost usage and review counts from evaluator spans. `recordDecisionSpanMetrics()` also accepts independently constructed batch/cache spans; shared batch usage is counted only on the request span, not linked answer attempts. Queue/admission delay, coverage/abstention and drift require separately supplied metadata and are not emitted automatically by the evaluator. Dimensions use fixed enumerated values by default. Adapter ID/version and requested/actual model dimensions are **dropped** unless an operator supplies explicit known-good values as the third `BoundedDecisionMetrics` constructor argument (for example, `{ 'aiwg.adapter.id': ['jev'] }`); do not construct that allowlist from request input. The distinct-series and point caps still apply. Run, invocation, decision/question, provider-request, user, tenant, body-derived and arbitrary error strings are prohibited dimensions.

The bounded exporter has a fixed queue, deadline, diagnostic ring and per-trace serialized byte limit (default 65,536 bytes; set `maximumTraceBytes` to lower it). Oversized/malformed traces are dropped without throwing into the decision path; full queues drop new telemetry, and timeouts and failures are visible diagnostics. Queue capacity and trace byte bounds constrain serialized content, not JavaScript object overhead or transient serialization allocations. There is no telemetry retry loop and no path from telemetry to the decision result or an effect authorization. Durable receipt persistence retains its independent fail-closed semantics.

`DecisionOtlpHttpSink` is an opt-in OTLP/HTTP JSON transport for trusted telemetry traces. Supply an explicitly approved, credential-free HTTPS collector endpoint ending in `/v1/traces` and a positive request-byte limit; wire the sink into `BoundedDecisionTraceExporter`, whose deadline and queue capacity remain mandatory. It serializes sanitized spans, events, links, and typed attributes, never follows redirects, and reports transport failures through the exporter's bounded diagnostics. It does not discover collectors or read environment credentials. The sink now inspects at most 4 KiB of a successful collector response and fails when OTLP reports rejected spans or malformed partial-success metadata; it never emits the collector's response text. IP literals and `.localhost` destinations are rejected at construction. The default native HTTPS transport resolves all DNS answers for each connection, rejects the whole answer set if any address is non-global (including loopback, RFC1918, link-local, reserved, mapped IPv4, and non-global IPv6), and pins the accepted address to that TLS connection while verifying the original hostname. It disables connection pooling and never follows redirects. Injecting `fetch` bypasses this DNS policy and is **only for controlled tests**. This does not protect against a compromised public collector, proxy interception, DNS answers pointing at public addresses under attacker control, or collector-side forwarding. Do not deploy through a proxy or with custom DNS/transport overrides without separate qualification. Collector deployment and incident drills remain unqualified outside controlled tests.

## Review and operator-audit correlation

Review and action spans are not a second audit identity. Each `decision.review` span for an approval, denial, escalation or authorization denial carries `aiwg.operator_decision.event_id`, which is the #1567 operator-decision record's `event_id`. The `decision.action` span carries the event ID of the approval that authorized the effect and links to its review span. When the review service has both `operatorAudit` and `telemetry.parent`, and the host's correlation omits `trace_id`, the #1567 record's `correlation.trace_id` is bound to the parent's W3C trace ID, so the audit chain and the trace join on one identifier. The host must pass the same parent on every service instance for that review; replay compares correlation exactly.

## Golden traces

`test/unit/decision/telemetry-golden.test.ts` executes every scenario in `test/fixtures/decision/telemetry-golden-v1.json` against the real evaluator, job, cache and review runtimes with offline fakes and deterministic IDs: `OBS-001` single success, `OBS-002` heterogeneous native batch (with receipt replay), `OBS-003` retry, `OBS-004` backend fallback, `OBS-005` invalid output, `OBS-006` caller cancellation, `OBS-007` execution uncertainty, `OBS-008` policy review, `OBS-009` cache hit, `OBS-010` async job item, `OBS-011` approved action with the #1567 approval/denial/escalation join, `PRV-001` sanitized incident export and `PRV-002` orphaned links. Each run also checks parent/child chronology and that no input canary or provider request ID survives sanitized export.

## Retention, deletion, and export

Trace, debug sidecar, export, and linked review/job/cache/evaluation TTLs must be positive. Deletion is denied during legal hold. Otherwise links become explicit tombstones rather than broken or reused references. Backup/restore must reapply TTL and tombstone state before records become queryable. `tombstoneOrphanedLinks()` handles links whose target was never exported or has since expired or been deleted elsewhere: a link that does not resolve inside the trace or through the supplied resolver becomes `aiwg.link.state = orphaned` with a tombstone, and the operation is idempotent. Sanitized export keeps the link state.

Use `sanitizedTelemetryExport()` and run `scanTelemetryCanaries()` before disclosure. Example queries:

- retry rate: group `decision.attempt` by `aiwg.adapter.id` and terminal reason;
- fallback latency: filter attempts with ordinal greater than one and compare duration;
- review chain: follow `review` and `action` links from the workflow trace;
- batch cost: sum only spans where `aiwg.usage.scope = shared-request`.

Schema additions are backward compatible within v1. Removing/changing meaning or privacy posture requires a new schema version and a migration note. Rollback disables exporters, not mandatory receipts or provenance.

Operational response uses the versioned runbooks in [`docs/decision/operations/README.md`](operations/README.md), listed in the closure manifest `docs/decision/operations/closure-manifest.v1.json`. Treat these as distinct triggers:

| Trigger | Runbook |
|---|---|
| Telemetry loss (export backlog, drops, trace continuity) | `RUN-JEV-TELEMETRY-v1` |
| Suspected data egress through telemetry, collector or provider | `RUN-JEV-EGRESS-v1` |
| Credential compromise, including collector or provider credentials | `RUN-JEV-CREDENTIAL-v1` |
| Incident-evidence preservation and sanitized handoff | `RUN-JEV-INCIDENT-EVIDENCE-v1` |

The security incident template at `agentic/code/extensions/sec/templates/security-incident-runbook.md` and the forensics evidence-preservation flow remain the general incident process these runbooks plug into.

### Collector qualification and incident exercises

The exporter is disabled by default. Before enabling it for production, record the approved collector hostname, DNS ownership, certificate trust chain, egress firewall/proxy configuration, retention/deletion policy and operator approval. Use an isolated collector that accepts OTLP/HTTP JSON at `/v1/traces` over TLS without embedded URL credentials. Verify a real exported trace by querying that collector: spans, links and chronology must match the receipt; no protected canary or provider request ID may appear. Verify refusal when DNS changes to private or mixed public/private answers, when the collector returns partial success or redirects, and when it stalls. Test sustained load against the approved queue capacity, deadline and collector throughput; measure dropped/failed/timeout diagnostics and memory. No production collector or external load qualification is implied by the offline tests.

For a telemetry-loss drill, stall or disconnect the collector, verify bounded diagnostics and unchanged decision/receipt outcomes, restore connectivity and confirm fresh traces without retroactive duplicate accounting. For suspected egress, disable the sink, preserve sanitized traces and access logs under legal hold, inspect DNS/TLS/egress logs and notify the incident owner; do not attach raw payloads to tickets. For credential compromise, rotate credentials outside this exporter (which never accepts URL credentials), inspect collector ACLs and access audit, and follow the linked security incident template. For evidence preservation, apply the trace/review/job retention and tombstone rules before sanitized export, log the custodian and canary scan, and verify deletion or hold behavior. Record timestamps, collector version, trace IDs, findings and recovery evidence in the incident record; exercises are not complete until performed against the approved deployment.
