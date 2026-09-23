# Common decision data lifecycle (v1)

`decision-lifecycle/v1` is trusted host control data, not a model-selected state field. Every persistent/live deployment must declare classification, non-empty access scope, positive retention, export handling, deletion mode and backup handling for **every** surface below. `validateDecisionLifecyclePolicy` rejects omissions and unknown surfaces, rather than defaulting to permissive retention.

| Surface | Content erased on subject deletion | Non-sensitive facts retained |
|---|---|---|
| state | Projected body and stored copies | Opaque tombstone |
| receipt | Any body-bearing detail; preserve only necessary bounded audit identity | Opaque tombstone, policy outcome |
| trace | Linked content and references | Opaque tombstone |
| debug-sidecar | Ciphertext, nonce and key access | Opaque tombstone, audited deletion |
| cache | Prefix/result data and lookup keys | Opaque tombstone |
| job | Input/output body and handle access | Opaque tombstone |
| review | Notes, attachments and subject identifiers | Opaque tombstone |
| calibration | Subject-bearing fixtures and samples | Opaque tombstone |
| evaluation | Subject-bearing fixtures and samples | Opaque tombstone |
| export | Exported body and pending download access | Opaque tombstone |
| preprocessing-lineage | Source snippets and subject-bearing provenance | Opaque tombstone |

`eraseDecisionSubject` resolves host-maintained reverse references and active holds before any mutation. It tombstones each reference **before** erasing content, so failure to erase does not allow backup restore to resurrect the record. Erasure failure is reported as a category only; the host must retry incomplete erasure, not claim completion. `mayRestoreDecisionReference` checks tombstones and primary TTL before backup contents become queryable. Opaque tombstones do not authorize reuse of removed identifiers.

The optional encrypted debug-sidecar constructor requires this entire policy and refuses a debug rule whose classification, TTL, export or deletion semantics disagree with the capture authorization. A sidecar cannot silently select a weaker lifecycle rule.

Holds require a subject, authorized actor, reason, surface scope and finite expiry. Placement persists the approved hold in the host store; release requires a separately authorized actor/reason and is recorded by the store. An active hold blocks deletion of linked in-scope surfaces; it does not grant access to held content. Expired holds do not block erasure. Real stores must enforce these constraints transactionally and audit administrative operations. A returned in-memory policy object alone is not proof that a deployment's cache, backup or export service obeys them.

## Evidence limits

Offline tests cover all eleven surfaces, omissions, cascading tombstones, expiry, hold denial/release and restore rejection. They do **not** prove a deployed backing store has completed purge of snapshots/backups or access logs; operator approval and end-to-end tests against each configured backend remain necessary. Provider retention, region and ZDR are unknown until deployment evidence establishes them.
