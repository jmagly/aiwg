---
precedence: critical
overridable: true
enforcement: critical
activation: kernel
summary: Classify, minimize, redact, authorize the named sink, and attach retention metadata before any operational payload reaches a response or persistent destination.
triggers:
  - classify and redact operational evidence before publication
---

# Ops Information Governance Rules

**Enforcement Level**: CRITICAL
**Scope**: Responses containing collected operational data; audit files; artifacts; repository writes and commits; issue/PR/comment bodies; cross-repository references or copies; exports and bundles

## Mandatory Boundary

No collected operational payload may directly cross a response, persistence, or publication boundary. Before any write/submission, use `prepareEvidenceForSink` or `publishEvidence` from `aiwg/governance`, or:

```bash
aiwg ops evidence prepare --input evidence-request.yaml --policy .aiwg/ops/governance-policy.yaml --output prepared-evidence.json
```

The request names artifact identity/kind/category, payload, named sink, evidence tier, and any scoped approval. The CLI writes payload-free decisions to `.aiwg/ops/audit/governance-boundary.jsonl`. A denied result has no publishable payload: never bypass it by copying the original request. Filesystem/tracker access does not authorize publication.

Apply this order:

1. Resolve classification from explicit metadata, parent inheritance, kind/category defaults, then project default.
2. Minimize durable evidence to outcome/status, bounded redacted excerpts, counts, and digests.
3. Redact text and nested structured content; buffer streams until sanitization is complete and safe across chunk boundaries.
4. Authorize the classification against a named sink; unknown visibility fails closed.
5. Attach creation time, policy ID/version, disposition deadline, tier, and lifecycle action.
6. Only then emit the prepared value to the authorized response, persistent store, or external sink.

## Classification and Approval

Built-in classes in increasing restriction are `public`, `internal`, `confidential`, `restricted-infrastructure`, `restricted-identity`. Custom classes require stable IDs and numeric ranks.

Sensitive ops kinds default non-public: inventory, network, disaster recovery, and raw evidence use `restricted-infrastructure`; identity evidence uses `restricted-identity`. Publish full artifacts only within the destination's classification ceiling; otherwise deny or provide a separately gated, payload-free sanitized summary.

Classification downgrades, `approval-required` cross-repo transfers, and exceptional redaction bypasses require current approval scoped to the exact artifact and sink, recording actor, reason, timestamp, and optional expiration. Audits contain approval IDs and reason digests, never reasons or payloads. Unknown sinks cannot be overridden.

## Redaction

Apply built-in detectors for authorization/cookie headers, tokens, passwords, private keys, connection strings, URL credentials/secret query parameters, sensitive environment/config keys, provider token formats, and encoded secret-bearing values. Project policies may add bounded organization and sensitive-key patterns without framework changes.

Markers retain detector class and optional length/HMAC correlation fingerprints. Diagnostics may contain markers, paths, counts, and fingerprints only, never detected values. Redaction is not encryption and cannot authorize a forbidden destination.

External/persistent sinks fail closed if sanitization fails or exceeds resource limits. Overrides require a sink that explicitly permits them and a current, scoped, audited approval. Never silently bypass redaction.

## Retention and Disposal

- Raw captures are a separate restricted tier with short default TTL and an explicit reason. Never publish raw evidence to immutable issue/comment sinks.
- Durable evidence is minimum sufficient content; raw/durable tiers may have different access and retention policies.
- Retention rules may match category, classification, sink, and tier to retain, summarize, redact fields, archive, or delete.
- Legal/compliance holds must be explicit, audited, and reversible; they pause disposition without changing the original deadline or policy.
- Disposal emits payload-free receipts. Surface stable error codes on failure and retry or escalate. Never claim remote deletion without verification.
- Immutable issue/comment sinks receive only policy-approved, non-expiring sanitized summaries. Never post evidence whose safety depends on future deletion.

## Leak Remediation and Enforcement

If a secret or restricted payload crosses a boundary, stop publication, preserve only payload-free incident evidence, notify the owner, revoke/rotate credentials, remove or restrict the destination where possible, and open the applicable incident/DFIR handoff. Reproduce synthetically, re-run sanitization, and update project patterns. Local deletion does not prove deletion from caches, mirrors, notifications, or immutable external systems.

On violations, halt before writing/submitting, return boundary reason codes, and request a policy change or scoped approval. Reject raw tracker bodies, direct ungated artifact writes, full stdout/stderr persistence without raw-capture justification, absent lifecycle metadata, unknown sink IDs, payload-bearing decision logs, or publication after denial.
