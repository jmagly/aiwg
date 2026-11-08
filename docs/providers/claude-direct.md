# Claude Code direct CLI profile

Issues #2900 and #3845; installed CLI `/home/roctinam/.local/bin/claude`, rechecked
`2.1.319 (Claude Code)` on 2026-11-07 (America/New_York; 2026-11-08 UTC) using
only `claude --version`, `claude --help` and `claude -p --help`.
Help verifies syntax; fake tests verify mechanics. The registry stays **unqualified**.

Both the adapter and `direct-shell` profile now use `>=2.1.295 <2.2.0`.
The existing schema and semver loader already support comparator ranges (as used
by Codex); Factory currently uses an exact version. The lower bound preserves the
2.1.295 help-verified baseline; the next minor requires review. Offline resolver
and readiness tests cover 2.1.317, the installed 2.1.319, later patches and build
metadata, and reject older releases, prereleases and 2.2+. Only 2.1.319 was
rechecked locally for this change; synthetic cases do not establish live support
for every release in the range. Existing installation approval is still required.

Every flag in the bundled argv template appears in both help modes, including
`--print`, `--verbose`, `--effort`, `--permission-mode`, `--permission-prompts`,
`--restricted`, `--safe-mode`, tool filters and the strict empty MCP configuration.
The advertised effort and permission choices are unchanged. `--max-turns` remains
absent. Help wording now describes `--disable-slash-commands` as disabling skills
and commands, removes REPL from the restricted-mode examples and adds the print
requirement to `--json-schema`; none requires an argv change.

The driver requires an exact model ID and explicit effort. It uses stdin text to
EOF, JSONL stdout, `dontAsk` plus `--permission-prompts none`, restricted file
tools and an empty strict MCP configuration. Skills, customizations and Agent/Task
are disabled. `--tools`/`--allowedTools` vary by sandbox mode: the default
`workspace-write` sandbox emits `Read,Glob,Grep,Edit,Write` (the bundled registry's
pinned template, below); `read-only` narrows that to `Read,Glob,Grep`, omitting
Edit/Write. OS sandboxing is **unavailable** in this CLI profile; the existing
external-boundary requirement still applies. Inherited fallback is disabled and no
fallback model is emitted. Legacy adapter calls now deny permission prompts too;
their existing prompt transport is retained. The shared SessionLauncher fallback
still has its old bypass flag and needs a separate shared-owner change.

`ClaudeDirectAdapter.parseWorkerFinal` extracts one successful `result` envelope from
captured `.stdout`, then validates its JSON `result` text or `structured_output`
with the shared claims parser and trusted exit observation. Missing, double,
truncated, cross-session and error finals fail; exit zero cannot override an error
event. Health reuses `system/init`, `assistant`, `user/tool_result`, `stream_event`
and `result`. Semantic handshake remains unqualified; owned process exit supplies
stop evidence. The CLI does not write the renderer's `finalPath` directly.

The approved module exposes `interfaceVersion=1` and `register(factory)`. Its
installed factory ID is `claude-direct`, distinct from the legacy `claude` ID, so
both load orders coexist. Use the existing `workerAdapters:claude-direct` binding
for an installed direct adapter; provider identity and executable remain `claude`.
The fixture pins the module digest; host approval to load does not grant dispatch.

Unavailable: a help-evidenced turn cap (`--max-turns` is absent), renderer schema
input (CLI `--json-schema` exists), and a native MCP **reasoning worker**.
`claude mcp serve --help` says `Start the Claude Code MCP server` and lists only
`-d, --debug`, `-h, --help`, `--verbose`. This code-tools server is not a model
worker. No MCP worker profile or bridge normalization is advertised here.

One manual smoke run, from a trusted scratch workspace, after setting
`CLAUDE_SMOKE_MODEL` to an exact model ID available to the operator. This uses the
`read-only` tool list (`Read,Glob,Grep`, no Edit/Write) deliberately, since a smoke
probe has no reason to write; the bundled registry template above still pins the
`workspace-write` list as the profile default:

```sh
printf '%s\n' 'Reply exactly OK.' | claude --print --input-format text --output-format stream-json --verbose --model "${CLAUDE_SMOKE_MODEL:?set an exact model ID}" --effort low --permission-mode dontAsk --permission-prompts none --restricted --safe-mode --strict-mcp-config --mcp-config '{"mcpServers":{}}' --tools Read,Glob,Grep --allowedTools Read,Glob,Grep --disallowedTools Agent,Task,Bash,PowerShell,REPL,WebFetch --disable-slash-commands --no-chrome --no-session-persistence
```

Pass: CLI exit zero, exactly one final `type: result`, `subtype: success`,
`is_error: false`, and `result` saying OK; no error event. Anything else fails.
Record the CLI version and pass/fail manually. This command was not run here.

Verbatim relevant lines from installed `claude --help`:

```text
  --allowedTools, --allowed-tools <tools...>
      Comma or space-separated list of tool names to allow (e.g. "Bash(git *)
      Edit")
  --disable-slash-commands              Disable all skills and commands
  --disallowedTools, --disallowed-tools <tools...>
      Comma or space-separated list of tool names to deny (e.g. "Bash(git *)
      Edit")
  --effort <level>                      Effort level for the current session
                                        (low, medium, high, xhigh, max)
  --fallback-model <model>              Enable automatic fallback to specified
                                        model(s) when the default model is
                                        overloaded or not available. Accepts a
                                        comma-separated list to try each in
                                        order. Re-tries the primary at the start
                                        of each user turn.
  --input-format <format>               Input format (only works with --print):
                                        "text" (default), or "stream-json"
                                        (realtime streaming input) (choices:
                                        "text", "stream-json")
  --json-schema <schema>                JSON Schema for structured output
                                        validation (only works with --print).
                                        Example:
                                        {"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}
  --mcp-config <configs...>             Load MCP servers from JSON files or
                                        strings (space-separated)
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'fable', 'opus', or 'sonnet') or a
                                        model's full name.
  --no-chrome                           Disable Claude in Chrome integration
  --no-session-persistence              Disable session persistence - sessions
                                        will not be saved to disk and cannot be
                                        resumed (only works with --print)
  --output-format <format>              Output format (only works with --print):
                                        "text" (default), "json" (single
                                        result), or "stream-json" (realtime
                                        streaming) (choices: "text", "json",
                                        "stream-json")
  --permission-mode <mode>              Permission mode to use for the session
                                        (choices: "acceptEdits", "auto",
                                        "bypassPermissions", "manual",
                                        "dontAsk", "plan")
  --permission-prompts <target>         Who answers permission prompts with
                                        --print: "host" (the SDK host or
                                        --permission-prompt-tool) or "none"
                                        (nobody: anything that would prompt is
                                        denied automatically; the permission
                                        mode still decides everything else)
                                        (choices: "host", "none", default:
                                        "host")
  -p, --print                           Print response and exit (useful for
                                        pipes). Note: The workspace trust dialog
                                        is skipped when Claude is run in
                                        non-interactive mode (via -p, or when
                                        stdout is not a TTY, e.g. piped or
                                        redirected output). Only use this in
                                        directories you trust. Settings files
                                        that fail validation are silently
                                        ignored in this mode (no error dialog is
                                        shown).
  --restricted                          Restricted mode: removes the built-in
                                        tools that run commands or code (Bash,
                                        PowerShell and the other code-running
                                        tools) and WebFetch unless --tools names
                                        them, and ignores user, project and
                                        local settings files (managed settings
                                        and --settings still apply; add
                                        --strict-mcp-config to skip MCP servers
                                        too). Also confines the file tools to
                                        the working directories (--add-dir
                                        included), refuses bypassPermissions,
                                        and lets only a person or the configured
                                        permission handler approve writes to
                                        settings, git and tool-configuration
                                        files.
  --safe-mode                           Start with all customizations
                                        (CLAUDE.md, skills, installed plugins,
                                        hooks, MCP servers, custom commands and
                                        agents, output styles, workflows, custom
                                        themes, keybindings, and more) disabled
                                        — useful for troubleshooting a broken
                                        configuration. Admin-managed (policy)
                                        settings still apply. Auth, model
                                        selection, built-in tools and plugins,
                                        and permissions work normally. Sets
                                        CLAUDE_CODE_SAFE_MODE=1.
  --setting-sources <sources>           Comma-separated list of setting sources
                                        to load (user, project, local).
  --strict-mcp-config                   Only use MCP servers from --mcp-config,
                                        ignoring all other MCP configurations
  --tools <tools...>                    Specify the list of available tools from
                                        the built-in set. Use "" to disable all
                                        tools, "default" to use the default set,
                                        or specify tool names (e.g.
                                        "Bash,Edit,Read").
  --verbose                             Override verbose mode setting from
                                        config
```
