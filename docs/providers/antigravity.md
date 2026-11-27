# Google Antigravity CLI Provider

Status: experimental. Reviewed on 2026-11-27 against installed agy **1.2.12**
and **1.3.3** (noodle) and **1.5.17** (titan): the embedded hook schemas list the
same events, and 1.5.17's built-in customization docs for MCP servers and rules are
identical to the copies used for this contract. These establish documented
configuration surfaces; authenticated model execution has not been qualified.

## Selection and evidence

Use `--provider antigravity`; `agy` is the accepted alias and CLI executable.
Persist the canonical `antigravity` id. The recorded evidence is
`test/fixtures/providers/antigravity-conformance/host-contract-evidence.json`:
built-in documentation paths and digests, observed versions, and the 1.3.3
binary's embedded tool schema markers, subagent model validation and swarm
schema. Historical 1.1.26 transport fixtures remain synthetic regression data.

## Documented Google surfaces

The installed guide at
`~/.gemini/antigravity-cli/builtin/skills/agy-customizations/SKILL.md`
and its `docs/` directory document these paths and keys:

| Surface | Path or key |
|---|---|
| CLI binary | `~/.local/bin/agy` on macOS/Linux installs |
| CLI settings | `~/.gemini/antigravity-cli/settings.json` |
| Workspace skills | `.agents/skills/<name>/SKILL.md` |
| Global skills | `~/.gemini/config/skills/<name>/SKILL.md` |
| Project MCP | `.agents/plugins/aiwg/mcp_config.json` |
| Required project plugin marker | `.agents/plugins/aiwg/plugin.json`, created as `{"name":"aiwg"}` |
| Global MCP | `~/.gemini/config/mcp_config.json` |
| MCP server map | `mcpServers` |
| Streamable HTTP endpoint | `url` (`serverUrl` is accepted as a legacy key) |
| Workspace hooks | `.agents/hooks.json` |
| Hierarchical context | `AGENTS.md`, `GEMINI.md`, `.agents/rules/*.md` |
| Per-rule byte cap | 24,000 bytes after include expansion |

Workspace customizations take priority over declared workspace configurations,
global `~/.gemini/config/`, built-ins, then globally declared configurations.
The CLI walks from the current directory to the repository root. AIWG uses
explicit bootstrap reading instructions rather than assuming Markdown links
load automatically.

AIWG retains its existing `.antigravity/rules/` storage and bootstrap delivery;
the firewall now audits this directory alongside skills, agents and `AGENTS.md`.
The installed guide does **not** establish that directory as a native rule
loader. Provider startup metadata lists the documented `.agents/rules/*.md`.

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

## MCP injection and legacy migration

```sh
aiwg mcp inject --provider antigravity --servers local-tools
aiwg mcp inject --provider antigravity --scope user --servers local-tools
```

Project injection writes the plugin config and required manifest together.
Existing manifests (including `disabled`) and operator-owned server names are
preserved. A plugin disabled by the operator remains disabled; manage it with
Antigravity's plugin controls. New plugin directories are discovered at
startup: restart `agy` after injection. AIWG deliberately reports
`reloadPolicy: "restart-required"` and `restartRequired: true`, consistent with
its next-session memory adapter. The built-in plugin guide distinguishes
new-directory discovery from live enable/disable operations; AIWG does not
claim every resource edit reloads live.

When `.agents/mcp_config.json` exists, injection copies nonconflicting server
entries and top-level values to the plugin config. Copied remote entries use
`url`. The plugin config wins collisions, which produce warnings. The legacy
file stays byte-for-byte intact for review and recovery; it is superseded and
is no longer an injection destination. While present, it is merged on each
injection; archive it after review to prevent reimporting a server deliberately
removed from the plugin config. Invalid JSON and symlinked destinations
are refused before any config write. Dry-run writes neither config nor marker.
`aiwg clean:providers` cleans registry-owned entries from both locations,
preserving operator entries and the plugin manifest.

## Deployment and native capabilities

`aiwg use aiwg-utils --provider antigravity --scope user` uses the existing
additive deployment/mirror flow and mirrors skills to `~/.gemini/config/skills/`.
Global custom agents, hooks and rules are not mirrored without a verified path
contract. Project agents remain `.agents/agents/<name>.md`. AIWG maps `Read`,
`Write`, `Edit`, `Grep` and `Bash` to `read_file`, `write_file`, `edit_file`,
`grep_search` and `run_command`; unknown tools are omitted. Agent projection
remains degraded because tool/account availability has not been exercised.

The provider matrix reports the native surfaces found locally:

- Scheduling: the documented `builtin: schedule` cron sidecar. An operator
  enables it via the Automations dashboard; AIWG does not enable automations.
- Agent teams: `swarm`, whose embedded schema accepts a per-worker `model`
  and `workspace: inherit|share|branch` (share is a separate working copy;
  branch is an isolated clone).
- Tasks: `invoke_subagent`, `define_subagent`, `run_workflow`, `manage_task`.
  Embedded model validation accepts `inherit|flash_lite|flash|pro`; account
  policy can restrict model selection.
- Behaviors: lifecycle hooks in `.agents/hooks.json`.
- MCP: stdio and Streamable HTTP via `mcpServers` and `url`.

These are provider capabilities, not a claim that the AIWG team runner has
been converted to native swarm. `aiwg team` still uses `aiwg-mc`, with a
conservative four-worker cap. Live task execution, account availability,
scheduling triggers and heterogeneous model execution remain unverified.

## Headless operation and local-source sandbox caveat

Installed help documents `agy -p` / `--print`, JSON and stream-JSON output,
`--input-format stream-json`, `--sandbox`, and
`--dangerously-skip-permissions`. AIWG enables dangerous mode only on an
explicit request. Authentication and permission settings remain operator-owned.

The issue reporter observed exit 127 when `aiwg` resolved through an nvm
symlink to a local source checkout outside Antigravity's terminal sandbox
mounts. This refresh did not reproduce that report. If it occurs, check the
binary and symlink targets with `command -v aiwg` and `readlink -f`, then make
the installation visible under the operator's sandbox policy or explicitly run
that command outside the sandbox. Do not infer an MCP failure from that error.
