# Semantic decision-result cache

The result cache reuses evidence from an earlier, side-effect-free decision. It is separate from exact invocation-receipt replay, compiled-schema caches, and provider prompt-prefix caches. It ships disabled: callers must supply an enabled, versioned cache policy, declare the evaluation side-effect-free, and choose an explicit TTL.

## Identity and freshness

`decision-semantic-key/v1` hashes canonical JSON for the definition, ruleset, binding, adapter, prompt, acceptance, calibration, backend/model compatibility, primitive, projected input, subject identity, projection and egress policies, and capability mode. Unicode and JSON object order use the repository canonicalizer. Changing any field produces a miss. The digest is scoped again by tenant, project, and workspace in storage.

Pinned models may be reused only for the exact requested/actual version. A moving alias requires a registry-generated compatibility snapshot, an explicit approved-version set, and an unexpired validity window. Expired or unknown snapshots bypass reuse; the cache never guesses the version an alias currently serves.

Hits preserve the original result, evaluation time, actual model, uncertainty, calibration status, source invocation, and receipt. The new caller receipt says `cache-hit` and `providerAttempted: false`; it must not be rendered as fresh inference. TTL expiry and policy-version changes prevent reuse, but TTL alone never establishes identity.

## Integrity and access

Every read revalidates schema version, immutable identity, result digest, entry digest, safe terminal state, scope, policy, and freshness. The filesystem store uses mode-restricted files and atomic no-overwrite publication. Host-authenticated actors must hold per-operation `read`, `write`, `invalidate`, `export`, or `delete` permission, and the actor scope must match the entry. Storage paths hash scope plus key to avoid cross-project substitution. Deployments remain responsible for encryption and lifecycle controls on the containing volume and backups; deletion renames content to a tombstone for a lifecycle worker rather than silently erasing audit state.

Only successful evidence is cached by default. A policy may opt into short negative caching solely for deterministic `invalid-input`; authentication, authorization, boundary denial, transient failures, and execution uncertainty are never reusable. A rejected or crashed fill publishes nothing. In-process single-flight collapses concurrent fills for one scoped key; distributed deployments must provide equivalent coordination around the store.

Telemetry reports only `hit`, `miss`, `bypass`, `stale`, `invalidation`, and `single-flight` with an opaque operation ID. Semantic keys, input-derived digests, subject identities, and entry IDs are not telemetry fields. Hit-side savings are labeled **estimates from the original request**, not measured counterfactual provider savings; missing input/output tokens or cost remain `null`, never fabricated as zero. Original provider usage remains attached to original evidence and is never counted again as new usage.
