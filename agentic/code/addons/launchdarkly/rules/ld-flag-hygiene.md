---
name: ld-flag-hygiene
activation: bound
summary: "Keep flags optional, owned and linked to lifecycle records with deliberate fallback and removal criteria."
bound_to:
  skills:
    - ld-docs
    - ld-connect
    - ld-doctor
    - ld-account-setup
  agents:
    - launchdarkly-concierge
enforcement: medium
---

# ld-flag-hygiene

## Rule

AIWG guidance: consume `feature_flags.provider` and the existing SDLC flag plan; do not override an opt-out or create a parallel lifecycle. Record flag kind separately from value type, owner, temporary/permanent intent, safe fallback, rollout/rollback, requirements and removal criteria. Create a removal task with a temporary flag; a team-selected review date is optional ([Feature Toggles](https://martinfowler.com/articles/feature-toggles.html)).

Verify current production, upcoming and fallback behavior rather than every combination ([testing code](https://launchdarkly.com/docs/guides/flags/testing-code.md)). Do not use flags as secrets, static configuration or a data store; remove temporary flags after their purpose is fulfilled ([technical debt](https://launchdarkly.com/docs/guides/flags/technical-debt.md)). AIWG guidance: record evidence gaps and defer advanced release/cleanup work to installed capabilities rather than claiming them complete during onboarding.
