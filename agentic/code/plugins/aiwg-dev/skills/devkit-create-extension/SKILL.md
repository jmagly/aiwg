---
namespace: aiwg
name: devkit-create-extension
platforms: [all]
description: Alias of scaffold-extension — Create an extension inside a parent framework.
---

# Devkit Create Extension

This skill is an alias of the canonical `scaffold-extension` skill in aiwg-utils.
Load and follow its instructions, including guided design and post-creation guidance:

```bash
aiwg show skill scaffold-extension --body
```

The canonical skill runs this CLI command from the root of an AIWG checkout:

```bash
aiwg scaffold-extension <name> --to <framework>
```
