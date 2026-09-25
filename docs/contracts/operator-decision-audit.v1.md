# Operator Decision Audit v1

Status: supported orchestration contract
Issue: AIWG #1567
Schema: `operator-decision.aiwg.io/v1`

This model records orchestration decisions made by operators or authorized
services. Agentic Sandbox supplies runtime evidence but does not own Mission,
Flow, approval, escalation, override, retention, or review policy.

## Required record

Each approval, denial, escalation, or override contains:

- schema version, globally unique event ID, and timestamp;
- authenticated actor ID, actor type, authentication method, and optional
  roles;
- decision kind, outcome, non-empty reason, policy reference, and data
  classification;
- a SHA-256 digest of the redacted decision context, never the raw prompt;
- correlation IDs where applicable: Mission, Flow, provider, sandbox task and
  session, issue, pull request, HITL prompt, and distributed trace;
- optional graph-profile correlation: graph/version/run/node/node-run identity,
  plus edge, route name/reason, checkpoint, and replay-parent identifiers;
- runtime evidence posture: host/container/VM kind, isolation, session backend,
  transport mode/trust, and immutable evidence references;
- paths redacted during record construction;
- previous-record hash and current-record hash.

At least one correlation identifier is mandatory. Credential values, raw
authorization headers, cookies, CSRF values, provider tokens, and raw prompt
context are not valid audit payloads.

## Integrity and custody

Records are canonicalized and linked through SHA-256 hashes. Readers verify the
chain before accepting another append. Mutation, reordering, or deletion within
an exported segment is detectable. Operators should periodically checkpoint
the segment head hash into an independently protected evidence system; a local
hash chain alone cannot prove deletion of an entire file.

The default JSONL store creates its directory as `0700` and file as `0600`.
Production deployments may replace it with an append-only/WORM or remote audit
sink while retaining the schema and verification behavior.

## Classification, redaction, retention, and deletion

Classifications are `public`, `internal`, `confidential`, and `restricted`.
Retention is configured per classification rather than hard-coded. Pruning is
an explicit operator action: retained records are re-chained, the deletion
count and new head hash are returned, and that maintenance decision must be
recorded in the external audit checkpoint. Legal holds override pruning.

Redaction is recursive and fail-safe for keys or values resembling tokens,
secrets, passwords, credentials, authorization, cookies, CSRF values, and API
keys. Integrations must classify domain-specific response payloads before
append. HITL response content is retained only when policy explicitly permits
it; the default orchestration record stores a digest and outcome.

Graph dimensions use the `aiwg.graph.*` OpenTelemetry namespace and the
`aiwg.flow.graph` A2A metadata key (`graph.flow.aiwg.io/v1`). Route evidence is
not an audit correlation field: adapters store only a classified context digest
or an immutable evidence reference. Route reasons pass through the same
recursive redaction as actor, correlation, and runtime fields. Ordinary
Flow/Mission decisions omit `graph` entirely and remain v1-compatible.

## Review and export

Native JSONL is the lossless review/export format. Each record also maps to an
OpenTelemetry-compatible log record with event, actor, context digest, Mission,
Flow, provider, sandbox task, prompt, and integrity attributes. Exporters must
preserve the native record hash and must not treat OpenTelemetry delivery as
the integrity anchor.

Review tools verify the chain first, then filter by actor, time, decision kind,
outcome, classification, and correlation ID. Evidence handoff includes the
native segment, its head hash/checkpoint, applicable retention policy, and any
referenced immutable runtime artifacts.

## Composition

- #1565 HITL attempts link `prompt_id`, Mission/Flow, task/context, actor,
  channel, outcome, and context digest.
- #1566 scheduling records queue, admission, renewal, denial, timeout,
  cancellation, and preemption with request/Mission/runtime lineage.
- #1657 Mission controls record requested and effective state revisions,
  conflicts/replays, and runtime evidence.
- Cockpit may project and export these records, but cannot mint approval or
  override authority.
- The [effect ledger](./effect-ledger.v1.md) (#2714) records the effects these
  decisions authorize. An effect record carries
  `links.operatorDecisionEventId` (this record's `event_id`) and optionally
  `links.operatorDecisionRecordHash` (its `record_hash`); both are `sha256:`
  digests, so D13 review event IDs (`reviewOperatorEventId`) link directly,
  while a random UUID `event_id` cannot be linked. `aiwg effect verify
  --with-decisions <audit.jsonl>` verifies this chain with
  `verifyDecisionChain` and checks that every linked event exists with the
  linked record hash; a broken chain or a missing event exits 6. The link is
  read-only in both directions: neither store writes the other.

Implementation evidence is in `src/audit/operator-decision.ts` and
`test/unit/audit/operator-decision.test.ts`. Runtime evidence fields align with
AIWG #1615/#1618 and the handoff expected by `roctinam/agentic-sandbox#234`.
