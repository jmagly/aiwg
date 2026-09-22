---
description: Update local issue metadata under .aiwg/issues/
category: project-management
argument-hint: "<issue-id> [--status open|closed] [--label name] [--provider local]"
allowed-tools: Bash, Read, Write
model: claude-sonnet-5
---

# Issue Update

Update local issue metadata. The local CLI currently exposes focused operations:

```bash
aiwg issue comment PROJECT-0001 --body "Progress update"
aiwg issue close PROJECT-0001 --reason "Fixed"
aiwg issue index rebuild
```

For external trackers, resolve `.aiwg/aiwg.config` `remotes.issue_tracker` and
use the matching tracker update tooling.
