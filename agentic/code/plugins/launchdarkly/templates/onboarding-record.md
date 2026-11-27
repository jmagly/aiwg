# LaunchDarkly onboarding record

AIWG guidance: resolve the artifact root before writing. Save beneath logical `.aiwg/launchdarkly/`; omit all key/token values, raw tool results and credential-bearing configuration.

- Status: pending / blocked / completed
- Stage: no-account / connected / first-flag / routine-releases / governed
- Goal and accepted flag-fit decision:
- SDLC dependency verified (installed project selection and SDLC artifacts):
- Provider seam: `feature_flags.provider: launchdarkly`
- Project / non-production environment / production boundary:
- Region and evidence (never inferred from credential shape):
- Plan/capability signals: observed / denied / unavailable / unknown
- Role and least-privilege evidence:
- Transport / credential class / intended placement / mismatch:
- SDK name / version / runtime:
- Read-only verification: sanitized success/failure and time
- Vendor guides used and source URL / retrieval date:
- Requirements / ADR / existing SDLC flag-plan links:
- Flag owner / kind / value type / temporary or permanent:
- Fallback and intended-state verification:
- Rollout / rollback / removal criteria and removal task:
- Proposed write diff reference / target scope / human approval:
- Sanitized read-back / actual application evaluation evidence:
- Redaction review before save: pass / pending
- Blockers / missing evidence / next action:

A completed first-flag stage requires a real application evaluation; a successful connection or fixture is insufficient. Keep current, upcoming and fallback checks ([testing code](https://launchdarkly.com/docs/guides/flags/testing-code.md)).
