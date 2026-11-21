# Provider Behavior Artifacts

AIWG addons may ship `behaviors/<name>/BEHAVIOR.md`. OpenClaw reads those natively. Other providers receive generated behavior artifacts on their closest rule, instruction, or context surface so behavior setup is never silently skipped.

## Deployment Targets

| Provider | Behavior surface |
|----------|------------------|
| Claude Code | `.claude/rules/behaviors/<name>.md` |
| Codex | `.codex/rules/behaviors/<name>.md` |
| GitHub Copilot | `.github/instructions/aiwg-behaviors/<name>.instructions.md` |
| Cursor | `.cursor/rules/behaviors/<name>.md` |
| Factory | `.factory/rules/behaviors/<name>.md` |
| OpenCode | `.opencode/rule/behaviors/<name>.md` |
| Warp | `.warp/rules/behaviors/<name>.md` |
| Devin Desktop | `.windsurf/rules/behaviors/<name>.md` |
| Hermes | `.hermes/behaviors/<name>.md` |
| OpenClaw | `~/.openclaw/behaviors/<name>/BEHAVIOR.md` plus translated hooks when hook metadata exists |

Generated behavior artifacts include the original `BEHAVIOR.md` content and an activation note for providers that do not expose native behavior hooks. Provider capability differences remain visible in `agentic/code/providers/capability-matrix.yaml` under `artifact_paths.behaviors`.

## Activation

Run the normal deploy command:

```bash
aiwg use aiwg-fleet --provider codex
aiwg use aiwg-fleet --provider openclaw
aiwg use all --provider claude
```

For OpenClaw, the native behavior loader owns execution. For other providers, the generated artifact is provider-context guidance that the session, daemon, Mission Control loop, chat bridge, or closest available hook surface applies when the source behavior trigger is observed.

## Orchestration Capabilities

Provider subagent limits are declared in the same capability matrix under `agent_capabilities`. Orchestrators can use `preflightSubagentDispatch()` from `src/providers/capability-matrix.ts` to check estimated prompt/context/output/tool budgets before spawning a subagent.
