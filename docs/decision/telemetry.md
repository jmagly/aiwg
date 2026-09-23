# Decision telemetry contract

`decision-telemetry/v1` is a dependency-free OpenTelemetry-compatible mapping for the decision lifecycle. It is an explicit hook, not implicit logging: an evaluator may emit spans through `DecisionTelemetryHook`, but exporter failure cannot change a decision, authorize an action, or replace the durable receipt.

## Span hierarchy and correlation

One W3C trace covers a workflow invocation. `decision.workflow` is the root; children may include `resolve`, `validate`, `project`, `admit`, `batch.request`, `attempt`, `normalize`, `accept`, `compose`, and `persist`. Review, cache, durable job, evaluation, continuation, and approved-action audit records use span links so they remain one audit chain without creating a second identity universe.

AIWG trace and span IDs are random W3C IDs. Provider request IDs are bounded opaque attributes only: they are never trace IDs, metric dimensions, authorization material, or public-export fields. Propagation uses `traceparent` and bounded `tracestate` across dispatch, adapter, receipt, and continuation boundaries.

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

Unknown values remain `null`; they are never rewritten to zero. Derived cost must name its catalog version. Per-answer allocation is optional, marked `estimate`, names its allocation method/version, and must reconcile exactly. Shared provider usage is recorded once on `decision.batch.request`, while answer spans link to it.

`recordBatchReceiptTrace()` is the bridge from the durable batch receipt to telemetry. It emits one request span for each dispatched attempt, including consumed failed retry/fallback attempts, and no span for a `not-sent` attempt. Provider-authoritative and client-derived costs retain distinct provenance; bounded or unknown costs remain `null`. Question and answer identifiers are represented only by bounded counts, so request-level accounting cannot become duplicated per-answer telemetry.

## Privacy and redaction

Metadata-only is the default. Attribute keys matching state, question, prompt, response/answer body, authorization, API key, credential, vault locator/hash, secret, cookie, access token, or private reasoning are dropped. Values are control-character stripped and bounded. Public export removes provider request IDs and vendor `tracestate`, drops unrecognized event names (only `retry.scheduled` and `attempt.terminated` are exported), and removes matching canaries from span attributes, event/link attributes and tombstones when supplied to `sanitizedTelemetryExport()`. Configure canary scanning on disclosure; without supplied canaries, the scanner cannot detect arbitrary PII hidden in an otherwise allowed metadata field.

Sensitive debug capture is disabled unless a policy is explicitly authorized and specifies encryption, an opaque key reference, access-audit sink, confidential/restricted classification, positive TTL, and deletion support. A trace may contain only the sidecar's opaque reference. Never record chain-of-thought.

## Metrics and exporter behavior

Metrics use fixed names and bounded dimensions. Supply `telemetry.metrics` with a `BoundedDecisionMetrics` instance to record workflow throughput/duration, attempt/retry/fallback/error counts, known request-level token/cost usage and review counts from evaluator spans. `recordDecisionSpanMetrics()` also accepts independently constructed batch/cache spans; shared batch usage is counted only on the request span, not linked answer attempts. Queue/admission delay, coverage/abstention and drift require separately supplied metadata and are not emitted automatically by the evaluator. Dimensions are allowlisted and bounded. Run, invocation, decision/question, provider-request, user, tenant, body-derived, and arbitrary error strings are prohibited dimensions.

The bounded exporter has a fixed queue, deadline, and diagnostic ring. Full queues drop new telemetry; timeouts and failures are visible diagnostics. There is no telemetry retry loop and no path from telemetry to the decision result or an effect authorization. Durable receipt persistence retains its independent fail-closed semantics.

`DecisionOtlpHttpSink` is an opt-in OTLP/HTTP JSON transport for trusted telemetry traces. Supply an explicitly approved, credential-free HTTPS collector endpoint ending in `/v1/traces` and a positive request-byte limit; wire the sink into `BoundedDecisionTraceExporter`, whose deadline and queue capacity remain mandatory. It serializes sanitized spans, events, links, and typed attributes, never follows redirects, and reports transport failures through the exporter's bounded diagnostics. It does not discover collectors or read environment credentials. The sink now inspects at most 4 KiB of a successful collector response and fails when OTLP reports rejected spans or malformed partial-success metadata; it never emits the collector's response text. IP literals and `.localhost` destinations are rejected at construction. The default native HTTPS transport resolves all DNS answers for each connection, rejects the whole answer set if any address is non-global (including loopback, RFC1918, link-local, reserved, mapped IPv4, and non-global IPv6), and pins the accepted address to that TLS connection while verifying the original hostname. It disables connection pooling and never follows redirects. Injecting `fetch` bypasses this DNS policy and is **only for controlled tests**. This does not protect against a compromised public collector, proxy interception, DNS answers pointing at public addresses under attacker control, or collector-side forwarding. Do not deploy through a proxy or with custom DNS/transport overrides without separate qualification. Collector deployment and incident drills remain unqualified outside controlled tests.

## Retention, deletion, and export

Trace, debug sidecar, export, and linked review/job/cache/evaluation TTLs must be positive. Deletion is denied during legal hold. Otherwise links become explicit tombstones rather than broken or reused references. Backup/restore must reapply TTL and tombstone state before records become queryable.

Use `sanitizedTelemetryExport()` and run `scanTelemetryCanaries()` before disclosure. Example queries:

- retry rate: group `decision.attempt` by `aiwg.adapter.id` and terminal reason;
- fallback latency: filter attempts with ordinal greater than one and compare duration;
- review chain: follow `review` and `action` links from the workflow trace;
- batch cost: sum only spans where `aiwg.usage.scope = shared-request`.

Schema additions are backward compatible within v1. Removing/changing meaning or privacy posture requires a new schema version and a migration note. Rollback disables exporters, not mandatory receipts or provenance.

Operational response should follow the security incident template at `agentic/code/extensions/sec/templates/security-incident-runbook.md` and the evidence-preservation flow in the forensics framework. Treat telemetry loss, suspected egress, credential compromise, and incident-evidence handling as distinct runbook triggers.

### Collector qualification and incident exercises

The exporter is disabled by default. Before enabling it for production, record the approved collector hostname, DNS ownership, certificate trust chain, egress firewall/proxy configuration, retention/deletion policy and operator approval. Use an isolated collector that accepts OTLP/HTTP JSON at `/v1/traces` over TLS without embedded URL credentials. Verify a real exported trace by querying that collector: spans, links and chronology must match the receipt; no protected canary or provider request ID may appear. Verify refusal when DNS changes to private or mixed public/private answers, when the collector returns partial success or redirects, and when it stalls. Test sustained load against the approved queue capacity, deadline and collector throughput; measure dropped/failed/timeout diagnostics and memory. No production collector or external load qualification is implied by the offline tests.

For a telemetry-loss drill, stall or disconnect the collector, verify bounded diagnostics and unchanged decision/receipt outcomes, restore connectivity and confirm fresh traces without retroactive duplicate accounting. For suspected egress, disable the sink, preserve sanitized traces and access logs under legal hold, inspect DNS/TLS/egress logs and notify the incident owner; do not attach raw payloads to tickets. For credential compromise, rotate credentials outside this exporter (which never accepts URL credentials), inspect collector ACLs and access audit, and follow the linked security incident template. For evidence preservation, apply the trace/review/job retention and tombstone rules before sanitized export, log the custodian and canary scan, and verify deletion or hold behavior. Record timestamps, collector version, trace IDs, findings and recovery evidence in the incident record; exercises are not complete until performed against the approved deployment.
