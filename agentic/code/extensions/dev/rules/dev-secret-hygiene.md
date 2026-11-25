---
activation: summary
summary: Protect CI secrets from untrusted code, forked pull requests, logs, and build artifacts.
enforcement: high
bound_to:
  agents:
    - ci-architect
    - ci-renderer
    - ci-doctor
    - ci-release-engineer
    - supply-chain-guard
  skills:
    - cicd-intake
    - ci-assess
    - ci-pipeline-design
    - ci-render
    - ci-drift-check
    - ci-failure-triage
    - ci-flake-hunt
    - ci-migrate
    - ci-pipeline-audit
    - ci-builder
    - ci-release-coordinate
---

# Secret Hygiene in CI/CD Pipelines

**Enforcement Level**: HIGH
**Scope**: All CI/CD configurations, environment variables, and build artifacts
**Issue**: #775

## Principle

CI secrets must never be visible to untrusted code. Pull request builds from forks can exfiltrate secrets if they are exposed as environment variables — a forked PR can print env vars, write them to build artifacts, or send them over the network. The correct model is: secrets live in protected environments and are never passed to untrusted execution contexts.

## Mandatory Rules

1. **No credentials in CI env vars visible to PR builds**: Secrets must be scoped to pipelines that run on protected branches only (`main`, `release/*`, tags). PR workflows from forks must not have access to registry credentials, API keys, signing keys, or any other sensitive value.

2. **Secrets scoped to protected branches only**: Configure secret exposure at the workflow or job level to restrict access. In Gitea Actions and GitHub Actions, use environment-level secrets with deployment protection rules rather than repository-level secrets available to all workflows.

3. **Secret rotation procedure documented per project**: Every project that uses CI secrets must document its rotation procedure — who rotates, how often, and where the new value is stored. Undocumented secrets are unrotatable secrets.

4. **Build logs must not print secret values**: Log output must mask secret values with `***`. Never use `set -x` or `echo $SECRET_NAME` in build scripts without masking. If a CI platform supports secret masking, enable it. If log output accidentally contains a secret value, rotate immediately — assume it is compromised.

5. **Docker build args must not contain secrets**: Use BuildKit `--mount=type=secret` for secrets needed during image build. Passing secrets via `--build-arg` embeds them in image layers and they are recoverable with `docker history`. Never use `ARG SECRET_VALUE` for credentials.

6. **No secrets in `docker-compose.yml` or workflow YAML files**: All secret values belong in the secret store (repository secrets, Vault, encrypted env files). Workflow files are committed to the repository and visible to all contributors.

## Detection Patterns

Flag any of the following in CI configurations, Dockerfiles, and workflow files:

| Pattern | Location | Risk |
|---------|----------|------|
| `echo $SECRET_NAME` without masking | Shell scripts | Secret in log output |
| `--build-arg TOKEN=` | Dockerfile or workflow | Secret in image layer |
| `ARG SECRET_VALUE` used with `RUN curl ... $SECRET_VALUE` | Dockerfile | Secret in build cache |
| `env:` block in PR-triggered jobs referencing org/repo secrets | Workflow YAML | Secret exposure to forks |
| `set -x` before commands that use secret vars | Shell scripts | Secret in debug logs |
| Hard-coded tokens or passwords (any value matching `[A-Za-z0-9+/]{20,}`) | Any file | Direct exposure |
| Secret values in `docker-compose.yml` environment block | Compose files | Secret in plaintext |
| `pull_request_target` with secrets exposed | GitHub/Gitea Actions | Privileged fork execution |

## Validation

Before merging any CI/CD configuration change:

- [ ] No secrets referenced in jobs triggered by `pull_request` from forks
- [ ] All secret env vars are in the `env:` block of protected-branch jobs only
- [ ] No `--build-arg` usage with secret values in Dockerfiles or workflows
- [ ] Build logs from a test run contain `***` wherever secrets appear
- [ ] Secret rotation procedure exists and is documented in the project's ops docs
- [ ] No `set -x` in any script that handles secret environment variables

## Rationale

A compromised CI secret can give an attacker registry write access (supply chain attack), production credentials (direct breach), or signing keys (artifact integrity bypass). The attack surface in PR-triggered CI is well-documented: an attacker submits a PR that prints env vars or exfiltrates them in a curl request. Secrets scoped to protected branches cannot be reached by untrusted PR code because those jobs do not run on fork PRs. This is not about trusting contributors — it is about defense-in-depth against account compromise and supply chain attacks.
