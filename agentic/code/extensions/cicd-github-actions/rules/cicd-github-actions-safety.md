---
name: cicd-github-actions-safety
enforcement: high
activation: summary
summary: Render Github Actions with reviewed immutable pins, isolated PR jobs and enforceable environment protection.
---

# Github Actions safety

- Apply `ci-action-pinning`, `dev-pipeline-safety`, `dev-secret-hygiene`,
  `dev-idempotent-builds` and `dev-ci-self-contained` by name; do not duplicate them.
- Pin every external `uses:` to a full 40-character commit SHA with a version
  comment. Update `templates/ci-action-pins.txt` with each reviewed pin change.
- Never render `pull_request_target`. PR jobs receive no user secrets and use
  ephemeral isolated runners. Delivery and secret steps require a non-PR event
  and a protected branch, including manual and scheduled runs.
- Set workflow `permissions: contents: read`; elevate only the specific job and
  scope that needs it. Do not grant write or OIDC permissions to validation jobs.
- Bind delivery jobs to a preconfigured environment. Verify reviewer count and
  branch restrictions outside workflow YAML; `environment:` alone is insufficient.
