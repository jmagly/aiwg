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

Metadata-only is the default. Attribute keys matching state, question, prompt, response/answer body, authorization, API key, credential, vault locator/hash, secret, cookie, access token, or private reasoning are dropped. Values are control-character stripped and bounded. Canary values are scanned and removed from spans, events, links, diagnostics, and sanitized exports. Public export also removes provider request IDs.

Sensitive debug capture is disabled unless a policy is explicitly authorized and specifies encryption, an opaque key reference, access-audit sink, confidential/restricted classification, positive TTL, and deletion support. A trace may contain only the sidecar's opaque reference. Never record chain-of-thought.

## Metrics and exporter behavior

Metrics cover throughput, delay, attempts, retries/fallbacks, failures, coverage/abstention/review, latency, cost, cache results, and drift inputs where metadata exists. Dimensions are allowlisted and bounded. Run, invocation, decision/question, provider-request, user, tenant, body-derived, and arbitrary error strings are prohibited dimensions.

The bounded exporter has a fixed queue, deadline, and diagnostic ring. Full queues drop new telemetry; timeouts and failures are visible diagnostics. There is no telemetry retry loop and no path from telemetry to the decision result or an effect authorization. Durable receipt persistence retains its independent fail-closed semantics.

`DecisionOtlpHttpSink` is an opt-in OTLP/HTTP JSON transport for trusted telemetry traces. Supply an explicitly approved, credential-free HTTPS collector endpoint ending in `/v1/traces` and a positive request-byte limit; wire the sink into `BoundedDecisionTraceExporter`, whose deadline and queue capacity remain mandatory. It serializes sanitized spans, events, links, and typed attributes, never follows redirects, and reports transport failures through the exporter's bounded diagnostics. It does not discover collectors or read environment credentials. The sink now inspects at most 4 KiB of a successful collector response and fails when OTLP reports rejected spans or malformed partial-success metadata; it never emits the collector's response text. IP literals and `.localhost` destinations are rejected at construction, but this is not DNS-resolution or rebinding protection: a DNS name can still resolve to a private address or change between lookup and connection. Collector deployment, a pinned private-address/DNS policy, sustained backpressure, and incident runbook exercises still require qualification before enabling it outside a controlled test environment.

## Retention, deletion, and export

Trace, debug sidecar, export, and linked review/job/cache/evaluation TTLs must be positive. Deletion is denied during legal hold. Otherwise links become explicit tombstones rather than broken or reused references. Backup/restore must reapply TTL and tombstone state before records become queryable.

Use `sanitizedTelemetryExport()` and run `scanTelemetryCanaries()` before disclosure. Example queries:

- retry rate: group `decision.attempt` by `aiwg.adapter.id` and terminal reason;
- fallback latency: filter attempts with ordinal greater than one and compare duration;
- review chain: follow `review` and `action` links from the workflow trace;
- batch cost: sum only spans where `aiwg.usage.scope = shared-request`.

Schema additions are backward compatible within v1. Removing/changing meaning or privacy posture requires a new schema version and a migration note. Rollback disables exporters, not mandatory receipts or provenance.

Operational response should follow the security incident template at `agentic/code/extensions/sec/templates/security-incident-runbook.md` and the evidence-preservation flow in the forensics framework. Treat telemetry loss, suspected egress, credential compromise, and incident-evidence handling as distinct runbook triggers.
