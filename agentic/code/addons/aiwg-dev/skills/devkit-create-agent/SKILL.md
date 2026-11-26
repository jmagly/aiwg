---
namespace: aiwg
name: devkit-create-agent
platforms: [all]
description: Alias of add-agent — Create an agent inside an addon or framework.
---

# Devkit Create Agent

This skill is an alias of the canonical `add-agent` skill in aiwg-utils.
Load and follow its instructions, including guided design and post-creation guidance:

```bash
aiwg show skill add-agent --body
```

The canonical skill runs this CLI command from the root of an AIWG checkout:

```bash
aiwg add-agent <name> --to <target> [--template <type>]
```
