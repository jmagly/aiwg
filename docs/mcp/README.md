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
Desktop's Code tab, which share project configuration. After running it, the
config is placed at `.claude/settings.local.json` in the project directory.

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

## Technical Details

- **Transport:** stdio (standard input/output)
- **Protocol Version:** MCP 2025-11-25
- **Implementation:** TypeScript with @modelcontextprotocol/sdk

## Further Reading

- [MCP Profiles](./profiles.md) — Named server subsets, provider overrides, ephemeral inject
- [Codex Per-Profile Runtime Homes](./codex-profiles.md) — OAuth isolation for Codex via runtime home adapter
- [MCP Specification Research](../references/REF-066-mcp-specification-2025.md) — Implementation details
- [MCP Official Docs](https://modelcontextprotocol.io/) — Protocol specification
