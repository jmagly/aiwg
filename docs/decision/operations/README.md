# Decision pattern operational runbooks

These versioned runbooks are the operator evidence referenced by
`closure-manifest.v1.json`. They apply to opt-in live pattern bindings. Offline
recorded fixtures make no provider call and remain the first diagnostic path.

Every response preserves receipts, traces, review records, and cache evidence.
Containment must fail closed: disable the affected live binding, deny new work,
or route it to review. Never delete incident evidence or silently replace a live
backend with recorded/mock evidence under the same execution-mode label.

| ID | Incident | Trigger and owner | Containment | Recovery and exit verification |
|---|---|---|---|---|
| `RUN-JEV-OUTAGE-v1` | Provider outage or retry storm | Admission rejection, timeout, or retry-rate alert; decision-platform on-call owns response. | Disable live binding, stop retries at the declared attempt/deadline bounds, preserve request and admission receipts. | Verify provider health with approved synthetic probes, re-enable a canary, and confirm retry and latency metrics return below alert thresholds before rollout. Escalate sustained impact to the provider owner and communicate affected request IDs. |
| `RUN-JEV-CREDENTIAL-v1` | Credential compromise or rotation | Secret-scanner, unauthorized-use, or rotation alert; security incident commander owns response. | Revoke the logical credential, disable its bindings, preserve access/audit evidence, and do not print or hash secret material into reports. | Issue a replacement through the approved secret system, update the logical resolver, run an approved synthetic probe, and verify the revoked credential cannot authenticate. Notify security and affected service owners. |
| `RUN-JEV-EGRESS-v1` | Suspected data egress | Egress-policy denial, canary match, or destination anomaly; privacy/security owner leads. | Deny the binding and quarantine sanitized metadata and immutable receipts; do not replay payloads or broaden collection. | Confirm projection and destination policy, remediate the boundary, obtain privacy approval, and verify synthetic canaries cannot cross the boundary. Follow incident communications policy. |
| `RUN-JEV-RECONCILE-v1` | Incomplete receipt or asynchronous job | Incomplete/uncertain lifecycle alert; runtime on-call owns response. | Stop automatic replay and preserve provider handles, invocation IDs, attempt lineage, and usage evidence. | Reconcile against the same provider handle, record an explicit terminal or uncertain state, and verify usage is accounted once. Escalate unresolved remote outcomes for manual review. |
| `RUN-JEV-CACHE-v1` | Cache tamper or poisoning | Digest, MAC, identity, or provenance mismatch; security and runtime owners respond. | Disable reads from the affected namespace, retain cache objects and verification logs, and fall back only through declared non-cache policy. | Rotate integrity material if required, rebuild from trusted inputs, verify complete semantic identity and negative tamper tests, then restore with a canary. |
| `RUN-JEV-DRIFT-v1` | Incompatible model or calibration drift | Alias/model mismatch, expired calibration, or drift gate; model-risk owner responds. | Block action routes, pin the last approved identity where allowed, and send incompatible observations to review. | Qualify the actual model/version, approve a new compatibility relation or rollback, and verify calibration and drift gates before promotion. Communicate the affected decision classes. |
| `RUN-JEV-TELEMETRY-v1` | Telemetry loss | Export backlog/drop or trace continuity alert; observability owner responds. | Keep decisions governed by receipts, bound the exporter queue, preserve local metadata, and do not fail open or log raw state. | Restore the exporter, replay only allowed buffered metadata, verify trace linkage and drop counters, and document any visibility interval. |
| `RUN-JEV-ROLLBACK-v1` | Faulty pattern or release | Conformance, policy, or incident rollback trigger; release owner responds. | Remove the exact pattern version/live binding from discovery, preserve all evidence, and prevent silent backend/mode substitution. | Restore the previously approved pin, run offline package smoke and bounded canary checks, verify reported execution modes, then communicate completion and residual risk. |

## Deterministic tabletop drills

The package smoke checks the following sanitized scenarios and their expected
containment: compromised credential → binding disabled; provider retry storm →
attempt cap reached; incompatible alias → action route blocked; cache digest
mismatch → namespace quarantined; egress canary → request denied. A drill passes
only when the matching runbook ID, owner, evidence list, recovery step, and exit
verification are present in the closure manifest.
