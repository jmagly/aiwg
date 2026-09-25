# Effect Ledger v1

Status: contract accepted; core library in `src/effects/` (#2717); verifiers, CLI and adoption pending (#2718 onward)
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

`aiwg effect id | intent | record | lookup | reconcile | verify | checkpoint |
kinds | keys`. `record` performs intent, verify and completed in one command.
Output is JSON by default.

<!-- effect-exit-codes:begin -->
| Code | Outcome | Meaning |
|---|---|---|
| `0` | present or recorded | The record was appended, an idempotent replay returned the existing receipt, `lookup`/`reconcile` found the effect present, or `verify` found the ledger intact |
| `1` | internal error | Unexpected failure; nothing is claimed about the effect |
| `2` | usage error | Invalid arguments, unknown subcommand, malformed effect ID or unknown kind |
| `3` | absent | `reconcile`: the verifier reported `absent`. `lookup`: the ledger has no record for the ID, or its latest outcome is `failed` or a `reconciled` `absent` |
| `4` | unknown | The verifier reported `unknown`, or `lookup` found an intent with no outcome |
| `5` | conflict | Same effect ID with a different payload digest |
| `6` | integrity failure | A signature, key window, chain link, record hash, checkpoint or scope check failed |
| `7` | artifact root unavailable | The configured artifact root cannot be written or read; no fallback |
<!-- effect-exit-codes:end -->

Exit codes 20–29 belong to `aiwg verify` (`ARTIFACT_VERIFICATION_EXIT_CODES`,
`src/security/artifact-verifier.ts`) and are never emitted by `aiwg effect`.
When several conditions apply, the precedence is 2, 7, 6, 5, then the outcome.

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
  `links.operatorDecisionEventId` and `links.operatorDecisionRecordHash`
  (D13 IDs come from `reviewOperatorEventId`).
- D13 review (#2606) adopts the ledger through a `VerifiedReviewEffectLedger`
  adapter using `d13.review/v1`.
- D16 jobs (#2610) may resolve `execution-unknown` only through a verified
  effect whose digest matches the attempt's receipt digest.
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
