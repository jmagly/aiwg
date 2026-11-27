# Google Antigravity CLI Provider

Status: experimental. Resource conformance is pinned to Antigravity CLI `1.1.26`;
native hook contracts were checked against installed `1.3.3` and `1.2.12` schemas.
Authenticated model execution has not been qualified.

## Selector Names

Canonical AIWG provider id:

- `antigravity`

Accepted aliases:

- `agy`

Provider binary:

- `agy`

Use `--provider antigravity` in examples and docs. Accept `--provider agy`
because Google documents `agy` as the CLI executable. Persist only the
canonical `antigravity` id.

## Documented Google Surfaces

Official Google docs identify Antigravity CLI as the terminal-first Antigravity
surface backed by the shared Antigravity agent harness. The local binary
observed on 2026-09-04 reports version `1.1.26`.

Relevant paths:

| Surface | Path |
|---|---|
| CLI binary | `~/.local/bin/agy` on macOS/Linux installs |
| Settings | `~/.gemini/antigravity-cli/settings.json` |
| Workspace skills | `.agents/skills/` |
| Global skills | Deferred: Google sources conflict between `~/.gemini/antigravity-cli/skills/` and `~/.gemini/config/skills/` |
| Workspace MCP | `.agents/mcp_config.json` |
| Workspace lifecycle hooks | `.agents/hooks.json` |
| Global MCP | `~/.gemini/config/mcp_config.json` |
| Plugins | `~/.gemini/antigravity-cli/plugins/<plugin_name>/` |

## Integration Notes

- Headless execution should use `agy -p` or `agy --print`.
- JSON and stream JSON output are available for automation.
- MCP config should use the standard `mcpServers` object.
- Remote MCP servers should use `serverUrl`.
- `--dangerously-skip-permissions` must stay behind an explicit AIWG dangerous
  mode.
- `--sandbox` can be passed only when requested by operator policy or provider
  launch settings.
- Initial support should deploy workspace skills only. Global skill deployment
  remains unsupported until the active 1.1.26 discovery precedence is proven.
- AIWG custom agents are projected to `.agents/agents/<name>.md`. Their generic
  tool allowlists are mapped only for the documented `view_file`,
  `write_to_file`, `replace_file_content`, `grep_search`, and `run_command`
  equivalents; unknown tool names are omitted, so agent projection is marked
  degraded rather than fully native. Commands,
  workflows, plugins, auth settings, trust settings, and permission settings are
  not installed or modified by this provider integration.
- `aiwg team` uses `aiwg-mc` emulation. Antigravity's documented subagents do
  not imply a native AIWG team runner.
- Persistent MCP injection preserves unrelated top-level keys and refuses to
  replace an existing server with the same name. Project scope writes
  `.agents/mcp_config.json`; explicit MCP user scope writes
  `~/.gemini/config/mcp_config.json`.

## Native project hooks

`aiwg use all --provider antigravity` installs bounded prompt discovery by
default (suppress with `--no-hooks`). `AGENTS.md` requires `aiwg discover` before
tool-based context reads on each new directive, including subagent tasks.

The native `.agents/hooks.json` is a map of named hooks, not a `hooks` wrapper or
versioned document. AIWG owns the `aiwg-prompt-discovery` name and preserves other
names and explicit `enabled: false`. Its `PreInvocation` array contains flat
`{type: "command", command: "…", timeout: 2}` handlers. Tool events use
`{matcher: "*", hooks: [handler]}` groups. The bridge maps `SessionStart`,
`PreToolUse`, `PostToolUse` and `Stop`; unsupported canonical events are reported.
`aiwg refresh --dry-run --skip-update --provider antigravity` detects missing or
outdated registration and script bytes. Edited managed scripts are kept for review.

Offline contract verification on 2026-11-27 used installed
`~/.local/bin/agy --version` (**1.3.3**), its embedded `JSONHookSpec` Go metadata
and `third_party/jetski/hooks_pb/hooks.proto` descriptors, plus installed builtin
`agy-customizations/docs/hooks.md`. The PATH executable at
`/opt/noodle-agentic/bin/agy` reports **1.2.12**; the issue's 1.5.17 was unavailable.
Its embedded schema also confirms the hook events and payload fields used here.
The captured contract is in
`test/fixtures/providers/antigravity-conformance/hooks-contract.json`.

The verified protojson input uses `conversationId`, `lastUserInput`,
`workspacePaths` and `invocationNum`. Version 1.3.3's input schema has no
`hookEventName` or `cwd`, so the registered command explicitly selects the
Antigravity adapter and uses the first workspace path. Hook commands run from
the directory containing `hooks.json`, not the project root. Output is
`{injectSteps: [{systemMessage: {systemMessage: "…"}}]}`; the installed docs also
show the alternative `ephemeralMessage` form. Embedded schema confirms the
nested system message and `SessionStart`, which those docs omit.

`PreInvocation` fires before every model call. The shared discovery script emits
once per `(project, conversationId, lastUserInput)` using exclusive, hash-only
markers in the system temporary directory. Changed prompts or conversations get
new discovery; clearing the temporary directory permits reinjection. Missing
input/runtime, disabled discovery, timeouts and errors fail open without injection.
Authenticated execution and hook behavior on 1.5.17 were not tested.

## Headless use

The bounded adapter invokes `agy -p` with argument arrays, a finite timeout,
and JSON or stream-JSON parsing. Standard operation does not add
`--dangerously-skip-permissions`; it is added only for an explicit dangerous
request. Protocol data is read from stdout and diagnostics from stderr.

The live smoke command is opt-in and version-only:

```sh
AIWG_ANTIGRAVITY_LIVE_SMOKE=1 npm run smoke:antigravity:live
```

It does not authenticate or make a model call. Normal CI uses only sanitized
fixtures under `test/fixtures/providers/antigravity-conformance/`.

## Evidence

- `agentic/code/providers/antigravity/provider-contract.v1.json`
- [Google install documentation](https://antigravity.google/docs/cli/install/)
- [Google headless documentation](https://antigravity.google/docs/cli/headless/)
- [Google MCP documentation](https://antigravity.google/docs/cli/mcp/)
- [Google subagent documentation](https://antigravity.google/docs/cli/subagents/)
