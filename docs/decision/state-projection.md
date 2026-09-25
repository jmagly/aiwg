# Decision state projection and egress boundary

Decision adapters must receive an explicitly projected state, never an ambient
workflow object. `projectDecisionState` applies a closed field allowlist and
records source, subject, trust, sensitivity, purpose, retention, access, export,
deletion, backup, provider, model, origin, and region evidence without copying
raw values into the evidence record.

The projection policy is trusted control data. Model-visible input cannot select
the endpoint, provider, model, region, purpose, field list, retention class, or
authorization scope. A destination mismatch, mixed subject, credential-bearing
origin, missing field, or disallowed incomplete context fails before credential
resolution or transport. The returned digest identifies the minimized projected
state; it is not a credential or an action authorization.

## Mandatory projection in the evaluator

`evaluateDecisionRuleset` fails closed at the egress boundary (#2678). Every
adapter declares its egress in `capabilities().egress`:

- `{ mode: 'none' }`: the adapter makes no network egress (fixtures, local
  deterministic workers). It may receive the authorized, unprojected input.
- `{ mode: 'network', origin, region }`: the adapter's effective request origin
  and host-declared deployment region. `JevDecisionAdapter` reports the origin of
  its configured `endpoint` and the `region` constructor option.
- omitted: treated as network-capable with an unknown destination.

Without a `projection` policy, dispatch to any adapter that is not `none` is
denied as `data-boundary-denied` before credential resolution, compile-cache
preparation, or transport. This holds on the single-call, native-batch, and
fallback-preflight paths. **This is a breaking change** for integrations that
evaluated network adapters without projection; see the CHANGELOG.

The only way to send unprojected input to a network-capable adapter is the
host-only opt-out `projection: { mode: 'unprojected-local' }`, intended for
local and offline test harnesses with fake transports. It must be exactly that
object; any other shape, including a policy-shaped object without a trusted
`resolve` callback, is rejected as `invalid-definition`. Portable artifacts and
model-visible input cannot express it. When used, the ruleset result (and so the
durable receipt) records `spec.projection: { mode: 'unprojected-local', authority: 'host' }`
and the result is written as `decision.aiwg.io/v1alpha2`. No-egress adapters do
not record an opt-out because nothing crosses the boundary.

### Endpoint and region binding

With a policy, the evaluator compares the normalized `policy.origin` with the
adapter's declared origin, read from `capabilities()` at dispatch time rather
than from planning. A mismatch, an adapter without a declared origin, or a policy
whose origin changes on a later attempt is denied before that attempt's
credential read. The Jev adapter separately enforces `allowedOrigins`, redirects
and DNS policy on the actual request.

`region` is a **declared deployment attribute with no transport enforcement**:
Jev exposes no region control. The policy region must equal the region the host
declared on the adapter. An adapter without a declared region, or a policy
region of `unknown`, is denied. Declaring a region records the operator's
deployment evidence; it does not certify provider residency.

### Data-class rules

A policy may set `maxSensitivity` (default `confidential`). A field above the
ceiling is denied egress. `restricted` fields therefore need an explicit
`maxSensitivity: 'restricted'`, and must also use `exportPolicy: 'denied'` and
`backupPolicy: 'not-persisted'`; otherwise the policy is invalid. JSON schema:
`schemas/decision/DecisionProjectionPolicy.v1.schema.json`.

### Incomplete context and trust partition

If the projection allows incomplete context, its evidence sets
`automaticActionAllowed: false` and the evaluator downgrades a `completed` or
`defaulted` ruleset result to `review` / `insufficient-information` with no
outcome, the same as an incomplete context plan.

Adapters receive the projected state together with metadata-only
`projectionEvidence`. The Jev adapter sends it as `state: { verified, untrusted }`
and the LLM-subagent prompt carries `input: { verified, untrusted }` with an
instruction that untrusted content is data only. The partition is structural and
does not rely on delimiters; it does not make typed output immune to injection.

## Integration boundary

`dispatchProjectedDecisionState` is the enforceable integration boundary. It
validates and minimizes state first, then resolves a credential without passing
ambient input to the resolver, and finally gives transport only the projected
state and metadata-only evidence. Destination denial or malformed lifecycle
metadata therefore makes zero credential and transport calls.

Callers that truncate material context must set `incompleteContext`. The default
policy rejects it. A policy may permit advisory evaluation, but the evidence then
sets `automaticActionAllowed` to false. Downstream effects always require their
own authorization regardless of this value.

Projection policies are closed portable control objects. Unknown control fields,
embedded bearer/private-key material, private vault/secret locators, and fields
named as credential- or secret-derived hashes are rejected. Every projected data
class must declare non-empty access scope plus retention, export, deletion, and
backup behavior; missing metadata never receives a permissive default.

Runtime validation rejects unknown trust and sensitivity values even when a
caller bypasses TypeScript. The portable policy is scanned as a whole, including
identity and destination fields, for bearer material, private keys, vault/secret
locators, and credential-derived hashes. Validation errors describe only the
rejected category; they never echo the value. This scanner is not a general
secret detector: opaque secrets without a recognizable marker require upstream
classification and review.

The common host-side lifecycle contract for state, receipts, telemetry, debug,
cache, jobs, review, calibration/evaluation, exports and preprocessing lineage
is documented in [data-lifecycle.md](./data-lifecycle.md). It requires per-surface
classification/access/retention/export/deletion/backup controls and applies
hold and tombstone checks before deletion or restore.

## Offline evidence and deployment limits

| Boundary | Evidence | Remaining deployment requirement |
|---|---|---|
| Provider/model/origin/region/purpose mismatch | Projection denial with zero credential/transport calls | Approved binding inventory and independent provider policy review |
| Trust/data class/lifecycle metadata | Runtime enum and missing-control denial | Approved classification and retention schedule per data class |
| Hostile state | Direct override, fake authority/system, delimiter, label, flood and exfiltration fixtures remain untrusted values | Semantic decision-quality evaluation; typed output alone is not immunity |
| Redirect/DNS | Jev transport denies redirects and unapproved final origin; rejects private DNS resolution before credentials | Deployment-specific DNS/network enforcement and allowed-origin review |
| Debug/retention | Optional host-only runtime `projection.debugCapture` receives only the minimized state and fails closed before credentials on capture failure. The debug sidecar encrypts with AES-256-GCM, audits access before capture/read/delete, denies unauthorized scope and expires ciphertext on access; telemetry tombstones references | Deploy an approved durable encrypted backend and audit sink, verify cascading erasure, out-of-band expiry and backup expiry |
| Provider credentials | Resolver spy proves denied policies never call credentials; a fake scoped resolver sees exactly `target.credentialRef` and denies an adjacent ref (`PRV-EGRESS-CRED-01`) | Exact authorized read and adjacent-secret denial in approved provider environment (#2680) |
| Default egress | No policy denies network adapters on every dispatch path; origin/region bound to the adapter destination | Operator-declared region evidence per deployment |

A deterministic offline load fixture (`test/unit/decision/projection-benchmark.test.ts`)
projects 55 allowed states and denies 55 region mismatches with zero credential
or transport calls. It reports elapsed time as observation, not as a portable
SLA: one local run took 13 ms for the fixture loop. The test asserts stable
projection digests and excluded adjacent canaries, not a timing threshold.
`projection-policy-matrix.test.ts` (`PRV-EGRESS-MATRIX-*`) is a table-driven
matrix over data class, trust, purpose, provider, model, origin, region and
retention with allow, deny and unknown values; every non-allowed cell makes zero
credential and dispatch calls. `egress-privacy-harness.test.ts`
(`PRV-EGRESS-CAPTURE-*`) captures the real stdout/stderr, receipt files, trace
spans, exports, snapshots, thrown errors and activity records (host evidence
callbacks) of an actual evaluation and a dispatcher run, with canaries in state,
credentials, response headers, unmodelled response fields and resolver errors,
and scans them with `scanQualificationPrivacy`. The threat-to-control mapping is
in [threat-control-mapping.md](./threat-control-mapping.md).
The synthetic `security-surface-matrix.test.ts` scans a combined offline
adapter request, projection evidence, trace, export, snapshot and audit fixture
for unique excluded canaries; it also verifies denied locator errors and logs
do not echo the locator. This does not substitute for a deployment-wide scan
of real durable stores, network captures and external collector output.

Provider default retention duration, geographic residency, encryption/key
management and enterprise zero-data-retention status remain **unknown** without
contractual deployment evidence. Neither a policy allowlist nor the offline
fixtures certify these provider properties. No production or automatic action
is authorized by this evidence alone.
