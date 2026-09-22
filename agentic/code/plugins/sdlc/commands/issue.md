---
description: Operate local file-system issues under .aiwg/issues/
category: project-management
argument-hint: "init|new|list|show|comment|close|index rebuild [options]"
allowed-tools: Bash, Read, Write
model: claude-sonnet-5
---

# Issue

Operate local project issues through the AIWG CLI.

Use this command only when project issue tracking is configured for local issue
storage. External tracker issues are resolved through `.aiwg/aiwg.config`
`remotes.issue_tracker` and the matching Gitea/GitHub tooling.

## Usage

```bash
aiwg issue init --prefix PROJECT
aiwg issue new --title "Fix navigation" --body-file issue.md
aiwg issue list --status open --limit 20
aiwg issue show PROJECT-0001 --comments last:10
aiwg issue comment PROJECT-0001 --body-file comment.md
aiwg issue close PROJECT-0001 --reason "Fixed"
aiwg issue index rebuild
```

## Related

- `issue-audit` — audit issue backlogs
- `address-issues` — implement issue fixes
- `issue-workflow-guide` — choose and operate project issue workflows
