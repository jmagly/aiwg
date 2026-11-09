---
precedence: high
overridable: true
name: artifact-output-policy
description: "Write governed outputs (issues, comments, PRs, reports, SDLC artifacts) from their discovered template, filling every required section; write the canonical artifact to the AIWG store first; provider-native destinations are explicit-only."
summary: "Write governed outputs (issues, comments, PRs, reports, SDLC artifacts) from their discovered template, filling every required section; write the canonical artifact to the AIWG store first; provider-native destinations are explicit-only."
enforcement: high
scope: artifact-producing-workflows
activation: kernel
---

# Artifact Output Policy

## Templates

- Before a governed output, find and read its template: use the skill's "Output template" section or `aiwg discover "<output> template" --type template`.
- Fill every required section with observed facts. Mark a non-applicable section with a reason; never drop it silently.
- Write free-form only when no template exists, and say so.

## Destinations

Before any durable AIWG plan/review/report/SDLC artifact, MUST resolve `.aiwg/aiwg.config` `artifact_outputs`:

- Write the canonical artifact to the configured AIWG artifact store first as the unambiguous source of truth. Never substitute, relocate, or omit it because of provider defaults.
- Treat provider-native destinations as derived exports. Defaults: `canonical: aiwg`, `provider_native: explicit-only`. Only explicit task selection may choose an enabled supported destination; user/provider defaults cannot silently select one.
- When both outputs are selected, record presentation reference, canonical path, authority, and timestamp in artifact-output provenance.
- Unknown/unsupported destinations MUST fail safe with a clear diagnostic. Report honestly when the provider acts above AIWG's controllable prompt/tool boundary.
- Project policy is the ceiling; within it, explicit task selection outranks user preferences and provider defaults. Higher-authority safety, privacy, and project data boundaries always apply.

Supporting rationale and examples: [artifact-output-policy-guidance](./artifact-output-policy-guidance.md) (`aiwg show rule artifact-output-policy-guidance --body`, on-demand).
