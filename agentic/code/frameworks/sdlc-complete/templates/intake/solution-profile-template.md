# Solution Profile

Select a profile to set defaults for gates, controls, and process rigor.

## Profile

- Profile: `Prototype | MVP | Production | Enterprise`

## Defaults (can be tailored)

- Security
  - Prototype: basic auth, no PII storage
  - MVP: baseline controls, secrets management, SBOM
  - Production: threat model, SAST/DAST, zero criticals
  - Enterprise: comprehensive SDL, compliance, IR playbooks
- Reliability
  - Prototype: best-effort
  - MVP: p95 targets, basic alerts
  - Production: SLO/SLI, ORR, runbooks
  - Enterprise: error budgets, chaos drills, 24/7 on-call
- Process
  - Prototype: lightweight docs, rapid iteration
  - MVP: briefs/cards, minimal plans
  - Production: full traceability and assessments
  - Enterprise: strict gates and audits

## Feature flags

```yaml
feature_flags:
  provider: none
  policy: suggest
```

Contract: `provider: none|openfeature|<addon-id>`, `policy: suggest|always|never`.
`none` produces cards and code guidance only; `openfeature` uses neutral client
concepts. An installed addon may supply provider skills. `always` requests planning
for eligible work; `never` suppresses suggestions. Declines and never-flag cases
still apply. These field names/values are shared with cicd-complete. [AIWG guidance]
See `$AIWG_ROOT/docs/frameworks/sdlc-complete/feature-flags.md` for the provider seam and optional per-service cap.

## Overrides

- Notes: `tailoring decisions`
