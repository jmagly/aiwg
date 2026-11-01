---
title: "AIWG - October 2026 Report"
slug: "2026-10-aiwg-october-2026-report"
date: "2026-10-31"
project: "AIWG"
type: report
tags: [report, "2026-10", aiwg]
summary: "October brought shared project context, checked worker handoffs, fuller session records, and new ways to review memory, small decisions, and research sources."
hero: "https://docs.aiwg.io/assets/blog/2026-10-aiwg-october-2026-report.png"
hero_alt: "Screenprint illustration in rust, ochre and slate: an open ring binder of project notes sends four colored paths, each through a small checkpoint gate, to four different tool windows, with autumn leaves and hills behind."
status: "scheduled"
canonical: "https://aiwg.io/blog/2026-10-aiwg-october-2026-report"
publish_at: "2026-11-01T12:00:00Z"
scheduled_assets: ["blog/2026-10-aiwg-october-2026-report.png"]
---

# AIWG — October 2026

*October gave AIWG projects one shared framework-context file, checks before starting helper workers, and records of what each deploy wrote. Framework removal uses those records to preserve your edits.*

## TL;DR

October brought a guided setup and a shared home for project context. Worker checks now explain which model settings a tool can set and whether the host has room to start more work. Session tools gained live viewing, broader imports, and ways to rebuild history without losing older records. Memory review and research lookup now have clear preview and review steps. Jev, an external decision service, receives question text for small decisions after you opt in. The wider decision studies remain experimental and off by default.

## At a glance

| What's public | Value |
|---|---|
| Stable provider milestone | Muse Code in `2026.10.0`; verified on Linux only; macOS and Windows/WSL checks waived |
| Memory workflow | Audit, plan, apply, verify, restore |
| Research commands | `corpus resolve`, `corpus expand`, `corpus review` |

## Highlights

**1. Project notes have one shared home.** When you switch coding tools, the project rules should still point to the same source. By 2026.10.16, root `AIWG.md` holds the shared framework context. `WORKSPACE.md` holds project notes, and the short `AGENTS.md` points tools to both files. Extra notes in `.aiwg/AIWG.md` are folded into the root file.

Setup follows how each tool reads rules. Claude and Cursor have native rule loaders. Codex, Muse, and Hermes have no automatic loader; their startup files tell the assistant to read a rules folder.

**2. Worker checks cover the launch and the host.** `aiwg doctor --probe-workers --qualify` checks the installed worker tools before you hand off a task. `aiwg models resolve` can then produce the launch command within the chosen rules. Per-task limits can reduce attempts, time, output, or spend; they cannot raise those limits.

The later `aiwg doctor --resources` check reports load, memory, disk space, and running workers. The launch is blocked when no slots remain. Model reports show which settings are fixed for each worker and which come from the parent or the whole tool.

**3. Session history survives more of the way you work.** You may start a chat in a nested folder, then move to a linked worktree—a separate checkout of the same project. That folder may be gone by the time you need the chat again. October fixed how those chats are filed under their workspace. A session catalog—the saved list of chats—can be rebuilt with records from the old one. Those records pass through the current secret-removal rules.

For work still in progress, `aiwg sessions tail --follow` gives a read-only view where the coding tool has a native stream. Grok Bot, the desktop chat app, now keeps chats once in a host catalog, with links from each workspace. Shared chats no longer need a copy in each workspace. Hermes also gained native session discovery through a read-only database snapshot in 2026.10.12.

**4. Jev setup connects small decisions to an external service.** Version 2026.10.1 shipped setup and `aiwg decision ask` for yes/no answers, fixed choices, and scores. The service receives the question text. Offload stays off until enabled; setup stores a token and records the opt-in, with `decision.enabled` added in 2026.10.4. If setup is missing, a call fails, or confidence is too low, the assistant makes the choice as usual.

Later releases added repeated passes, checks on whether answers agree, and offline history and stats. You can inspect how calls ended and where fallback occurred. You still need to check whether the answer was right. The decision studies that test broader uses remain experimental and off by default.

**5. Memory cleanup starts with a review.** A note may see little use because it covers a rare fault. Low use alone is a poor reason to drop it. The 2026.10.6 memory tools show what supports a change and what is still unclear through `audit`, `cost`, and `recommend`. You can review a plan, apply it, verify the result, and restore the prior state.

Cleanup protects pinned notes and rules for rare cases. After a change, the tools name stale copies in each tool's context and give the command to rebuild them. You choose when to run that step.

**6. Paper lookup accepts partial references.** The new `aiwg corpus resolve` checks source services for a title, URL, or paper ID and flags unclear matches. If a network call fails and leaves the match unclear, you can retry later.

To explore a set of papers, `corpus expand` finds related papers within a chosen scope. It shows a preview by default. `corpus review` lets you accept, reject, or defer a candidate, and can prepare a brief for adding it. An accepted match still needs to go through the steps to add the paper. The lookup can still merge distinct works with the same title, nearby years, and a shared author.

**7. Framework removal preserves edits.** Version 2026.10.18 records what each deploy wrote. `aiwg remove <framework>` uses those records to keep edited, shared, or untracked files and report them. Settings and hooks are restored only where the records show they are still owned by that framework. A dry run shows which files removal will keep.

## Features shipped

**Setup and discovery.** Guided setup, shipped in 2026.10.6, moves through an interview, review, and apply flow. It can resume without redoing steps that worked.

Search results now include the rules for a found skill or agent. `aiwg show` starts with a compact card; `--body` reads the full text and `--section` reads one part. Read the text before you follow the workflow.

A synced skill can no longer silently replace a managed skill of the same name. Deployment blocks conflicts from a lower-priority source and preserves operator files.

**Providers and worker roles.** Muse Code reached stable support in 2026.10.0, based on Linux checks with Muse Code 1.4.2. Checks on macOS and Windows/WSL were waived. Later releases added qualified direct Muse worker dispatch. Explorer and verifier roles now cover read-only work, with short returns that state the checks, proof, and result. You must choose to use flagship models.

From 2026.10.16, `aiwg use --provider claude` clears Claude Code's commit and pull-request attribution by default, including session links. It merges `attribution: {commit: "", pr: "", sessionUrl: false}` into settings. Existing non-empty text or enabled session links are kept with warnings. `--no-attribution` skips this settings change. In 2026.10.18, the rule that tells assistants not to add attribution became a core rule. It now reaches every project in every deploy mode and provider, and `aiwg doctor` reports it.

**Human approval.** Project approval profiles let you preview and turn on narrow rules for routine tasks. Workflows consult those rules before prompting. Denied actions stay denied, and platform prompts still apply. Secrets, destructive actions, production actions, and policy overrides cannot be approved in advance. In Pi, native edit/write tools bind approval to the actor and exact input only when the human approval policy is enabled. Changed input needs a new check. Bash gating is unchanged.

**Tool connections.** The Model Context Protocol (MCP) connects assistants to tools and data. October added layered MCP config and profiles that extend a base profile. Tool filters now reach each supported tool's config, with warnings where that tool cannot express a filter. For example, Claude supports tool denies but cannot express AIWG's restrict-only allowlist through its allow rules.

The covered commands can take keys through masked entry, piped input, private files, or a named secret store. They can also read a named environment variable. A reference stores the key's location so the runtime can read it when needed. If the chosen source fails, the call stops. AIWG's own runtime can read file and store references. Native tool config writers need supported environment references.

**Maintenance and evaluation.** The opt-in housekeeper can run index checks, cache cleanup, and update checks on a schedule. It does not install updates by default. If you opt in, it checks the allowed time, version rules, active work, and setup state. Linux user services are supported; macOS support is best-effort, and Windows is unsupported.

The experimental, default-off gates system packages rules for pass, hold, and rollback with their proof. It now shows which rules have checks and ships a pack for tests that fail from run to run. Broader decision pilots still need live evidence and human review; shipped offline tools do not prove that these uses are ready for live work.

## Fixes

Claude project MCP servers now go to `.mcp.json`, where Claude Code reads them. The old path left those servers unloaded. Codex skill deployment now copies the whole skill folder, including assets. Updates follow the installed bundle list in `aiwg.config` instead of stale legacy entries.

Session fixes cover Pi import checkpoints, Codex fork identities, and Muse logs that were skipped after an early record limit. The VS Code sidebar now refreshes when project config changes, and its setup prompt recognizes an initialized project.

A first `aiwg use sdlc` now keeps the framework's rules; before 2026.10.19 a second run was needed. Paper lookup now separates a preprint and its published version, a year apart, from two different works. A year difference without supporting evidence is flagged for review.

## Performance & reliability

Index preparation now uses child processes and retries unfinished work serially if the pool fails. Large files take the serial path. Unchanged index builds avoid repeated scans and output writes.

Some setup steps can run within one process. Session imports stream records within set limits, and repeated tool-output images are stored once by content hash.

## Breaking changes & migrations

Scripts that read full text from `aiwg show` must add `--body`. Zod is the library AIWG uses to check data shapes. Code that imports AIWG schemas must use Zod 4's interface after the change in 2026.10.6.

After upgrading, re-run `aiwg models resolve` for saved launch plans and requalify existing worker installation records. Old unsigned approvals also need a signing key. Initialize the selected key provider with `aiwg effect keys init`, then run `aiwg doctor --probe-workers --qualify`. Repeat the check when you change accounts; approval binds a set account label.

Secret-input commands now need an explicit source when no terminal is attached. Piping a key also requires that command's stdin flag. Jev setup needs `--token-env JEV_API_KEY` for environment input. With no source flags, `aiwg mcp profile login` now prompts for a hidden key instead of starting OAuth browser sign-in.

Legacy executors must supply `AIWG_EXECUTOR_TOKEN` once to establish the private restart cache.

Claude project MCP injection now refuses literal environment or header values and credentials embedded in URLs. Use supported environment references for `.mcp.json`; private user-scope config is another option.

Private key files must be regular files that you own, with access closed to other users. Symlinks and extra hard links—alternate paths to a file—are refused. Replace linked or exposed files before using the updated loaders. Windows file input is blocked where native access checks are not yet in place; use a supported input or store route.

Fresh session imports are needed to remove Codex fork duplicates already stored. Grok Build's experimental native session reads are now off by default behind explicit opt-in; documented export remains available.

## Releases

- **2026.10.0** (Oct 2) — Muse Code stable, verified on Linux only; macOS and Windows/WSL checks waived. Gates and decision studies remain experimental and off by default.
- **2026.10.1** (Oct 5) — Turnkey Jev decision offload.
- **2026.10.3** (Oct 14) — Bounded command runs, MCP profiles, and session repairs; includes the unpublished 2026.10.2 changes.
- **2026.10.4** (Oct 21) — Rule discovery, decision checks, session limits, and index refresh.
- **2026.10.5** (Oct 21) — Session history carry-forward and index worker recovery.
- **2026.10.6** (Oct 25) — Guided setup, memory review, housekeeper, and managed orchestration pilot.
- **2026.10.7** (Oct 26) — Shared credential inputs, signed worker checks, and deploy rollback.
- **2026.10.8** (Oct 26) — MCP secret references and decision-history rotation.
- **2026.10.9** (Oct 26) — Credential references for resources, daemon, and storage.
- **2026.10.10** (Oct 27) — Worker group choices, policy review, and handoff repairs.
- **2026.10.11** (Oct 28) — Shared Grok Bot history, stored image references, and worker context.
- **2026.10.12** (Oct 28) — Live session viewing, Hermes native discovery, project approval profiles, and task limits.
- **2026.10.14** (Oct 28) — Approval-aware workflows, explorer and verifier roles, and model controls.
- **2026.10.15** (Oct 29) — Paper lookup, research expansion, and shorter startup files.
- **2026.10.16** (Oct 30) — Resource checks, research review, and one generated framework-context file.
- **2026.10.18** (Oct 30) — Recorded deploy ownership, removal repairs, and resource freshness checks; includes the 2026.10.17 changes, which were tagged but not published.
- **2026.10.19** (Oct 31) — Rules kept on first deploy and paper-year checks.

## Dependencies & security

October patched the MCP support library, body-parser, Vite, and other affected dependencies. The server update in 2026.10.15 fixes double decoding of static-file paths. AIWG moved its schemas to Zod 4, while Fortemi's nested Zod 3 copy still needs an upstream release.

Session imports remove detected credentials before storing or indexing them. MCP config writers refuse malformed registries and unsafe paths. These are checks on supported inputs and paths; artifact file access is not a sandbox against another local process running as the same user.

## Docs & DX

Guides at [docs.aiwg.io](https://docs.aiwg.io) now lead with example requests and the response to expect. Command references follow the task. Worker guides include a bounded brief, model choices, review expectations, and approval limits. Session docs walk through Claude export intake and the path to a Fortemi archive.

## Tests & CI

Continuous integration (CI) now checks packaged imports, deploy ownership, rule discovery, and extension lifecycle behavior. Process tests wait for observed state in place of fragile timers. Release recovery retains package bytes for signing retries, and package audits wait for the exact version to become visible in the registry.

## Cross-project impact

Fortemi session checks now test the path from import through export, verification, and recovery against a pinned consumer. Knowledge Shard 2.2.0 support preserves added fields in the `full-v1` profile. That support targets an unreleased Fortemi candidate contract; other profiles refuse it. It does not mean Fortemi 2.2.0 shipped.

## Known issues & open threads

Managed orchestration remains a pilot, with limits on how it separates tasks run by the same user. It needs more checks before general release. Grok Build remains experimental. Its native session access requires explicit opt-in.

Paper lookup can still merge distinct works with the same title, a nearby year, and one author. Review those matches before adding them. The experimental, default-off decision studies still lack live evidence and human review for broader claims.

## What's next

Azure identity fixes remain deferred under the release-age policy and become eligible on November 5. Fortemi's nested Zod 3 copy needs an upstream release on Zod 4. Both dependency updates remain open. We will keep improving AIWG's provider integrations in coming releases.

## Appendix

- **Managed packages:** `aiwg`, `@aiwg/cli`, `@aiwg/cockpit`.
- **Public repository:** [github.com/jmagly/aiwg](https://github.com/jmagly/aiwg).
- **Release notes:** [GitHub releases](https://github.com/jmagly/aiwg/releases).
- **Public changelog:** [CHANGELOG.md](https://github.com/jmagly/aiwg/blob/main/CHANGELOG.md).
- **Docs:** [docs.aiwg.io](https://docs.aiwg.io).
- **npm:** [aiwg](https://www.npmjs.com/package/aiwg), [@aiwg/cli](https://www.npmjs.com/package/@aiwg/cli), [@aiwg/cockpit](https://www.npmjs.com/package/@aiwg/cockpit).
- **Window:** October 1–31, 2026.
