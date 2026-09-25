# Effect Ledger v1

Status: contract accepted; core library in `src/effects/` (#2717); verifier framework and built-in verifiers in `src/effects/verifiers/` (#2718); tracker verifiers (#2719); `aiwg effect` CLI in `src/cli/handlers/effect.ts` (#2720); D13 adoption (#2721); D16 resolver, skill adoption and #1567 links (#2722)
Issue: AIWG #2715 (epic #2714)
Decision: [ADR: AIWG effect ledger](../architecture/adr-effect-ledger.md)
Predicate type: `https://aiwg.io/attestations/effect/v1`
Schemas: `schemas/effects/EffectRecord.v1.schema.json`,
`EffectCheckpoint.v1.schema.json`, `EffectKeyring.v1.schema.json`,
`EffectVerifierResult.v1.schema.json` (catalog domain `effects`)

The effect ledger records that AIWG intended, performed and verified a side
effect on a target system: a tracker comment, a PR merge, a git tag, a file, a
decision receipt or an approved review continuation. It is a signed proof and
deduplication index. It is **not** an exactly-once mechanism and it never
authorizes an effect. A #1567 operator decision authorizes; the ledger proves.

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## Protocol

1. **Intent.** Before the effect, the writer appends a signed `intent` record
   for the effect ID.
2. **Effect.** The caller performs the effect and carries the effect ID into the
   target wherever the target allows it: a hidden
   `<!-- aiwg-effect: eff1_… -->` comment marker, a git `Effect-Id:` trailer, an
   `Idempotency-Key` header, or a manifest field.
3. **Verify.** The per-kind verifier queries the target.
4. **Outcome.** The writer appends `completed` (verifier result `present`) or
   `failed` (the target definitively rejected the effect).

On restart, every intent without an outcome is reconciled through its verifier,
and each attempt appends a `reconciled` record. The ledger MUST NOT replay an
effect on its own authority. Replay is always a separate, explicit caller
decision.

`absent` never authorizes a D13 replay by itself. A D13 executor treats
`absent` as still uncertain. It may replay only under its own explicit policy,
for example when the effect ID was delivered as an idempotency key to a target
that deduplicates.

A missing ledger entry is not evidence that the effect did not happen at the
target. Only a verifier result can speak for the target.

## Effect identity

### Canonicalizer

Every canonical form in this contract is RFC 8785 JSON produced by
`artifact-trust.canonicalJson` (`src/security/artifact-trust.ts`). The other
JSON canonicalizers in the repository (`src/audit/operator-decision.ts`,
`src/marketplace/provenance.ts`) MUST NOT be used for effect records: the audit
copy sorts keys with the locale-sensitive `localeCompare`. Identity inputs are
restricted to strings, integers, booleans, nested objects and arrays, so the
number-serialization edge cases of RFC 8785 do not arise. `undefined` members
are not permitted: omit the key.

### Derivation `aiwg.effect/v1`

```text
input    = {"v": 1, "scope": scope, "kind": kind, "target": target, "context": context}
digest   = SHA-256(UTF-8(canonicalJson(input)))            ; 32 bytes
effectId = "eff1_" || base32(digest)
```

- `base32` is the RFC 4648 section 6 alphabet in **lowercase**
  (`abcdefghijklmnopqrstuvwxyz234567`), most significant bit first, with **no
  padding**. A 32-byte digest encodes to 52 characters. The final character
  carries one data bit followed by four zero bits, so it is always `a` or `q`.
- The full ID is 57 characters and matches `^eff1_[a-z2-7]{51}[aq]$`. Readers
  MUST reject uppercase, padding (`=`), any other length, and a final character
  with non-zero trailing bits. They MUST NOT normalize case.
- `v` is the integer `1`. A future derivation uses a new prefix (`eff2_`).
- Attempt number, timestamps, actor, host and payload are **excluded**.

### Registered adapter derivations

Adapters that already have a persisted identity register a derivation by name
instead of re-deriving. The record states its derivation in `idDerivation`.

| Derivation | ID format | Definition | Kind |
|---|---|---|---|
| `aiwg.effect/v1` | `^eff1_[a-z2-7]{51}[aq]$` | Above | any except `decision.review.continuation` |
| `d13.review/v1` | `^sha256:[a-f0-9]{64}$` | `reviewDigest({reviewId, continuationId, proposalVersion})` from `src/decision/review/validate.ts`: `"sha256:"` plus lowercase hex SHA-256 of `canonicalJson` of exactly those three members | `decision.review.continuation` only |

For `d13.review/v1`, `context` is exactly `{reviewId, continuationId,
proposalVersion}` and `scope.subsystem` is `review`. The identity uses
`proposalVersion` (an integer ≥ 1), not a proposal digest: this is the identity
D13 already enforces, so persisted reviews stay valid. New derivations need a
contract revision.

### Scope, kind, target and context

- **Scope** is `{tenant, project, subsystem}`, derived from host configuration,
  never from model input. `subsystem` is one of `review`, `job`, `delivery`,
  `custom`. Scope is inside the signed payload, so a cross-scope replay fails.
- **Kind** is one of the core kinds `git.commit`, `git.tag`, `file.digest`,
  `decision.receipt`, `decision.review.continuation`, `tracker.comment`,
  `tracker.issue.closed`, `tracker.pr.merged`, or an extension kind matching
  `^x\.[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$` (for example
  `x.example.notify`). Other names are invalid. Adding a core kind is a contract
  revision.
- **Target** is a reference string `<scheme>:<ref>` with no whitespace, at most
  1024 characters. Schemes: `gitea:owner/repo#N`, `github:owner/repo#N`,
  `git:<sha>`, `git-tag:<name>`, `file:<path>@sha256:<hex>`,
  `release:<tag>/<asset>`, `decision:<receipt-id>`,
  `review:<tenant>/<project>/<reviewId>`, and `x-<vendor>:<ref>` for extension
  kinds.
- **Context** is the caller's causal identity: a flat object of at most 16
  members whose names match `^[A-Za-z][A-Za-z0-9_]{0,63}$` and whose values are
  strings (≤ 256 characters), integers or booleans. Examples:
  `{issue, action, cycle}` or `{job, item}`.

### Payload digest

`payloadDigest` is `"sha256:"` plus hex SHA-256 over the exact bytes the effect
sends (for example the comment body), or over `canonicalJson` of a structured
request. It is stored beside the ID, never inside it.

- Same effect ID, same payload digest: idempotent. The existing receipt is
  returned and nothing is appended (exit 0).
- Same effect ID, different payload digest: **conflict** (exit 5). Nothing is
  appended.

The conformance vectors in `test/fixtures/effects/vectors/identity.v1.json`
fix `eff1_` IDs for known inputs and D13 IDs for known `{reviewId,
continuationId, proposalVersion}`.

## Envelope and record

Each record is a [DSSE](https://github.com/secure-systems-lab/dsse/blob/master/protocol.md)
envelope with `payloadType` `application/vnd.in-toto+json`, whose payload is the
RFC 8785 bytes of an [in-toto Statement v1](https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md),
as in the #2068 envelope standard. Verifiers check the exact decoded bytes and
never reserialize before signature verification.

- `_type`: `https://in-toto.io/Statement/v1`
- `predicateType`: `https://aiwg.io/attestations/effect/v1`
- `subject`: exactly one entry. `name` is the target reference and
  `digest.sha256` is hex SHA-256 of its UTF-8 bytes. A tombstone uses the name
  `aiwg-effect:<effectId>` and keeps the original digest.

### Predicate

| Member | Required | Meaning |
|---|---|---|
| `schemaVersion` | yes | `aiwg.effect.record.v1` |
| `effectId`, `idDerivation` | yes | Identity and its registered derivation |
| `scope`, `kind` | yes | As above |
| `target`, `context` | all phases except `tombstone` | Identity inputs |
| `phase` | yes | One of the five phases below |
| `payloadDigest` | yes | As above |
| `writer`, `seq` | yes | Segment writer ID and 0-based position |
| `prev` | yes | `null` when `seq` is 0, otherwise the previous line's `recordHash` in the same segment |
| `recordedAt` | yes | RFC 3339 UTC (`Z`); excluded from identity |
| `verification` | `completed` (result `present`), `reconciled` (any result) | Verifier outcome (see below); forbidden on `intent` and `failed` |
| `failure` | `failed` | `reason` (`target-rejected`, `precondition-failed` or `cancelled-before-dispatch`) and optional `evidenceDigest` |
| `tombstone` | `tombstone` | See retention |
| `links` | yes (may be empty) | `operatorDecisionEventId`, `operatorDecisionRecordHash`, `traceId`, `spanId`, `toolCallId` |

The phases are `intent|completed|failed|reconciled|tombstone`:

- `intent`: written before the effect; carries no `verification` or `failure`.
- `completed`: the verifier reported `present`.
- `failed`: the target definitively rejected the effect.
- `reconciled`: one reconcile attempt and its tri-state result.
- `tombstone`: a purged record (see retention).

Unknown members are rejected. Any other `phase` value is rejected.

### Digest-only rule

Records, checkpoints, keyrings and verifier results carry identifiers, digests
and references only. They MUST NOT contain raw effect payloads (bodies,
requests, responses), secrets, credentials, private keys, vault locators or
private reasoning. Evidence is a digest (`evidenceDigest`) plus a reference.
Writers run the restricted-material scan used by D13
(`assertReviewProjection`, `src/decision/review/validate.ts`) before signing.

### Segment line

Each segment is JSON Lines, one line per record:

```json
{"schemaVersion":"aiwg.effect.segment-line.v1","writer":"<writer-id>","seq":0,"recordHash":"sha256:<hex>","envelope":{"payloadType":"application/vnd.in-toto+json","payload":"<base64>","signatures":[{"keyid":"sha256:<hex>","sig":"<base64>"}]}}
```

`recordHash` is `"sha256:"` plus hex SHA-256 of the DSSE PAE bytes
(`DSSEv1 <len> <payloadType> <len> <payload>`, `artifact-trust.dssePae`).
Because `prev` and `seq` are inside the signed payload, editing, reordering or
splicing a line breaks a signature or a link. The line's `writer` and `seq` MUST
equal the predicate's.

## Signing and keyring

- Every record is signed with a **dedicated Ed25519 ledger key** held by the host
  secret service. It is independent of the artifact, review, job and commit keys.
  HMAC is not an acceptable record signature. The commit OpenPGP key is not used
  per record.
- Every DSSE signature MUST carry `keyid`: `"sha256:"` plus hex SHA-256 of the
  DER SubjectPublicKeyInfo of the public key (`artifact-trust.publicKeyFingerprint`).
  Signatures are standard padded base64 of the 64-byte signature.
- The keyring (`EffectKeyring.v1`) holds public keys only: `keyid`,
  `algorithm` (`ed25519`), `publicKey` (base64 DER SPKI), `validFrom`,
  `validUntil`, `status` (`active|retired|revoked`) and `revokedAt`. A signature
  is valid only inside its key's window (`validFrom ≤ t < validUntil`), where
  `t` is `recordedAt`, a tombstone's `purgedAt`, or a checkpoint's `createdAt`.
- A **rotation** record `{schemaVersion: aiwg.effect.key-rotation.v1, sequence,
  from, to, effectiveAt, reason}` MUST carry exactly one `prior` signature by
  the `from` key and one `successor` signature by the `to` key. Both sign the
  DSSE PAE with payload type `application/vnd.aiwg.effect-key-rotation.v1+json`
  over `canonicalJson` of the rotation without `signatures`. A rotation without
  a valid prior-key signature is rejected. Records signed before a rotation stay
  verifiable against their historical key.
- Checkpoints MAY additionally carry OpenPGP or SSH signatures through an
  explicitly selected adapter. They never replace the Ed25519 signature.

## Storage layout

The ledger lives under the artifact store at
`projectAiwgWritePath(projectDir, 'effects', <subsystem>)`. If an external
artifact root is configured but unavailable, every command fails closed with
exit 7 and never falls back to a repository-local path.

```text
effects/<subsystem>/
  segments/<writer-id>.jsonl         one hash-chained segment per writer
  index/<keyed-name>.json            exclusive-create, one per effect ID
  checkpoints/<sequence>.json        EffectCheckpoint.v1
  keyring.json                       EffectKeyring.v1
```

The reference implementation also keeps `index.key` (the per-ledger key for
index file names), `locks/` (same-host directory locks) and
`segments/<writer-id>.pending` (a signed line whose index claim won but whose
append has not completed; the writer finishes or discards it under its lock).
None of them is part of the verified record set. It also writes a second
exclusive-create index file per effect ID for the terminal outcome, so the
first `completed` or `failed` wins across writers.

- Writer IDs match `^[a-z0-9][a-z0-9-]{0,63}$`. Only one process appends to a
  segment, under a directory lock. Readers merge segments by `(recordedAt,
  writer, seq)`.
- The **index** file for an effect ID is created with an exclusive create
  (`link`/`O_EXCL`); the first writer wins. It holds the effect ID, payload
  digest, writer, `seq` and `recordHash` of the first intent. Its file name is a
  keyed digest, so plaintext IDs do not appear in directory listings.
- Directories are `0700` and files `0600`.
- A **checkpoint** records every writer's `{writer, segment, count, headHash}`,
  sorted by writer ID, and `root` = `"sha256:"` plus hex SHA-256 of
  `canonicalJson(writers)`. It also records `keyringDigest` (SHA-256 of
  `canonicalJson(keyring)`), `sequence` and `previousCheckpoint` (`null` at
  sequence 0). It is signed like a rotation with payload type
  `application/vnd.aiwg.effect-checkpoint.v1+json`. A copy MUST also go to an
  independent sink (the #1567 audit or a git ref), because a local chain alone
  cannot detect deletion of a whole segment or of its tail.
- The Merkle-log format is deferred. Moving to it changes storage, not this
  record format.

## Verifiers and tri-state results

Verifiers are registered by `kind`. Each declares `{kind, version,
canReportAbsent}`. A result (`EffectVerifierResult.v1`, and the `verification`
member of records) is:

| Result | Reason codes | Rules |
|---|---|---|
| `present` | `marker-match`, `state-match`, `digest-match`, `heuristic-match` | The target positively confirms the effect. Author and time-window heuristics give `heuristic-match` and never `absent`. |
| `absent` | `complete-query-no-match` | Requires `canReportAbsent: true`, `complete: true`, and an authenticated, successful, fully paged query. Verifiers SHOULD also require a minimum age since the intent, or two probes separated by a delay, where the target is eventually consistent. |
| `unknown` | `verifier-missing`, `verifier-version-mismatch`, `verifier-cannot-report-absent`, `network-error`, `timeout`, `auth-denied`, `rate-limited`, `server-error`, `container-unreadable`, `paging-incomplete`, `consistency-lag`, `tracker-blocked`, `malformed-response`, `evidence-conflict` | Anything else. `unknown` blocks replay and escalates. |

Verifiers use read-only credentials and the project tracker access order. A
`chooseTrackerAccess` blocker maps to `unknown` / `tracker-blocked`. Each
reconcile appends a new `reconciled` record; earlier records are never mutated.
A `present` result also records `completed` when no outcome is recorded yet
(the first outcome wins; an existing `failed` is left as it is).

### Verifier interface

The interface lives in `src/effects/verifiers/types.ts` and is exported
through `src/effects` and the package API. Additions MUST be optional members.

```ts
interface EffectVerifier {
  readonly kind: string;             // core kind or x.<vendor>.<name>
  readonly version: string;          // semver MAJOR.MINOR.PATCH
  readonly canReportAbsent: boolean;
  verify(request: EffectVerifierRequest): Promise<EffectVerifierObservation>;
}

interface EffectVerifierRequest {
  effectId: string; scope: EffectScope; kind: string; target: string;
  context: EffectContext; payloadDigest: string; intentRecordedAt: string;
  expected: EffectVerifierExpectation;   // {} when nothing is pinned
  signal: AbortSignal;                   // aborted at the framework timeout
}

interface EffectVerifierExpectation { digest?: string; object?: string; signed?: boolean }

interface EffectVerifierObservation {
  result: 'present' | 'absent' | 'unknown';
  reason: string;                        // a code from the table above
  complete: boolean;
  evidenceDigest?: string;               // sha256:<hex>
  evidence?: Record<string, string | number | boolean | null>;
}

interface EffectVerifierRegistry {
  get(kind: string): EffectVerifier | undefined;
  kinds(): string[];
  listKinds(): VerifierRef[];            // {kind, version, canReportAbsent}
}

class EffectVerifierError extends Error { readonly reason: UnknownReason }
```

- `expected` carries caller expectations that are not identity: digests and
  references only. Built-in verifiers read each member from `expected` first
  and fall back to a context member of the same name.
- `evidence` is digest-and-reference-only (it passes the digest-only scan). The
  framework sets `evidenceDigest` to `sha256:` over `canonicalJson(evidence)`
  and returns `evidence` to the caller; only the digest is recorded.
- The framework (`runVerifier`, used by `reconcileEffect`) enforces the
  tri-state rules and never throws. Each of these gives `unknown`:

  | Condition | Reason |
  |---|---|
  | No verifier for the kind | `verifier-missing` |
  | The verifier's kind differs from the intent's, or `verifierVersion` is pinned and differs | `verifier-version-mismatch` |
  | `absent` from a verifier with `canReportAbsent: false` | `verifier-cannot-report-absent` |
  | `absent` with `complete: false` | `paging-incomplete` |
  | Timeout (default 30 s; the request signal aborts and a late answer is ignored) | `timeout` |
  | `EffectVerifierError(reason)` thrown | that reason |
  | Any other throw | `server-error` |
  | A reason that does not belong to the result, a non-object answer, invalid or restricted evidence, or evidence that disagrees with `evidenceDigest` | `malformed-response` |

- `reconcileEffect(ledger, id, {verifiers?, expected?, timeoutMs?,
  verifierVersion?, links?})` returns `{result, receipt, completed, evidence?}`:
  the `EffectVerifierResult.v1`, the `reconciled` receipt, the `completed`
  receipt (or `null`) and the unrecorded evidence.
- `createBuiltinVerifierRegistry(options, extensions)` registers the built-ins
  and any extension verifiers. One verifier per kind; a duplicate is refused.

#### Extension kinds

A vendor verifier uses an extension kind `x.<vendor>.<name>` (the kind pattern
above) and targets in the `x-<vendor>:<ref>` scheme, implements the same
interface, and is passed in `extensions` or to `createVerifierRegistry`. It is
subject to every framework rule. It cannot shadow a registered kind, and adding
a core kind remains a contract revision. Tracker verifiers (#2719) register the
core `tracker.*` kinds the same way.

### Built-in verifiers

| Kind | Version | Target | `canReportAbsent` |
|---|---|---|---|
| `git.commit` | `1.0.0` | `git:<sha>` (full 40 or 64 hex) | yes |
| `git.tag` | `1.0.0` | `git-tag:<name>` | yes |
| `file.digest` | `1.0.0` | `file:<path>@sha256:<hex>` | yes |
| `decision.receipt` | `1.0.0` | `decision:invocation/<invocationId>`, `decision:batch/<batchId>`, `decision:job/<jobId>/<itemId>` | yes |
| `decision.review.continuation` | `1.0.0` | `review:<tenant>/<project>/<reviewId>` | yes |

A built-in whose repository, root or store is not configured on the host
answers `unknown` / `container-unreadable`. The pinned outcomes are:

- **`git.commit`.** Present commit: `present` / `state-match`, or
  `marker-match` when the commit has an `Effect-Id:` trailer equal to the
  effect ID. Missing from a complete repository: `absent`. Missing from a
  shallow or partial clone: `unknown` / `paging-incomplete`. A missing
  repository or a git binary that fails or cannot start: `unknown` /
  `container-unreadable`. A target that is not a full object ID: `unknown` /
  `malformed-response`.
- **`git.tag`.** Present tag: `present` / `state-match`. Missing tag: `absent`.
  A tag that exists but whose peeled object differs from `object`: `unknown` /
  `evidence-conflict`, never `absent`, because a replay would collide with the
  existing name.
- **Signature status (`signed: true`).** Checked with `git verify-commit` or
  `git verify-tag`, as `tools/ci/verify-signed-tag.sh` does. The evidence
  carries `signature`: `good`, `unsigned`, `bad`, `unverifiable`, `expired`,
  `revoked`, or `unchecked` when no signature was required. Only `good` can be
  `present`. `unverifiable` (no trusted key or allowed signer) is `unknown` /
  `container-unreadable`; every other non-good status, including an unsigned
  commit and a lightweight tag, is `unknown` / `evidence-conflict`. There is no
  `present-unsigned` result.
- **`file.digest`.** The path is resolved under the configured root and
  realpath-contained. Matching digest: `present` / `digest-match`. Different
  digest, or a missing file whose nearest existing ancestor is contained:
  `absent`. A lexical or symlink escape from the root, or an unreadable root:
  `unknown` / `container-unreadable`. A non-regular file: `unknown` /
  `evidence-conflict`.
- **`decision.receipt`.** D03 invocation receipts are read from the
  `DecisionReceiptStore` (`projectId`), batch receipts from the
  `BatchReceiptStore` (`tenantId`, `projectId`), and D16 job items from the
  `JobStore` (`tenantId`, `projectId`, `workspaceId`, `principalId`) followed
  by the D03 receipt of the item's latest attempt. Scope members come from the
  context, then from the verifier options. A `completed` receipt is `present` /
  `digest-match` when its `artifactDigest` equals the expected digest (the
  attempt's `receiptDigest` for a job item, else `expected.digest`, else
  `context.receiptDigest`), and `present` / `state-match` when no digest is
  pinned. A different digest or a `context.fingerprint` mismatch is `unknown` /
  `evidence-conflict`. A missing receipt, job, item or attempt in a readable
  store, or a `failed` receipt, is `absent`. A non-terminal or
  `execution-uncertain` receipt is `unknown` / `consistency-lag`. A MAC or
  integrity failure, an I/O failure or a D10-deleted job is `unknown` /
  `container-unreadable`; an access denial is `unknown` / `auth-denied`. D16
  resolves `execution-unknown` only on `digest-match`.
- **`decision.review.continuation`.** Reads the D13 review store (#2721). The
  context must be exactly the `d13.review/v1` identity and the effect ID must
  equal its derivation; otherwise `unknown` / `malformed-response`. A persisted
  receipt with this effect ID is `present` / `state-match`, or `digest-match`
  when it equals `expected.digest`; a different digest, a receipt for another
  effect ID or a different continuation ID is `unknown` / `evidence-conflict`.
  A missing review, a continuation never dispatched under this effect ID, or a
  definitive `execution-failed` is `absent`. A tombstoned review or an
  unreadable store is `unknown` / `container-unreadable`. While the review
  holds the dispatched continuation without a receipt, the verifier asks the
  host's `execution` probe at the effect's own target; with no probe it is
  `unknown` / `consistency-lag`. A D13 executor never replays on `absent` by
  itself. Legacy HMAC receipts are imported as `completed` records verified by
  a one-shot importer of the same kind at version `0.2.0` (evidence
  `method: legacy-hmac`).

### Tracker verifiers

`createTrackerVerifiers({config, remoteUrls, ...})` returns the three core
tracker verifiers, registered as extensions of the built-in registry. Each is
version `1.0.0` with `canReportAbsent: true`, and each takes a target
`gitea:owner/repo#N` or `github:owner/repo#N`.

| Kind | Present | Absent |
|---|---|---|
| `tracker.comment` | A comment by the pinned tracker actor carries `<!-- aiwg-effect: <effectId> -->` (`marker-match`, or `digest-match` when its body digest equals `expected.digest`, `context.digest` or the `payloadDigest`) | Every comment page read, no match |
| `tracker.issue.closed` | The issue state is `closed` (`state-match`) | The issue state is `open` |
| `tracker.pr.merged` | The PR is merged, and its merge commit equals `expected.object` or `context.object` when one is pinned (`marker-match` when the merge commit has an `Effect-Id:` trailer equal to the effect ID, else `state-match`) | The PR is open or closed unmerged, or it was merged as a different commit than the pinned one (evidence `mergeCommitMatch: false`) |

- **Authority.** `resolveTrackerAuthority` over the project config and the git
  remote URLs selects the tracker. A target on the internal tracker's forge
  uses the `issue_tracker` remote and `tracker_actor`; a target on the customer
  tracker's forge uses `customer_issue_tracker` and `customer_tracker_actor`.
  Any other forge, or a repository other than the selected remote's, is
  `unknown` / `tracker-blocked` and sends no request. The API base is derived
  from the selected remote URL (`https://<host>/api/v1` for Gitea,
  `https://api.github.com` or `https://<host>/api/v3` for GitHub); no host is
  assumed and secondary remotes are never contacted.
- **Access order.** `chooseTrackerAccess` over the paths a CLI process has:
  the tracker HTTP API with credentials from the existing tracker token path
  (`AIWG_GITEA_TOKEN`/`GITEA_TOKEN`, `AIWG_GITHUB_TOKEN`/`GITHUB_TOKEN`), then
  the forge CLI (`gh api --include`, GitHub only; Gitea has no CLI with a raw
  read API). MCP/app tools are never offered. A blocker is `unknown` /
  `tracker-blocked`. Reads are GET-only; access material is never part of
  evidence, records, errors or output.
- **Exact and heuristic matches.** A marker by any author other than the pinned
  actor, by a `forbid_actors` login, or when no actor is pinned, is `unknown` /
  `evidence-conflict`, never `present`. A pinned-actor comment without the
  marker created within `heuristicWindowMs` of the intent (off by default) is
  `present` / `heuristic-match` with evidence `confidence: heuristic`, never
  `absent`.
- **Absent.** Only after an authenticated, complete read: every comment page,
  proven by `x-total-count`, `x-hasmore` or `Link rel="next"`, or an
  authoritative issue or PR state. An intent younger than `minAbsentAgeMs`
  (default 60 s) is `unknown` / `consistency-lag` instead.

| Condition | Reason |
|---|---|
| HTTP 401 or 403, or `gh` exit 4 | `auth-denied` |
| HTTP 429, or 403 with `x-ratelimit-remaining: 0` or `retry-after` | `rate-limited` |
| HTTP 404 or 410 on the repository, issue or PR | `container-unreadable` |
| HTTP 5xx or another unexpected status | `server-error` |
| Connection failure | `network-error` |
| Framework timeout | `timeout` |
| A full page without pagination headers, totals that disagree, a short chain, or more than `maxPages` (default 100) pages | `paging-incomplete` |
| A body over 2 MB (`maxResponseBytes`), invalid JSON or an unexpected shape | `malformed-response` |
| No usable access path, or a target outside the tracker authority | `tracker-blocked` |

## Retention and tombstones

Retention follows D10 (`decision-lifecycle/v1`). Ledger records bind the
`receipt` surface until a dedicated surface exists; `tombstone.retentionPolicy`
names the rule (for example `decision-lifecycle/v1#receipt`).

- On purge, a segment line keeps its `writer`, `seq` and original `recordHash`,
  and its envelope is replaced by a signed `tombstone` record. The tombstone
  keeps `effectId`, `idDerivation`, `scope`, `kind`, `payloadDigest`, `writer`,
  `seq`, `prev`, `links` and the subject digest. It drops `target`, `context`,
  `verification` and `failure`, and adds `{originalRecordHash, originalKeyid,
  originalPhase, purgedAt, retentionPolicy}`. `originalRecordHash` MUST equal
  the line's `recordHash`, so the chain still verifies.
- The effect-ID index is kept for at least the longest resume or continuation
  window plus the D10 grace period, so a purged ID cannot be replayed as new.
- An intent with no outcome is never purged until it has been reconciled.
- A D10 legal hold blocks purge.

## CLI and exit codes

`aiwg effect id | intent | record | lookup | reconcile | probe | verify |
checkpoint | kinds | keys`, plus the operator command `recover-lock` (see
"Stale lock recovery"). `record` performs intent, verify and completed in one
command: it appends the intent, runs the kind's verifier, and appends
`completed` for `present` or `reconciled` for `absent` and `unknown`.
`record --unverified` appends the intent only. `probe` is read-only: it runs
the kind's verifier once, writes no records, needs no ledger key, and exits
0, 3 or 4 like `reconcile`. `verify --with-decisions <audit.jsonl>` also
verifies the #1567 decision chain and every operator-decision link (see
"Composition"). Output is JSON by default (`--format text` for
people), and every JSON document carries a `schema` member
(`aiwg.effect.<command>.v1`, or `aiwg.effect.error.v1` for a failure with its
`code`, `reason` and fixed message). The command reference is
[`docs/cli/reference.md`](../cli/reference.md#effect).

Scope `tenant` and `project`, the segment writer ID and the key provider come
from the `effects` block of `aiwg.config`, never from command arguments. The
default key provider is the host secret service (`effects.aiwg.io`, account
`ledger/<tenant>/<project>/<subsystem>`); `keys init` provisions the key there
and `keys rotate` stages the successor under a separate entry until the
rotation is written, then promotes it. Output shows key IDs and public keys
only.

<!-- effect-exit-codes:begin -->
| Code | Outcome | Meaning |
|---|---|---|
| `0` | present or recorded | The record was appended, an idempotent replay returned the existing receipt, `lookup`/`reconcile` found the effect present, or `verify` found the ledger intact |
| `1` | internal error | Unexpected failure; nothing is claimed about the effect |
| `2` | usage error | Invalid arguments, unknown subcommand, malformed effect ID or unknown kind |
| `3` | absent | `reconcile`: the verifier reported `absent`. `lookup`: the ledger has no record for the ID, or its latest outcome is `failed` or a `reconciled` `absent` |
| `4` | unknown | The verifier reported `unknown`, or `lookup` found an intent with no outcome |
| `5` | conflict | Same effect ID with a different payload digest |
| `6` | integrity failure | A signature, key window, chain link, record hash, checkpoint or scope check failed, or (`verify --with-decisions`) the decision chain is broken or a linked decision event is missing |
| `7` | artifact root unavailable | The configured artifact root cannot be written or read; no fallback |
<!-- effect-exit-codes:end -->

`recover-lock` uses the same codes: `0` recovered and recorded, `2` missing
`--authorize` or an invalid lock name, `3` no such lock is held, `4` the owner
cannot be verified, `5` the owner is live, its PID was reused, or another
recovery is in progress.

Exit codes 20–29 belong to `aiwg verify` (`ARTIFACT_VERIFICATION_EXIT_CODES`,
`src/security/artifact-verifier.ts`) and are never emitted by `aiwg effect`.
When several conditions apply, the precedence is 2, 7, 6, 5, then the outcome.

## Stale lock recovery

Ledger locks are same-host directory locks under `locks/<name>.lock` (`name` is
`writer-<writer-id>`, `checkpoint` or `keyring`) whose `owner` file holds the
owner's PID and a random token. A writer never steals a lock: it waits and then
fails. A lock left by a crashed writer is removed only by an explicit operator
recovery, modelled on the D16 quota-lock recovery
(`recoverStaleJobQuotaLock`):

- The owner MUST be dead (`ESRCH`). A live owner is refused. On Linux, a live
  PID whose process started after the owner file was written is a reused PID
  and is refused. A malformed or unreadable owner file, or a PID that cannot be
  signalled (`EPERM`), is unverifiable and refused.
- The recovery needs an explicit authorization (`--authorize`) that approves
  the inspected owner. A guard directory serializes concurrent recoveries.
- The recovery appends a signed intent of kind `x.aiwg.ledger-lock-recovery`
  (target `x-aiwg:effects/<subsystem>/locks/<name>`, context `{lock, ownerPid,
  ownerDigest}` where `ownerDigest` is the SHA-256 of the owner file value),
  re-checks that the same dead owner still holds the lock, removes it, and
  appends `completed` once the lock-state verifier reports `present`. A
  recovery of the CLI's own writer lock appends under the `lock-recovery`
  writer.

## Security boundary

- The ledger proves what AIWG recorded and what a verifier observed. It does not
  prove that an effect was authorized, correct or safe.
- A correctly keyed writer can record a false outcome. Verifiers, not
  signatures, establish what happened at the target.
- Trust in records reduces to custody of the ledger key and to the independent
  checkpoint sink. Keyring updates are accepted only through rotations signed by
  the prior key.
- The same-host local filesystem is the only supported compare-and-swap.
  Distributed writers are out of scope.
- Model output never selects scope, kind derivation, keys or retention.

## Composition

- #1567 operator decisions authorize effects. Records link to them through
  `links.operatorDecisionEventId` and `links.operatorDecisionRecordHash`, both
  `sha256:` digests (D13 IDs come from `reviewOperatorEventId`;
  `reviewApprovalLinks(review, proposalVersion)` builds the links for a review
  continuation, and `journaledReviewExecutor({links})` records them with the
  intent). `verifyDecisionLinks` and `aiwg effect verify --with-decisions`
  check the decision chain and that every linked event exists, with a
  matching record hash when one is linked. There is no write coupling: the
  ledger never writes the decision store and the decision store never reads
  the ledger.
- D13 review (#2606) adopts the ledger through a `VerifiedReviewEffectLedger`
  adapter using `d13.review/v1` (#2721): a signed `intent` before the effect,
  `completed` only on a `present` verification, and a ledger-backed
  `reconcile(effectId)` for stale leases.
- D16 jobs (#2610) may resolve `execution-unknown` only through a verified
  effect whose digest matches the attempt's receipt digest (#2722). The
  worker records a `decision.receipt` effect (target
  `decision:job/<jobId>/<itemId>`, context the job scope and `attemptId`,
  payload digest the D03 receipt digest) before it writes the job record. The
  opt-in resolver re-runs the verifier with that digest as `expected.digest`
  and promotes the item only on `present` / `digest-match`; `state-match`,
  `absent` and `unknown` leave it `execution-unknown`. The promotion is the
  one gated `DecisionJob` transition out of `execution-unknown` and records
  `attempts[].resolution`.
- OpenTelemetry `trace_id`, `span_id` and `gen_ai.tool.call.id` are correlation
  links, never evidence.

## Conformance evidence

- Schemas and catalog domain: `schemas/effects/`, `schemas/catalog/domains/effects.json`
- Fixtures: `test/fixtures/effects/{valid,invalid}/`, built deterministically by
  `test/fixtures/effects/build-fixtures.ts` (`--check` fails on drift)
- Identity vectors: `test/fixtures/effects/vectors/identity.v1.json`
- Test: `test/conformance/effects-v1/effect-ledger-contract.test.ts` validates
  every positive and negative fixture, recomputes each vector, verifies every
  fixture signature, chain and checkpoint, scans fixtures for restricted
  material, and checks this exit-code table against the ADR.
- Runtime: `src/effects/` (exported through the package API) implements this
  contract. `test/conformance/effects-v1/effect-ledger-runtime.test.ts` uses the
  fixtures as golden vectors for the library, and `test/unit/effects/` covers
  idempotence, the multi-process first-writer race, the tamper matrix,
  rotation, tombstones, the fail-closed artifact root and the canary scan.
- Verifiers: `test/unit/effects/verifiers.test.ts` covers the registry, the
  table-driven error mapping, `file.digest`, `decision.receipt`, the
  unconfigured review verifier, the crash-window harness and append-only reconcile history;
  `test/unit/effects/verifiers-git.test.ts` covers the `git.commit` and
  `git.tag` matrix, including signature status, over temporary repositories.
  `test/unit/effects/verifiers-tracker.test.ts` covers the tracker verifiers
  against mocked Gitea and GitHub responses: the tri-state tables, pagination,
  the access-gap table, authority (no mirror traffic), the access order and a
  canary scan of records, errors and output.
- CLI: `test/unit/cli/handlers/effect.test.ts` runs every subcommand against a
  temporary project and artifact root (exit codes, idempotence, conflict,
  tamper, fail-closed root, key custody, lock recovery and the output canary);
  `test/integration/effect-cli.test.ts` runs the built CLI;
  `test/integration/effect-ledger-discovery.test.ts` checks discovery; and
  `test/unit/docs/effect-cli-docs.test.ts` keeps the help, reference and man
  page in step with the exit codes.
- D13 adoption: `test/unit/decision/review-effect-ledger.test.ts` covers the
  review verifier, intent before execution, the reconciler fallback, the legacy
  HMAC migration, key independence and reviews persisted before the ledger;
  `test/conformance/decision-v1/review-effect-crash.test.ts` is the
  killed-process crash matrix.
