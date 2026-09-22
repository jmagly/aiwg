---
description: Rebuild the local issue index from canonical .aiwg/issues/items markdown files
category: project-management
argument-hint: "rebuild [--json] [--provider local]"
allowed-tools: Bash, Read, Write
model: claude-sonnet-5
---

# Issue Index

Rebuild the local issue index:

```bash
aiwg issue index rebuild
```

The index is derived from canonical markdown issue files under
`.aiwg/issues/items/`; JSONL event streams remain append-only metadata.
