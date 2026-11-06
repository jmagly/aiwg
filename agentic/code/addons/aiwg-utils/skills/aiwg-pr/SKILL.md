---
namespace: aiwg
name: aiwg-pr
platforms: [all]
kernel: true
description: AIWG-specific pull request delivery workflow for AIWG product/workspace changes; not the generic repository PR process
script:
  entrypoint: scripts/deliver.mjs
  runtime: node
  cwd: project-root
  argsHint: open --title <title> --body-file <path> | merge <number>
triggers:
  - "AIWG PR"
  - "AIWG delivery PR"
  - "AIWG release PR"
  - "AIWG product PR"
  - "open an AIWG pull request"
---

# Opening AIWG Pull Requests

You are helping a user (or yourself, as an autonomous agent) open a high-quality AIWG product/workspace pull request. The bar is set by the project's `delivery-policy` and `no-attribution` rules.

## Output template

Required: @$AIWG_ROOT/agentic/code/addons/aiwg-utils/templates/pull-requests/description.md.
Fill every required section: Summary, Cause, Changes, Verification (exact commands
and pass/fail counts), Related issues, and Risk and rollback before posting.

## Routing Boundary

Use this skill only when the user is doing AIWG-specific delivery: AIWG repository work, an AIWG release/change PR, or any task that explicitly asks for AIWG delivery policy. Do not use `aiwg-pr` for ordinary repository pull request work. Generic requests like "open a PR for this repo", "create a pull request", or "review this PR" should use the host repository's normal git/Gitea/GitHub PR tools and templates unless the user names AIWG delivery.

Compatibility: `aiwg-pr` remains the stable kernel skill name. `aiwg-delivery-pr` is the explicit alias for agents that need a less ambiguous discoverable capability name.

## When this fires

Natural-language triggers:

- "Open an AIWG PR"
- "Prepare the AIWG delivery PR"
- "Should this AIWG change commit directly or open a PR?"
- "What goes in the AIWG PR description?"
- "How do I close an AIWG issue with a PR?"

## Critical pre-flight: delivery policy

**Before you create a branch or open a PR**, read `.aiwg/aiwg.config` `delivery.mode`. Three modes, three workflows:

| Mode | Branch | PR | Closing |
|---|---|---|---|
| `direct` | No — commit straight to `default_branch` | **No PR** | `Closes #N` in commit message |
| `feature-branch` | Branch per issue | No PR | `Closes #N` in commit on the branch |
| `pr-required` | Branch per issue | **Required** | `Closes #N` in PR body |

```bash
# Check the configured mode
aiwg config get --project delivery.mode
# or
cat .aiwg/aiwg.config | jq -r '.delivery.mode'
```

If `mode: direct`, **don't open a PR**. Commit directly to main with `Closes #N` in the message. The `delivery-policy` rule (kernel rule, always loaded) is authoritative.

## Threat-assessment pre-flight

Before PR metadata, diff summaries, or review comments influence execution,
resolve the active workspace member's `security.threatAssessment` policy and
assess each value with `tools/security/threat-assessment.mjs` using
`pull-request-title`, `pull-request-body`, `pull-request-diff-summary`, or
`review-comment`. Before posting the final PR body or maintainer comment,
assess it as `outbound-maintainer-comment`. Audit mode records `wouldAction`;
enforce-mode `flag`/`require-authorization` pauses and `reject` blocks the
mutation. Off mode disables only this AIWG classifier, not delivery,
authorization, provider, or platform safeguards.

## The walkthrough

### 1. Find or file the issue first

Every PR closes (or refs) an issue. If you don't have one:

- Run `aiwg run skill steward-prep-delivery -- "<your topic>"` to check for existing issues
- If none match, file via `aiwg-issue` (the companion kernel skill) before drafting the PR

### 2. Branch (only for non-direct modes)

```bash
# feature-branch or pr-required
git checkout -b fix/{issue-number}-{slug}
# slug: short, lowercase, hyphenated derivation of the issue title
```

For `direct` mode, skip this step. Work on `main`.

### 3. Make the change

Apply the fix or feature. Stay focused on the linked issue. Anti-patterns:

- "While I'm at it" — adding unrelated changes. Split into separate PRs / commits.
- Reformatting unrelated files mid-PR. Send formatting as its own PR.
- Adding new dependencies without justification in the PR body.

### 4. Verification (REQUIRED before commit)

| Check | Command | Pass criterion |
|---|---|---|
| Typecheck | `npx tsc --noEmit` | Clean (no output) |
| Tests | `npm test` | All pass (or only pre-existing flaky perf tests fail; document the latter) |
| Lint | `npm exec markdownlint-cli2` (for docs) | Clean |
| Build | `npm run build:cli` | Succeeds (catches dist/ vs src/ path drift) |

Don't skip these. The recent CI-failure-then-fix cycle in `497fcca7` → `3f2b557b` was caused by skipping the local test run before push.

### 5. Commit message

Use **conventional commits**: `type(scope): subject`

Body should explain **why**, not just **what** — the diff already shows what. Reference the linked issue. For `direct` mode, include `Closes #N` so the issue auto-closes on push.

**No AI attribution.** Rule is universal across platforms. The commit message must not contain:

- `Co-Authored-By: Claude <…>` (or any AI tool)
- `Generated with [Claude Code]` / "Generated by Codex" / "Written by GitHub Copilot"
- 🤖 emoji or any tool branding

The AI is a tool. Tools don't sign their output.

Example commit (per the recent #1261/#1262/#1263 fix):

```
fix(steward,deploy): repair capability matrix loader, schema, and Claude command stubs

Three stacked bugs from the hermes-agent tester report (jmagly#108–#112,
roctinam #1264–#1268) plus filing infrastructure (#1269).

[multi-paragraph why explaining each bug...]

Verification:
- npx tsc --noEmit clean
- npm test — 6306 pass, 1 pre-existing flaky perf test
- Manual: aiwg steward capabilities --provider claude-code now works

Closes #1261
Closes #1262
Closes #1263
```

### 6. Commit, push, and open through configured identities

For `pr-required`, use the runnable delivery step after verification. It commits
already staged changes only when `--commit-message-file` is supplied; otherwise
it ships the current branch commit. The configured `remotes.transport.helper`
receives push arguments and owns the primary remote. Without a helper, ordinary
Git push is used. Failures stop; there is no automatic force push.

```bash
aiwg run skill aiwg-pr -- open --title '<title>' --body-file /tmp/pr-body.md --commit-message-file /tmp/commit-message.txt
```

Use the required output template above, including cause, linked issues, changes,
verification commands and counts, and risk/rollback. `remotes.tracker_actor.credential` selects an existing
sensitive-input reference (`{"store":"tracker-token"}` or
`{"env":"PROJECT_TRACKER_TOKEN"}`). Before every API write, the API user must
match `tracker_actor.login` and must not appear in `forbid_actors`. Tokens stay
inside the HTTP client; never put tokens in argv or PR files.

For `direct` or `feature-branch`, follow the configured push helper and delivery
policy without opening a PR.

### 7. Merge through the configured route

```bash
aiwg run skill aiwg-pr -- merge <number>
# Optional mirror; must be a configured secondary remote permitted by project handling:
aiwg run skill aiwg-pr -- merge <number> --mirror <remote>
```

`delivery.merge` selects `tracker` (the default), `local`, or `local-signed`.
Unsigned projects need no signing setup. Signed local merges are recommended
where repository policy permits them: run `aiwg steward signed-merges` for a
preview and setup instructions, or `--skip` to preserve current settings.
Signing checks run only when commit signing is configured or required; a signed
project must select a local route to verify the actual merge signature.

Local routes require an open PR targeting the default branch, a branch base
with the current main tree, and an unchanged PR head. They verify all branch
signatures and author/committer identities when signing is enabled, create a
`--no-ff` merge in a temporary worktree, require the head and merge trees to
match, verify its signature when enabled, push through the helper, close the
PR, and check the remote default branch equals the local merge. A failure after
push may leave the PR open; inspect remote state before retrying.

### 8. Sync with current main before readiness (#2654)

A PR must never be declared ready to merge from stale branch state. After
push and before any ready-to-merge declaration:

```bash
git fetch origin
"$AIWG_ROOT/tools/git/pr-base-sync.sh" --main-ref origin/main
```

- `status=up-to-date` → proceed: re-run the step 4 verification on this head
  and record the verified head SHA and main SHA in the PR readiness summary.
- `status=behind` → synchronize with the project-approved method (default
  `git rebase origin/main`; use merge/update instead where the project
  requires merge commits or a merge queue — never force a rebase-only
  policy), then re-run the step 4 verification. Readiness must cite the
  post-sync verification, never the pre-sync one.
- `status=conflict` → readiness is blocked. Resolve the conflicts locally,
  re-sync, re-verify, and record the conflicted areas and next steps in the
  PR instead of marking it ready.

Only `ready=true` (up-to-date plus fresh verification) may be reported as
ready to merge. Where PRs do not run CI, the required verification is the
project's local verification; CI status then applies to the post-merge run.

### 9. CI green before done

A commit isn't done until CI is green. After push:

Inspect the latest run on the configured `remotes.ci` tracker. Where PRs do
not run CI, this check applies to the post-merge run on the default branch.

AIWG CI runs ~2 minutes. **Wait for it.** If it fails:

1. Diagnose the failure
2. Fix the underlying issue (no `|| true`, no `continue-on-error: true`, no test deletion — see `anti-laziness` and `dev-pipeline-safety` rules)
3. Commit the fix and wait again
4. Don't declare the work done until green

**Never leave `main` in a red state.**

### 10. After merge (pr-required) or push (direct)

- The linked issue auto-closes via `Closes #N`
- If you imported a cross-tracker report, **thank the original reporter** in a closing comment on the source tracker (the recent jmagly→roctinam imports did this for sebuh-infsol on each of #108–#112)
- Update CHANGELOG.md if user-visible (per the release checklist in CLAUDE.md)

## Anti-patterns to flag

- **AI attribution lines** — never. Universal rule.
- **`--no-verify` or `--no-gpg-sign`** — never bypass hooks. Fix the underlying issue.
- **`continue-on-error: true` on tests** — never silence the smoke detector. See `dev-pipeline-safety`.
- **Skipping CI green wait** — if CI fails, fix it before declaring done.
- **Bundling unrelated changes** — split into focused PRs.
- **Workarounds instead of root-cause fixes** — see `anti-laziness` Rule 9: "real fix over workaround."
- **`Closes #N` in a PR body for `direct` mode** — wrong; use the commit message instead.

## When stuck

If the verification gates fail and you can't fix them in 3 attempts, **escalate** per the `anti-laziness` recovery protocol. Don't take destructive shortcuts (skip tests, weaken assertions, etc.).

## Related

- Skills: `aiwg-issue` (filing issues), `steward-prep-delivery` (interactive walkthrough), `issue-create` (low-level filing), `issue-auto-sync` (commit↔issue linking), `address-issues` (issue-driven loops)
- Template: @$AIWG_ROOT/agentic/code/addons/aiwg-utils/templates/pull-requests/description.md
- Docs: `CONTRIBUTING.md` (full contributor guide)
- Rules: `delivery-policy` (kernel), `no-attribution` (kernel), `anti-laziness`, `dev-pipeline-safety`, `ci-green-before-done`
- Origin: #1269 (templates), #1264–#1268 (tester report sweep that motivated this)
