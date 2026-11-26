---
namespace: aiwg
name: devkit-create-command
platforms: [all]
description: Alias of add-command — Create a command inside an addon or framework.
---

# Devkit Create Command

This skill is an alias of the canonical `add-command` skill in aiwg-utils.
Load and follow its instructions, including guided design and post-creation guidance:

```bash
aiwg show skill add-command --body
```

The canonical skill runs this CLI command from the root of an AIWG checkout:

```bash
aiwg add-command <name> --to <target> [--template <type>]
```
