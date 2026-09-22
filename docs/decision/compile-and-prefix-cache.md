# Decision compilation and provider-prefix caches

The decision runtime has separate namespaces for definition/schema compilation, adapter or grammar compilation, provider-prefix evidence, invocation replay, and semantic result caching. Only the first two store compiled artifacts. They never store or reuse a prior answer.

Compile keys cover pinned source digests, compiler/runtime/schema/canonicalizer versions, adapter and prompt versions, backend capability mode, model compatibility, feature flags, project scope, and data class. Reads verify identity, value integrity, authorization, project scope, expiry, and tombstone state. Cold concurrent requests use a single fill; failed fills are not published. Bypass compiles through the same callback and therefore preserves normalized request semantics.

Provider-prefix identity additionally pins the ordered-prefix digest, provider/backend/model/API revision, cache policy and TTL, workspace, region, data class, and egress policy. `hit` and `miss` require explicit provider reports. An absent report is `unknown`; timing, token patterns, and local compile hits are never used as evidence.

Cache telemetry is metadata-only. It uses bounded layer/outcome labels and must not contain raw cache keys, prompts, schemas, credentials, provider handles, private locators, or tenant-controlled labels. Lifecycle operations include tombstone, legal hold, deletion, and integrity-checked restore.

Compilation or prefix reuse does **not** imply a cached answer, correctness, calibration, deterministic inference, semantic equivalence, or semantic freshness. Deploy compile caching disabled first, compare the normalized requests from bypass and cache paths, and enable provider-prefix handling only for a pinned backend revision with documented semantics and approved privacy policy.

Paired benchmarks must pin their configuration digest, warmup and measured calls, minimum benefit target, and confidence interval. They report preparation latency, authoritative provider token/cache usage when available, total token/cost observations, hit and invalidation rates, and memory/storage. Unknown provider economics remain `null`, not zero.
