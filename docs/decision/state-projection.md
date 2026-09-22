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

This foundation covers deterministic projection and destination authorization.
Encrypted debug capture, retention deletion/tombstones, legal hold, redirect-hop
authorization, and adoption by every adapter call site remain separate controls
and must not be inferred from a successful projection.
