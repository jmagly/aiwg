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

## Offline evidence and deployment limits

| Boundary | Evidence | Remaining deployment requirement |
|---|---|---|
| Provider/model/origin/region/purpose mismatch | Projection denial with zero credential/transport calls | Approved binding inventory and independent provider policy review |
| Trust/data class/lifecycle metadata | Runtime enum and missing-control denial | Approved classification and retention schedule per data class |
| Hostile state | Direct override, fake authority/system, delimiter, label, flood and exfiltration fixtures remain untrusted values | Semantic decision-quality evaluation; typed output alone is not immunity |
| Redirect/DNS | Jev transport denies redirects and unapproved final origin; rejects private DNS resolution before credentials | Deployment-specific DNS/network enforcement and allowed-origin review |
| Debug/retention | Optional debug sidecar encrypts with AES-256-GCM, audits access before capture/read/delete, denies unauthorized scope and expires ciphertext on access; telemetry tombstones references | Deploy an approved durable encrypted backend and audit sink, verify cascading erasure, out-of-band expiry and backup expiry |
| Provider credentials | Resolver spy proves denied policies never call credentials | Exact authorized read and adjacent-secret denial in approved provider environment |

Provider default retention duration, geographic residency, encryption/key
management and enterprise zero-data-retention status remain **unknown** without
contractual deployment evidence. Neither a policy allowlist nor the offline
fixtures certify these provider properties. No production or automatic action
is authorized by this evidence alone.
