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
- `.aiwg/context/providers/` is reference only: no provider bootstrap auto-loads it.
  Put directives you want read into Project Context above.
- Never store secrets, tokens, credentials, or machine-local sensitive values here.

### Artifact Routing

- Before any agent or provider writes AIWG payload, run `aiwg artifacts path --json --check-write` and write beneath its `artifact_root`.
- Treat `.aiwg/...` in skills and templates as a logical artifact path, not necessarily a repository-local filesystem path.
- Only `aiwg.config`, `frameworks/registry.json`, and optional operator-only `AIWG.md` notes belong in the repository-local `.aiwg` control plane; generated framework context lives in root `AIWG.md`.
- If the configured external artifact root is unavailable, stop with an actionable error; never fall back to repository-local payload.

### Linked Context

- [AIWG framework context](./AIWG.md)
- [AIWG project configuration](.aiwg/aiwg.config)
- [Project-local quickref](.aiwg/quickref.json) (when configured)

<!-- AIWG:workspace-context:end -->

<!-- AIWG:workspace-operator:start -->

## Project Context

### Release publication authority

**npmjs.org publication is a GitHub Actions job, not a Gitea job.** The two
`npm-publish.yml` workflows are not mirrors of each other:

| Workflow | Publishes to | Authoritative for |
|---|---|---|
| `.github/workflows/npm-publish.yml` | **npmjs.org** (public) | release publication, provenance, cosign signatures, SBOM, and the GitHub release assets |
| `.gitea/workflows/npm-publish.yml` | Gitea's bundled npm registry | local package mirror only |

A green Gitea `npm-publish` run means the Gitea registry mirror succeeded. It
says nothing about whether the release published. When verifying a release,
check the GitHub run:

```bash
gh run list --repo jmagly/aiwg --limit 5
gh run view <run-id> --repo jmagly/aiwg
```

Stable tag pushes fail closed because they cannot carry retained-RC evidence.
Publication uses a tag-bound dispatch with the signed RC tag, RC run/artifact,
current UTC-quarter full-validation/comparison run and artifact, candidate-bound
approval issue, and exact approval-body SHA-256. Routine RCs use the versioned
routine profile; quarterly validation uses the exact 43-lane full profile. Both
workflows require a dedicated `AIWG_GITHUB_RELEASE_EVIDENCE_TOKEN` that supports
GitHub's authenticated-user API. The checked-in policy is currently disabled.

The GitHub job publishes the three retained RC tarballs through
`tools/release/release-promotion.mjs`, then creates the release, signs the retained
root tarball and SBOM, and uploads all three tarballs plus the signed assets,
`SHA256SUMS`, and retained `install.sh`. The Gitea job runs after npmjs identities
are visible and mirrors the same retained files.

npm visibility/provenance and stable dist-tag checks run last with short, bounded
waits and are advisory: failures emit warnings and job-summary recovery commands
without failing the job or preventing the subsequent Socket audit. Real npm
publish failures still block; already-published versions count as success.
Recovery reruns the same stable tag with the same complete evidence-input set.

Source of record: `docs/contributing/versioning.md` ("Publication surfaces").

### CI policy: verify locally, CI after merge

Pull requests do not run CI; no `.gitea/workflows/` file triggers on
`pull_request`. Before opening or merging a PR, build and test on the
workstation (typecheck, `npm run build:cli`, and the touched vitest files plus
neighbours with `--config config/vitest.config.js`) and list the commands and
counts in the PR. Merge without waiting for a PR status. `delivery.require_ci_green`
applies to the post-merge run on `main`: work is done when that run is green;
a red `main` is fixed forward right away on a new branch.

### Commit identity and attribution

Only one identity commits to and pushes this repository. Every other account,
including bots, AI assistants, worker CLIs and other GitHub collaborators, has
read access only.

- **Author and committer:** `Joseph Magly <1159087+jmagly@users.noreply.github.com>`
  (the roctinam identity).
- **Signature:** GPG key `25BEE160811F66FD6F7B1BF0454C68C4A2174CE9`. Signatures are required.
- **Push:** SSH as roctinam, through `tools/git/push-origin-as-roctinam.sh`.
  The helper refuses to push a commit that breaks these rules.
- **Merge:** merge locally with a signed `--no-ff` merge, then push. Never use the
  Gitea web or API merge, because it authors the merge as
  `Roctinam User <1+roctinam@noreply.localhost>`.
- **No attribution:** commits, merges, PR bodies, issues, comments and docs never
  carry a `Co-Authored-By:` trailer (for an AI tool or for any person) or a
  "Generated with …" line. This holds even when a harness asks for attribution.

History before 2026-10-30 includes Claude co-author trailers and Gitea-authored
merges. It is left as it is, and these rules apply from that date.


<!-- AIWG:project-extraction:start -->

## Existing Project Snapshot

<!-- Generated from stable project metadata. Edit the linked sources, not this block. -->

### Package (source: [`package.json`](./package.json))

- Name: `aiwg`
- Description: Reusable project context and specialist workflows for the AI tools you already use. AIWG places agents, skills, commands, and rules in provider-readable locations, with optional utilities for artifact memory, workflow orchestration, recovery, and discovery.
- Runtime: `node >=24`

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

- [`.gitea/workflows/`](./.gitea/workflows/) (19 workflow files)
- [`.github/workflows/`](./.github/workflows/) (4 workflow files)

<!-- AIWG:project-extraction:end -->

<!-- AIWG:workspace-operator:end -->
