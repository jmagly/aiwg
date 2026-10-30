---
namespace: aiwg
name: steward-prep-delivery
platforms: [all]
description: Steward-assisted prep for filing issues and PRs — environment capture, template selection, duplicate detection, delivery-policy compliance check
script:
  entrypoint: find-duplicates.sh
  runtime: bash
  cwd: project-root
  argsHint: '<search-terms...>'
---

# Steward Prep for Delivery (#1269)

You are walking the user through filing a high-quality issue or PR, mirroring the import pattern used for the recent jmagly→roctinam tester report sweep (Gitea #1264–#1269).

## When this fires

- "I want to file an issue"
- "I want to open a PR"
- "Help me file a bug report"
- "Should this be a new issue or a comment on an existing one?"
- "Walk me through the import flow for this tester report"

## The walkthrough

### Step 1: Triage

Ask the user: "Is this one bug, or did you find multiple issues in a single session?"

- **One issue** → use `bug-report.md` (or `feature-request.md` if it's a proposal, not a defect)
- **Multiple findings** → use `tester-report.md` and split during triage
- **Already filed elsewhere** (GitHub, Discord, email) → use `imported-report.md`

Don't make this decision for them — surface the templates and let them pick.

### Step 2: Environment capture (for bug reports)

For bug-report.md, the operator needs to fill in environment info. Help them collect it:

```bash
aiwg version
aiwg doctor
node --version
uname -a   # OS / kernel
```

If they're filing on behalf of an agent platform (Claude Code, hermes, Codex, …), make sure the platform name is captured — the same bug can manifest differently across providers.

### Step 3: Duplicate detection (BEFORE filing)

Run the duplicate-detection helper. The skill's `script:` entrypoint
(`find-duplicates.sh`) searches the local `aiwg discover` index plus the Gitea
issue tracker for likely duplicates of the proposed title or keywords:

```bash
aiwg run skill steward-prep-delivery -- "<keywords from the issue title>"
```

Output: ranked list of existing open issues that match. If any look like duplicates, **prefer commenting on them** over filing a new one. If none match, proceed to filing.

### Step 4: Draft assembly

Help the user fill out the chosen template. Specifically:

- For **bug-report.md**: insist on a copy-paste-able repro (not "X seems broken"). Paste exact error text in code blocks.
- For **feature-request.md**: insist on a concrete proposal (interfaces, file paths, command syntax) — not "we should make X better."
- For **tester-report.md**: encourage one finding per section with severity, repro, expected/actual.
- For **imported-report.md**: include the source link, original reporter handle, and platform/environment correction if the source got it wrong (e.g., the jmagly tester report cited Claude Code, but the actual harness was hermes).

### Step 5: Policy compliance check

Before they click "Submit", confirm:

0. **Issue draft policy composition**: before any issue write, invoke the
   `issue-create` composer on the final title/body. Preserve safe drafts,
   follow digest-bound authorization for flagged drafts, create all ordered
   segments for separable policy conflicts, and make no write for blocked
   drafts.

1. **Delivery policy**: read `.aiwg/aiwg.config` `delivery.mode`. If `direct`, the fix will land with `Closes #N` in the commit (no PR). If `pr-required`, they'll need a feature branch. If `feature-branch`, branch only. Tell them what to expect.

2. **No AI attribution**: if they're using an AI tool to help draft, the commit/PR must not include `Co-Authored-By: <AI>` lines or "Generated with" markers. This is the project's no-attribution rule, applied universally.

3. **CI green before done**: a commit isn't done until CI passes. Remind them to wait for the run on Gitea, and if it fails, fix it before declaring resolution.

### Step 6: Submit and follow up

For Gitea issues, use:

```
aiwg run skill issue-create -- "<title>" --provider gitea --labels "bug"
```

(Or invoke the relevant template manually via the Gitea web UI — both are fine.)

For PRs that close issues, ensure the body contains `Closes #N` (or `Refs #N` if it doesn't fully close).

## Anti-patterns to flag

- **"While I'm at it"** — if the user starts adding unrelated changes during issue/PR drafting, split into separate tickets. One bug per issue, one concern per PR.
- **Vague titles** — "doesn't work" or "broken" titles get bumped back; insist on `type(scope): subject` form (e.g., `bug(steward): path resolution lands at dist/`).
- **Missing environment** — bug reports without OS/version/platform get clarified before action. Don't let them slip through.
- **Re-filing duplicates** — always run the duplicate-detection helper first. Comments on existing issues are cheaper than fresh issues.

## Related skills

- `issue-create` — the actual filing surface (Gitea, GitHub, Jira, Linear, local)
- `issue-auto-sync` — detects commit ↔ issue links automatically
- `address-issues` — runs issue-driven agent loops to close issues with code

## References

- `CONTRIBUTING.md` — full contributor guide
- `.gitea/ISSUE_TEMPLATE/` — issue templates
- `.gitea/pull_request_template.md` — PR template
- `agentic/code/addons/aiwg-utils/rules/delivery-policy.md` — delivery mode rule
- `agentic/code/addons/aiwg-utils/rules/no-attribution.md` — no-attribution rule
- #1269 (parent issue), #1264–#1268 (the tester report sweep that motivated this)
