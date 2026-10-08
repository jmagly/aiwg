# MCP Server (Model Context Protocol)

The AIWG MCP server gives compatible AI tools a programmatic way to discover
AIWG capabilities, read selected artifacts, and run allow-listed AIWG commands.
Use it when an external tool needs structured access to AIWG rather than only
the files deployed into a provider-specific directory.

[![Listed on mcpservers.org](https://mcpservers.org/badge.svg)](https://mcpservers.org/servers/docs-aiwg-io)

The AIWG MCP Daemon is listed in the
[mcpservers.org directory](https://mcpservers.org/servers/docs-aiwg-io).

## Quick Start

```bash
# Start MCP server (stdio transport)
aiwg mcp serve

# Install config for Claude Code (CLI and Claude Desktop's Code tab share this config)
aiwg mcp install claude

# Install config for Cursor
aiwg mcp install cursor

# View MCP info
aiwg mcp info
```

## Tool Surface

| Tool | Description |
|------|-------------|
| `discover` | Search AIWG skills, agents, commands, rules, flows, runbooks, templates, and behaviors |
| `skill-list` / `skill-show` | List skills and fetch full SKILL.md bodies |
| `command-list` / `command-show` | List CLI commands and fetch command definitions |
| `rule-list` / `rule-show` | List rules and fetch rule bodies |
| `agent-list` / `agent-show` | List agents and fetch agent definitions |
| `template-list` / `template-show` / `template-render` | List, fetch, and render templates |
| `command-run` | Run allow-listed `aiwg` CLI commands |
| `artifact-read` | Read artifacts from .aiwg/ directory |
| `artifact-write` | Write artifacts to .aiwg/ directory |

Opt-in toolsets add Flow, Mission, memory, knowledge-base, research,
activity-log, index, Ralph, Mission Control, ops, and Agentic Sandbox tools:

```bash
aiwg mcp serve --toolsets=flows,missions
aiwg mcp serve --toolsets=sandbox
aiwg mcp serve --toolsets=all
```

The `sandbox` toolset exposes revisioned fleet inventory/admission/observation/
reconciliation and governed activity coverage/timeline/export. Configure it with
`AIWG_SANDBOX_MANAGEMENT_URL` and a mode-`0600` bearer file named by
`AIWG_SANDBOX_MANAGEMENT_TOKEN_FILE`. Credentials are server configuration,
never tool inputs or outputs. Non-loopback endpoints must use HTTPS. Mutations
and evidence export require `confirmed: true`; unsupported upstream endpoints
return a typed `supported: false` result for HTTP 404/405.

`workflow-run` has been removed from the core MCP surface. Use `command-run`
for general CLI execution, the `flows` toolset for `flow-list` / `flow-show` /
`flow-run`, or the `missions` toolset for Mission guide, dispatch, and status.

## Available Prompts

| Prompt | Description |
|--------|-------------|
| `decompose-task` | Break down complex tasks into steps |
| `parallel-execution` | Plan parallel agent workflows |
| `recovery-protocol` | Handle workflow failures |

These prompts are auto-integrated and available in compatible tools.

## Configuration

### Claude Code

`aiwg mcp install claude` configures **Claude Code** — the CLI and Claude
Desktop's Code tab — using project-scoped `.mcp.json`. The generated `aiwg`
entry has no `env` block and inherits the user's environment. With `--scope
user`, install writes `AIWG_ROOT` only when it is set in the environment.
`aiwg mcp inject --provider claude --scope user` (or `aiwg mcp install claude
--scope user`) writes the top-level `mcpServers` of private `~/.claude.json`.
User config writes always set mode `0600`, including existing files.
Project-scope inject and install refuse non-empty literal `env` or `headers`
and URL userinfo, reporting only server and key names; use `--scope user`
for those values because `.mcp.json` is meant to be committed.
Config writes reject symlink destinations; project writes also reject symlink
parents below the project directory. JSON installation refuses malformed JSON,
non-object roots, and non-object server maps without changing the file.
Writes use atomic replacement, preserve existing project file permissions,
and apply the process umask to new project files.
Claude Code does not read `mcpServers` from `.claude/settings.json` or
`.claude/settings.local.json`; entries that earlier AIWG releases wrote there
were never loaded and can be deleted.

This is distinct from the Claude Desktop **chat app** (the Cowork surface),
which reads MCP servers from its own `claude_desktop_config.json`
(`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS,
`~/.config/Claude/claude_desktop_config.json` on Linux,
`%APPDATA%\Claude\claude_desktop_config.json` on Windows). `aiwg mcp
install` does not write that file today; see
[roctinam/aiwg#2632](https://git.integrolabs.net/roctinam/aiwg/issues/2632)
for that work.

### Cursor

After running `aiwg mcp install cursor`, the config is added to your Cursor settings.

## Manual Configuration

If automatic installation doesn't work, add this to your MCP config:

```json
{
  "mcpServers": {
    "aiwg": {
      "command": "aiwg",
      "args": ["mcp", "serve"]
    }
  }
}
```

## Credentials in Injected Servers

A registry entry can carry a credential as a literal value (`--env`, `--headers`) or as a reference to an
environment variable (`--header-env HEADER=VAR`, `--env-from NAME=VAR`). A reference writes only the
variable name; the harness reads the value when it starts the server. Each harness spells a reference
differently:

| Harness | `--header-env` / `--env-from` renders as |
| --- | --- |
| Claude Code | `${VAR}` |
| Cursor, Windsurf | `${env:VAR}` |
| Factory | `${VAR}` |
| opencode | `{env:VAR}` |
| OMP, Grok Build | `${VAR}` |
| Codex | `env_http_headers = { HEADER = "VAR" }` and `env_vars = ["VAR"]` |
| Antigravity, Warp | refused: neither documents interpolation in its MCP config |

Codex forwards a variable only under its own name, so `--env-from` for Codex must map `VAR=VAR`.
Claude Code reads `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `NPM_TOKEN` as empty in a remote
server's URL and headers, so do not reference those.

The credential policy decides what `aiwg mcp inject` will render:

| Policy | Flag | Renders |
| --- | --- | --- |
| `literal` (default) | none | everything |
| `references` | `--strict-credentials` | references only; refuses literal `env`/`headers`, URL userinfo, OAuth client secrets |
| `none` | `--no-credentials` | refuses every credential-bearing field, references included |

A refusal names each server and field, exits non-zero and writes nothing, including in `--ephemeral`
mode. Precedence is the flag, then `AIWG_MCP_CREDENTIAL_POLICY`, then the registry default set with
`aiwg mcp credential-policy <policy>`. `aiwg session --provider codex --profile <p>` applies the same
policy before setup and launch. Any setup failure prevents launch and reuse of an existing runtime
config. With `--persist`, successful injection launches against the default Codex home.

Persistent injection applies credential policy to the selected registry servers. Unrelated entries
already in the provider config are preserved, including their credentials. Use `--ephemeral` or a
Codex profile runtime home to render a standalone server set under a restrictive policy.
The profile config removes the entire global `mcp_servers` subtree, including inline and quoted
forms, and refuses malformed base TOML instead of copying it.

Ephemeral and Codex runtime-home configs are written owner-only (0600). Codex runtime homes use
0700; runtime and persistent Codex config writes are atomic and refuse symlink targets.
A symlinked global `~/.codex` home is supported; `roles-runtime`, profile directories, and
runtime config files beneath it must be real directories/files. Runtime profile names must match
`[a-z0-9-]+`.
`aiwg mcp add` and `update` show env/header key names only and redact URL userinfo.
Persistent project files such as
`.mcp.json` should hold credential references rather than literal secrets.

## Technical Details

- **Transport:** stdio (standard input/output)
- **Protocol Version:** MCP 2025-11-25
- **Implementation:** TypeScript with @modelcontextprotocol/sdk

## Further Reading

- [MCP Profiles](./profiles.md) — Named server subsets, provider overrides, ephemeral inject
- [Codex Per-Profile Runtime Homes](./codex-profiles.md) — OAuth isolation for Codex via runtime home adapter
- [MCP Specification Research](../references/REF-066-mcp-specification-2025.md) — Implementation details
- [MCP Official Docs](https://modelcontextprotocol.io/) — Protocol specification
