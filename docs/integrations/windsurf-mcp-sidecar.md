# Devin Desktop MCP Sidecar Guide

Connect AIWG to Devin Desktop Cascade AI as an MCP sidecar for structured workflow access.

> **This is not a standard provider deployment.** Devin Desktop is an IDE-integrated AI assistant that cannot be spawned from the CLI. The MCP sidecar provides structured AIWG tool access from within Devin Desktop's Cascade agent. The architecture is `Devin Desktop Cascade AI → MCP → AIWG Server`. Devin Desktop supports stdio, Streamable HTTP, and SSE transports for MCP connections, with a 100-tool limit across all connected servers.

---

See [Desktop path verification](../providers/devin-desktop-paths.md) for retained paths and the pending 3.14 check.

## Architecture

```
Devin Desktop Cascade AI (host)
  ├── Cascade conversation and workflows
  ├── AGENTS.md (aggregated agent definitions)
  ├── .windsurf/ (skills, rules, workflows)
  └── MCP connection
        └── AIWG MCP Server (sidecar)
              └── .aiwg/ artifacts, workflows, templates
```

**Devin Desktop owns**: Cascade conversation context, AGENTS.md aggregation, `.windsurf/` directory, workflow invocation.

**AIWG owns**: workflow execution, artifact output in `.aiwg/`, template rendering, agent role definitions.

**MCP is the seam.** Devin Desktop already receives AIWG agent and workflow definitions via `aiwg use sdlc --provider devin`. The MCP sidecar adds structured, callable AIWG tooling on top of that foundation — without replacing it.

---

## Prerequisites

- Devin Desktop installed and running ([windsurf.ai](https://windsurf.ai))
- AIWG installed: `npm install -g aiwg`
- A project with AIWG deployed for Devin Desktop:

```bash
cd /path/to/your/project
aiwg use sdlc --provider devin
```

If you have not done the base deployment yet, complete the [Devin Desktop Quick Start](windsurf-quickstart.md) first, then return here.

---

## Install MCP Configuration

Run the AIWG install command to write the MCP configuration for Devin Desktop:

```bash
aiwg mcp install devin
```

This writes (or updates) `~/.codeium/windsurf/mcp_config.json` with the AIWG server entry.

**Verify the config was written:**

```bash
cat ~/.codeium/windsurf/mcp_config.json
```

You should see:

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

After writing the config, restart Devin Desktop to pick up the new MCP server.

---

## Configure Tool Whitelist

The default config connects to the full AIWG MCP surface. Restrict to the five core tools to keep Cascade's context budget manageable:

**Edit `~/.codeium/windsurf/mcp_config.json`:**

```json
{
  "mcpServers": {
    "aiwg": {
      "command": "aiwg",
      "args": ["mcp", "serve"],
      "tools": {
        "include": [
          "discover",
          "command-run",
          "artifact-read",
          "artifact-write",
          "template-render",
          "agent-list"
        ],
        "prompts": false,
        "resources": false
      }
    }
  }
}
```

**Why this whitelist:** Each MCP server exposes its tool schemas into the Cascade context window before any tool is called. The lean whitelist keeps discovery, CLI dispatch, artifact IO, templates, and agents available without enabling every opt-in subsystem. See the [Context Budget](#context-budget) section for the full breakdown.

A ready-to-use minimal config template is available at `agentic/code/frameworks/sdlc-complete/templates/windsurf/windsurf-mcp-minimal.json`.

---

## Verify the Connection

After restarting Devin Desktop, ask Cascade to confirm the tools are available:

```text
What AIWG MCP tools are available?
```

Cascade should list the lean whitelisted tools, including `discover`, `command-run`, `artifact-read`, `artifact-write`, `template-render`, and `agent-list`.

**Verify AIWG MCP server runs independently:**

```bash
aiwg mcp info    # Show capabilities
aiwg version     # Confirm CLI is in PATH
```

If Cascade cannot see the tools, check that `aiwg` is accessible from the PATH that Devin Desktop uses when launching processes.

---

## Run Your First Workflow

Ask Cascade to create a structured artifact that routes through the AIWG MCP server:

```text
Create an architecture decision record for choosing PostgreSQL over MongoDB
for our user service. Save it as a persistent AIWG artifact.
```

**What should happen:**

1. Cascade recognizes this as a structured artifact request
2. Cascade calls `command-run`, `template-render`, or `artifact-write` via MCP
3. AIWG creates the artifact in `.aiwg/architecture/`
4. Cascade reports the result

**Verify the artifact was written:**

```bash
ls .aiwg/architecture/
```

You should see the new ADR file.

---

## Context Budget

Understanding the token footprint helps you configure the whitelist for your needs.

### With lean whitelist (recommended)

| Component | Tokens |
|---|---|
| Cascade system context | ~2,000 |
| AGENTS.md (aggregated agents) | ~3,500 |
| AIWG MCP schema (lean tools) | bounded |
| **Total overhead** | **~8,500** |
| **Available for work** (128K context) | **~119,500 (93%)** |

### Without whitelist (full surface)

| Component | Tokens |
|---|---|
| Cascade system context | ~2,000 |
| AGENTS.md (aggregated agents) | ~3,500 |
| AIWG MCP schema (core + opt-in toolsets) | larger |
| **Total overhead** | **~17,500** |
| **Available for work** (128K context) | **~110,500 (86%)** |

Devin Desktop has a large default context window, so the absolute impact is lower than on memory-constrained local models. The whitelist still matters for response latency: Cascade must process all schema tokens on every tool-using turn.

---

## Advanced — Enable Prompts

After the basic integration is stable, you can enable AIWG prompt exposure for richer workflow access.

**Update `~/.codeium/windsurf/mcp_config.json`:**

```json
{
  "mcpServers": {
    "aiwg": {
      "command": "aiwg",
      "args": ["mcp", "serve"],
      "tools": {
        "include": [
          "discover",
          "command-run",
          "artifact-read",
          "artifact-write",
          "template-render",
          "agent-list"
        ],
        "prompts": true,
        "resources": false
      }
    }
  }
}
```

This adds AIWG workflow prompts as callable templates from within Cascade. Only enable after the base integration in the previous sections is working reliably.

A ready-to-use full config template is available at `agentic/code/frameworks/sdlc-complete/templates/windsurf/windsurf-mcp-full.json`.

---

## Validation Checklist

Run these checks to confirm the integration is working:

| Check | Action | Expected |
|---|---|---|
| Connectivity | Ask "What AIWG tools are available?" | Lean tools listed |
| Routing (direct) | Ask a one-off question | Cascade answers directly (no MCP call) |
| Routing (artifact) | Ask for a requirements document | Routes to AIWG via MCP |
| Artifact write | Check `.aiwg/` after workflow | New artifact file exists |
| Artifact read | Ask Cascade to read an existing artifact | Uses `artifact-read` |
| Failure mode | Run `aiwg mcp serve` in isolation, confirm it starts | No errors |

---

## Troubleshooting

**AIWG tools not visible in Cascade:**

- Verify `aiwg mcp serve` runs successfully on its own
- Confirm `~/.codeium/windsurf/mcp_config.json` is valid JSON (use `jq . ~/.codeium/windsurf/mcp_config.json`)
- Ensure `aiwg` is in your PATH (check `which aiwg`)
- Restart Devin Desktop after any config change

**Artifacts not appearing in `.aiwg/`:**

- Confirm AIWG is initialized in the project (`aiwg use sdlc --provider devin`)
- Check that `artifact-write` is in the tool whitelist
- Verify Devin Desktop's working directory matches the project root

**Context growing too fast:**

- Confirm `prompts: false` and `resources: false` in the MCP config
- Keep the whitelist lean unless you have a specific reason to add more tools or toolsets

**Config location not found:**

- The config path is `~/.codeium/windsurf/mcp_config.json`
- Create the directory if it does not exist: `mkdir -p ~/.codeium/windsurf`
- Re-run `aiwg mcp install devin` after creating the directory

---

## Related Resources

- [Devin Desktop Quick Start](windsurf-quickstart.md) — base provider deployment (prerequisite)
- [Hermes MCP Sidecar Guide](hermes-quickstart.md) — reference architecture this guide follows
- [AIWG MCP server reference](https://github.com/jmagly/aiwg/blob/main/docs/cli/reference.md#mcp)
- [Devin Desktop Documentation](https://windsurf.ai/docs)
