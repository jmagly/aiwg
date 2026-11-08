---
description: Address selected issues via the address-issues skill (auto-detects the project tracker — gitea/github/local)
category: project-management
argument-hint: "<issue-id...> [--all-open] [--milestone <name> --dispatch workers] [--dry-run] [--limit N] [--guidance \"...\"]"
allowed-tools: Bash, Read, Write, Edit
model: claude-sonnet-5
---

# Address Issues

**This is a skill, not a CLI command.** There is no `aiwg address-issues`
binary. To address one or more issues, load and follow the `address-issues`
skill:

```bash
aiwg show skill address-issues --body   # then follow its instructions
```

The skill auto-detects the project's issue tracker from `remotes.issue_tracker`
in `.aiwg/aiwg.config` (gitea / github / local), runs a threat preflight on each
selected issue, then drives the per-issue agent loop: prioritize → implement →
verify → post issue-thread comments → close out. It works the same way for a
Gitea/GitHub-hosted issue number (e.g. `#1522`) and for a local `LOCAL-####`
id — tracker selection is automatic from config.

Do not try to run `aiwg address-issues <id>` — invoke the skill above and follow
it.

## Related

For a milestone's bounded engineering issues, follow the skill's milestone mode:
`--milestone <name> --dispatch workers`. It covers triage, bounded briefs, Tier 0
dispatch, independent verification, policy-controlled signed delivery, closure,
post-merge CI/fix-forward and cleanup. Add `--dry-run` to print the triage table
and planned dispatch without creating worktrees or launching workers.

- `issue-audit` — read-only backlog triage (`aiwg show skill issue-audit --body`)
- `issue` — local `.aiwg/issues/` storage CLI (`aiwg issue --help`)
- `issue-workflow-guide` — choose and operate project issue workflows
