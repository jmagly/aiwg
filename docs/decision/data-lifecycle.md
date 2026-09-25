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

`FileDecisionLifecycleStore` supplies a local, private, append-only metadata journal for links, tombstones and holds. It delegates each surface's content erasure to a required host handler and fails closed if none is registered. A restart can replay journal references and hold releases. The implementation is **single-writer**: multi-process deployments must provide a transactional journal and complete erasers for their own stores. The offline test uses a real encrypted debug backend to prove journal-driven cascading erasure.

`eraseDecisionSubject` resolves host-maintained reverse references and active holds before any mutation. It tombstones each reference **before** erasing content, so failure to erase does not allow backup restore to resurrect the record. Erasure failure is reported as a category only; the host must retry incomplete erasure, not claim completion. `mayRestoreDecisionReference` checks tombstones and primary TTL before backup contents become queryable. Opaque tombstones do not authorize reuse of removed identifiers.

Cross-surface references held by other subjects' records resolve through `FileDecisionLifecycleStore.resolveReference()`: an erased target is `{ state: 'tombstoned', deletedAt }` (without the erased subject), a live one `linked`, anything else `unknown`, so a deleted record never becomes a dangling link. Telemetry links are rewritten the same way by `deleteTelemetryReference` (`aiwg.link.state = deleted`), and that marker survives sanitized export.

`restoreDecisionSubjectBackup(backup, policy, tombstones, restore, now)` is the subject-level restore across surfaces. Each backup entry (subject, opaque reference, creation time) is refused as `tombstoned`, `not-persisted` (surface `backup` rule), `expired` (primary retention), `invalid` or `restore-unavailable` before the host's per-surface restore handler runs; unrelated subjects restore normally. A handler failure fails closed with a category-only error. After erasure, sanitized exports (`decisionResultForExport`, `sanitizedTelemetryExport`) carry only bounded audit facts (status, reason, pins, attempt counts, tombstones), which the offline tests verify against a canary.

The JSON contract is `schemas/decision/DecisionLifecyclePolicy.v1.schema.json`; projection policy is `schemas/decision/DecisionProjectionPolicy.v1.schema.json`. Runtime validators remain authoritative for cross-field rules (destination authorization, single subject, secret material).

Telemetry retention (M09) derives from this policy with `telemetryRetentionFromLifecyclePolicy(policy, holds, now)`: trace, debug-sidecar and export TTLs come from those surfaces, linked-record TTL is the shortest of review/job/cache/evaluation, and `legalHold` is true only while an authorized lifecycle hold covering a telemetry surface is active. The hand-set `DecisionRetentionPolicy.legalHold` boolean remains accepted but is deprecated.

The optional encrypted debug-sidecar constructor requires this entire policy and refuses a debug rule whose classification, TTL, export or deletion semantics disagree with the capture authorization. A sidecar cannot silently select a weaker lifecycle rule. `FileDebugSidecarBackend` provides a local private-directory implementation: ciphertext-only 0600 files, metadata-only 0600 audit log, no-follow reads, atomic no-replace publishing, expiry sweep and restart-time TTL checks. The encryption key is supplied only by a host callback, never written by this backend. Tests restart the service and prove expired ciphertext cannot be disclosed. Deployments still need independently controlled key access, backups, audit forwarding, filesystem access review and a scheduled sweep.

The durable batch receipt and result stores bind the `receipt` rule in the same way. `FileBatchReceiptStore.erase` is the `receipt` surface eraser. It cascades to the batch's encrypted result snapshots, leaves only body-free tombstones, and refuses re-acquisition, so an erased batch is never re-dispatched. See [batch-receipts.md](batch-receipts.md#integrity-encryption-and-lifecycle).

Holds require a subject, authorized actor, reason, surface scope and finite expiry. Placement persists the approved hold in the host store; release requires a separately authorized actor/reason and is recorded by the store. An active hold blocks deletion of linked in-scope surfaces; it does not grant access to held content. Expired holds do not block erasure. Real stores must enforce these constraints transactionally and audit administrative operations. A returned in-memory policy object alone is not proof that a deployment's cache, backup or export service obeys them.

## Evidence limits

Offline tests cover all eleven surfaces, omissions, cascading tombstones, expiry, hold denial/release and restore rejection. They do **not** prove a deployed backing store has completed purge of snapshots/backups or access logs; operator approval and end-to-end tests against each configured backend remain necessary. Provider retention, region and ZDR are unknown until deployment evidence establishes them.
