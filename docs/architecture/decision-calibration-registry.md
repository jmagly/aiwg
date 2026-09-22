# Decision calibration registry

The calibration registry binds every threshold to the configuration that produced its evidence. Its immutable identity includes provider, backend, actual served model, decision primitive, definition digest, adapter/prompt version, dataset and slice hashes, and calibrator parameters. A requested alias is recorded separately from the actual model returned by the provider.

Exact reuse requires the entire identity to match. Any changed field is unknown unless an immutable, reviewed relation explicitly marks the new identity approved-compatible, shadow-required, or incompatible. Unknown and unusable evidence follow an explicit policy (`fail`, `defer`, `shadow`, or `require-approval`); they never inherit the previous model's calibration. Alias observations emit drift history before reuse, and a compatibility decision is pinned by run ID so concurrent registry changes cannot alter an active run.

Calibration profiles are preregistered before holdout access. They pin minimum total and per-slice samples (or a stated power rule), confidence-interval method and level, maximum calibration error and selective-risk bounds, and expiry. Missing, expired, unapproved, under-sampled, or out-of-bound evidence is non-actionable under the configured policy and appears in the compatibility receipt.

Raw provider probability, confidence, and distributions remain intact. Calibrated evidence is an additional derived record that cites the pinned artifact ID and digest; it does not normalize or replace raw evidence.

Promotion eligibility requires an evaluation-integrity report digest, an approval reference, and an exact rollback revision. Alias, promotion, rollback, retirement, and drift history is append-only. The registry only establishes eligibility and authoritative state; runtime shadow execution, drift response, promotion, and rollback orchestration belong to the D17 control plane.

Calibration is a population-level measurement, not proof that an individual result is correct. Expected calibration error alone is insufficient for safe automation, vendor confidence is not a portable calibrated probability, and public datasets may be contaminated or unlike production traffic. Production thresholds require representative held-out workflow data, relevant slices, adequate samples, uncertainty intervals, and ongoing expiry/drift controls. The deterministic fixtures test registry mechanics only and are not product-quality evidence.
