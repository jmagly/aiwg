---
name: cicd-gitea-actions-safety
enforcement: high
activation: summary
summary: Render Gitea Actions with reviewed immutable pins, isolated PR jobs and enforceable environment protection.
---

# Gitea Actions safety

- Apply `ci-action-pinning`, `dev-pipeline-safety`, `dev-secret-hygiene`,
  `dev-idempotent-builds` and `dev-ci-self-contained` by name; do not duplicate them.
- Pin every external `uses:` to a full 40-character commit SHA with a version
  comment. Update `templates/ci-action-pins.txt` with each reviewed pin change.
- Never render `pull_request_target`. PR jobs receive no user secrets and use
  ephemeral isolated runners. Delivery and secret steps require a non-PR event
  and a protected branch, including manual and scheduled runs.
- Resolve logical runner labels against operator-owned act_runner registration;
  never assume `ubuntu-latest` means a GitHub-hosted machine. Provision separate
  ephemeral pools for untrusted PRs and privileged delivery, with pinned images.
- Do not rely on GitHub `permissions:` or environment approval syntax being enforced
  by Gitea. Require an external approval/secret broker, or stop rendering delivery.
- Use explicit reviewed action origins and compatible cache/artifact protocols;
  these templates select upload-artifact v3, not GitHub's v4 artifact service.
