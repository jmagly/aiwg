# Batch receipts and shared accounting

`src/decision/batch-receipts/` defines the versioned `decision-batch-receipt/v1` record. A receipt is the sole owner of a shared provider request's identity, attempt chronology, usage, and cost evidence. Evaluation results link through `decision-batch-result-ref/v1`; they do not copy shared tokens or cost.

Receipts bind the deterministic context plan digest and partition ID from `context-plan.ts`, plus an optional native group ID from `batch.ts`. A split plan therefore emits one receipt per partition under one plan digest. Attempt history is append-only and includes failures, retries, uncertain execution, and fallback lineage.

## Accounting rules

- Provider usage lives on each attempt exactly once. `batchAccountingTotals` adds all attempts, including failed requests that consumed usage. Any unknown token field makes that aggregate field unknown rather than zero.
- Provider-authoritative cost is preserved. Client-derived cost uses integer USD micros and a price-catalog ID, version, and effective timestamp. Unknown cost stays `unknown`, or `bounded-unknown` when an approved conservative bound is available.
- Optional per-answer values are reporting-only `estimated` allocations. Algorithm `largest-remainder-weighted` version `1` floors each weighted share and awards remaining integer tokens by descending remainder, breaking ties by question ID. The result reconciles exactly to the request total. These allocations are not spend-admission evidence.

## Persistence, replay, and exports

Both stores expose acquisition plus compare-and-swap. File revisions are immutable and published with an exclusive hard-link, so concurrent owners cannot both acquire or publish the same revision. Reads validate every contiguous transition; retrying acquisition returns the existing identity and timestamps.

Sanitized exports retain hashes, plan/partition lineage, chronology, answer references, and accounting evidence. Raw state and response bodies are never accepted by the receipt type. Provider request IDs are bounded opaque internal values; public exports replace them with deployment-salted hashes. They must not be metric labels, authorization inputs, or cross-provider correlation keys.
