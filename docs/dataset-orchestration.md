# Dataset orchestration CLI

`aiwg dataset` is the single control-plane surface for governed dataset work. It stores canonical state in `.aiwg/dataset/state.v1.json`; adapters and execution backends do not own AIWG plans, run identities, checkpoints, or receipts.

Use `source --file source.json`, then `check <id>` and bounded `preview <id> --count 10`. Create an immutable reviewed plan with `plan --file plan-input.json`; execute it with `ingest <plan-id> --digest <digest> --idempotency-key <key>`. Inspect one run by its required ID with `status <run-id>`, or inspect other objects with `show`, `verify`, `query`, `lineage`, or `export`. `--json` returns the same `aiwg.dataset-orchestration/v1` envelope used to render human output. Missing the status run ID returns `DATASET_ARGUMENT_REQUIRED` before opening dataset state; a supplied unknown run ID returns `DATASET_RUN_NOT_FOUND`.

Plans bind source/revision identity, adapter and configuration digest, schemas, capability decision, policy, locality/backend/fallback, estimates, approvals, and reconciliation enumeration. Ingest fails before mutation when any binding changes. Reconciliation approval must repeat the exact preview digest and threshold. Reusing an idempotency key with the same plan returns its prior state; reuse with another digest fails.

`--offline` rejects network adapters before configuration or backend initialization. Fortemi is unavailable unless a compatible transport is explicitly injected; the currently pinned dependency is not treated as implementing newer Fortemi contracts. Fortemi receipts are verified inputs only, while AIWG remains the canonical ledger authority.

Run `aiwg dataset --help` for the complete action list.
