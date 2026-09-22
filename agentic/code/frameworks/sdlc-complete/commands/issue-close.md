---
description: Close a local issue under .aiwg/issues/
category: project-management
argument-hint: "<issue-id> [--reason \"...\"] [--provider local]"
allowed-tools: Bash, Read, Write
model: claude-sonnet-5
---

# Issue Close

Close a local issue and append a closure event:

```bash
aiwg issue close PROJECT-0001 --reason "Fixed"
```
