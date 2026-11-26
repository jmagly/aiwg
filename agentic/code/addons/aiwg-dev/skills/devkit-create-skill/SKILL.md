---
namespace: aiwg
name: devkit-create-skill
platforms: [all]
description: Alias of add-skill — Create a skill inside an addon or framework.
triggers:
  - "help me build a custom workflow"
  - "help me turn this repeated process into an AIWG workflow"
  - "decide whether this is a skill agent addon or docs recipe"
  - "skill architect"
---

# Devkit Create Skill

This skill is an alias of the canonical `add-skill` skill in aiwg-utils.
Load and follow its instructions, including guided design and post-creation guidance:

```bash
aiwg show skill add-skill --body
```

The canonical skill runs this CLI command from the root of an AIWG checkout:

```bash
aiwg add-skill <name> --to <target>
```
