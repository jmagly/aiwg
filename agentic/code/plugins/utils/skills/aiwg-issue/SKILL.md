---
namespace: aiwg
name: aiwg-issue
platforms: [all]
kernel: true
description: AIWG project issue filing only — templates, environment capture, duplicate detection, and import flow for AIWG tracker reports; not for general issue audits or address-issues processing
triggers:
  - file an AIWG issue
  - report an AIWG bug
  - import this AIWG issue from GitHub
  - I want to file an issue
  - How do I report a bug?
  - Help me write up a bug report
  - What template should I use?
  - Should I file a new issue or comment on an existing one?
  - Import this report from GitHub
  - Import this report from Discord
  - Import this report from email
---

# Filing AIWG Issues

You are helping a user (or yourself, as an autonomous agent) file a high-quality issue. The bar is set by the recent tester-report import sweep (Gitea #1264–#1269): environment captured, exact commands, error text in code blocks, suggested fix paths.

This is an **AIWG-specific kernel capability**. Use it for filing, importing, or triaging the quality of issue reports about AIWG itself.

Do **not** use this skill for general backlog processing:

- Use `issue-audit` / `audit-issues` when the user asks to audit open issues, triage a backlog, find duplicates, review stale issues, or rank work.
- Use `address-issues` when the user asks to fix, process, or work through issues.
- Treat `aiwg-*` skill names as AIWG product/workspace capabilities, not as the generic issue-processing surface.

## When this fires

Natural-language triggers:

- "file an AIWG issue"
- "report an AIWG bug"
- "import this AIWG issue from GitHub"
- "I want to file an issue"
- "How do I report a bug?"
- "Help me write up a bug report"
- "What template should I use?"
- "Should I file a new issue or comment on an existing one?"
- "Import this report from GitHub" / "from Discord" / "from email"

Non-triggers:

- "audit open issues"
- "triage the issue backlog"
- "review stale issues"
- "address issues"
- "process open issues"

## Output template

The selected template is required. Fill every required section before filing;
mark non-applicable optional fields with a reason and remove template instructions.

### Template selection

| Template | When to use | Path |
|---|---|---|
| `bug-report.md` | One concrete defect with a reproduction | @$AIWG_ROOT/agentic/code/addons/aiwg-utils/templates/issues/bug-report.md |
| `feature-request.md` | A new capability or enhancement proposal | @$AIWG_ROOT/agentic/code/addons/aiwg-utils/templates/issues/feature-request.md |
| `tester-report.md` | A single session that surfaced multiple findings | @$AIWG_ROOT/agentic/code/addons/aiwg-utils/templates/issues/tester-report.md |
| `imported-report.md` | Mirroring an issue filed in a different tracker | @$AIWG_ROOT/agentic/code/addons/aiwg-utils/templates/issues/imported-report.md |

These bundle templates are canonical. The repository `.gitea/ISSUE_TEMPLATE/` and
`.github/ISSUE_TEMPLATE/` files are derived copies maintained by `npm run package-plugins`.

Compose through `issue-create` with `--template <kind|path>` matching the selected
template (default: `bug-report`). Missing required headings produce an advisory
stderr warning; the composer remains headless-safe.

## The walkthrough

### 1. Triage first

Ask: is this one bug, or multiple findings from a single session?

- **One issue** → `bug-report.md` or `feature-request.md`
- **Multiple findings** → `tester-report.md`, split into discrete bugs during follow-up triage
- **Already filed elsewhere** → `imported-report.md`

**One bug per issue.** If three things broke, file three issues (or one tester-report and split). Don't bundle.

### 2. Duplicate detection (BEFORE filing)

Always check for duplicates first. Cheaper to comment on an existing thread than file again. Use:

```bash
aiwg discover "<keywords from the proposed title>"
```

Then search the tracker for matching titles. The `steward-prep-delivery` skill bundles both lookups into one command:

```bash
aiwg run skill steward-prep-delivery -- "<search terms>"
```

If a likely duplicate exists, comment on it rather than filing fresh.

### 3. Environment capture (REQUIRED — three non-negotiable fields)

Bug reports without **AIWG version + operating system + provider** are bounced before triage. Collect ALL of these:

```bash
aiwg version           # → AIWG version + channel (REQUIRED)
uname -a               # → operating system + kernel (REQUIRED)
node --version         # → Node version
aiwg doctor            # workspace health snapshot (helpful)
```

And — also required — the **provider** (the AIWG harness in use): one of
`claude-code`, `codex`, `copilot`, `cursor`, `factory`, `hermes`, `opencode`,
`openclaw`, `openhuman`, `omp`, `pi`, `warp`, or `windsurf`.

When you (the agent) draft a bug report on behalf of a user, **ask explicitly for each of the three required fields** if they aren't already in the conversation. Don't infer. The May-2026 jmagly→roctinam import sweep needed a correction round because the original GitHub report cited "Claude Code 2.1.137" but the actual harness in use was hermes — same bug, different behavior, wasted half a round-trip to clarify. Don't repeat that.

The bug-report template has a checklist that enforces this; surface it before the operator submits.

### 4. Reproducible repro

Paste **exact** commands (copy-paste-ready, no `<placeholder>`s without explicit substitution instructions) and **exact** error text in fenced code blocks. Paraphrased errors lose detail.

Bad:
> "When I run the steward command it errors out"

Good:
> ```
> $ aiwg steward capabilities --provider claude-code
> ERROR ENOENT: no such file or directory, open '/home/linuxbrew/.linuxbrew/lib/node_modules/aiwg/dist/agentic/code/providers/capability-matrix.yaml'
> ```

### 5. Title format

`type(scope): one-line summary`. Examples:

- `bug(steward): AIWG_ROOT path resolution lands at dist/ instead of package root`
- `feat(contributing): consistent PR + Issue templates`
- `regression: Skill Seekers implementation lost`
- `imported: <original title> (<source>#<number>)` for imports

Vague titles ("doesn't work", "broken") get bumped back. Insist on the typed form.

### 6. Suggested fix (if you've investigated)

If you've already traced the bug, point at the file or line. "I think this is in `src/cli/handlers/steward.ts:26`" is faster than a round-trip. This is optional but valued — the recent #1261/#1262/#1263 imports landed faster because the original reporter included file-line pointers.

### 7. Acceptance criteria

Bug reports should include checkable acceptance:

```markdown
- [ ] Repro from "Steps to reproduce" no longer fails
- [ ] Regression test added (if the bug bypassed existing tests)
- [ ] Related docs updated (if behavior was documented incorrectly)
```

Feature requests need concrete, checkable conditions — not "works well" or "feels right".

## Import flow (cross-tracker reports)

When a report lands in a different tracker (GitHub mirror, Discord, email, vendor support), mirror to Gitea as `imported-report.md`:

1. Title: `imported: <original title> (<source>#<number>)`
2. Link the source URL
3. Preserve the **original reporter handle** and **platform/environment** (correct it if the source got it wrong)
4. Add a "Status against current main" table
5. Cross-reference any local issues that duplicate or overlap
6. If already fixed: note the resolving commit and close as duplicate
7. **Thank the original reporter** in a closing comment when the work lands

Example: jmagly#108–#112 → roctinam #1264–#1268 sweep (May 2026).

## Filing

### Mapped control workspaces

From a mapped `/srv/*-workspace`, resolve the target member from
`config/repository-routing.yaml` `workTracker` and the workspace access manifest
before duplicate detection or filing. Check the member's `read` permission for
queries and `issue-comment` permission for tracker writes. Load that member's
`.aiwg/aiwg.config`: its `remotes.issue_tracker`, `remotes.issue_provider`, and
`remotes.tracker_actor.login` / `credential` govern the request. Never substitute
the control workspace's remotes or the current default forge login.

Go straight to that member's tracker through the configured tracker tools;
local issue initialization in the control workspace is unnecessary. For the
native create command, run it from the authorized member directory so it reads
the member config. The CLI does not interpret `repository-routing.yaml` itself.
Follow `issue-create` composition and authorization before writing.

`aiwg issues list` queries local storage only; it refuses a configured external
tracker unless `--provider local` is explicit. Search the member's external
tracker with its tracker tools instead. A failed query (including missing init
or HTTP 401) is a blocker to duplicate detection, never an empty result.

Before any MCP, CLI, API, or web-UI write, discover and load the
`issue-create` skill, then route the final title/body through its policy
composition. Use the returned segment bodies exactly;
obtain digest-bound authorization when requested, and make no write for a
`blocked` plan. This prevents authoring an issue that the address workflow will
reject under the same project policy.

```bash
aiwg run skill issue-create -- plan --title '<title>' --body-file /tmp/issue.md
# After reviewing the plan and any required digest-bound authorization:
aiwg issues create --title '<title>' --body-file /tmp/issue.md
aiwg issues comment <number> --body-file /tmp/comment.md
aiwg issues close <number>
```

These writes use the configured external tracker (`remotes.issue_tracker` and
`issue_provider`). Local-only projects retain local issue storage; use
`--provider local` to select it explicitly. Multi-segment composition and
`--authorize-policy <digest>` use the same policy plan as `issue-create`.

Configure `remotes.tracker_actor.credential` with an existing sensitive-input
reference: `{"store":"tracker-token"}` or `{"env":"PROJECT_TRACKER_TOKEN"}`.
The HTTP client checks `/user` before every write, requires
`tracker_actor.login` to match, and refuses `forbid_actors`. Configured
credentials cannot be overridden with token flags. No token belongs in argv,
logs, or issue bodies. Projects without an actor credential retain provider
environment token discovery. PR delivery uses the same actor via `aiwg-pr`.

For a missing or rejected actor token, save a token belonging to the configured
`tracker_actor.login` with `aiwg auth secret set <name> --value-stdin`, then set
the member's `remotes.tracker_actor.credential` to `{"store":"<name>"}`. An env
reference works when its named variable is supplied. Refresh an existing
reference when configured; never switch to a different actor to bypass a 401.

## After filing

- Add labels (priority, area, type) per the `ops-issue-tracking` rule conventions
- Link related issues with `Refs #N` / `Blocked-by: #N` / `Blocks: #N` in the body
- Watch the thread for triage comments and answer promptly

## Anti-patterns to flag

- **"While I'm at it"** — adding unrelated changes to a bug report. Split into separate issues.
- **Bundling fixes into the report** — if you have a fix, file the issue first, then submit the PR with `Closes #N`. Don't mix.
- **Re-filing duplicates** — always run duplicate detection first.
- **Vague titles** — `type(scope): subject` form is required.
- **Missing environment** — bug reports without OS/version/platform get clarified before action.

## Related

- Skills: `aiwg-pr` (filing PRs), `steward-prep-delivery` (interactive walkthrough), `issue-create` (low-level filing), `issue-auto-sync` (commit↔issue linking)
- Templates: required canonical bundle paths in "Output template" above
- Docs: `CONTRIBUTING.md` (full contributor guide)
- Rules: `delivery-policy`, `no-attribution`, `ops-issue-tracking`
- Origin: #1269 (templates), #1264–#1268 (tester report sweep that motivated this)
