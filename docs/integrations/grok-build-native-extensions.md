# Grok Build native MCP and hooks

AIWG can opt into Grok Build's native project surfaces without treating Grok as
a Claude or Codex compatibility target.

## MCP configuration

Register a server in the AIWG MCP registry, then inject it into the reviewed
project layer:

```bash
aiwg mcp add aiwg --type stdio --command aiwg --args mcp,serve
aiwg mcp inject --provider grok-build --scope project
```

AIWG edits only its marked server blocks in `.grok/config.toml`. Comments,
unrelated tables, ordering outside those blocks, and operator-owned servers are
preserved. A same-name operator server blocks deployment instead of being
overwritten. Remove managed entries with:

```bash
aiwg mcp uninject --provider grok-build --servers aiwg
```

Use `${NAME}` or `${NAME:-default}` references in URL, command, argument,
environment, and header values. Grok expands them while loading; AIWG does not
persist the expanded secret in configuration, receipts, or diagnostics.

Project configuration has higher precedence than the user configuration for a
same-name server. Organization requirements or managed policy can therefore
block a requested project integration; this is reported as
`blocked-by-policy`, not as a successful write. Native verification uses
`grok inspect --json`, `grok mcp list --json`, and
`grok mcp doctor <name> --json`.

## Hooks and trust

Hook translation is explicit:

```bash
aiwg use all --provider grok-build --enable-cross-provider-hooks
```

AIWG writes owned JSON under `.grok/hooks/`. Deployment never edits
`~/.grok/trusted_folders.toml`, runs `/hooks-trust`, or launches Grok with
`--trust`. Review the generated files and grant project trust separately in
Grok if appropriate.

AIWG maps `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`,
`PostToolUse`, and `Stop` to the same Grok events. Unsupported events are
reported instead of being silently approximated. Only `PreToolUse` can block,
and only an explicit JSON deny decision blocks. Timeouts, crashes, malformed
output, non-denial exits, and failures from passive events are fail-open.

Status distinguishes `configured`, `disabled`, `blocked-by-policy`,
`untrusted`, `unhealthy`, and `absent` for the native MCP and hook surfaces.
