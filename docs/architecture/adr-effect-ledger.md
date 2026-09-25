# ADR: AIWG effect ledger

- Status: Accepted (contract, schemas and the `src/effects` core library committed; verifiers, CLI and adoption pending #2718 onward)
- Date: 2026-09-24
- Issue: [#2715](https://git.integrolabs.net/roctinam/aiwg/issues/2715) (epic [#2714](https://git.integrolabs.net/roctinam/aiwg/issues/2714))
- Origin: #2677 owner question (D13 production completion lookup)
- Decision owners: AIWG maintainers
- Contract: [Effect ledger v1](../contracts/effect-ledger.v1.md)
- Inputs: [research brief](effect-ledger/effect-ledger-research.md) and
  [reuse and integration assessment](effect-ledger/effect-ledger-assessment.md)
- Related: [cross-asset attestation envelope](adr-cross-asset-attestation-envelope.md)
  (#2068), [operator-decision audit](../contracts/operator-decision-audit.v1.md)
  (#1567), D13 review (#2606), D16 jobs (#2610), D10 lifecycle (#2597)

## Context

AIWG agents, skills, flows and services perform real side effects. They merge
PRs, post and close tracker items, write artifacts, and execute approved review
continuations (D13) and job items (D16). Crash recovery today does one of two
things. It replays an effect, which risks a duplicate, or it fails closed with no
way back out: D16 `execution-unknown`, and D13 "uncertain until reconciled".

No durable-execution system gives exactly-once external effects. Temporal,
Restate, Azure Durable Functions and Step Functions all re-run an effect that
crashed before its journal write. **Only the target system can settle whether
an effect happened.**

## Decision

AIWG adds an **effect ledger**: a core library, schemas and an `aiwg effect`
command group, with aiwg-utils skill and quickref discovery. It is a **signed
proof and deduplication index**, not an exactly-once mechanism.

1. **Protocol.** `intent` → perform the effect *carrying the effect ID* →
   verify → `completed` (with evidence). On restart, `reconcile` every intent
   that has no outcome, through a per-kind verifier. The ledger never replays
   on its own authority.
2. **Effect ID.** `eff1_` + base32(sha256(RFC 8785 `{v, scope, kind, target,
   context}`)). Attempt, time, actor and host are excluded. A payload digest is
   stored beside the ID. The same ID and digest returns the existing receipt.
   The same ID with a different digest is a **conflict** (IETF Idempotency-Key
   semantics). Domain adapters may register an existing derivation by name.
   D13's `d13.review/v1` preserves `reviewDigest({reviewId, continuationId,
   proposalVersion})` exactly, so persisted reviews stay valid.
3. **Embed the ID in the target** wherever possible, so verifiers match
   exactly: a hidden `<!-- aiwg-effect: eff1_… -->` comment marker, a git
   `Effect-Id:` trailer, an `Idempotency-Key` header, or a manifest field.
4. **Envelope.** Reuse the #2068 standard: a DSSE envelope around an in-toto
   Statement v1, serialized with RFC 8785. The predicate type is
   `https://aiwg.io/attestations/effect/v1`. The subject is the target
   reference and its digest. The signed payload carries `prev` (the previous
   record hash), `scope`, `phase` (`intent|completed|failed|reconciled|tombstone`),
   verifier metadata and `links` (#1567 decision event ID, trace and span, tool
   call ID). Records are digest-only: no raw payloads, secrets or locators.
5. **Signing.** A **dedicated Ed25519 ledger key** held by the host secret
   service, independent of the artifact, review and job stores (the D13 rule).
   Every record is signed, because a symmetric HMAC would let any verifier
   forge records. Every signature carries a `keyid`. A keyring of public keys
   with validity windows is kept, and a rotation is a record signed by the old
   key (and by the new key, proving possession). The commit OpenPGP key is
   **not** used per record. Optional OpenPGP or SSH signatures may sign
   checkpoints.
6. **Storage and multi-writer.** One ledger per project under the artifact
   store (`effects/<scope>/`, resolved through `projectAiwgWritePath`; it fails
   closed if an external root is missing). Sub-scopes are `review`, `job`,
   `delivery` and `custom`. Each writer has its own hash-chained segment,
   merged on read. Cross-writer idempotency uses an exclusive-create index file
   per effect ID (first writer wins). The storage primitives are promoted from
   `batch-receipts/protection.ts`.
7. **Truncation.** Periodic **signed checkpoints** (segment counts, head hashes
   and a root over the heads) are also written to an independent sink: the
   #1567 audit or a git ref. A later move to a Merkle log changes storage, not
   the record format.
8. **Verifiers.** A plugin registry keyed by `kind`. Built in: `git.commit`,
   `git.tag`, `file.digest`, `decision.receipt`, `tracker.comment`,
   `tracker.issue.closed` and `tracker.pr.merged` (Gitea and GitHub, through the
   project tracker access order, read-only). `decision.review.continuation` is
   a core kind whose verifier arrives with the D13 adapter; until then it
   reconciles to `unknown`. Extension kinds use the `x.<vendor>.<name>`
   namespace. Each verifier declares its kind, version and whether it **can**
   report `absent`.
9. **Tri-state results.** `present | absent | unknown`. `absent` requires an
   authenticated, successful and *complete* query. Errors, timeouts, 401/403,
   rate limits, unfinished paging, search lag and a missing verifier all give
   `unknown`. Author and time-window heuristics may return `present`, never
   `absent`. `unknown` blocks replay and escalates. Each reconcile appends a new
   signed `reconciled` record; history is never mutated.
10. **Retention.** Records follow D10. On purge, a record becomes a signed
    tombstone that keeps the effect ID, kind, target digest, original record
    hash and keyid, so the chain still verifies. The effect-ID index is kept
    for at least the longest resume or continuation window plus the grace
    period. An unreconciled intent is never purged.
11. **CLI and exit codes.** `aiwg effect id | intent | record | lookup |
    reconcile | verify | checkpoint | kinds | keys`. `record` does intent,
    verify and completed in one command. Outcome exit codes: 0 = present or
    recorded, 3 = absent, 4 = unknown, 5 = conflict, 6 = integrity failure.
    Environment exit codes: 1 = internal error, 2 = usage error, 7 = artifact
    root unavailable. None of these collide with the `aiwg verify` codes 20–29.
    Output is JSON by default for agents.
12. **Packaging.** The library `src/effects/*`, the schemas `schemas/effects/*`
    and the CLI are in **core**, because D13, D16 and delivery depend on them.
    They are registered like `artifactsCommand`. aiwg-utils ships the skill and
    quickref phrases ("record an effect", "reconcile effect", "did this PR
    merge"). Extra verifiers come as extensions.

The [v1 contract](../contracts/effect-ledger.v1.md) pins the identity grammar,
envelope, storage layout, verifier reason codes and exit codes.

## Policy boundary

The ledger proves that AIWG recorded an intent or an outcome, and what a
verifier observed at the target. It does not authorize an effect: a #1567
operator decision authorizes, and the ledger links to it. Ledger absence is
never evidence of target absence. For D13, `absent` never authorizes a replay
by itself; replay stays a separate, explicit executor decision.

## Consequences

### Positive

- D13 gains a production `reconcile(effectId)` and a ledger-backed
  `VerifiedReviewEffectLedger`. `journaledReviewExecutor` writes the intent
  *before* execution and reconciles a stale lease through the verifier. This
  answers #2677: the owner is the AIWG effect ledger, and target systems are the
  authorities, reached through verifiers.
- D16 gains an opt-in resolver out of `execution-unknown`. address-issues
  Phase 3.5 and issue-close use `aiwg effect reconcile` and `lookup` in place of
  ad-hoc checks, which removes duplicate-comment risk.
- Shared primitives are consolidated: storage (`protection.ts`),
  `signCanonicalDocument` into `src/security/signing.ts`, one RFC 8785
  canonicalizer (`artifact-trust.canonicalJson`), and a configurable
  credential-store service and account.
- Records are forward-compatible with Rekor and SCITT publication without
  re-signing.

### Costs and residual risk

- The crash window between an effect and its outcome record cannot be closed
  locally. A target that accepts no embedded ID and offers no complete query
  leaves such effects `unknown` until an operator decides.
- The same-host local filesystem is the only supported compare-and-swap.
  Distributed writers are out of scope.
- Key custody, rotation and checkpoint anchoring need operational runbooks.
- A correctly keyed writer can still record a false outcome; verifiers, not
  signatures, establish what happened at the target.

## Deferred

- Publishing to IETF SCITT (no RFC yet) or Rekor. The DSSE records are
  forward-compatible, and no re-signing is needed.
- Keyless Sigstore signing, and target-signed receipts ("notarized" effects),
  which trackers don't offer today.
- The Merkle-log storage format. The record format does not depend on it.
- Distributed consensus across hosts.

## Rejected alternatives

### HMAC per record

Rejected because every verifier would hold signing power and could forge
records.

### Reusing the commit GPG key per record

Rejected because it couples custody, costs a vault round trip per record, and
breaks key independence.

### Building on the operator-decision store

Rejected because it has no writer lock, `prune` re-chains history, and nothing
in production constructs it. The ledger links to it instead.

### Treating the journal as proof of absence

Rejected because it cannot close the crash window between the effect and the
journal write.

## Verification evidence

- Contract: [`docs/contracts/effect-ledger.v1.md`](../contracts/effect-ledger.v1.md)
- Schemas: [`schemas/effects/`](https://github.com/jmagly/aiwg/tree/main/schemas/effects)
  and catalog domain [`schemas/catalog/domains/effects.json`](https://github.com/jmagly/aiwg/blob/main/schemas/catalog/domains/effects.json)
- Fixtures and identity vectors: [`test/fixtures/effects/`](https://github.com/jmagly/aiwg/tree/main/test/fixtures/effects)
- Conformance test: [`test/conformance/effects-v1/effect-ledger-contract.test.ts`](https://github.com/jmagly/aiwg/blob/main/test/conformance/effects-v1/effect-ledger-contract.test.ts)

## Primary references

- [DSSE protocol and PAE](https://github.com/secure-systems-lab/dsse/blob/master/protocol.md)
- [in-toto Statement v1](https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md)
- [RFC 8785 JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785)
- [RFC 4648 base32](https://www.rfc-editor.org/rfc/rfc4648#section-6)
- [RFC 8032 EdDSA](https://www.rfc-editor.org/rfc/rfc8032)
- [IETF Idempotency-Key header draft](https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-idempotency-key-header-07)
