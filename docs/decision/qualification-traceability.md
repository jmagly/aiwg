# Decision amendment and risk traceability

This page mirrors
`test/fixtures/decision/amendment-traceability-v1.json`
(`decision-amendment-traceability/v1`), which links the D11 harness (#2604)
security and operations amendments M01-M11 and the scored risks R-23 through
R-30 to executable test evidence. `test/unit/decision/amendment-traceability.test.ts`
(`M11-TRACE-01` to `M11-TRACE-05`) fails if an amendment or risk is missing or
duplicated, if an evidence file is missing, if a test ID is not part of a test
title in that file, or if this page drifts from the fixture.

Gate assignment: security and privacy amendments are G2 (security and privacy
suites); operational, resilience, and release-evidence amendments are G4
(fault and drift suites).

Status values:

- `offline-covered`: executable offline tests exercise the amendment.
- `offline-guard-live-pending`: offline tests prove the fail-closed guard; the
  live behavior depends on unbuilt work tracked in the named issue.

## Amendments

| ID | Amendment | Gate | Owning issues | Status | Evidence |
|---|---|---|---|---|---|
| M01 | Endpoint normalization, redirect/DNS/private-address policy, authorization-header non-forwarding, bounded response parsing | G2 | #2593, #2597 | offline-covered | `SEC-DNS`, `SEC-DNS-PRIVATE`, `SEC-ORIGIN-REDIRECT`, `SEC-REDIRECT-LOOP`, `SEC-HOST-MISMATCH`, `SEC-RESPONSE-BOUNDS`, `SEC-RESPONSE-PARSE-TIME`, `SEC-DNS-PIN`, `SEC-COMPRESSED-BOUND`, telemetry collector DNS rebinding, projection origin checks |
| M02 | Opaque request-ID validation, export redaction, metric-cardinality exclusion | G2 | #2593, #2602, #2605 | offline-covered | `ADP-REQID-INJECTION`, `ADP-REQID-BODY`, batch malformed request IDs, telemetry redaction and cardinality bounds |
| M03 | Per-principal/project quotas, bounded queues and pre-admission work, noisy-neighbor isolation, load shedding | G4 | #2594, #2601, #2610 | offline-covered | scheduler-admission noisy-neighbor, shedding and queue bounds; job quota and poll-limiter conformance |
| M04 | Receipt/cache tamper detection, alias-safe cache lookup, cross-project read denial | G2 | #2595, #2609 | offline-covered | receipt tamper and substitution, result-cache tamper/alias/cross-workspace, result-cache scope substitution, `CCP-006` |
| M05 | Object-level authorization and non-enumerability for review, job, and item operations | G2 | #2606, #2610, #2614 | offline-covered | `M05-ENUM-JOB-01`, `M05-ENUM-JOB-02`, `M05-ENUM-ITEM-01`, `M05-ENUM-ITEM-02`, `M05-ENUM-REVIEW-01`, `M05-ENUM-REVIEW-02`, `M05-ENUM-REVIEW-03`, `M05-ENUM-REVIEW-04`, job gateway handle binding, `HITL-POLICY`, review cross-project lookup |
| M06 | Reviewer eligibility, separation of duty and quorum, revocation, execution-time reauthorization | G2 | #2606 | offline-covered | `HITL-POLICY`, `HITL-QUORUM`, `HITL-SEPARATION`, `HITL-REVALIDATE`, `HITL-REVOKE` |
| M07 | DMN/OPA parser-bomb, XXE/external-resource, source-authenticity, and size/time bounds | G2 | #2612 | offline-covered | `M07-BOMB-01..03`, `M07-XXE-01..03`, `M07-AUTH-01..02`, `M07-BOUND-01..02` |
| M08 | Live research egress and sensitivity-probing limits for D20/D22/D23 | G2 | #2613, #2615, #2616 | offline-guard-live-pending | projection destination denial, `SEC-DNS-PRIVATE`, `SEC-ORIGIN-REDIRECT`, `LIVE-ABSENT-01`; live part tracked in #2684 |
| M09 | Lifecycle deletion, tombstone, legal-hold, and backup behavior | G2 | #2597, #2605, #2609, #2610, #2613, #2614, #2615, #2616, #2617 | offline-covered | lifecycle cascade and holds, file lifecycle journal, result-cache backup restore, telemetry tombstones, `HITL-RETENTION`, job D10 erase and backup restore |
| M10 | Machine-validated threat-preflight and runbook evidence | G4 | #2605, #2607 | offline-covered | `M10-PREFLIGHT-01..03`, `M10-RUNBOOK-01..03`, `PAT-OPS-001` |
| M11 | Traceability to every new scored risk R-23 through R-30 | G4 | #2604 | offline-covered | `M11-TRACE-01..05` |

M07 note: no DMN, OPA, or XML importer exists yet. The M07 suite bounds the
existing JSON/YAML decision admission path (`parseDecisionJson`,
`parseDecisionYaml`, `parseCompressedDecisionJson`, `admitEntry`,
`validateDecisionDocument`, artifact pins). DMN/XML and Rego text is rejected
as non-JSON, or parsed by YAML as an inert string that document validation
refuses, so no XML entity is resolved. The suite must be extended when #2612
adds an importer. DMN/OPA import itself is optional #2612 work and is out of
scope for #2604 closure.

M08 note: D20, D22, and D23 are not built. The offline guards show that an
unapproved destination is denied before credential resolution or dispatch and
that the qualification runner never labels mock execution as live. Live egress
and sensitivity-probing limits are tracked in #2684 and are out of scope for
#2604 closure.

M05 note: `M05-ENUM-REVIEW-03` and `M05-ENUM-REVIEW-04` are regression tests
for the two review existence oracles fixed in #2674. The first proves that the
same review ID in two projects is two isolated objects, with no "already
exists" collision and no cross-scope listing. The second proves that a
same-project caller without authority gets the absent-review outcome
(`Review not found`, `null` or an empty list) for every operation, never a
distinct "access denied".

## Risks

Risk titles are derived from the child issues that cite each risk, because the
scored risk register is not in this repository.

| ID | Risk (derived) | Citing issues | Amendments | Evidence |
|---|---|---|---|---|
| R-23 | Provider egress and transport trust: projected state, credentials, or retries reach an unapproved or rebound destination | #2593, #2597 | M01, M02, M08, M09 | `SEC-DNS-PRIVATE`, `SEC-ORIGIN-REDIRECT`, projection destination denial |
| R-24 | Integrity and isolation of durable decision state: receipts, caches, jobs, reviews, and exports tampered with, replayed, exhausted, or read across scopes | #2595, #2601, #2603, #2606, #2609, #2610, #2614 | M03, M04, M05, M06, M09 | receipt CAS, `CCP-006`, result-cache tamper, `M05-ENUM-JOB-01`, scheduler shedding |
| R-25 | Human-review authority bypass: self-approval, ineligible or revoked reviewers, stale authorization at execution | #2606, #2622 | M05, M06 | `HITL-QUORUM`, `HITL-SEPARATION`, `HITL-REVOKE`, `M05-ENUM-REVIEW-01` |
| R-26 | Identifier and usage leakage through receipts, cache keys, traces, and metrics, including unbounded metric cardinality | #2593, #2602, #2603, #2605 | M01, M02, M10 | `ADP-REQID-INJECTION`, telemetry cardinality bounds, batch request IDs, `CCP-009` |
| R-27 | Unsafe import of external decision formats (DMN/OPA): parser bombs, XML external entities, unauthenticated sources, unbounded work | #2612 | M07 | `M07-BOMB-01`, `M07-XXE-01`, `M07-AUTH-01`, `M07-BOUND-01` |
| R-28 | Calibration and model drift or unqualified promotion across the calibration registry, ensembles, champion-challenger rollout, and pilots | #2600, #2611, #2613, #2615, #2618, #2619, #2620, #2621 | M08, M09 | calibration registry drift, calibration runtime alias drift, `LIVE-ABSENT-01` |
| R-29 | Retention and privacy of stored decision artifacts: deletion, tombstones, legal hold, and backup resurrection across every persisted surface | #2597, #2603, #2605, #2606, #2609, #2610, #2614, #2617, #2619, #2622 | M09 | file lifecycle cascade, lifecycle backup denial, `HITL-RETENTION` |
| R-30 | Sensitivity probing through counterfactual analysis: repeated perturbations infer protected thresholds or inputs | #2616 | M08, M09 | projection destination denial, `LIVE-ABSENT-01` (offline guard only; live limits tracked in #2684) |

R-30 has only offline guard evidence: the counterfactual sensitivity analysis
in #2616 is not built, so no anti-probing limit can be exercised yet.
