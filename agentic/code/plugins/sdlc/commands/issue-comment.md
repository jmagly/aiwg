---
description: Comment on a local issue under .aiwg/issues/
category: project-management
argument-hint: "<issue-id> --body \"...\" [--body-file path] [--provider local]"
allowed-tools: Bash, Read, Write
model: claude-sonnet-5
---

# Issue Comment

Append a local issue comment as an event with markdown body storage:

```bash
aiwg issue comment PROJECT-0001 --body-file comment.md
```
