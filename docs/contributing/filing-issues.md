# Filing Issues

> **Related**: [filing pull requests](./filing-pull-requests.md), [the import flow](#import-flow-cross-tracker-reports), AIWG-specific kernel skill `aiwg-issue` (run `aiwg show skill aiwg-issue`)

A high-quality issue is scoped, reproducible, and captures environment. The bar is set by the May-2026 tester-report sweep — five issues filed by `sebuh-infsol` on the GitHub mirror that mirrored cleanly into Gitea (#1264–#1268) and resolved in days because each one had exact commands, exact error text, and a hypothesis.

This guide makes that the default, not the exception.

---

## Pick the right template

Templates live in [`.gitea/ISSUE_TEMPLATE/`](https://git.integrolabs.net/roctinam/aiwg/src/branch/main/.gitea/ISSUE_TEMPLATE/) and are mirrored to [`.github/ISSUE_TEMPLATE/`](https://github.com/jmagly/aiwg/blob/main/.github/ISSUE_TEMPLATE/). Same content, different tracker.

| Template | When to use |
|---|---|
| [`bug-report.md`](https://git.integrolabs.net/roctinam/aiwg/src/branch/main/.gitea/ISSUE_TEMPLATE/bug-report.md) | One concrete defect with a reproduction |
| [`feature-request.md`](https://git.integrolabs.net/roctinam/aiwg/src/branch/main/.gitea/ISSUE_TEMPLATE/feature-request.md) | A new capability or enhancement proposal |
| [`tester-report.md`](https://git.integrolabs.net/roctinam/aiwg/src/branch/main/.gitea/ISSUE_TEMPLATE/tester-report.md) | A single session that surfaced multiple findings — split during triage |
| [`imported-report.md`](https://git.integrolabs.net/roctinam/aiwg/src/branch/main/.gitea/ISSUE_TEMPLATE/imported-report.md) | Mirroring an issue filed in a different tracker |

**One bug per issue.** If you found three things, file three issues (or one tester-report and split). Don't bundle.

---

## Before you file: duplicate detection

Always check for duplicates first. Commenting on an existing thread is cheaper than filing fresh.

```bash
# Search the AIWG capability index (skills, agents, rules, commands)
aiwg discover "<keywords from the proposed title>"

# Search the AIWG capability index + Gitea issues in one shot
aiwg run skill steward-prep-delivery -- "<search terms>"
```

The `steward-prep-delivery` skill bundles both lookups and gracefully degrades when no Gitea token is configured (it just skips the live issue search).

---

## Required content

Every bug report must include:

### Environment (REQUIRED — three fields are non-negotiable)

Every bug report **must** include these three, copy-pasted verbatim, not paraphrased:

```bash
aiwg version           # → AIWG version + channel (REQUIRED)
uname -a               # → operating system + kernel (REQUIRED)
node --version         # → Node version
aiwg doctor            # workspace health snapshot (helpful)
```

And — also required — the **provider** (the AIWG harness you were running): one
of `claude-code`, `codex`, `copilot`, `cursor`, `factory`, `hermes`, `opencode`,
`openclaw`, `grokbot`, `openhuman`, `omp`, `pi`, `warp`, or `windsurf`.

> **Why these three (AIWG version + OS + provider) are non-negotiable:**
> - **AIWG version**: a bug you're hitting may already be fixed in `main` but not yet in the version you installed. Without the version, the first triage step is asking you for it.
> - **Operating system**: the same bug behaves differently across Linux kernel versions, macOS, and Windows. Path resolution, permission semantics, shell behavior all diverge.
> - **Provider**: Claude Code's slash-command path is not Hermes's is not Codex's. The May-2026 tester-report import sweep needed a correction round because the original GitHub report cited "Claude Code 2.1.137" but the actual harness in use was hermes — the slash-command churn behavior the tester observed only happens on hermes (Claude Code's deployed command stubs route to the deterministic CLI). Get this right the first time.

Bug reports missing any of these three will be returned for clarification before any triage work begins. The bug-report template checklist enforces this.

### Reproducible repro

Paste **exact** commands (no `<placeholder>`s without explicit substitution instructions) and **exact** error text in fenced code blocks.

Bad:
> "When I run the steward command it errors out"

Good:
> ```
> $ aiwg steward capabilities --provider claude-code
> ERROR ENOENT: no such file or directory, open '/home/linuxbrew/.linuxbrew/lib/node_modules/aiwg/dist/agentic/code/providers/capability-matrix.yaml'
> ```

### Title format

`type(scope): one-line summary`. Examples:

- `bug(steward): AIWG_ROOT path resolution lands at dist/ instead of package root`
- `feat(contributing): consistent PR + Issue templates`
- `regression: Skill Seekers implementation lost`
- `imported: <original title> (<source>#<number>)` for imports

Vague titles ("doesn't work", "broken") get bumped back.

### Acceptance criteria

Concrete, checkable conditions. Not "works well" or "feels right".

```markdown
- [ ] Repro from "Steps to reproduce" no longer fails
- [ ] Regression test added (if the bug bypassed existing tests)
- [ ] Related docs updated (if behavior was documented incorrectly)
```

### Suggested fix (optional but valued)

If you've already investigated, point at the file or line. `src/cli/handlers/steward.ts:26` is faster than a round-trip. The recent #1261/#1262/#1263 imports landed in one day because the original reporter included file-line pointers.

---

## Import flow (cross-tracker reports)

When a report lands in a different tracker (GitHub mirror, Discord, email, vendor support), mirror it into Gitea using the `imported-report.md` template. The process:

1. **Title**: `imported: <original title> (<source>#<number>)`
2. **Preserve the original reporter handle** (e.g., `@sebuh-infsol`)
3. **Correct the platform/environment** if the source got it wrong (verify which AIWG harness was actually in use)
4. **Add a "Status against current main" table**: which sub-bugs are already fixed, which are open, which need to be split
5. **Cross-reference** any local issues that duplicate or overlap
6. **Thank the original reporter** in a closing comment on the source tracker when the work lands

Example sweep: jmagly#108–#112 → roctinam #1264–#1268 (May 2026). Closed #1265 immediately as duplicate of already-fixed work; closed the others after the fix commits landed; posted thank-you comments on all five GitHub issues citing the resolving commits.

---

## Filing

Three paths, all valid:

```bash
# 1. Via discovery, then the issue-create skill (handles Gitea, GitHub, Jira, Linear, local files)
aiwg discover "issue create" --type skill
aiwg show skill issue-create
aiwg run skill issue-create -- "<title>" --provider gitea --labels "bug"

# 2. Via the Gitea MCP server (when available)
mcp__git-gitea__issue_write method=create owner=roctinam repo=aiwg title='<title>' body='<full body>'

# 3. Via the tracker's web UI with the template pre-loaded
```

---

## After filing

- Add the right labels (priority, area, type). The `ops-issue-tracking` rule covers conventions when the issue lives in the ops repos; for AIWG, match labels used on adjacent issues.
- Link related issues with `Refs #N` / `Blocked-by: #N` / `Blocks: #N` in the body.
- Watch the thread for triage comments and answer promptly.

---

## Anti-patterns to avoid

- **"While I'm at it"** — adding unrelated changes to a bug report. Split.
- **Bundling fixes into the report** — file the issue first, then submit the PR with `Closes #N`. Don't mix.
- **Re-filing duplicates** — always run duplicate detection first.
- **Vague titles** — `type(scope): subject` is required.
- **Missing environment** — bug reports without OS/version/platform get clarified before action.

---

## Quick reference

| Need to | Run |
|---|---|
| Find existing skills/issues for a topic | `aiwg discover "<keywords>"` |
| Bundle discover + tracker search | `aiwg run skill steward-prep-delivery -- "<terms>"` |
| Fetch a skill body | `aiwg show skill aiwg-issue` |
| File a new issue (skill-mediated) | `aiwg discover "issue create" --type skill`, then `aiwg show skill issue-create` |
| Read the full kernel skill | `aiwg show skill aiwg-issue` |

## Related

- **In-context kernel skill**: `aiwg-issue` (always loaded for AIWG issue filing/import hygiene; same content as this doc, accessible to agents without reading docs/)

For general issue backlog processing, use `issue-audit` / `audit-issues` for read-only audit and triage, or `address-issues` for implementation loops. `aiwg-*` capabilities are AIWG product/workspace capabilities, not the generic issue-processing surface.
- **PR companion**: [filing pull requests](./filing-pull-requests.md)
- **Templates**: [`.gitea/ISSUE_TEMPLATE/`](https://git.integrolabs.net/roctinam/aiwg/src/branch/main/.gitea/ISSUE_TEMPLATE/), [`.github/ISSUE_TEMPLATE/`](https://github.com/jmagly/aiwg/blob/main/.github/ISSUE_TEMPLATE/)
- **Rules**: [`delivery-policy`](https://github.com/jmagly/aiwg/blob/main/agentic/code/addons/aiwg-utils/rules/delivery-policy.md), [`no-attribution`](https://github.com/jmagly/aiwg/blob/main/agentic/code/frameworks/sdlc-complete/rules/no-attribution.md), [`ops-issue-tracking`](https://github.com/jmagly/aiwg/blob/main/agentic/code/frameworks/ops-complete/rules/ops-issue-tracking.md)
- **Origin**: #1269 (templates infrastructure), #1264–#1268 (tester report sweep that codified this pattern)
