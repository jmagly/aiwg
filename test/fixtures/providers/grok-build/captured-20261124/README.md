# Grok Build 1.0.92 live captures (titan, 2026-11-24)

Version correction (conductor, 2026-11-24): titan auto-updated to
`grok 1.0.92 (b06756fd6256) [stable]` at 2026-11-21 09:05. All captures
in this directory ran on 1.0.92; their bytes are preserved.

Sanitized: project paths -> /absolute/temp/project and /absolute/temp/agent-project, home -> $HOME. Login: grok.com. Model: grok-4.7-build-fast, reasoning low.

| File | Command shape | Result |
|---|---|---|
| sub-on.jsonl | `--permission-mode dontAsk --sandbox read-only`, prompt asks for two parallel subagents | model calls `spawn_subagent`; refused: "a headless run cannot ask for approval"; `stopReason: cancelled` |
| sub-off.jsonl | same + `--no-subagents` | no `spawn_subagent` tool offered; model falls back to `run_terminal_command` (cap enforced); refused under dontAsk; cancelled |
| sub-on-run.jsonl | `--permission-mode bypassPermissions --sandbox read-only` | two parallel `spawn_subagent` calls + two terminal calls, all completed; final `a=3 b=2`; `end_turn`, 2 turns |
| agent-run.jsonl | `aiwg use all --provider grok-build --copy-all` (220 agents in .grok/agents, no `model:` lines), then `--agent code-reviewer -m grok-4.7-build-fast --no-subagents` | finds planted bug; `modelUsage` reports exactly `grok-4.7-build-fast`; `end_turn`, 3 turns |
| combined.jsonl | `--no-subagents --disallowed-tools workflow`, prompt asks for subagent or workflow | only `run_terminal_command` used; `a=3`; `end_turn` |
| tools-default.json / tools-banned.json | native `tool_definitions.json` from the session store, default vs. both bans | the bans remove exactly `spawn_subagent` and `workflow`; native list also includes `scheduler_create/list/delete`, `todo_write`, `monitor` |
| wt-*.json/.jsonl/.out | `grok -w aiwg-probe`, then `grok worktree list --json`, `rm`, `rm -f` | standalone copy under `$HOME/.grok/worktrees/<repo>/<name>` (`kind: fork`, `creation_mode: standalone`); `git worktree list` unchanged; `rm` refuses dirty copy ("unsaved work: dirty"), `rm -f` removes; registry empty after |
| mcp-list.json / mcp-doctor.json | AIWG-injected project server in `.grok/config.toml` (`aiwg mcp inject --provider grok-build --scope project`) | listed; doctor refuses: "repo-local (project-scoped) server not started for an untrusted folder" (hint names a `--trust` flag that 1.0.92 doesn't have) |
| mcp-user-doctor.json / mcp-session.jsonl | same server added at user scope (temporary; config restored byte-identical) | doctor healthy: started, handshake OK, 19 tools; session uses `search_tool` then `use_tool`, both completed; answer `top=Bug Report` |
| sched-run.jsonl | `--no-subagents --disallowed-tools workflow`, prompt asks for a 1-minute scheduled task | `scheduler_create` succeeds under both bans (`{"interval":"1m",...}`, completed); the headless session ends in ~5 s so no run fires. Its tool description says each run "starts a background subagent", so a long-lived session (ACP) bypasses `--no-subagents` |
| tools-banned-scheduler.json / sched-banned.jsonl | `--no-subagents --disallowed-tools workflow,scheduler_create,scheduler_list,scheduler_delete` (comma-separated) | 20 tools remain; no scheduler, spawn or workflow tool |
