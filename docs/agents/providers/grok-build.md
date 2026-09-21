---
audience: agent-operator
publication: agent-reference
stable_id: aiwg.agent-reference.provider.grok-build
---

# Grok Build operational reference

Grok Build is xAI's coding-agent CLI, provider ID `grok-build`. It is distinct
from `grokbot` (the desktop Bot integration) and the Grok web Build experience.
The AIWG adapter is **experimental** until the [qualification gate](../../providers/grok-build-qualification.md)
has four-platform evidence. Install the released CLI using the reviewed
[upstream installation instructions](https://github.com/xai-org/grok-build#installing-the-released-binary),
then confirm `grok --version` before deploying AIWG.

| Surface | AIWG location or behavior |
|---|---|
| Canonical project context | `WORKSPACE.md`; `AGENTS.md` is a generated bridge to it and `AIWG.md` |
| Project skills | `.grok/skills/<name>/SKILL.md`; `.agents/skills` is compatibility only |
| User skills | `$GROK_HOME/skills/<name>/SKILL.md` (default home resolved by Grok Build) |
| Native agents | `.grok/agents/<name>.md` model-worker wrappers; inspect before trusting live dispatch |
| MCP and hooks | Project `.grok/config.toml` sidecar; review/trust activation separately |
| Sessions | Documented `grok export` Markdown, see [sessions](../../providers/grok-build-sessions.md) |
| Models | Native discovery and role resolution, see [models](../../providers/grok-build-models.md) |

## Connect, deploy, and verify

From the project root, with `aiwg` and `grok` on `PATH`:

```bash
aiwg use all --provider grok-build --scope project --dry-run
aiwg use all --provider grok-build --scope project
aiwg regenerate --workspace --provider grok-build
aiwg build-verify --provider grok-build
grok inspect --json
```

`aiwg build-verify` requires Grok's live inspection of the generated
`AGENTS.md` and deployed kernel skills. It does not assert that a model
followed them. For user-scope skills, run `aiwg use all --provider grok-build
--scope user` after reviewing the resolved `$GROK_HOME` target; this is an
additive mirror. Project and user scopes must be qualified separately.

`WORKSPACE.md` owns operator project guidance. AIWG generates/updates
`AGENTS.md` and the Claude-compatible `CLAUDE.md` hook through `aiwg use` and
`aiwg regenerate`; do not hand-edit their managed blocks. Operator text outside
the blocks is preserved. On a legacy workspace whose context has not been
adopted, preview `aiwg regenerate --existing-project --dry-run`, then use its
transactional `--apply` route. After adoption, use `--workspace` for updates.
The [workspace context guide](../../configuration/workspace-context.md) documents
rollback.

## Operations and recovery

Review [MCP and hook trust](../../integrations/grok-build-native-extensions.md)
before enabling either sidecar. [CI/headless use](../../integrations/grok-build-ci.md)
requires reviewed tool and runner pins. ACP, subagent/worktree, and native
session-storage behavior remain evidence-gated in the qualification contract.

For a refresh, run `aiwg regenerate --workspace --provider grok-build` for
context only, or `aiwg refresh` to redeploy assets, then rerun `aiwg
build-verify --provider grok-build`. To remove AIWG's Grok Build project
deployment, preview `aiwg remove grok-build --provider grok-build --dry-run`,
then run the same command without `--dry-run` after reviewing its targets.
The provider removal verifies unchanged generated files against the installed
source and preserves modified or unverifiable files. Keep operator-owned `.grok`
content and context files. If discovery fails, compare `grok inspect --json`
with the AIWG deployment receipt, check the configured `GROK_HOME`, and restart
the Grok Build session. The [qualification matrix](../../providers/grok-build-qualification.md)
has update and rollback checks.

Projects that temporarily used `--provider claude` for Grok Build should deploy
`--provider grok-build` in the same project, run the canonical regeneration
route, verify `.grok/skills` with `grok inspect`, then remove only AIWG-owned
old Claude artifacts through the reviewed uninstall path. Keep `CLAUDE.md`
when Claude Code is actually in use and preserve its operator-owned text.
