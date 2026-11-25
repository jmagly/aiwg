# Selective discovery shadow routing

The experimental `aiwg/discovery/shadow` library observes ambiguous discovery
results. It is default-off and shadow-only: discovery always returns its original
lexical/graph order. The CLI does not install a model binding or enable paid calls.
There is no production ranking-improvement claim or promotion evidence yet.

`discoveryAmbiguity(query, candidates, policy)` applies the pinned
`discovery-ambiguity/v1` gate. Candidates arrive in the authoritative retrieval
order. An exact candidate name or stable ID bypasses inference. A top score at or
above `minimumScore` with a margin at or above `minimumMargin` also bypasses it.
Low scores, smaller margins and close cross-type candidates are eligible. Empty,
malformed, duplicate-ID, unsorted or oversized inputs bypass inference. Comparisons
use the unrounded retrieval score; equality at either threshold is explicit.

`DiscoveryShadowRoute` accepts a trusted host and a pinned policy. A source host
can pass it to `discoverCapability` through `DiscoverParams.shadowRoute`. Other
hosts can call `observe` with their existing authorized retrieval result. Do not
construct host policies or callbacks from query text, candidate metadata or model
output. No configuration is read from the index.

Before evaluation, the host's `authorize` callback must approve the query and
bounded candidate projection. Its `evaluate` callback must use the existing D10
projection/egress and admission path before any resolver or transport access,
validate the supplied definition/binding pins and option domain, and retain the
complete normalized result under the normal scoped D10 receipt/lifecycle policy.
The supplied [governed evaluator bridge](discovery-shadow-evaluator.md) implements
that callback through the existing evaluator. The route itself has no credential resolver or transport. The callback receives
only the bounded semantic projection and opaque `candidate_N` choices plus `none`.
It cannot receive an executor from this interface. Candidate IDs, names and
summaries remain untrusted data. Candidate count and UTF-8 text bytes are bounded.

An alternate selection requires successful normalized evidence, exact definition
and binding pins, an allowed served model, matching allowed calibration identity,
provider-native uncertainty with the required profile, an exact finite normalized
option distribution and the declared probability/margin thresholds. Ties and all
unsupported/error/review/invalid responses preserve the baseline. A `none` result
is recorded separately. The observer never installs, enables or invokes a skill.

The host receives a metadata-only route receipt: ambiguity reason, policy/candidate
digests, alternate ordinal or `none`, durable result digest, allowed served model,
latency and usage. It receives no raw query, names, capability summaries, paths or
response bodies. Use the protected source receipt to inspect full lineage.
An allowed served model remains in the receipt when token or cost accounting
rejects the observation. An unavailable or throwing host clock disables the
route and records a failure receipt; it never permits an unmeasured selection.
Request-shared batch usage is not allocated to each observation. This initial
single-request observer treats batch or unknown usage as unqualified and opens
the circuit. It does not invent a cost estimate or advertise savings.

Timeout aborts the evaluation and opens the circuit. Token/cost limit breaches,
unknown accounting, model/calibration/quality rejection and sink failure also
restore deterministic-only routing. The trusted quality/drift monitor can call
`disable()` explicitly. Re-enabling requires constructing a new route after
review; existing route policy is copied and cannot be changed by a caller later.
A host must also enforce its total call/token/cost budget before dispatch. The
observer's post-call limits detect provider overrun; they cannot undo billable work.

## Qualification still required

The historical 80-query baseline (Hit@3 1.0, MRR 0.9875) is development evidence,
not an unseen holdout. Boundary/failure tests prove routing mechanics, not Jev
ranking quality or economic benefit. No final holdout has been evaluated here.

Before a shadow study, freeze the reviewed dataset and source/temporal partitions,
exact definitions/binding/model/calibration pins, per-slice sample minima or power,
confidence-interval method/level, retrieval non-inferiority margin, minimum useful
ambiguity improvement and positive end-to-end economics. Include exact-name,
high-margin, low-margin, cross-type, hard-negative and no-match slices. Keep
calibration/tuning and final holdout disjoint; do not retune on the final holdout.

The report must include Hit@1/3, MRR, nDCG, hard-negative intrusion, no-match
precision/recall, selective coverage/risk, ties, latency, all calls/tokens/cost and
wrong-load/extra-show/correction proxies. Extend the existing eval-integrity and
economics contracts; a point estimate or synthetic fixture cannot upgrade `HOLD`
or `ROLLBACK`. No reviewed held-out dataset or complete economic observations were
supplied for this implementation. Issue #2621 therefore remains open for the
preregistered study, approved live configuration and promotion review.
