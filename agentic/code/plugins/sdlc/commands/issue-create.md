---
description: Create a local issue under .aiwg/issues/
category: project-management
argument-hint: "--title \"...\" [--body \"...\"] [--body-file path] [--provider local]"
allowed-tools: Bash, Read, Write
model: claude-sonnet-5
---

# Issue Create

Create a local project issue. This command maps to:

```bash
aiwg issue new --title "..." --body-file issue.md
```

Use local issue creation only when project configuration points issue tracking
at local issue storage. For Gitea/GitHub projects, use the configured external
tracker from `.aiwg/aiwg.config` `remotes.issue_tracker`.
