# D10 threat-control mapping (T-01 to T-14)

This document maps the D10 state projection and egress threats (#2597) to the
controls that implement them and the offline tests that exercise them. It is the
input to the security reviewer sign-off tracked in #2680. The sign-off, live
least-privilege checks, attack-movement measurement and provider
retention/residency evidence are **not** claimed here.

## Source and status

#2597 names `security-screening.md:21-38` as the source list for T-01..T-14 and
`research-vendor-docs.md:531-552` for TV-21/TV-24. Neither file is in this
repository or the local artifact store. The threat statements below are
therefore derived from what #2597 itself states: its protected assets (user and
project state, credentials, policies, receipts, routing and budgets), risks R-04
(prompt injection) and R-11 (disclosure), scope requirements 1-9 and M01/M09.
**The numbering is provisional.** Before sign-off the reviewer must reconcile
each row with the screening document and record any renumbering, split or
missing threat here.

Status values: **offline** means the control is implemented and covered by an
offline test; **live** means the remaining proof needs the #2680 environment.

## Mapping

| ID | Threat | Controls | Offline evidence | Status / residual |
|---|---|---|---|---|
| T-01 | Direct instruction override in state steers the decision (R-04) | Typed output; state is data in a fixed body shape; host trust partition `{ verified, untrusted }` | `projection.test.ts` attack fixtures; C29 `security-vectors.test.ts`; `TV-21` and `TRUST-PARTITION-01/02` in `projection-egress.test.ts` | Offline structural. Movement against a real model is live (#2680) |
| T-02 | False authority, fake-system and delimiter-break content (R-04) | Same as T-01; no delimiter-only defense; subagent prompt states untrusted input is data only | `projection.test.ts` fixtures; `TV-21`; `TRUST-PARTITION-02` | Offline structural; semantic movement is live |
| T-03 | State tries to change control data: endpoint, model, credential, policy, thresholds, options, tools, pins, permissions | Control data only from trusted request fields; projection resolver sees only `{ alias, target }`; opt-out must be the exact host object | `projection.test.ts` hostile-control case; C29; `PRV-EGRESS-06` | Offline |
| T-04 | Unminimized ambient state reaches a provider (fail-open egress) | Mandatory projection for network-capable adapters; deny before credentials on single, native-batch and fallback paths; dispatcher refusal | `PRV-EGRESS-01..05`, `PRV-EGRESS-FALLBACK` (`batch.test.ts`), `DISPATCH-PROJ-01/02` | Offline |
| T-05 | Egress to an unauthorized provider, model, purpose or data class | Closed allowlist; destination authorization per field; `maxSensitivity` ceiling and restricted-field rules | `PRV-EGRESS-MATRIX-01/02`; `projection.test.ts` denial cases | Offline |
| T-06 | Policy origin or region differs from the real transport destination | Policy origin bound to the adapter's declared origin at dispatch; region is a declared attribute that must match, unknown denied | `PRV-EGRESS-07/08/10/11/12`; `TV-24`; `DISPATCH-PROJ-03` | Offline. Region is not transport-enforced (documented) |
| T-07 | Redirect, DNS rebinding or an origin policy change moves credentials or state elsewhere (M01) | `redirect: 'error'`, final-origin check, public-IPv4 DNS pinning; per-attempt re-authorization | `SEC-ORIGIN-REDIRECT`, `SEC-REDIRECT-LOOP`, `SEC-DNS`, `SEC-DNS-PRIVATE`, `SEC-HOST-MISMATCH`, `SEC-DNS-PIN`; `PRV-EGRESS-09` | Offline; deployment network enforcement remains an operator control |
| T-08 | Credential over-read, adjacent-secret read or enumeration | Logical `credentialRef` only; resolver called only after projection and origin checks, with exactly the target ref; resolver errors normalized | `PRV-CRED-*` (`jev-transport.test.ts`); `PRV-EGRESS-CRED-01` | Offline half. Real scoped vault check is live (#2680) |
| T-09 | Secret material embedded in portable artifacts: policies, receipts, batch receipts, cache entries | Portable secret detector (bearer, PEM private key, vault/secret locators, KV paths, secret-derived hash and secret-value keys) on write and read | `projection.test.ts` secret cases; `SEC-PORTABLE-01/02`; `PRV-EGRESS-RECEIPT-*` | Offline. Opaque secrets without markers need upstream classification |
| T-10 | Raw state, response body, auth header or credential on stdout/stderr, logs, traces, activity records, receipts, snapshots, exports or errors | Metadata-only telemetry and evidence; category-only errors; export redaction | `PRV-EGRESS-CAPTURE-01/02`; `security-surface-matrix.test.ts`; `telemetry.test.ts`; `PRV-SURFACE-*` | Offline. Deployment-wide collectors and network captures are live |
| T-11 | Incomplete or truncated material context drives automatic action | Projection denies incomplete context by default; allowed incomplete context and incomplete context plans both force `review` / `insufficient-information` | `AC6-PROJ` (`projection-egress.test.ts`); `AC6-CTX` (`batch.test.ts`); `context-plan.test.ts` | Offline. Truncation is caller-declared, not detected |
| T-12 | Debug capture exposes raw state or outlives policy | Host-only gated sink receiving only projected state; AES-256-GCM sidecar with audit, scope checks and expiry | `PROJ-DEBUG` (`batch.test.ts`); `debug-sidecar.test.ts`; `file-debug-backend.test.ts` | Offline; production KMS and audit sink are host infrastructure |
| T-13 | Deletion, hold, backup/restore or orphaned references resurrect or leak erased data (M09) | One `decision-lifecycle/v1` policy; tombstone before erase; hold checks; subject-level restore refusal; tombstoned cross-surface references; telemetry retention derived from the lifecycle policy | `lifecycle.test.ts`; `file-lifecycle-store.test.ts`; `LIFE-ORPHAN-*`, `LIFE-EXPORT-AFTER-ERASE-01`, `LIFE-BACKUP-*`, `M09-*`; `SCHEMA-LIFE-*` | Offline; deployed backup purge is host infrastructure |
| T-14 | Provider retention, residency, encryption or ZDR assumed without evidence | Unknowns documented; no default region; `unknown` region denied | `TV-24`; `docs/decision/state-projection.md`, `docs/decision/data-lifecycle.md` | Documentation only. Deployment evidence is live (#2680) |

## Test identifier trace

| Identifier | Meaning here | Tests |
|---|---|---|
| `PRV-EGRESS-01..12` | Evaluator egress boundary: safe default, opt-out, endpoint and region binding | `test/unit/decision/projection-egress.test.ts` |
| `PRV-EGRESS-FALLBACK` | Safe default on the native-batch fallback preflight path | `test/unit/decision/batch.test.ts` |
| `PRV-EGRESS-MATRIX-01/02` | Policy and evaluator allow/deny/unknown matrix | `test/unit/decision/projection-policy-matrix.test.ts` |
| `PRV-EGRESS-CAPTURE-01/02` | Real-evaluation surface capture and scan | `test/unit/decision/egress-privacy-harness.test.ts` |
| `PRV-EGRESS-CRED-01` | Fake scoped resolver, adjacent ref denial, no enumeration | `test/unit/decision/egress-privacy-harness.test.ts` |
| `PRV-EGRESS-RECEIPT-*` | Secret-material rejection in receipts, batch receipts and cache entries | `receipts.test.ts`, `batch-receipts.test.ts`, `result-cache.test.ts` |
| `DISPATCH-PROJ-01..05` | Packaged dispatcher through the source-import seam | `test/unit/decision/dispatcher-projection.test.ts` |
| `TV-21` | Provisional: vendor guidance that state can carry adversarial instructions; state stays data | `projection-egress.test.ts` |
| `TV-24` | Provisional: vendor retention/residency/ZDR claims are not assumed | `projection-egress.test.ts` |

`master-test-plan.md:222-246`, which #2597 cites for the full `SEC-*`,
`PRV-EGRESS-*` and `PRV-*` catalogue, is also not in the repository. The
`PRV-EGRESS-*` identifiers above were assigned by this work and should be
reconciled with that plan when it is available.

## Sign-off

| Field | Value |
|---|---|
| Reviewer | Pending (#2680) |
| Reviewed commit | Pending |
| Reconciled with security-screening.md | Pending |
| Decision | Pending |
