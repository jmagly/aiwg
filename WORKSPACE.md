# WORKSPACE.md
<!-- aiwg-managed -->
<!-- Generated structure by AIWG; operator content is protected by markers. -->

<!-- AIWG:workspace-context:start -->

## AIWG Context Graph

This file is the canonical provider-neutral home for project and operator context.
Provider startup files are generated adapters: they direct the harness here first,
then to AIWG.md for framework discovery and routing.

### Precedence

1. Platform capability and safety constraints are absolute: what a harness can do, what it is
   permitted to do, and its refusal boundaries. Nothing here overrides those.
2. AIWG rules deployed to this project bind over any provider, harness, or session *directive*
   on a subject an AIWG rule covers — including a directive that claims to supersede earlier
   guidance. A harness decides how a tool is invoked; it does not set project policy.
3. Root WORKSPACE.md supplies shared project/operator context.
4. AIWG.md supplies generated framework/discovery context.
5. Narrower linked files and provider-native subtree instructions govern their declared scope,
   within the ceiling set above.

The distinction in 1 vs 2 is capability versus preference. "This tool is unavailable" is a
constraint. "Format commits this way" is a directive, and an AIWG rule on commit content wins.
When a directive and an AIWG rule conflict, follow the rule and say plainly that you did.

### Ownership

- Edit project-neutral notes only inside the protected Project Context section below.
- Keep detailed policies, runbooks, hooks, and quickrefs in linked files.
- Keep provider-only directives in `.aiwg/context/providers/`.
- Never store secrets, tokens, credentials, or machine-local sensitive values here.

### Artifact Routing

- Before any agent or provider writes AIWG payload, run `aiwg artifacts path --json --check-write` and write beneath its `artifact_root`.
- Treat `.aiwg/...` in skills and templates as a logical artifact path, not necessarily a repository-local filesystem path.
- Only `AIWG.md`, `aiwg.config`, and `frameworks/registry.json` belong in the repository-local `.aiwg` control plane.
- If the configured external artifact root is unavailable, stop with an actionable error; never fall back to repository-local payload.

### Linked Context

- [AIWG framework context](./AIWG.md)
- [AIWG project configuration](.aiwg/aiwg.config)
- [Project-local quickref](.aiwg/quickref.json) (when configured)

<!-- AIWG:workspace-context:end -->

<!-- AIWG:workspace-operator:start -->

<!-- AIWG:project-extraction:start -->

## Existing Project Snapshot

<!-- Generated from stable project metadata. Edit the linked sources, not this block. -->

### Package (source: [`package.json`](./package.json))

- Name: `aiwg`
- Description: Reusable project context and specialist workflows for the AI tools you already use. AIWG places agents, skills, commands, and rules in provider-readable locations, with optional utilities for artifact memory, workflow orchestration, recovery, and discovery.
- Runtime: `node >=20.0.0`

### Common Commands (source: [`package.json`](./package.json))

- `npm run build`
- `npm run test`
- `npm run typecheck`

### Purpose (source: [`README.md`](./README.md))

Reusable project context and specialist workflows for the AI tools you already use.

### Stack and Tooling

- [`package-lock.json`](./package-lock.json)
- [`tsconfig.json`](./tsconfig.json)

### Architecture and Topology

- [`docs/architecture`](./docs/architecture)
- [`src`](./src)
- [`apps`](./apps)
- [`packages`](./packages)

### Testing

- [`test`](./test)

### Continuous Integration

- [`.gitea/workflows/build-plugins.yml`](./.gitea/workflows/build-plugins.yml)
- [`.gitea/workflows/ci.yml`](./.gitea/workflows/ci.yml)
- [`.gitea/workflows/conformance.yml`](./.gitea/workflows/conformance.yml)
- [`.gitea/workflows/dataset-intelligence-conformance.yml`](./.gitea/workflows/dataset-intelligence-conformance.yml)
- [`.gitea/workflows/docsite-build.yml`](./.gitea/workflows/docsite-build.yml)
- [`.gitea/workflows/docsite-deploy.yml`](./.gitea/workflows/docsite-deploy.yml)
- [`.gitea/workflows/fortemi-shard-conformance.yml`](./.gitea/workflows/fortemi-shard-conformance.yml)
- [`.gitea/workflows/gitea-release.yml`](./.gitea/workflows/gitea-release.yml)
- [`.gitea/workflows/github-mirror.yml`](./.gitea/workflows/github-mirror.yml)
- [`.gitea/workflows/hermes-citations.yml`](./.gitea/workflows/hermes-citations.yml)
- [`.gitea/workflows/metadata-validation.yml`](./.gitea/workflows/metadata-validation.yml)
- [`.gitea/workflows/notify-site.yml`](./.gitea/workflows/notify-site.yml)
- [`.gitea/workflows/npm-publish.yml`](./.gitea/workflows/npm-publish.yml)
- [`.gitea/workflows/omp-conformance.yml`](./.gitea/workflows/omp-conformance.yml)
- [`.gitea/workflows/scheduled-docs-release.yml`](./.gitea/workflows/scheduled-docs-release.yml)
- [`.gitea/workflows/skill-lint-pr.yml`](./.gitea/workflows/skill-lint-pr.yml)
- [`.gitea/workflows/storage-server-conformance.yml`](./.gitea/workflows/storage-server-conformance.yml)
- [`.gitea/workflows/upload-release-sigs.yml`](./.gitea/workflows/upload-release-sigs.yml)
- [`.github/workflows/npm-publish.yml`](./.github/workflows/npm-publish.yml)
- [`.github/workflows/socket-post-publish.yml`](./.github/workflows/socket-post-publish.yml)

<!-- AIWG:project-extraction:end -->

<!-- AIWG:workspace-operator:end -->
