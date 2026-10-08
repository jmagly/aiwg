# Claude Code MCP Sidecar — AIWG Tooling Layer

Connect the AIWG MCP server to Claude Code for structured artifact management and workflow tools.

> **This is a tooling layer, not a permission workaround.** Claude Code already supports `--dangerously-skip-permissions` for unrestricted filesystem access. The MCP sidecar adds a complementary layer: structured AIWG tools for artifact management, template rendering, and workflow execution.

---

## Two-Layer Model

| Layer | Flag / Tool | Controls |
|---|---|---|
| **Permission** | `--dangerously-skip-permissions` | Filesystem access, tool approval |
| **Tooling** | MCP sidecar (`aiwg mcp serve`) | AIWG artifact tools, workflows, templates |

Both layers are independent. You can use either or both:

| Configuration | Use Case |
|---|---|
| Permission only | Direct file editing with full access |
| Sidecar only | AIWG tools with standard permission prompts |
| Both (recommended) | Full AIWG experience — unrestricted access + structured tooling |

---

## Architecture

```
Claude Code (host)
  ├── Conversation, code editing
  ├── --dangerously-skip-permissions (permission layer)
  └── MCP connection (tooling layer)
        └── AIWG MCP Server (sidecar)
              ├── discover / command-run
              ├── artifact-read / artifact-write
              ├── template-render
              └── agent-list
```

---

## Setup

### Step 1: Install MCP Configuration

```bash
aiwg mcp install claude
```

This creates or merges into `.mcp.json` in the project root:

```json
{
  "mcpServers": {
    "aiwg": {
      "command": "aiwg",
      "args": ["mcp", "serve"],
      "env": {
        "AIWG_ROOT": "~/.local/share/ai-writing-guide"
      }
    }
  }
}
```

### Step 2: Verify

Restart Claude Code, then ask: "What AIWG MCP tools are available?"

Claude Code should list the AIWG core tools.

### Step 3: Use Both Layers Together

```bash
# Launch with both layers active
aiwg sdlc-accelerate "My project" --provider claude --dangerous
```

Claude Code starts with `--dangerously-skip-permissions` and has AIWG MCP tools available via the sidecar simultaneously.

---

## What the Sidecar Adds

Without the sidecar, Claude Code can read and write files directly but has no structured interface to AIWG's artifact system. With it:

| Tool | Purpose |
|---|---|
| `discover` | Find AIWG skills, commands, rules, agents, and Flow wrapper skills |
| `command-run` | Invoke allow-listed AIWG CLI commands programmatically |
| `artifact-read` | Structured read from `.aiwg/` with schema validation |
| `artifact-write` | Structured write to `.aiwg/` with schema validation |
| `template-render` | Fill AIWG templates with project context |
| `agent-list` | Discover and invoke specialized agents by role |

`workflow-run` has been removed. Use `command-run` for general AIWG CLI execution. For first-class YAML Flow tools, start the server with `AIWG_MCP_TOOLSETS=flows` and allow `flow-list`, `flow-show`, and `flow-run`. For Mission tools, use `AIWG_MCP_TOOLSETS=missions` and allow `mission-guide`, `mission-dispatch`, and `mission-status`.

---

## Example Workflows

### SDLC Accelerate with Full Stack

```bash
# Both layers active
aiwg sdlc-accelerate "E-commerce platform" --provider claude --dangerous
```

Claude Code runs with full filesystem access and can call AIWG MCP tools for structured artifact management.

### Agent Loop with Sidecar

```bash
aiwg ralph "Fix all auth tests" --completion "npm test passes" --provider claude --dangerous
```

The agent loop agent can use `artifact-read` to check existing requirements and `artifact-write` to update test documentation alongside its direct file edits.

### Artifact-Driven Workflow

Without `--dangerous`, the sidecar still provides structured access:

```bash
# Start Claude Code normally, with AIWG tools available
claude .
```

Then ask Claude Code to:

```
Create a Software Architecture Document for this project using AIWG templates
and save it to .aiwg/architecture/.
```

Claude Code calls `template-render` to generate the document and `artifact-write` to persist it with schema validation.

---

## Verification Checklist

| Check | Action | Expected |
|---|---|---|
| MCP connection | Ask "list AIWG tools" | AIWG core tools listed |
| Artifact write | Ask to create an ADR | File appears in `.aiwg/architecture/` |
| Permission layer | Edit a file outside `.aiwg/` | No permission prompt (with `--dangerous`) |
| Combined | Run a workflow that reads requirements and writes code | Both layers work together |

---

## Troubleshooting

**AIWG tools not visible in Claude Code:**
- Check `.mcp.json` has the `mcpServers.aiwg` entry
- Check that you approved the project server (`claude mcp list` shows its state)
- Verify `aiwg mcp serve` runs successfully standalone: `aiwg mcp info`
- Restart Claude Code after config changes

**Permission prompts still appearing with the sidecar:**
- The sidecar does not grant filesystem permissions — that is the `--dangerously-skip-permissions` flag
- Use `--dangerously-skip-permissions` (via `--dangerous` shorthand) for unrestricted filesystem access

**Artifacts not appearing in `.aiwg/`:**
- Ensure AIWG is initialized in the project: `aiwg use sdlc`
- Check that `artifact-write` is in the tool whitelist
- Verify the working directory matches the project root

---

## Related Resources

- [Claude Code Quick Start](claude-code-quickstart.md) — Basic AIWG + Claude Code integration
- [Hermes MCP Sidecar](hermes-quickstart.md) — Reference sidecar implementation
- [AIWG MCP server reference](https://github.com/jmagly/aiwg/blob/main/docs/cli/reference.md#mcp)
