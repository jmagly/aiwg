---
description: Show a local issue and its event thread under .aiwg/issues/
category: project-management
argument-hint: "<issue-id> [--comments last:10|all] [--json] [--provider local]"
allowed-tools: Bash, Read
model: claude-sonnet-5
---

# Issue Show

Show a local project issue:

```bash
aiwg issue show LOCAL-0001 --comments all
```

This command is local-only. External issue trackers are resolved from
`.aiwg/aiwg.config` `remotes.issue_tracker` and handled by their tracker tools.
