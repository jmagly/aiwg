---
namespace: aiwg
name: flow-release
platforms: [all]
description: Config-driven release orchestration — reads .aiwg/release.config plus optional .aiwg/releases/<plan-id> sidecars and walks the selected release plan's gates
triggers:
  - "help with CI builds or deployment"
  - "help me make the build or deployment path safer"
  - "start with pipeline safety or release readiness"
  - "pipeline safety ci"
  - "release flow"
  - "flow release"
  - "flow-release"
  - "run the release flow"
  - "run release flow"
commandHint:
  argumentHint: '<version> [--plan <id>] [--channel <stable|rc|beta|alpha|nightly>] [--dry-run] [--skip-uat] [--no-mirror] [--config <path>] [--guidance "text"]'
  allowedTools: 'Task, Read, Write, Edit, Bash, Glob, Grep, mcp__git-gitea__*'
  model: sonnet
  category: sdlc-orchestration
  orchestration: true
  modelRole: coding
  modelTier: standard
---

# Release Orchestration Flow (config-driven)

> **Declarative Flow source of truth (#1539):** the release gate sequence is
> defined as a YAML Flow at
> [`agentic/code/frameworks/sdlc-complete/flows/flow-release.playbook.yaml`](../../flows/flow-release.playbook.yaml)
> (with release capabilities under `flows/capabilities/`). This skill is the
> human-readable **wrapper** over that Flow — it stays for discoverability and
> operator guidance, and is a candidate for retirement once discovery surfaces
> YAML Flows directly (#1540). Per-gate config still lives in
> `.aiwg/release.config`; the Flow encodes the gate sequence and dependencies.

**You are the Core Orchestrator** for the project's release sequence.

## Output template

Required for release notes: @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/deployment/release-notes-template.md. Fill every required section; explain non-applicable fields and unrun checks.

## Artifact root resolution

Treat every `.aiwg/...` path in this skill as a logical artifact path. Before
reading or writing release configuration, sidecars, evidence, or reports, run
`aiwg artifacts path` from the active workspace and use the returned absolute
directory as `AIWG_ARTIFACT_ROOT`. An explicit `--config` path still wins.
Never assume the repository-local `.aiwg/` directory is the artifact corpus:
split-root projects may redirect it with `AIWG_ARTIFACTS_PATH` or
`.aiwg-location`. Do not copy redirected payload back into the local control
plane.

## Threat-assessment gate

Before publishing release notes, announcements, or forge release content,
resolve the active workspace member's `.aiwg/aiwg.config`
`security.threatAssessment` policy and assess the final content as
`release-note` with `tools/security/threat-assessment.mjs`. Persist the
machine-readable report with the release evidence. `audit` records without
interrupting; enforce-mode `flag`/`require-authorization` pauses publication
and `reject` blocks it. Off mode disables only this AIWG classifier.

## Your role

You walk the gates declared in `.aiwg/release.config`, in order, enforcing `hard_stop` semantics. You do not hard-code which gates exist or what they do — the config does. This is what makes the skill portable across projects with different release policies (a CalVer + npm project like AIWG vs. a SemVer + container-only project will share this skill body but differ entirely in their config).

When the user requests a release:

1. **Resolve `AIWG_ARTIFACT_ROOT` with `aiwg artifacts path`, then read `$AIWG_ARTIFACT_ROOT/release.config`** (or the path passed via `--config`). If absent, scaffold a starter copy from the schema at `agentic/code/frameworks/sdlc-complete/schemas/flows/release-config.yaml` and ask the operator to review before continuing.
2. **Discover release-plan sidecars** under `$AIWG_ARTIFACT_ROOT/releases/*.json`, `$AIWG_ARTIFACT_ROOT/releases/*.yaml`, and `$AIWG_ARTIFACT_ROOT/releases/*.yml`.
   - If `--plan <id>` is passed, select that plan.
   - If exactly one sidecar exists and no `--plan` is passed, select it.
   - If multiple plans exist and no plan is selected, halt with an actionable error listing available plan ids.
   - If duplicate plan ids exist, halt and require unique ids.
   - If no sidecar exists, continue with `.aiwg/release.config` as the legacy project-wide plan.
3. **Report the active release plan before actions.** Print the selected plan id, sidecar path, target, and effective delivery mode before executing build, validation, publish, tag, or post-release steps.
4. **Apply sidecar precedence.** When a release plan is active, its `delivery.mode` is authoritative for this release and overrides broad project defaults such as `direct`, `pr`, or `pr-required` where they conflict.
5. **Resolve the target channel** from `--channel` (default: `stable`).
6. **Validate the version** against `version_policy.format` and the `versioning` rule (CalVer no-leading-zeros, semver, etc.).
7. **Walk the selected plan's gates in order.** For a sidecar plan, use its `build.commands`, `validation_gates`, publish target policy, and `post_release_verification` commands. Without a sidecar, walk `.aiwg/release.config`'s `gates` array. For each gate:
   - Skip if `required_for_channels` is present and the target channel isn't in it.
   - Execute the gate's body (steps, invoke_skill, artifacts, review_diff, actions).
   - On failure: if `hard_stop: true`, **halt and report**. If false, log a warning and continue.
8. **Report** with the release tag URL, CI run URL, and tracker actions taken.

## Natural language triggers

- "release v2026.5.2"
- "release flow"
- "flow release"
- "flow-release"
- "run the release flow"
- "cut a release"
- "promote to stable"
- "ship it"
- "tag a nightly"

## Release plan sidecars

Release plan sidecars are optional per-target release configs stored beside the
main project config:

```text
.aiwg/aiwg.config
.aiwg/release.config
.aiwg/releases/<plan-id>.json
.aiwg/releases/<plan-id>.yaml
.aiwg/releases/<plan-id>.yml
```

Use sidecars when one repository has independent release tracks, such as an npm
package, documentation site, plugin bundle, container image, or customer-specific
distribution. The schema lives at
`agentic/code/frameworks/sdlc-complete/schemas/flows/release-plan.schema.yaml`.

Each sidecar can declare:

- release identity: `id`, `name`, and `target`
- build commands and validation gates
- publish targets and registry/remote details
- artifact, signing, SBOM, and provenance requirements
- docs, changelog, and release-note expectations
- post-release verification commands
- `delivery.mode`, which overrides broad project delivery defaults while that plan is active

Agents must fail closed on missing, ambiguous, or conflicting sidecars. Do not
fall back silently to `.aiwg/release.config` when the user requested a specific
plan and that plan cannot be resolved.

## Config-driven gate semantics

The config schema (`release-config.yaml`) defines six gate shapes. Each gate has exactly one shape:

### Shape 1: `steps`

Sequential shell commands. Each step has an `id`, a `run` template (supports `{version}`, `{tag}`, `{channel}` placeholders), and an `expect_exit` (default 0).

```yaml
- name: local-build-test
  hard_stop: true
  steps:
    - id: typecheck
      run: npx tsc --noEmit
    - id: unit-tests
      run: npm test
      tolerate_pre_existing_flakes: [test/integration/cli-perf.test.ts]
```

Execution: run each step in order. Capture stdout/stderr. Compare exit code to `expect_exit`. If `tolerate_pre_existing_flakes` is set, treat failures in those test files as warnings (not gate failures) — useful for known-flaky perf tests.

Steps may carry:
- `required_for_channels` (skip when channel not listed)
- `skip_when_flag` (skip when the named CLI flag is present)
- `depends_on_channel` (per-channel variant of the `run` command)

### Shape 2: `invoke_skill`

Dispatch another AIWG skill via the Task tool. Pass `args` as input.

```yaml
- name: doc-sync
  hard_stop: true
  invoke_skill: doc-sync
  args:
    direction: code-to-docs
    guidance: |
      <prose explaining the doc-sync intent>
    dry_run_first: true
```

Execution: spawn a sub-agent invoking the named skill with `args`. Wait for completion. On failure, apply the gate's `hard_stop` policy.

### Shape 3: `tracker` (CI poll)

Poll an issue/CI tracker until the workflows referenced complete.

```yaml
- name: ci-green
  hard_stop: true
  tracker: gitea
  owner: roctinam
  repo: aiwg
  timeout_seconds: 600
  poll_interval_seconds: 30
  required_workflows: [ci.yml, validate.yml]
```

Execution: list recent action runs for the release commit. For each `required_workflows` entry, wait for `status: completed` and assert `conclusion: success`. Fail the gate on timeout or any non-success conclusion.

For Gitea, use `mcp__git-gitea__actions_run_read` if available. For GitHub, use `gh run list/view`.

### Shape 4: `artifacts`

Assert release-time files exist (and optionally contain a section).

```yaml
- name: changelog-and-announcement
  hard_stop: true
  required_for_channels: [stable]
  artifacts:
    - path: CHANGELOG.md
      section_pattern: '## [{version}]'
    - path: 'docs/releases/v{version}-announcement.md'
      must_exist: true
```

Execution: for each artifact, check `must_exist` (default true) and, if `section_pattern` is provided, grep the file for the pattern (with `{version}` interpolated).

### Shape 5: `review_diff`

Surface a diff and prompt the operator.

```yaml
- name: readme-freshness
  hard_stop: false
  review_diff:
    path: README.md
    since_tag: latest-stable
    prompt: 'Has the README been reviewed for changes shipping in this release?'
```

Execution: run `git diff <since_tag>..HEAD -- <path>` and present to the operator. Wait for explicit acknowledgment before proceeding. With `hard_stop: false`, a "no" response logs a warning and continues; with `hard_stop: true`, it halts.

### Shape 6: `actions` (post-release)

Declarative actions for post-release housekeeping.

```yaml
- name: post-release
  hard_stop: false
  actions:
    - close_imported_issues_with_thanks: true
    - update_release_entry: gitea
    - update_release_entry: github
      skip_when_flag: '--no-mirror'
    - create_github_announcement_discussion:
        category: Announcements
        required_for_channels: [stable]
        hard_stop: true
        skip_when_flag: '--no-mirror'
        links: [github_release, npm_version, release_notes, changelog]
        style: conversational-impact-guidance
```

Each action is interpreted by the skill:

- `close_imported_issues_with_thanks: true` — find issues with the `imported` label closed by commits in this release, post a thank-you comment on the source tracker, then close on both sides. Mirrors the May-2026 jmagly→roctinam sweep pattern.
- `update_release_entry: <tracker>` — create or update the release entry (Gitea/GitHub) with the announcement body.
- `create_github_announcement_discussion` — after GitHub release publication
  is verified, create one discussion in the configured category for stable
  releases. **This action is tool-backed, not prose.** Draft the body, write it
  to `{evidence_dir}/discussion.md`, then run the action's `run` command
  (reference: `tools/release/publish-github-release-discussion.mjs`). The
  publisher refuses to run until the GitHub release is published and not a
  draft, validates the four required links and the `no_ai_attribution` policy
  in the body, resolves the repository and category node IDs, searches the
  category for an existing discussion titled `AIWG {version}…` and reuses it
  so retries are idempotent (updating the body only when required links are
  missing or `--update` is passed), issues GitHub's GraphQL `createDiscussion`
  mutation, writes `discussion-preflight.json`, `discussion-request.json`, and
  `discussion-result.json` beside the body, and finishes by running
  `verify-github-release-discussion.mjs`. It fails with an actionable message
  when Discussions are disabled, the category is absent, the release is
  missing, or authentication lacks Discussions write access. Respect
  `required_for_channels`, `hard_stop`, and `skip_when_flag`; the reference
  release uses `hard_stop: true`, so a non-zero exit halts the flow and the
  stable release is **not** reported complete without its discussion. Do not
  substitute a hand-run GraphQL call or skip the step because the gate that
  contains it is `hard_stop: false`; the action-level flag governs.

  `{evidence_dir}` resolves to `<artifact_root>/releases/evidence/{version}`,
  where `<artifact_root>` comes from `aiwg artifacts path --json`. Create it at
  the start of the release run and write every gate's log there; a release run
  that leaves no evidence directory is itself a defect to report.

  The discussion is a companion to the durable release records, not another
  copy of them. Its body must link to the GitHub release, the published npm
  version, the release announcement/notes, and the matching CHANGELOG section.
  Summarize the few changes with the greatest user impact; explain who each
  helps, what it changes in practice, and one concrete way to try it. Use a
  friendly, educational, professional voice, and close with specific questions
  about how people are using the update or where they want more guidance. For
  `style: conversational-impact-guidance`, prefer direct language, concrete
  examples close to claims, varied sentence length, and useful analogies only
  when they clarify the change. Avoid corporate filler, hype, and exhaustive
  restatement. Keep raw install commands out of the body and point at the
  release notes for upgrade steps; that keeps the `release-note` threat
  assessment at `proceed`. Optional `voice_sources` refine that style when
  readable; absence of a local voice file must not block an otherwise valid
  release.

## Completion gate: post-release verification is mandatory

A stable release is **not complete** until every command in the active release
plan sidecar's `post_release_verification` list has exited 0 (respecting
`required_for_channels` and `skip_when_flag`). For AIWG that means both
`release-publication-verify` and
`node tools/release/verify-github-release-discussion.mjs --version {version}`.
Run them after the `post-release` gate, record their output in
`{evidence_dir}`, and only then report the release done or close release
issues. If a verification command fails, apply the anti-laziness recovery
protocol: fix the missing surface (for example, run the discussion publisher)
and re-verify. Never report completion with a failing or unexecuted
verification; 2026.9.7 and 2026.9.9 shipped without their announcement
discussions because this gate was skipped.

> **Verify publication before closing release-completion issues.** After the
> `release` gate pushes the tag and the release workflows run, invoke the
> `release-publication-verify` skill with the tag *before* the `post-release`
> close-outs. It turns the tag into concrete proof — Gitea/GitHub release assets,
> `SHA256SUMS` + native package checksums, GHCR images, and installer dry-run —
> and emits an issue-comment-ready evidence summary distinguishing MISSING from
> FAILED proof. Do not close a release-completion issue on assumption; paste the
> verifier's evidence into the close comment. Configure what "published" means
> via the optional `publication_verify` block in `.aiwg/release.config`.

## Policy enforcement

The config's `policy` block applies at every gate:

- `no_ai_attribution`: scan commit message / tag message / announcement body for AI-tool branding. Fail if found.
- `ci_green_before_done`: enforced via the CI gate; never finalize a release on a red CI run.
- `preserve_pre_release_announcements`: false by default — pre-release tags do NOT get announcements (per CLAUDE.md release-channels guidance).
- `thank_external_reporters`: enforced in the `post-release` action above.

## Failure handling

- **Pre-tag failures**: revert any version-bump commits, restart after fixing the issue.
- **Post-tag failures**: never delete pushed tags. Increment patch and re-run the flow.
- **Gate failures with `hard_stop: true`**: halt immediately, surface the failure log, do not advance.
- **Gate failures with `hard_stop: false`**: log a warning, continue.
- **Supply-chain gate (signed-tag verify) failure**: this is the recovery exception to "never delete pushed tags." If `tools/ci/verify-signed-tag.sh` rejects the tag (wrong signing key, expired key, missing-from-maintainers.asc), no artifacts are emitted by `npm-publish.yml` / `gitea-release.yml` / `github-mirror.yml` — the bad tag is an empty shell. Recovery: `git tag -d <tag>`, push delete to both remotes (`git push origin :refs/tags/<tag>` and `git push github :refs/tags/<tag>`), then re-cut via `tools/release/cut-tag.sh <version>` which forces the release key. Document the incident in `docs/contributing/versioning.md` for the next release.

Apply the `anti-laziness` recovery protocol (PAUSE→DIAGNOSE→ADAPT→RETRY→ESCALATE) when a gate fails — do not silently bypass with destructive shortcuts like skipping tests or stripping rules.

## Tag-cutting must use the wrapper

**`git tag -a` and `git tag -s` are NOT to be used directly by this skill.** The maintainer's global git config typically has `tag.gpgsign=true` and `user.signingkey=<personal-commit-signing-key>`, which causes plain `git tag` invocations to sign with the **wrong key** — the personal key, not the release key. The supply-chain gate will reject the tag and no artifacts will ship.

Always use `tools/release/cut-tag.sh <version>` for the tag step. The wrapper:

1. Runs 10 pre-tag sanity checks (CalVer shape, package.json + marketplace.json lockstep, CHANGELOG entry, announcement file present, release-signing key present locally AND published in `.gitea/keys/maintainers.asc`)
2. Signs with `-u <RELEASE_KEY_FINGERPRINT>` (defaults to the AIWG release key; override via `AIWG_RELEASE_KEY_FINGERPRINT` env var for forks)
3. Verifies the local signature via `git tag -v` before declaring success
4. Does NOT push automatically — push is left to the operator so a final sanity step can run

This is the canonical path. Any release config that templates a raw `git tag -s` is incorrect and must be migrated to call the wrapper.

## Defaults when no config exists

If `.aiwg/release.config` is missing, scaffold one from the schema and ask the operator to review before continuing. The AIWG repo's own config is the reference implementation; new projects can copy it as a starting point.

## Owner

Canonical owner: **Deployment Manager** (`agentic/code/frameworks/sdlc-complete/agents/deployment-manager.md`).

May delegate to:
- **Reliability Engineer** — SLO validation in pre-release gates
- **Security Architect** — for security-sensitive releases
- **Technical Writer** — for the announcement body

## AIWG-specific reference

This repository's `.aiwg/release.config` declares the gates AIWG uses today:

1. **local-build-test** (typecheck, unit tests, build, UAT for stable)
2. **ci-green** (Gitea workflows on the release commit)
3. **doc-sync** (code-to-docs sync with agentic/ + docs/ scope)
4. **changelog-and-announcement** (CHANGELOG.md + docs/releases/ for stable)
5. **readme-freshness** (diff prompt for stable)
6. **release** (tag, push, mirror, npm dist-tag)
7. **post-release** (release entries, stable GitHub announcement discussion, tracker close-outs, and reporter thanks)

That config IS the AIWG release checklist — what was previously prose in CLAUDE.md is now an executable spec.

## Related

- Schema: `agentic/code/frameworks/sdlc-complete/schemas/flows/release-config.yaml`
- Release plan schema: `agentic/code/frameworks/sdlc-complete/schemas/flows/release-plan.schema.yaml`
- Config: `.aiwg/release.config` (per project)
- Release plan sidecars: `.aiwg/releases/<plan-id>.yaml`, `.yml`, or `.json`
- Rules: `versioning`, `no-attribution`, `ci-green-before-done`, `delivery-policy`, `anti-laziness`
- Skills: `doc-sync` (called by gate 3), `release-publication-verify` (post-tag proof before closing release issues), `aiwg-pr` (when delivery.mode is pr-required for release prep), `aiwg-issue` (filing release-blocker issues)
- Doc: CLAUDE.md "Release Documentation Requirements" + "Release Checklist"

## Acceptance criteria

- [ ] `.aiwg/release.config` validated against the schema
- [ ] Every gate in `gates` either executed or skipped per `required_for_channels`
- [ ] All `hard_stop: true` gates green before tag push
- [ ] CI green on the tag commit
- [ ] No AI attribution in commits, tags, or announcement
- [ ] Original reporters thanked (if release closes imported issues)
- [ ] Release entry created on Gitea (and GitHub mirror for stable)
- [ ] One idempotent GitHub Announcements discussion created for stable
      releases, linking the GitHub release, npm version, release notes, and
      CHANGELOG
- [ ] npm dist-tag updated correctly per channel
