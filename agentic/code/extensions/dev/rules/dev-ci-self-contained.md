---
activation: summary
summary: Keep CI builders self-contained and pinned; define all build dependencies in the project builder image.
enforcement: high
bound_to:
  skills:
    - ci-pipeline-audit
    - ci-builder
---

# Self-Contained CI Builders

**Enforcement Level**: HIGH
**Scope**: All CI/CD pipeline configurations and build processes
**Issue**: #491

## Principle

Projects must not depend on external repositories, shared runners with pre-installed tools, or network-fetched dependencies at build time for their CI pipeline to function. Each project defines its own `ci/Dockerfile.builder` containing all build dependencies. This ensures builds are reproducible, auditable, and immune to upstream breakage.

## Mandatory Rules

1. **Each project owns its builder**: Every project with a CI pipeline must have a `ci/Dockerfile.builder` (or equivalent) in its repository. This builder image contains all tools, compilers, linters, and utilities needed to build and test the project.

2. **No external repo dependencies in CI**: CI workflows must not clone other repositories to obtain build tools, scripts, or configurations. If a tool is needed, it goes in the builder image. If a shared script is needed, it is copied into the project (vendor it).

3. **Pin all dependencies in the builder**: Every tool and package in the builder Dockerfile must be version-pinned. No `latest` tags, no unpinned `apt-get install` without version specifiers. This prevents builds from silently changing behavior when upstream packages update.

4. **Builder image is versioned**: The builder image must be tagged with a version (commit SHA or semantic version). CI workflows reference a specific tag, not `latest`. Updates to the builder are intentional and tracked.

5. **Builder image is tested before adoption**: When updating the builder image, the project's test suite must pass inside the new builder before the CI workflow is updated to reference it. The builder update workflow should be separate from the main CI workflow.

6. **Network isolation at build time**: The build and test stages should function without network access beyond pulling the builder image itself. If a test requires network access (e.g., integration tests), it must be in a separate stage clearly marked as requiring network.

## Validation

When reviewing CI configurations:

- [ ] Project has `ci/Dockerfile.builder` or equivalent
- [ ] CI workflow references a pinned builder image tag
- [ ] No `git clone` of external repos in CI steps
- [ ] All builder dependencies are version-pinned
- [ ] Builder update procedure is documented

## Rationale

External dependencies in CI are a supply chain risk and a reliability hazard. When a shared runner updates its Node.js version, or a third-party action changes behavior, or an upstream package repository has an outage, your build breaks for reasons entirely outside your control. Self-contained builders make builds reproducible and your CI pipeline's behavior a function of your code, not the internet's mood.
