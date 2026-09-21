# Grok Build quickstart

Grok Build is xAI's coding-agent CLI (`grok-build` in AIWG). Grok Bot is a
separate desktop integration; the Grok web Build experience is not this CLI.
Start with the [AIWG install, connect, and verify guide](../getting-started/install-connect-verify.md)
if AIWG is not yet installed in the project.
Install a reviewed released binary from the [upstream instructions](https://github.com/xai-org/grok-build#installing-the-released-binary),
then check `grok --version`. In a project with AIWG installed:

```bash
aiwg use all --provider grok-build --scope project --dry-run
aiwg use all --provider grok-build --scope project
aiwg regenerate --workspace --provider grok-build
aiwg build-verify --provider grok-build
```

Open a new Grok Build session after deployment. AIWG stores shared project
guidance in `WORKSPACE.md`; generated `AGENTS.md` loads it before `AIWG.md`.
Kernel skills land in `.grok/skills`; inspect the live discovery with `grok
inspect --json`. For user-scope skills, inspect the target with a dry run of
`aiwg use all --provider grok-build --scope user` first. Operator-owned `.grok`
files and text outside managed context blocks must survive refreshes.

See [native extensions](grok-build-native-extensions.md) for MCP/hooks,
[sessions](../providers/grok-build-sessions.md), [models](../providers/grok-build-models.md),
the [CI guide](grok-build-ci.md), and the Grok Build migration guide.
The [qualification matrix](../providers/grok-build-qualification.md) documents
scope, recovery, and the evidence still needed for stable promotion.
