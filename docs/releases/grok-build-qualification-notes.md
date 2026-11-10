# Grok Build qualification — AIWG 2026.11.4

The `grok-build` CLI provider remains experimental. Supplied Linux Grok Build
**1.0.77** captures from 2026-11-09 back trusted `AGENTS.md`/`.grok/rules`
loading, AIWG skill discovery, permission rules such as `Bash(aiwg *)`, four
headless output formats, and sessions list/search/export observations. Untrusted
folders load no project instructions. Export includes commands, without tool output.

The existing smoke now requires explicit opt-in, skips missing binary/login,
and records OS, auth mode without credentials, sanitized inspect output,
deployed surfaces and expected provider receipt. The existing drift tool gains
a local help-token/schema comparison. No new CI workflow is added.

Stable promotion stays blocked: needs Windows PowerShell and WSL PUWs, repeat
1.0.77 Linux lifecycle/security evidence, current source revision mapping,
and native MCP/hooks/models/ACP/subagent/worktree captures. Older 1.0.38 source
review and lifecycle evidence do not qualify 1.0.77. Full help/config schema
comparison needs additional captures. See the
[native-surface inventory](../providers/grok-build-evidence/2026-11-09.md).

Grok Build is xAI's coding-agent CLI. Grok Bot and Grok web Build are separate
products. Start with the [quickstart](../integrations/grok-build-quickstart.md),
[reference](https://github.com/jmagly/aiwg/blob/main/docs/agents/providers/grok-build.md), or
[qualification gate](../providers/grok-build-qualification.md).
