# Grok Build 1.0.77 — 2026-11-10 capture excerpts

Derived offline from the operator's read-only `grok-build-captures-20261110`
bundle after reading its README. No model calls or credentials are needed.

- `acp-frames.jsonl`: selected `acp/frames.jsonl` initialize/authMethods,
  session/new, `_x.ai/*` notifications, text/completion usage and cancellation.
- `acp-compact-frames.jsonl`: selected `acp-compact/frames.jsonl` initialize,
  session/new, first completion, `/compact`, summary/compact notifications and
  recalled code word. Unrelated river-answer chunks/turns are omitted.
- `permissions.json`: selected tool-use/result records from the named `cli/*.out`
  plus relevant stderr. `flags` are contextual annotations from the capture
  README, not output fields. Tool inputs are omitted; nested result JSON is
  decoded. Workflow output retains only type/run/task/name. Default headless
  cancelled spawn/workflow; allowing spawn did not help. Auto ran spawn and
  workflow, though later auto actions could also be denied.
- `workflow-children.json`: ownership fields from the two `native/<parent>/subagents/*/meta.json`
  records belonging to the successful workflow in `cli/subagents-off-auto.out`.
  Both children eventually cancelled at max turns; spawning still occurred.
- `worktree-list.json`: `cli/worktree-list.json` with ownership/recovery fields.
  `git-worktree-{before,after}.txt` are the unchanged `cli/worktree-{before,after}.txt`
  listings: native `-w` made a standalone copy, not a Git worktree.

Paths, user/host names, PID, commit hash and session/agent/request/tool/workflow
identifiers are synthetic; UUID version/variant shapes and shared references
are preserved. Large model/settings payloads are trimmed to fields the tests
need. No system prompts, tool definitions or user skill inventories are included.
Tests: `test/unit/providers/grok-build-{headless,acp,dispatch}.test.ts`.
These captures do not exercise the combined `--no-subagents --disallowed-tools workflow`
flags, native copy recovery/removal, resident daemon lifecycle or live AIWG ACP
dispatch; those remain unverified/deferred.

`discover-cancelled.json` is a selected stream from the later
`grok-build-captures-20261110b/cli/smoke-in-aiwg-project.out` capture (1.0.77).
It retains the discovery shell input, pending/null/failed updates, cancelled
terminal event and accounting with exit code 0. Thoughts, signatures and command
inventories are omitted; tool/session/request ids and cwd are synthetic. The
request is the harmless smoke prompt, with no system prompts or user/host names.
The broader `--allow "Bash(aiwg *)"` succeeded in `cli/agent-probe-allow.out`;
`Bash(aiwg discover *)` is the narrower rule selected from the bundled Bash
matching documentation, not a claim of live verification. Headless tests replay
the failure and exercise a fake permission gate; ACP/direct tests check argv.
