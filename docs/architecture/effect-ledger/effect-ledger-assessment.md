# Effect Ledger — Reuse and Integration Assessment

> Input to the [effect ledger ADR](../adr-effect-ledger.md). Where this
> assessment and the ADR or the [v1 contract](../../contracts/effect-ledger.v1.md)
> differ, the ADR and contract win. The ADR replaced the proposed per-record
> HMAC with Ed25519 signatures on every record, and replaced the proposed exit
> codes (10–14, 21–27 reuse) with 0, 3, 4, 5 and 6 plus 1, 2 and 7.

Scope: read-only assessment of `main` plus `origin/delivery/unit-c-final` (fetched 2026-09-24, head `f7ca62d30`).
Paths prefixed `[uc]` exist only on (or were read from) `origin/delivery/unit-c-final` (`git show origin/delivery/unit-c-final:<path>`). Everything else is on `main`.
Input: `effect-ledger-issue.md` (draft proposal).

Verdict legend: **reuse** = reuse as is · **extend** = keep and generalise · **replace** = the effect ledger supersedes it (keep a compatibility shim) · **avoid** = don't build on it.

---

## 1. Inventory

| # | Asset | Evidence (file:line) | What it gives the ledger | Verdict |
|---|---|---|---|---|
| 1a | `FileVerifiedReviewEffectLedger` (D13) | [uc] `src/decision/review/recovery-adapters.ts:107-165` | HMAC-SHA256 envelope (`mac()` :121), ≥32-byte key (:110), one file per scope digest (`path()` :117-120), exclusive `link()` publication plus dir fsync (:129-137), idempotent same-receipt plus conflicting-write rejection on `EEXIST` (:139-142), scope-bound lookup with timing-safe MAC check (:148-164) | **replace** with a ledger-backed adapter. Keep the class as a thin shim that implements `VerifiedReviewEffectLedger` over `src/effects`. Its semantics are the reference behaviour for `record`/`lookup`. |
| 1b | `VerifiedReviewEffectLedger` interface | [uc] `src/decision/review/recovery.ts:17-20` | The narrow read-only port that review clients get | **reuse**. The production adapter implements this interface. |
| 1c | `journaledReviewExecutor` | [uc] `src/decision/review/recovery-adapters.ts:80-105` | Checks the effect identity (:90-91), returns a known receipt without redispatch (:93-99), and journals after the executor returns (:100-102) | **extend**. Its parameter is typed to the concrete class (:81); change it to a ledger port. Add an *intent* record before `executeEffect` and a verifier call on crash-recovery. As written, it cannot distinguish "never ran" from "ran, journal lost" (documented in [uc] `docs/decision/review.md:20`). |
| 1d | `auditedReviewReconciler` | [uc] `src/decision/review/recovery.ts:27-43` | Session-coverage gate (:33-34) → attempt marker (:35-37) → ledger receipt (:38-41). Returns `null` if any check fails. | **extend**. Insert a verifier step: if the ledger has no receipt but the attempt exists, call `reconcileEffect`, which queries the target system. This closes the gap in #2677. |
| 1e | `reconcile(effectId)` callback in `resume` | [uc] `src/decision/review/service.ts:263-297` (stale lease → `reconcile` :288-296; identity recheck :291-292) | Integration seam that already exists. The service re-validates `effectId`, `continuationId` and `proposalVersion`. | **reuse**. No service change is needed. |
| 1f | D13 effect ID derivation | [uc] `service.ts:285,300`; enforced in [uc] `validate.ts:108,142`; `reviewDigest` = `sha256:`+canonical JSON (`validate.ts:9-11`) | `sha256(canonicalJson({reviewId, continuationId, proposalVersion}))` | **reuse exactly**. The draft says "proposal digest", but the code uses `proposalVersion`, and the validator rejects any other identity. `aiwg effect id --review` must reproduce this byte-for-byte. |
| 1g | Review ↔ #1567 mapping | [uc] `src/decision/review/operator-audit.ts:10-31,37-62`; `reviewOperatorEventId` [uc] `validate.ts:13-15` | Deterministic decision event IDs; replay after a crash with conflict detection | **reuse** as the model for linking an effect to the decision that authorised it (`authorizedBy.operatorDecisionEventId`) |
| 2a | D03 `FileDecisionReceiptStore` | [uc] `src/decision/receipts.ts:168-270` (key check :170, `mac` :181-183, revisioned read with gap/transition checks :184-221, exclusive persist :250-269) | Revisioned, HMAC'd, append-only per-invocation receipts with CAS | **reuse** as a *data source* for a `decision.invocation` verifier. **avoid** as the ledger's storage: the store is shaped around an invocation state machine. |
| 2b | Batch-receipt protection primitives | [uc] `src/decision/batch-receipts/protection.ts:34-104`: `requireIntegrityKey` :34, `keyedName` :44 (HMAC filenames, no plaintext IDs on disk), domain-separated `macFor`/`macMatches` :48-55, canonical-bytes-only `serialized`/`parseCanonical` :57-64, `ensurePrivateDirectory` (0700 check) :66-70, `publishExclusive` :83-93, body-free `writeTombstone` :96-100, `expired` :102-104 | The most generic hardened file-store toolkit in the repo | **extend**. Lift it to a shared module (for example `src/storage/protected-files.ts`) and keep re-exports in the batch-receipts module. The ledger then builds on it directly. |
| 2c | D16 job reconciliation | [uc] `src/decision/job-runtime.ts:88-105` (dispatched → `execution-unknown`, never replayed); contract [uc] `job-contract.ts:20,73-76,127-132`; receipt-based result recovery [uc] `job-service.ts:95-108`; worker digests [uc] `job-worker.ts:87,117` | Durable attempt fences and `receiptDigest` per attempt | **extend**. Today `execution-unknown` is terminal. Add an opt-in resolver: `reconcileEffect({kind:'decision.job-item', effectId: attempt.id})` promotes to succeeded only if a verified effect record or D03 receipt matches `attempt.receiptDigest`. |
| 2d | D16 file journal plus locks | [uc] `job-store.ts:89-129` (revision journal, exclusive publish); [uc] `job-payload-store.ts:38,126` uses `acquireDirectoryLock` (`src/artifacts/prebuilt-build-lock.ts:16`); stale-lock recovery is documented in [uc] `docs/decision/async-jobs.md:7` | Same-host multi-process safety pattern | **reuse** `acquireDirectoryLock` for the per-scope chain-head writer. Copy the pattern of explicitly authorised stale-lock recovery. |
| 2e | D10 lifecycle | [uc] `src/decision/lifecycle.ts:2-55,105` (`eraseDecisionSubject`), :131 `mayRestoreDecisionReference` | Retention rules, holds, tombstones, restore refusal | **reuse** for retention and erasure: add a `effect` surface, or bind the ledger to the `receipt` surface as batch stores do (`protection.ts:39-42`) |
| 3a | Operator-decision audit record plus chain | `src/audit/operator-decision.ts:80-97` (record with `previous_hash`/`record_hash`), `createDecisionRecord` :108-140 (redaction :113-118, `context_digest` :127), `verifyDecisionChain` :142-156 | Hash-chain format, redaction via `redactStructured` (:14), OTel mapping :158-188 | **extend** by pattern, not by type. Reuse `verifyDecisionChain`'s algorithm and the redaction and digest-only discipline. The record schema differs. |
| 3b | `JsonlOperatorDecisionStore` | `src/audit/operator-decision.ts:190-234` | Append verifies the whole chain first (:193-202). `prune` **re-chains** retained records (:214-233). | **avoid** as the ledger store: it has no writer lock (callers "must serialize writers", [uc] `operator-audit.ts:34-36`), no signature, O(n) read per append, and prune rewrites history (acceptable there only because of an external checkpoint, per `docs/contracts/operator-decision-audit.v1.md:49-52`). No production path constructs it: no `new JsonlOperatorDecisionStore` outside tests/decision (grep). |
| 3c | Contract doc | `docs/contracts/operator-decision-audit.v1.md:11-44` (required record, integrity and custody; "local hash chain alone cannot prove deletion of an entire file" :38-40), :46-52 retention | Template for `effect-ledger.v1.md` sections | **reuse** as the doc template. Cross-link: a decision authorises, the ledger proves. |
| 4a | OpenPGP commit signer | `tools/git/gpg-from-openbao.sh:1-67` (OpenBao AppRole fetch :39-51, fingerprint pin :55-61, gpg passthrough :64); config `SigningConfig` `src/config/aiwg-config.ts:729-739`, `delivery.signing`/`release_signing` :761-763; `.aiwg/aiwg.config` `delivery.signing` | Git `gpg.program` adapter for the **commit** key | **avoid** for per-record signing: it makes a network OpenBao round trip per signature, is tied to host-specific paths (:12-13), mixes key purposes, and breaks the D13 key-independence rule. Optional **reuse** only as a checkpoint signer adapter (sign segment heads), selected explicitly. |
| 4b | Ed25519 canonical-document signing | `src/marketplace/provenance.ts:471-493` `signCanonicalDocument`, :490-503 `verifyCanonicalSignature`, :505-507 `signingKeyId` | "Sign this canonical JSON" helper (Ed25519, key ID, payload SHA-256) | **extend**. This is the closest thing to a reusable sign-blob helper, but it sits in the marketplace module with "Marketplace" errors and its own `canonicalJson` (:94-96). Move it to `src/security/signing.ts`. |
| 4c | DSSE / in-toto attestation | `src/security/artifact-attestation.ts:170-193` (Ed25519 over DSSE PAE); `artifact-trust.ts:217-228` `canonicalJson` (strict, rejects non-finite), :234 `dssePae`, :273 `verifyBytes`, :475 `verifyThresholdSignatures`; ADR `docs/architecture/adr-cross-asset-attestation-envelope.md` | Standard envelope, trust roots, key rotation and revocation, sigstore path (`artifact-verifier.ts:250`) | **reuse** `canonicalJson` + `dssePae` + `verifyBytes` for checkpoint signatures. **reuse** the trust-root model for "which ledger keys are trusted". |
| 4d | Verifier exit-code vocabulary | `src/security/artifact-verifier.ts:23-35` (`verified 0`, `unsigned 21`, `unknown-signer 22`, `mismatched 26`, `malformed 27`, …) | Scriptable status codes already in use for `aiwg verify` | **extend**. Align `aiwg effect verify` codes with this set; add `present/absent/unknown` codes for `reconcile`/`lookup`. |
| 4e | Release signing | `.github/workflows/npm-publish.yml:51-74` (cosign blob signing, Rekor); `src/resources/web-release.ts:135-140,222` (pinned Ed25519 detached signature `aiwg.detached-signature/v1`); `tools/ci/verify-signed-tag.sh`; `src/a2a/jws.ts:71` | Verification-side code for signed git tags, detached signatures and JWS | **reuse** `verify-signed-tag.sh`'s logic in the `git.tag`/`git.commit` verifiers (`git verify-commit`/`verify-tag`). **avoid** cosign/sigstore for the ledger itself (online, CI-OIDC-bound). |
| 4f | Key custody | `src/auth/credential-store.ts:45-46` (hard-coded `releases.aiwg.io`/`aiwg-cli`), :70 `LinuxSecretServiceStore`, :137 `createCredentialStore` | OS keychain / Secret Service / file stores | **extend**. Parameterise the service and account (for example `effects.aiwg.io`/`<project-id>`) so it can hold the ledger HMAC key and the Ed25519 private key. |
| 4g | Canonical JSON implementations (3) | `src/security/artifact-trust.ts:217` (code-unit sort, throws on `undefined`); `src/audit/operator-decision.ts:250-259` (`localeCompare` sort, drops `undefined`); `src/marketplace/provenance.ts:94` (`stable()`) | Must be byte-stable for MACs and signatures | **reuse** only `artifact-trust.canonicalJson` (D13, D03 and batch stores already import it). **avoid** the audit copy: `localeCompare` is locale-sensitive. |
| 5a | Artifact root resolution | `src/config/project-artifacts-runtime.mjs:54-64` (env aliases :16-20 → `.aiwg-location` → `<project>/.aiwg`), `resolveProjectAiwgDirForWrite` :87-104 (external root must exist; never falls back), `projectAiwgWritePath` :110; CLI `src/cli/handlers/artifacts.ts:52-83` (`--check-write` :64, JSON `aiwg.artifacts.path.v1` :70-80) | Canonical, fail-safe write root | **reuse**. The ledger resolves `projectAiwgWritePath(projectDir, 'effects', <scope>)`. |
| 5b | Existing artifact-root stores | `src/providers/transformation-receipt.ts:113` (`receipts/providers/…`); `src/writing/writing-receipt.ts:223` (`writing/receipts/…`); activity log `src/activity-log/cli.ts:31,125-140` via `resolveStorage('activity_log')` (O_APPEND); traces `.aiwg/traces/current-trace.jsonl` written by the aiwg-hooks addon (`agentic/code/addons/aiwg-hooks/README.md:50,108`) | Naming precedent (`<area>/receipts/`) plus the pluggable storage adapter | Paths: **reuse** the convention (`effects/`). Activity log and traces: **avoid** (unauthenticated free text/JSONL). Optionally mirror a one-line summary to `activity.log`. |
| 5c | Storage subsystem adapter | `src/storage/types.ts:19-38` (`SubsystemKey` union), `src/storage/index.ts:192` `resolveStorage` | Backend-pluggable storage (fs/postgres/…) | **avoid** for v1: the integrity guarantees depend on local atomic `link()`/fsync, as in the D03/D13 stores. Revisit as an `effects` subsystem once a remote CAS backend is qualified. |
| 5d | Evidence bundle | `src/evidence/bundle.ts:1-30` (`signature_key_id`, `signed_merkle_root`, restricted-key regex :8) | Export and packaging of evidence | **reuse** later for `aiwg effect export`. Use its restricted-key regex in the canary test. |
| 6a | Built-in CLI command registration | Definition `src/extensions/commands/definitions.ts:1519-1545` (`artifactsCommand`, keywords and `triggerPhrases` drive discovery), list entry :3985; handler map `src/cli/handlers/index.ts:110,216,333,399`; router `src/cli/router.ts:108-111` | How `aiwg effect` becomes a first-class command | **reuse**. Recommended packaging (see §4). |
| 6b | Addon CLI extensions | `src/cli/cli-extension-loader.ts:1-11,78` (registry = `projectAiwgPath(cwd,'cli-extensions.json')`, i.e. the *artifact root*), `registerCliCommands` :104, `tryExecuteCliExtension` :206; manifests e.g. `agentic/code/addons/composition-engine/manifest.json:56-70`; `aiwg-utils/manifest.json` declares **no** `cli_commands` | Addon-contributed `aiwg <ns> <sub>` | **avoid** for the core ledger. The registry lives in the artifact root, so it is unavailable when an external root is detached. It stores absolute global-install paths (see `.aiwg/cli-extensions.json`), and `src/decision` cannot import addon `.mjs`. |
| 6c | Discover index | `aiwg discover` → `src/cli/handlers/subcommands.ts:1484-1500` → `src/artifacts/cli.js` (`index discover`); ranks definitions and skill frontmatter | Discoverability of `record an effect` | **reuse**: `keywords`/`triggerPhrases` on the definition plus a skill `SKILL.md` |
| 6d | aiwg-utils quickref | `agentic/code/addons/aiwg-utils/skills/aiwg-utils-quickref/SKILL.md:119-128` (domains), :176-182 ("Activity & provenance" phrases) | Curated discover phrases | **extend**: add `aiwg discover "record an effect"` etc. |
| 7a | Forge PR read adapter | `tools/security/pr-evidence-forge.mjs:46-…` `createForgePrAdapter` (github/gitea, trusted base URL :48-51, bounded responses :5-31, auth header :61-65, pagination :33-44); `getPullRequest` :77-87 | Read-only, bounded, paginated PR/comment/check reads for **both** forges | **extend** into the verifier HTTP layer. `getPullRequest` does not return `merged`, `merged_at` or `merge_commit_sha`; add a `getPullState`. Port it to TypeScript under `src/tracker/`. |
| 7b | `LiveIssueClient` | `src/issues/live.ts:42-128` (issue plus comments fetch :59-110), `resolveToken` :137-140 (`AIWG_GITEA_TOKEN`/`GITEA_TOKEN`, `AIWG_GITHUB_TOKEN`/`GITHUB_TOKEN`), default API URL :142-145 (host-specific Gitea default) | Issue state (open/closed) and comments normalised across forges | **reuse** for the `tracker.issue.closed` and `tracker.issue.comment` verifiers. Don't rely on its Gitea default URL; take the URL from tracker authority. |
| 7c | Tracker authority / access order | `src/tracker/capability-protocol.ts:94-136` `resolveTrackerAuthority`, :138-163 `chooseTrackerAccess` (MCP → HTTP → CLI → blocker) | Which tracker is authoritative and which access path | **reuse**. Verifiers take the `TrackerAuthority` target; `blocker` maps to verifier result `unknown`. Note the CLI verifier cannot use MCP; HTTP/CLI only. |
| 7d | Gitea work-item client plus comment markers | `src/jobs/gitea.ts:14-102` (0600 token-file check :25-33); `src/jobs/runner.ts:9-11` hidden `<!-- aiwg-job:complete {…} -->` markers, `completedBy` :115-124 (actor-pinned) | Existing precedent for **authoritative remote idempotency markers** on the tracker | **extend** as a `tracker.comment.marker` verifier: find a comment by the pinned actor containing `effectId`. Reuse the actor-pinning rule. |
| 8a | address-issues Phase 2 Step 2 (cycle comment) | `agentic/code/frameworks/sdlc-complete/skills/address-issues/SKILL.md:199-258` | Tracker write with validated payload | **extend**: after posting, `aiwg effect record --kind tracker.issue.comment --verify` |
| 8b | address-issues Phase 3 / 3.5 | same file :276-292 (closure path by `delivery.mode`), :294-313 (confirm merge :302, re-run verification :303, delegate to issue-close :305) | Ad-hoc merge confirmation | **replace** step 1 with `aiwg effect reconcile --kind tracker.pr.merged`, and record the close in step 3 |
| 8c | issue-close | `agentic/code/frameworks/sdlc-complete/skills/issue-close/SKILL.md:8` (allowedTools), Step 4 verify :167-234, Step 6 close :352-380 | Close plus comment | **extend**: record `tracker.issue.comment` and `tracker.issue.closed` after Step 6. Add `Bash(aiwg effect *)` to allowedTools. |
| 8d | Plugin copies | `agentic/code/plugins/sdlc/skills/{address-issues,issue-close}/SKILL.md`, `agentic/code/plugins/codex-sdlc/skills/…` | Packaged duplicates | Regenerate from source; don't hand-edit |
| 9 | Docs | see §2.9 | — | extend |

---

## 2. Integration points

### 2.1 D13 review (#2606 / #2677)
- **Adapter:** `src/decision/review/effect-ledger-adapter.ts` (new) exports `ledgerVerifiedReviewEffectLedger(ledger, scope)` implementing `VerifiedReviewEffectLedger` ([uc] `recovery.ts:17-20`). It maps `{tenantId, projectId, reviewId, effectId}` to ledger scope and effect ID, and maps the record's `result` reference to `ReviewEffectReceipt` ([uc] `types.ts:48-54`).
- **Executor:** generalise `journaledReviewExecutor` ([uc] `recovery-adapters.ts:80-105`) so it takes a ledger port and does the following:
  1. writes an `intent` record;
  2. executes;
  3. calls `recordEffect(status: 'completed', verification)`.

  On a later stale lease, `reconcile` finds an intent without a completion. It runs the kind verifier: `present` → record `completed` (`verification.method` = verifier) → receipt; `absent` → the effect remains uncertain, *not* replayed (D13 rule); `unknown` → `null`.
- **Reconciler:** `auditedReviewReconciler` ([uc] `recovery.ts:27-43`) gains an optional `verifier` fallback between :38 and :40.
- **Identity:** `aiwg effect id --review R --continuation C --proposal-version N` must call `reviewDigest` ([uc] `validate.ts:9`) with exactly `{reviewId, continuationId, proposalVersion}`.
- **Doc:** [uc] `docs/decision/review.md:80` names the missing production executor-side lookup. The ADR answers it.

### 2.2 D16 jobs (#2610)
- Record `decision.job-item` effects at worker finalisation ([uc] `job-worker.ts:87`), using `effectId = attempt.id` and target `job:<jobId>/<itemId>`, with digest refs (`receiptDigest`, `resultDigest`).
- Add opt-in `resolveUnknown` to `DecisionJobRuntime.reconcile` ([uc] `job-runtime.ts:89-105`). This is the only path out of `execution-unknown`, and needs a contract change at [uc] `job-contract.ts:76,127-132` (a new `reconciled-succeeded` transition gated on a verified effect whose digest matches `attempt.receiptDigest`).

### 2.3 Operator-decision audit (#1567)
- The effect record carries `authorizedBy: { operatorDecisionEventId, recordHash }` (IDs from [uc] `reviewOperatorEventId`, `validate.ts:13`).
- `aiwg effect verify --with-decisions <audit.jsonl>` checks `verifyDecisionChain` (`operator-decision.ts:142`) and that each referenced event exists. No write coupling.

### 2.4 Signing
- **Per-record:** HMAC-SHA256 with domain separation (`macFor(key, 'aiwg-effect-record/v1', record)`, `protection.ts:48`), using a dedicated ledger key from the credential store (§4f). This is independent of review, receipt and commit keys, which satisfies the D13 rule.
- **Per-segment:** hash chain (`previous_hash`/`record_hash`), as in `operator-decision.ts:95-96,142-156`.
- **Checkpoint:** an Ed25519 signature over `{scope, segment, head_hash, count, writer}`, via DSSE PAE (`artifact-trust.ts:234`) and the lifted `signCanonicalDocument` (`provenance.ts:471`). A third party can verify it with only the public key. An optional OpenPGP checkpoint signer uses `delivery.signing.program` (`aiwg-config.ts:733-739`); it is opt-in because it is networked and uses the commit-key identity.
- `record` returns signed = HMAC'd plus chained. `verify` checks MAC, chain, scope and the latest checkpoint signature.

### 2.5 Storage in the artifact root
- Root: `projectAiwgWritePath(projectDir, 'effects')` (`project-artifacts-runtime.mjs:110`). Fail closed when an external root is unavailable (:87-104).
- Layout per scope `effects/<scope-id>/`:
  - `records/<keyedName>.json`: one per `effectId`. Uses exclusive link, which gives idempotence and conflict rejection (pattern from `recovery-adapters.ts:129-145`; primitives in `protection.ts:83-93`). HMAC'd filenames (`keyedName`, `protection.ts:44`) avoid plaintext IDs on disk.
  - `segments/<writer-id>.jsonl`: hash-chained index of record digests, one segment per writer. This avoids cross-process chain contention; `verify` merges segments on read.
  - `checkpoints/<writer-id>.<n>.json`: signed segment heads.
  - `tombstones/`: body-free (`protection.ts:96-100`).
- Directories 0700 and files 0600 (`ensurePrivateDirectory`, `protection.ts:66-70`).

### 2.6 CLI and discovery
- New `effectCommand` in `src/extensions/commands/definitions.ts`, next to `artifactsCommand` (:1519), plus the list entry near :3985. Handler `src/cli/handlers/effect.ts` registered in `src/cli/handlers/index.ts` (four sites, as `artifactsHandler` at :110/216/333/399).
- Discovery comes from definition `keywords`/`triggerPhrases` ("record an effect", "reconcile effect", "did effect happen", "effect ledger", "idempotent side effect"), an aiwg-utils skill `skills/effect-ledger/SKILL.md`, and quickref lines under "Activity & provenance" (`aiwg-utils-quickref/SKILL.md:176-182`).
- Library export via `src/api/index.ts` (alongside the security exports :13-15); optionally a `./effects` subpath in `package.json` `exports`.

### 2.7 Verifiers and tracker access
- Target syntax `gitea:owner/repo#N`, `github:owner/repo#N`, `git:<sha>`, `git-tag:<name>`, `file:<path>@sha256:…`, `release:<tag>/<asset>`.
- The tracker host comes from `resolveTrackerAuthority` (`capability-protocol.ts:94`). Tokens come from `resolveToken` (`live.ts:137`) or a 0600 token file (`jobs/gitea.ts:25-33`). HTTP uses the bounded fetch from `pr-evidence-forge.mjs:5-31,61-65`.
- Result is `present | absent | unknown` with `reason`. Network, auth, 5xx, rate limit or a `chooseTrackerAccess` blocker (`capability-protocol.ts:151-162`) always map to `unknown`, never `absent`.

### 2.8 address-issues and issue-close
- Phase 2 Step 2 (`address-issues/SKILL.md:199-258`): after posting, run `aiwg effect record --kind tracker.issue.comment --target gitea:<repo>#N --effect-id $(aiwg effect id --issue N --action cycle-comment --cycle K) --body-digest <sha256(cycle-comment.md)> --verify`.
- Phase 3.5 step 1 (:302): replace "query `merged_at`" with `aiwg effect reconcile --kind tracker.pr.merged --target gitea:<repo>#<PR> --effect-id …`. Exit `present` → continue; `absent` → post the open-PR status and exit; `unknown` → blocker comment.
- Phase 3.5 step 3 (:305) and issue-close Step 6 (:352-380): record `tracker.issue.comment` (closing summary) and `tracker.issue.closed`. On re-entry after a crash, `aiwg effect lookup` prevents a duplicate closing comment.
- Integration Points table (:389-399): add the `aiwg effect` row.

### 2.9 Docs to update
| Doc | Change |
|---|---|
| `docs/contracts/effect-ledger.v1.md` (new) | Contract, using `operator-decision-audit.v1.md` sections as the template |
| `docs/architecture/adr-effect-ledger.md` (new) | Decisions: signing, scope and multi-writer, verifier trust, retention, packaging |
| `docs/contracts/operator-decision-audit.v1.md` §Composition (~:80) | Link: a decision authorises, the effect ledger proves |
| `docs/contracts/conformance.md` | List the new contract, if it acts as the contracts index |
| [uc] `docs/decision/review.md:18-20,80` | Replace "pluggable, not chosen" with the ledger-backed adapter |
| [uc] `docs/decision/async-jobs.md:5,11` | `execution-unknown` resolution through the ledger |
| `docs/cli/reference.md` (authoritative; `docs/cli-reference.md` is a pointer) plus `man/aiwg.1` | `effect` command group |
| `docs/cli/agent-usage.md` | One-command agent usage |
| `docs/architecture/schema-inventory.md`, `schema-control-plane.md` | New schema family |
| `schemas/catalog/catalog.json` (domains list), plus `schemas/catalog/domains/effects.json` (new) | Register `EffectRecord.v1`, `EffectCheckpoint.v1`, `EffectVerifierResult.v1` |
| `agentic/code/addons/aiwg-utils/README.md` ("CLI Commands" :108) and quickref `SKILL.md` | Skill and phrases |
| `docs/_manifest.json` | Register the new doc pages |

---

## 3. Gaps (nothing today provides these)

1. **No generic effect record or identity.** Every store (D03, D04 batch, D13, D16, `jobs/runner` markers) invents its own identity and envelope. There is no cross-subsystem `effectId` namespace.
2. **No authoritative remote verification.** D13 and D16 both end in "unknown, fail closed" with no resolver ([uc] `review.md:20`; [uc] `job-runtime.ts:99-100`). The forge adapters are read-only evidence collectors, not verifiers. None returns PR merge state (`pr-evidence-forge.mjs:77-87`).
3. **No intent-before-execute journal.** `journaledReviewExecutor` writes only after success ([uc] :100-102), so the crash window is undetectable locally.
4. **No reusable sign-blob API.** Ed25519 signing lives in `marketplace/provenance.ts:471` and `security/artifact-attestation.ts:170` under domain-specific names. The OpenPGP path is a git `gpg.program` shim only.
5. **No key custody for integrity keys.** Every HMAC store takes `integrityKey: Uint8Array` from the host, and no CLI path loads one. `credential-store.ts:45-46` is hard-wired to release credentials.
6. **Hash chain without writer serialisation or truncation anchor.** `JsonlOperatorDecisionStore` has no lock, and whole-file deletion is undetectable (`operator-decision-audit.v1.md:38-40`). The ledger needs signed checkpoints and per-writer segments.
7. **Three divergent `canonicalJson` implementations** (§4g). A shared canonicaliser must be pinned for MAC and signature stability.
8. **No `effects` schema family** in `schemas/catalog`, and no JSON Schema for D13's `ReviewEffectReceipt`.
9. **Skills verify by prose.** address-issues 3.5 and issue-close describe `gh`/MCP checks in markdown, with no machine-checkable exit codes and no duplicate-write guard for closing comments.
10. **Retention for ledger records is undefined.** D10 surfaces ([uc] `lifecycle.ts:4-8`) have no `effect` surface, and the rule for what survives purge (digest-only tombstone) needs pinning.
11. **Scope identity.** No existing "workspace/project ID" primitive is shared by D13 (`tenantId/projectId`) and CLI usage (project dir). The ledger needs a mapping: `scope = {tenant, project, subsystem}` derived from config, not model input.

---

## 4. Recommended module layout

```
src/effects/
  index.ts              # public API: recordEffect, lookupEffect, reconcileEffect, verifyLedger, effectId, listKinds
  types.ts              # EffectRecord, EffectScope, EffectStatus ('intent'|'completed'|'failed-definitive'), VerifierResult ('present'|'absent'|'unknown')
  identity.ts           # effectId derivations: review (== reviewDigest), job-item, issue-action, custom (domain-separated sha256 over canonicalJson)
  store.ts              # FileEffectLedger: records/, segments/, checkpoints/, tombstones/ (uses lifted protected-files primitives)
  chain.ts              # per-writer hash chain + merge-on-read verify (algorithm from audit/operator-decision.ts:142)
  signing.ts            # HMAC record MAC + checkpoint signer port (Ed25519 default; OpenPGP adapter opt-in)
  keys.ts               # key resolution via parameterised src/auth/credential-store.ts; env override for CI/tests
  lifecycle.ts          # D10 binding, tombstone, legal hold passthrough
  redaction.ts          # reuse governance/redaction + restricted patterns from review/validate.ts:18-19
  verifiers/
    registry.ts         # kind -> verifier; `aiwg effect kinds`
    git.ts              # git.commit.present|signed, git.tag.present|signed (git verify-commit/verify-tag; verify-signed-tag.sh logic)
    file.ts             # file.digest (sha256, realpath-contained)
    forge-http.ts       # bounded fetch + auth, ported from tools/security/pr-evidence-forge.mjs
    tracker.ts          # tracker.pr.merged (gitea/github), tracker.issue.closed, tracker.issue.comment (body digest / marker, actor-pinned)
    release.ts          # release.asset.present (+ digest)
    decision.ts         # decision.invocation (D03 receipt), decision.job-item
src/security/signing.ts         # lifted signCanonicalDocument/verifyCanonicalSignature (+ DSSE wrapper); marketplace re-exports
src/storage/protected-files.ts  # lifted from decision/batch-receipts/protection.ts; batch-receipts re-exports
src/decision/review/effect-ledger-adapter.ts   # VerifiedReviewEffectLedger + generalised journaled executor
src/cli/handlers/effect.ts      # aiwg effect record|lookup|verify|reconcile|kinds|id
schemas/effects/
  EffectRecord.v1.schema.json
  EffectCheckpoint.v1.schema.json
  EffectVerifierResult.v1.schema.json
  fixtures/{valid,invalid}/*.json
schemas/catalog/domains/effects.json
agentic/code/addons/aiwg-utils/skills/effect-ledger/SKILL.md   # one-command agent usage, discover triggers
docs/contracts/effect-ledger.v1.md
docs/architecture/adr-effect-ledger.md
test/unit/effects/*.test.ts, test/conformance/effects-v1/*
```

**Packaging decision (proposal Q5):** use a **core CLI command** (built-in definition and handler), not an aiwg-utils `cli_commands` extension. Reasons:
1. `src/decision` must import the library.
2. The extension registry lives in the artifact root (`cli-extension-loader.ts:78`), so the command would vanish when an external root is detached.
3. `aiwg-utils/manifest.json` has no `cli_commands` today.

aiwg-utils contributes the skill and quickref only.

**Exit codes (proposed):**
- `lookup`: 0 found, 10 not-found, 11 intent-only.
- `reconcile`: 0 present (recorded), 12 absent, 13 unknown.
- `record`: 0 new, 0 with `{"idempotent":true}` for a replay, 14 conflict.
- `verify`: reuse the `ARTIFACT_VERIFICATION_EXIT_CODES` values (`mismatched 26`, `malformed 27`, `unknown-signer 22`, `unsigned 21`).
- 2 usage, 1 artifact root unavailable.

All modes support `--json`.

---

## 5. Recommended issue breakdown

| # | Issue | Scope | Depends on | Size |
|---|---|---|---|---|
| **E1** | ADR plus contract `effect-ledger.v1` plus schemas | Resolve the five design questions: HMAC per record with a dedicated key, Ed25519 checkpoints, OpenPGP opt-in; per-writer segments merged on read; `unknown` ≠ `absent`; D10 binding with digest tombstones; core CLI. Write `EffectRecord/Checkpoint/VerifierResult` v1 schemas with positive and negative fixtures and register a catalog domain. Pin `artifact-trust.canonicalJson` and the D13 identity (`proposalVersion`, not digest). | — | M |
| **E2** | Shared primitives lift | Move `batch-receipts/protection.ts` helpers to `src/storage/protected-files.ts` and marketplace Ed25519 sign/verify to `src/security/signing.ts`, keeping re-exports. Parameterise `credential-store.ts` service and account. Behaviour-preserving, with existing tests green. | — (parallel with E1) | S–M |
| **E3** | `src/effects` core library | `identity`, `store` (exclusive-link records, idempotent/conflict), per-writer chain plus signed checkpoints, `verifyLedger` tamper detection (edit, reorder, truncate, forged MAC or signature, cross-scope replay), key resolution, redaction and canary scan, D10 retention and tombstones. Library API `recordEffect/lookupEffect/reconcileEffect/verifyLedger`. | E1, E2 | L |
| **E4** | Verifier framework plus local verifiers | Registry, `present/absent/unknown` contract, `git.commit`/`git.tag` (present and signed), `file.digest`, `decision.invocation` (D03 receipt), `decision.job-item`. Crash-window test: effect performed, journal lost, `reconcile` recovers with no replay. | E3 | M |
| **E5** | Tracker verifiers | TypeScript forge HTTP layer ported from `pr-evidence-forge.mjs` (bounded, paginated), adding PR merge state. `tracker.pr.merged` (Gitea and GitHub), `tracker.issue.closed`, `tracker.issue.comment` (body digest or actor-pinned marker, pattern from `jobs/runner.ts:115`). Authority from `resolveTrackerAuthority`; blocker/auth/5xx → `unknown`. Fixture-mocked fetch tests plus opt-in live smoke. | E4 | M |
| **E6** | `aiwg effect` CLI plus discovery | `src/cli/handlers/effect.ts` (`record` with `--verify`/`--unverified`, `lookup`, `verify`, `reconcile`, `kinds`, `id`), definition with keywords and trigger phrases, handler registration, scriptable exit codes and `--json`, artifact-root fail-closed. aiwg-utils `effect-ledger` skill plus quickref phrases; `aiwg discover "record an effect"` test. Docs: `docs/cli/reference.md`, `agent-usage.md`, `man/aiwg.1`, aiwg-utils README. | E3 (E4/E5 for `--verify` kinds) | M |
| **E7** | D13 adoption (answers #2677) | `effect-ledger-adapter.ts` implementing `VerifiedReviewEffectLedger`. Generalise `journaledReviewExecutor` (port type, intent record, verifier on stale lease), verifier fallback in `auditedReviewReconciler`. `FileVerifiedReviewEffectLedger` becomes a shim or is deprecated, with migration. Killed-process crash test in `test/conformance/decision-v1`. Update [uc] `docs/decision/review.md`. Lands after unit-c-final merges. | E3, E4 (E5 if review executors do tracker effects) | M |
| **E8** | Workflow adoption: D16 plus address-issues/issue-close plus #1567 link | D16: record item effects and add an opt-in `execution-unknown` resolver with a contract transition. Skills: Phase 2 cycle-comment record, Phase 3.5 `reconcile --kind tracker.pr.merged`, issue-close records and lookup guard, allowedTools; regenerate plugin copies. #1567: `authorizedBy` link plus `verify --with-decisions`. Docs: `async-jobs.md`, `operator-decision-audit.v1.md` composition. | E5, E6, E7 | M–L |

**Critical path:** E1 → E3 → E4 → E6 → E8. E2 runs in parallel with E1. E5 can run in parallel with E6 once E4 lands. E7 needs E4 and the unit-c-final merge. Mission, Flow and Ralph continuation recording is deferred to a follow-up after E8.

---

## 6. Risks and notes
- **Identity mismatch in the draft:** "review + continuation + proposal digest" differs from the enforced `proposalVersion` ([uc] `validate.ts:108,142`). Changing it would invalidate persisted reviews, so keep `proposalVersion`.
- **`absent` must never authorise replay for D13.** Replay remains a separate, explicit executor decision; D13 treats "absent" as still uncertain unless the executor declares an idempotent target. Put this in the contract.
- **HMAC-only records cannot be verified by third parties.** That is why checkpoints use Ed25519. Rotating the ledger key needs a checkpoint that bridges old and new key IDs, as the artifact-trust root transition does (`artifact-trust.ts:607`).
- **The same-host local filesystem is the only supported CAS**, matching D03, D13 and D16 claims. Distributed use is out of scope.
- **Commit-key reuse is inadvisable.** `gpg-from-openbao.sh` hard-codes host paths (:12-13) and fetches the key per invocation, so it is unsuitable for a hot path or CI.
