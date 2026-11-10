# Grok Build quickstart

Grok Build is xAI's coding-agent CLI (`grok-build` in AIWG). Grok Bot is a
separate desktop integration; the Grok web Build experience is not this CLI.
Start with the [AIWG install, connect, and verify guide](../getting-started/install-connect-verify.md)
if AIWG is not yet installed in the project.
Install a reviewed released binary from the [upstream instructions](https://github.com/xai-org/grok-build#installing-the-released-binary),
then check `grok --version`. The supplied Linux capture is **1.0.77**
(2026-11-09); Windows PowerShell and WSL qualification remain deferred. In a project with AIWG installed:

```bash
aiwg use all --provider grok-build --scope project --dry-run
aiwg use all --provider grok-build --scope project
aiwg regenerate --workspace --provider grok-build
aiwg build-verify --provider grok-build
```

Open a new Grok Build session after deployment. AIWG stores shared project
guidance in `WORKSPACE.md`; generated `AGENTS.md` loads it before `AIWG.md`.
Kernel skills land in `.grok/skills`; inspect the live discovery with `grok
inspect`. A folder must be trusted in Grok Build before it loads project
instructions: the untrusted capture loads none; the trusted capture loads
`AGENTS.md` and `.grok/rules/*`. Review the project before granting trust.
`grok inspect` may still list user skills in an untrusted folder; that does not
mean project instructions loaded. For user-scope skills, inspect the target with a dry run of
`aiwg use all --provider grok-build --scope user` first. Operator-owned `.grok`
files and text outside managed context blocks must survive refreshes.

See [native extensions](grok-build-native-extensions.md) for MCP/hooks,
[sessions](../providers/grok-build-sessions.md), [models](../providers/grok-build-models.md),
the [CI guide](grok-build-ci.md), and [migration from temporary Claude deployment](../migration/grok-build-from-claude-workaround.md).
The [qualification matrix](../providers/grok-build-qualification.md) documents
scope, recovery, and the evidence still needed for stable promotion.

For bounded headless automation, the captured command form was:

```bash
grok --no-auto-update -p "Find the AIWG capability for this task" \
  --output-format json --allow "Bash(aiwg *)" --max-turns 6
```

`Bash(aiwg *)` is a permission rule matching AIWG shell commands. Review each
allow rule and use the runner's isolation policy. The other captured formats
are `plain`, `streaming-json`, and `streaming-messages-json`; the two streaming
formats have different event grammars. See the [capture limits](../providers/grok-build-evidence/2026-11-09.md).
