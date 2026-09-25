# Effect Ledger: Best-Practices Research Brief

> Input to the [effect ledger ADR](../adr-effect-ledger.md). Where this brief
> and the ADR or the [v1 contract](../../contracts/effect-ledger.v1.md)
> differ, the ADR and contract win. In particular, the contract pins D13's
> identity to `proposalVersion` (not a proposal digest), and `absent` alone
> never authorizes a D13 replay.

Context: the draft proposal `effect-ledger-issue.md` (AIWG effect ledger: record, sign, look up, verify, reconcile side effects). This brief covers prior art and gives recommendations. Citations are numbered [n] and listed at the end.

## Executive summary

1. **Exactly-once effects do not exist end to end.** Every serious system gives at-least-once execution plus deduplication at the target, or verification against the target. The ledger is a *proof and dedup index*. It is not a transaction coordinator [1][2][6][7].
2. **The crash window cannot be closed locally.** Temporal, Restate and Azure Durable Functions all re-run an activity if the process crashes after the effect but before the journal write [6][7][8]. The target system is the only authority. That is exactly the role of the draft's per-kind verifiers.
3. **Write intent before the effect, and outcome after it.** Two records per effect (the outbox pattern [3]) turn "unknown" into a bounded search: reconciliation only needs to probe intents that have no outcome.
4. **Effect IDs must be deterministic and must travel to the target** (for example an idempotency key, or a marker embedded in a comment body) whenever the target supports it. Then a verifier can find the effect by ID, and not only by guessing [1][2].
5. **Reuse of an ID with a different payload digest is a conflict. It is not a replay.** Stripe and the IETF draft both reject it (the draft specifies 422) [1][2].
6. **Use a hash chain per writer segment and anchor it with signed checkpoints.** Move to a Merkle tree (C2SP tlog-tiles / Tessera) only when third parties need inclusion or consistency proofs [9][10][11][12].
7. **Envelope: DSSE wrapping an in-toto Statement v1** with a custom `predicateType`. This is the same shape Sigstore/Rekor accepts, so records can later be published without re-signing [13][14][16].
8. **Signing: Ed25519, with the key held outside the artifact store.** HMAC fails third-party verification. OpenPGP is heavy and interactive. Keep OpenPGP for commits [18][19][20].
9. **Reconciliation is tri-state (`present`, `absent`, `unknown`).** `absent` needs a positive, authoritative negative answer. Errors, timeouts, 403s and rate limits always mean `unknown` [7][22].
10. **For agent audit, OpenTelemetry GenAI `execute_tool` spans are good correlation IDs but are not evidence.** Link the span or tool-call ID into the record. Do not rely on telemetry for proof [23][24].

---

## 1. Idempotency and exactly-once effects

**Patterns**
- **Idempotency keys (Stripe).** The client generates a key. The server stores the first response together with the request parameters and returns that same response on retry. If the same key arrives with different parameters, the request fails. Keys expire after 24h [1]. The IETF `Idempotency-Key` draft (-07, Oct 2025, Standards Track) standardises this. It specifies a fingerprint of the request payload, 409 for a concurrent in-flight duplicate, 422 for key reuse with a different payload, and an advertised expiry policy [2].
- **Transactional outbox.** Write the intent in the same atomic step as the local state change. A relay performs the effect or publishes it at least once [3]. **Inbox / idempotent consumer:** the receiver records processed message IDs and drops duplicates [4].
- **Sagas.** A sequence of local transactions, each with a compensating action. Compensation is itself an effect and must be ledgered and idempotent [5].
- **Deterministic IDs.** Derive the ID from the causal context (workflow + step + attempt-independent inputs), never from time or randomness. Then a restarted process regenerates the same ID. Temporal recommends workflow ID + activity ID as the idempotency key for downstream calls [6].

**Pitfalls**
- Including the attempt number in the ID makes retries look like new effects. Keep `attempt` as a field, outside the identity.
- A dedup window shorter than the reconcile window. Stripe's 24h is enough for API retries but too short for crash reconciliation. The ledger must keep identities at least as long as a continuation can be resumed.
- Recording the intent *after* the effect. This loses the whole crash window.

## 2. Durable execution engines

| Engine | Effect semantics | Crash between effect and journal |
|---|---|---|
| Temporal | Activities run at least once. Completion is recorded as `ActivityTaskCompleted` in the event history. Retries follow the policy [6]. | The activity re-executes. Temporal tells you to make activities idempotent (use workflow ID + activity ID as the key) [6]. |
| Restate | `ctx.run` persists the action's result in the journal. On replay the stored result is returned and the action is not re-run [7]. | If the crash happens before the result is journaled, the action runs again. Restate says to make it idempotent [7]. |
| Azure Durable Functions | Orchestrator replays from history. Activities are "at least once" [8]. | Activities re-run. The docs require idempotent activities [8]. |
| AWS Step Functions | Standard workflows: exactly-once *workflow* execution, but task integrations can be retried. Express workflows: at least once. `StartExecution` is idempotent on execution name [25]. | Retries go to the task. Idempotency stays the target's job [25]. |

**Takeaways for AIWG**
- All four engines record *completion* as a journal event that the engine owns. None of them verifies against the target. AIWG's verifiers go one step further, and this is the correct addition for side effects on trackers and git, where AIWG does not control the target.
- Adopt the journal-event vocabulary: `scheduled` (intent), `completed` (outcome and evidence), `failed`, and `reconciled`.
- Replay should read the ledger first. A present receipt means return it (like Restate's journaled result). An intent with no outcome means reconcile before any retry.

## 3. Append-only tamper-evident logs

**Patterns**
- **Certificate Transparency** (RFC 6962, now RFC 9162 v2). A Merkle tree log with a Signed Tree Head (STH) and two proofs. An *inclusion proof* shows that an entry is in the tree. A *consistency proof* shows that tree N is a prefix of tree M, so nothing was rewritten [9][10]. Monitors and gossip catch split views.
- **Trillian → Tessera.** Trillian was the general-purpose verifiable log. Its successor, Tessera, uses the C2SP **tlog-tiles** static layout (tiles served as plain files) and the **checkpoint** format: a signed note over `origin`, `size` and `root hash`. Witnesses cosign checkpoints [11][12]. Rekor v2 is built on Tessera [16].
- **Hash chain vs Merkle tree.** A hash chain (`prev_hash` in each record) is simple and detects edits, reorders and deletions in the middle. However, proving that one entry is included costs O(n), and a chain alone **cannot detect truncation of the tail** unless the head is anchored somewhere else. A Merkle tree gives O(log n) inclusion and consistency proofs [9].
- **Git content addressing.** An object's ID is the hash of its content. Signed commits and tags anchor a DAG. Git moved from SHA-1 to SHA-256 after SHAttered, which is a reminder to use a modern hash and to name the algorithm in the record [26].

**Pitfalls**
- Truncation and rollback. You need signed checkpoints (size + head hash) stored away from the log: a git tag, the operator-decision audit, a witness, or later a transparency service.
- Canonicalisation. Hashing JSON that has been re-serialised breaks verification. Hash and sign the *exact bytes* (DSSE avoids this) or use RFC 8785 JCS [27].
- Multi-writer interleaving in a single chain needs a lock. Per-writer segments avoid contention.

## 4. Signed statements and attestations

- **IETF SCITT** (architecture draft -22, Oct 2025, not yet an RFC). An *issuer* signs a *Signed Statement* (COSE_Sign1). A *Transparency Service* registers it in an append-only log and returns a *Receipt*, which is a COSE inclusion proof [15][28]. It fits as a *later publication target*. Its COSE/CBOR tooling is still immature in Node.
- **in-toto Attestation Framework.** The Statement v1 has `subject[]` (name + digests), `predicateType` (a URI) and `predicate` (a free-form typed body) [14]. It is designed for custom predicates, so an `effect/v1` predicate fits cleanly.
- **DSSE.** The envelope carries `payloadType`, base64 `payload` and `signatures[{keyid, sig}]`. The signature covers PAE(type, payload), which avoids canonicalisation problems and type confusion. The envelope is agnostic to the signing algorithm [13].
- **Sigstore.** cosign signs DSSE / in-toto bundles. Rekor is the transparency log. *Keyless* mode binds a short-lived Fulcio certificate to an OIDC identity and needs network access and an identity provider. *Key-based* mode (a local key) works offline and can still upload to Rekor later [16][17].
- **W3C Verifiable Credentials 2.0.** Claims about a holder, secured with Data Integrity or JOSE/COSE [29]. VCs are oriented to identity and holders, not to event logs. They would be overkill here.

**Fit for a local-first CLI:** DSSE + in-toto Statement, signed with a local Ed25519 key. It works fully offline, verifiers exist in many languages, and the same envelope can later go to Rekor (key-based) or be converted into a SCITT Signed Statement [15][16]. Receiver-attested receipts, where the *target* signs (the "Notarized Agents" proposal [30]), are the strongest model. Trackers do not offer them today, which is why authoritative verifier lookups are the practical substitute.

## 5. Signing keys for local CLI tools

| Option | Third-party verifiable | Offline | Custody and rotation | Notes |
|---|---|---|---|---|
| **Ed25519** (RFC 8032) | Yes (public key) | Yes | Simple: key ID = hash of public key. Rotate by signing a rotation record with the old key | Deterministic signatures, small, fast. Node `crypto` supports it natively [18]. |
| HMAC-SHA256 | **No.** Any verifier can also forge | Yes | Shared secret, so every verifier holds signing power | Only acceptable as an internal MAC, never as an audit signature [19]. |
| OpenPGP (the existing `delivery.signing`) | Yes | Yes | Heavy. The OpenBao-backed program may prompt or fail non-interactively | Suited to commits. Signing every ledger append makes throughput and availability depend on the vault [20]. |
| SSH signatures (`ssh-keygen -Y sign`) | Yes (`allowed_signers`) | Yes | Reuses familiar tooling. Namespace separation (`-n aiwg-effect`) | A good fallback. Git already verifies SSH-signed commits [21]. |

**Custody rules**
- The signing key must live outside the artifact store (host secret service or OpenBao). The store holds only public keys and a `keyring` of `{keyid, pubkey, valid_from, valid_to, revoked}`.
- Use domain separation: a dedicated key purpose or namespace, never the commit-signing key raw, so that a ledger signature cannot be replayed as a commit signature.
- Rotation: the new key is introduced by a keyring record signed by the old key (or by the operator's OpenPGP key). Old records stay verifiable against their historical key.
- Record `keyid` in every signature. A verifier then rejects signatures made outside the key's validity window.

## 6. Agent-specific practice (brief)

- **OpenTelemetry GenAI semantic conventions** define `execute_tool` spans with `gen_ai.tool.name`, `gen_ai.tool.type` and `gen_ai.tool.call.id`, plus agent spans (`invoke_agent`). They are still in *Development* status [23][24]. They give correlation, not tamper-evidence. Sampling and exporters can drop spans.
- **MCP** has no audit-log standard. Tool annotations (`destructiveHint`, `idempotentHint`, `openWorldHint`) are advisory hints that are not guaranteed [31]. The `idempotentHint` hint is still useful for choosing a default verifier or retry policy.
- Frameworks such as LangGraph checkpoint state per step for replay, but they do not prove external effects. Research proposals (receiver-signed receipts [30]) confirm that self-logging by the agent is the weak point.
- **Apply:** put `gen_ai.tool.call.id`, `trace_id` and `span_id` in the record's `links`, and emit an OTel event on record and reconcile. Proof stays in the ledger.

## 7. Reconciliation semantics

- **Tri-state result:** `present` (the target positively confirms, with evidence digest and ref), `absent` (the target positively confirms non-existence under an authoritative, complete query), `unknown` (anything else).
- Never map to `absent`: network errors, timeouts, 401/403, 404 on the *container* (repo or issue unreadable), rate limiting, pagination that was not exhausted, eventual-consistency lag, or a verifier that is missing or has the wrong version. Only an authenticated, successful, complete query can return `absent`.
- `unknown` blocks replay (fail closed), unless the effect is target-idempotent (for example, the idempotency key was sent to a target that deduplicates).
- Record every reconcile attempt as its own signed entry (`reconciled: present|absent|unknown`, verifier id@version, evidence digest). Do not mutate the intent entry.
- Eventual consistency: `absent` should require either an age threshold since the intent or two probes separated by a delay (GitHub search and list endpoints lag).
- Prefer lookups that verifiers can match exactly: the effect ID embedded in the target (a hidden HTML comment marker in a PR or issue comment body, a git trailer `Effect-Id:`, or a release-asset digest). Heuristic matching (by author and time window) should at best produce `present` with `confidence: heuristic`, and never `absent`.

---

## Recommended design decisions for AIWG

**Q1. Signing.** Use a dedicated **Ed25519 ledger key**, held by the host secret service or OpenBao and independent of the artifact and review store (this satisfies the D13 rule). Sign with DSSE. Do not use HMAC for records, because third parties cannot verify it. Keep `delivery.signing` (OpenPGP) for commits. Optionally use it to sign the *keyring rotation records* and periodic *checkpoints*, so that ledger trust chains to the operator's release identity without putting the vault on the hot path. Provide SSH-signature (`ssh-keygen -Y`) support as an alternative signer adapter.

**Q2. Scope and multi-writer.** Use **per-project ledgers** (the scope is the project ID from config), with sub-scopes by domain (`review`, `job`, `delivery`). Each writer (host + process identity) gets its **own append-only segment** (`effects/<scope>/segments/<writer-id>.jsonl`), hash-chained and single-writer by construction. Use an `O_APPEND` + fsync + lock file only within a segment. Readers merge segments by `(recorded_at, writer, seq)`. Idempotency across writers is enforced at record time by an **effect-ID index**, created with an exclusive-create file `index/<effectId>` (atomic `O_EXCL`). The first writer wins. Later writers get the existing receipt, or a conflict if the payload digest differs. Periodically emit a signed **checkpoint** (per-segment `{size, head}` plus a Merkle root over the segment heads) to truncation-resistant storage (a git tag or note, or the #1567 audit). Moving later to C2SP tlog-tiles is a storage change, not a format change.

**Q3. Verifier trust.** Verifiers authenticate through the **project tracker access order** (MCP/app → HTTP API → CLI → blocker) and the configured `tracker_actor`. They are read-only credentials, never the writer's. Each verifier declares `kind`, `version`, `authoritative_for` and `supports_absent: bool`. A verifier with `supports_absent: false` can only return `present` or `unknown`. Failures are recorded as `unknown` with a reason code (`auth`, `network`, `rate_limit`, `not_readable`, `inconsistent`, `unsupported`). Callers must treat `unknown` as "do not replay; escalate". Evidence is always stored as digests and refs (for example a merge SHA, comment ID and body sha256), never raw bodies.

**Q4. Retention and erasure (D10).** Store records digest-only from the start, so erasure mostly concerns references. On purge, replace the record's DSSE payload with a **tombstone** that keeps `effectId`, `kind`, the target digest, the record hash, the original signature's `keyid`, and a `purged_at` + policy reference, signed by the ledger key. The chain uses **the hash of the original record**, so the chain stays verifiable after the payload is removed. Keep the effect-ID index for at least the maximum continuation or job resume horizon plus the D10 grace period. Otherwise a purged ID could be replayed. Never purge an intent that has no outcome record until it has been reconciled.

**Q5. Packaging.** Put the **core library + CLI group `aiwg effect`** in core. D13, D16 and delivery flows depend on it, and a core contract (`docs/contracts/effect-ledger.v1.md` + a JSON Schema) should not be optional. Ship **verifiers as a plugin registry**, with built-ins in core (git, file, Gitea, GitHub) and extras via aiwg-utils or extensions. Ship the **aiwg-utils skill + quickref entry** for agent discovery (`aiwg discover "record an effect"`, "reconcile effect", "did this PR merge"). Exit codes: 0 present / recorded, 3 absent, 4 unknown, 5 conflict, 6 integrity failure.

**Record envelope.** Use a DSSE envelope, `payloadType: application/vnd.in-toto+json`, whose payload is an in-toto Statement v1:

```json
{
  "_type": "https://in-toto.io/Statement/v1",
  "subject": [{"name": "gitea:roctinam/aiwg#2712", "digest": {"sha256": "<target-ref digest>"}}],
  "predicateType": "https://aiwg.io/attestations/effect/v1",
  "predicate": {
    "effectId": "eff1_<base32 sha256>", "phase": "intent|completed|failed|reconciled",
    "kind": "tracker.pr.merged", "scope": "project:<id>/review",
    "payloadDigest": {"sha256": "..."}, "actor": {"id": "...", "via": "api"},
    "verification": {"verifier": "gitea.pr.merged@1", "result": "present|absent|unknown",
                     "reason": null, "evidence": {"mergeSha": "...", "sha256": "..."}},
    "attempt": 2, "recordedAt": "RFC3339",
    "chain": {"writer": "<writer-id>", "seq": 41, "prev": "sha256:..."},
    "links": {"decisionEvent": "...", "otelTraceId": "...", "toolCallId": "..."}
  }
}
```

Each segment line is `{envelope, recordHash}`. `recordHash = sha256(PAE bytes)`. `chain.prev` is inside the signed payload, so reordering, editing and splicing all break a signature or a link. Scope is inside the signed payload, so a cross-scope replay fails verification.

**Effect-ID derivation.**
`effectId = "eff1_" + base32(sha256(JCS({v:1, scope, kind, target, context})))[:52]`,
where `context` holds the caller's causal identity, for example `{review, continuation, proposalDigest}`, `{job, item}` or `{issue, action, cycle}`.

- Exclude `attempt`, timestamps, actor and host.
- The payload digest is *not* part of the ID. It is stored beside the ID and compared on re-record: equal means idempotent return of the receipt, different means conflict.
- `aiwg effect id` computes the ID from named flags, so every caller derives it identically. The version prefix allows a future change of derivation.
- Where the target allows it, write the ID into the target (an `<!-- aiwg-effect: eff1_… -->` marker, a git trailer, or an `Idempotency-Key` header) so the verifier can find the effect exactly.

**Crash-window protocol.** (1) Record `intent` (signed). (2) Perform the effect, carrying the effect ID. (3) Run the verifier. (4) Record `completed` with evidence. On restart, for each intent that has no outcome, run `reconcile`. The result is `present` → record `reconciled` (no replay), `absent` → safe to retry under the same ID, or `unknown` → block and escalate.

---

## References

1. Stripe, "Idempotent requests." https://docs.stripe.com/api/idempotent_requests
2. IETF HTTPAPI WG, "The Idempotency-Key HTTP Header Field," draft-ietf-httpapi-idempotency-key-header-07 (Oct 2025). https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-idempotency-key-header-07
3. C. Richardson, "Pattern: Transactional outbox." https://microservices.io/patterns/data/transactional-outbox.html
4. C. Richardson, "Pattern: Idempotent Consumer." https://microservices.io/patterns/communication-style/idempotent-consumer.html
5. C. Richardson, "Pattern: Saga." https://microservices.io/patterns/data/saga.html; H. Garcia-Molina and K. Salem, "Sagas," SIGMOD 1987. https://dl.acm.org/doi/10.1145/38713.38742
6. Temporal, "Activity Definition: idempotency" and "Activity Execution." https://docs.temporal.io/activity-definition#idempotency ; https://docs.temporal.io/activity-execution
7. Restate, "Durable steps / actions (ctx.run)." https://docs.restate.dev/foundations/actions
8. Microsoft, "Durable Functions: orchestrations / reliability (activities at-least-once)." https://learn.microsoft.com/azure/azure-functions/durable/durable-functions-orchestrations
9. B. Laurie et al., RFC 6962 "Certificate Transparency." https://www.rfc-editor.org/rfc/rfc6962
10. B. Laurie et al., RFC 9162 "Certificate Transparency Version 2.0." https://www.rfc-editor.org/rfc/rfc9162
11. Transparency.dev, Trillian Tessera. https://github.com/transparency-dev/tessera
12. C2SP, "tlog-tiles" and "tlog-checkpoint" / "signed-note." https://c2sp.org/tlog-tiles ; https://c2sp.org/tlog-checkpoint ; https://c2sp.org/signed-note
13. Secure Systems Lab, "DSSE: Dead Simple Signing Envelope." https://github.com/secure-systems-lab/dsse
14. in-toto, "Attestation Framework: Statement v1." https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md
15. IETF SCITT, "An Architecture for Trustworthy and Transparent Digital Supply Chains," draft-ietf-scitt-architecture-22. https://datatracker.ietf.org/doc/html/draft-ietf-scitt-architecture-22
16. Sigstore, "Rekor" and "Rekor v2 (tile-backed)." https://docs.sigstore.dev/logging/overview/ ; https://blog.sigstore.dev/
17. Sigstore, "cosign: signing with keys vs keyless." https://docs.sigstore.dev/cosign/signing/overview/
18. S. Josefsson and I. Liusvaara, RFC 8032 "EdDSA." https://www.rfc-editor.org/rfc/rfc8032 ; Node.js crypto `sign`/`verify`. https://nodejs.org/api/crypto.html
19. H. Krawczyk et al., RFC 2104 "HMAC." https://www.rfc-editor.org/rfc/rfc2104
20. RFC 9580 "OpenPGP." https://www.rfc-editor.org/rfc/rfc9580
21. OpenSSH `ssh-keygen -Y sign/verify`, and PROTOCOL.sshsig. https://man.openbsd.org/ssh-keygen ; https://github.com/openssh/openssh-portable/blob/master/PROTOCOL.sshsig
22. GitHub REST API, "Rate limits" and "Best practices" (secondary limits, eventual consistency). https://docs.github.com/rest/using-the-rest-api/rate-limits-for-the-rest-api
23. OpenTelemetry, "Semantic conventions for GenAI spans / agent spans." https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/ ; https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/
24. OpenTelemetry, GenAI attribute registry. https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/
25. AWS, "Step Functions: Standard vs Express workflows" and StartExecution idempotency. https://docs.aws.amazon.com/step-functions/latest/dg/choosing-workflow-type.html ; https://docs.aws.amazon.com/step-functions/latest/apireference/API_StartExecution.html
26. Git, "hash-function-transition." https://git-scm.com/docs/hash-function-transition
27. A. Rundgren et al., RFC 8785 "JSON Canonicalization Scheme." https://www.rfc-editor.org/rfc/rfc8785
28. IETF COSE, "COSE Receipts (Merkle tree proofs)," draft-ietf-cose-merkle-tree-proofs. https://datatracker.ietf.org/doc/draft-ietf-cose-merkle-tree-proofs/
29. W3C, "Verifiable Credentials Data Model v2.0." https://www.w3.org/TR/vc-data-model-2.0/
30. J. Figuera, "Notarized Agents: Receiver-Attested Confidential Receipts for AI Agent Actions," arXiv:2606.04193. https://arxiv.org/abs/2606.04193
31. Model Context Protocol, "Tools: annotations." https://modelcontextprotocol.io/specification/2025-06-18/server/tools
