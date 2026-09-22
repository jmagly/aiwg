---
description: List local issues under .aiwg/issues/
category: project-management
argument-hint: "[--status open|closed] [--label name] [--limit N] [--json] [--provider local]"
allowed-tools: Bash, Read
model: claude-sonnet-5
---

# Issue List

List local project issues. This command maps to:

```bash
aiwg issue list --status open --limit 20
```

For external issue trackers, resolve `.aiwg/aiwg.config` `remotes.issue_tracker`
and use the matching tracker tooling instead of local issue storage.
