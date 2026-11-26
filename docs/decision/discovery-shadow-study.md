# Selective discovery offline study protocol

The D27 study remains unrun. Local deterministic tests establish routing and
contract behavior; they supply no empirical ranking, calibration or savings
claim. No paid or networked model call is needed to build an unrun report.

The versioned manifest extends the existing discovery evaluation and decision
study surfaces. It pins dataset identity and separate tuning, calibration and
holdout membership digests; source/time split method; definition/binding,
calibration, pricing, ambiguity policy and served-model identities; total and
per-slice minimum samples (or a supplementary power rule); paired bootstrap
method, confidence level, seed and resample count; aggregate retrieval
non-inferiority margin; a strictly positive minimum ambiguity-slice MRR benefit;
and strictly positive complete-task token and monetary savings requirements.
It retains the historical Hit@3 1.0/MRR 0.9875 reference. The ambiguity improvement
must be tested on paired ambiguity cases, alongside that historical reference;
a call replacing cheap correct retrieval alone cannot satisfy positive economics.
Latency and selective-risk limits are pinned too. Per-slice support is mandatory
for exact-name, high-margin, low-margin, cross-type, hard-negative and no-match.
No-match precision/recall must be analyzed separately from ordinary reranking.

`createDiscoveryStudyManifest` validates and digests the supplied fields.
`state: draft` and `registeredAt: null` do not claim preregistration or approval.
A reviewed study sets `registered` and an actual timestamp and anchors the digest
outside the mutable manifest **before holdout access**. The access caller must use
`assertDiscoveryStudyRegistration(manifest, trustedDigest, accessedAt)` before
reading the holdout. It rejects draft manifests, different digests, invalid
access times and registration at or after access. This library cannot independently
attest operator approval, access chronology or membership disjointness. Different
split digests alone do not prove disjoint records; reviewers must check membership
and isolate annotators/tuning feedback from the final holdout.

`buildUnrunDiscoveryStudyReport(manifest, integrity?)` emits `not-run`, zero
sample counts and null metric slots for baseline and alternate overall and in
all six slices. Slots cover Hit@1/3, MRR, nDCG@10, hard-negative intrusion,
no-match precision/recall, selective coverage/risk, ties, p50/p95 latency, calls,
input/output tokens, cost, wrong loads, extra show calls, exploratory tokens and
correction turns. Unknown observations stay null, including unknown native Jev
monetary usage. The economics slots separate baseline, decision calls, fallback
and downstream work, with total token/cost savings and the pricing digest.
These extend #1585 accounting: price all attempts plus downstream work and avoid
double-counting shared costs. No point estimate is treated as confidence evidence.

The report carries #2037/#2048 integrity metadata verbatim and uses the shared
upstream-ceiling gate. Verdict vocabulary remains `PROMOTE`/`HOLD`/`ROLLBACK`.
This unrun builder always adds `HOLD` to the ceiling; compromised evidence or
upstream `ROLLBACK` remains `ROLLBACK`. Its validator rejects a resealed upgrade,
mismatched digests, non-null metrics or substituted slice identities.
The v1 report is deliberately an unrun scaffold, not a completed-study analyzer.
A held-out analyzer must later derive paired intervals and economics from verified
observations before any promotion report can be supported.

To complete AC6–8, an operator must supply a reviewed frozen heldout set and
independent relevance/no-match labels, approve the preregistered thresholds and
calibration/pricing profile, authorize spend, and provide live Jev login through
the existing governed host. Then capture paired baseline/alternate receipts,
complete downstream accounting, and confidence intervals using the pinned method.
The synthetic fixture `test/fixtures/decision/discovery-study-manifest.json` is a
mechanics example with fake pins and provisional thresholds; it authorizes nothing.
