---
namespace: aiwg
name: session
platforms: [all]
description: Start an agentic session with pre-flight health checks, auto-repair, optional MCP injection, and provider launch
---

# AIWG Session

Start a fully-prepared agentic session. Pre-flight checks run automatically: version currency, health diagnostics, and deployment verification. Issues are auto-repaired before launch. Pass `mcp` to inject configured MCP servers into the provider config first.

For past conversations, cross-provider timelines, or catalog queries, use
`aiwg show skill session-explore --body`. The plural `aiwg sessions` namespace manages
history; this skill launches a new provider session.
## Triggers

Alternate expressions and non-obvious activations (primary phrases are matched automatically from the skill description):

- "start a session" → `aiwg session`
- "launch claude" → `aiwg session --provider claude`
- "start with mcp" → `aiwg session mcp`
- "start fresh" → `aiwg session` (triggers full pre-flight)
- "launch codex" → `aiwg session --provider codex`

## Trigger Patterns Reference

| Pattern | Example | Action |
|---------|---------|--------|
| Default launch | "start a session" | `aiwg session` |
| Explicit provider | "launch with codex" | `aiwg session --provider codex` |
| With MCP | "start with my MCP servers" | `aiwg session mcp` |
| MCP + provider | "launch cursor with MCPs" | `aiwg session mcp --provider cursor` |
| Skip repair | "just launch, skip checks" | `aiwg session --no-repair` |

## Behavior

When triggered:

1. **Resolve provider**: `--provider` flag → project config `providers[0]` → user config → `claude`

2. **Pre-flight** (auto-repair enabled by default):
   - Version check — updates aiwg if stale
   - Health check (`aiwg doctor`) — auto-repairs fixable issues
   - Deployment check — redeploys missing framework files
   - If repair fails: offers full reinstall + redeploy
   - If unresolvable: surfaces `aiwg feedback --type bug`

3. **MCP inject** (when `mcp` subcommand is used):
   ```bash
   aiwg mcp inject --provider <provider>
   ```

4. **Launch**:
   - Spawnable providers (claude, codex, opencode): launches the binary directly
   - IDE providers (cursor, devin, copilot, factory, warp): prints ready instructions

## Examples

### Example 1: Default session

**User**: "Start a session"

**Action**:
```bash
aiwg session
```

**Flow**: version check → doctor → deployment check → launch `claude`

### Example 2: Session with MCP

**User**: "Start a session with my MCP servers"

**Action**:
```bash
aiwg session mcp
```

**Flow**: version check → doctor → deployment check → `aiwg mcp inject --provider claude` → launch `claude`

### Example 3: Specific provider

**User**: "Launch with codex and inject MCPs"

**Action**:
```bash
aiwg session mcp --provider codex
```

### Example 4: IDE provider (Cursor)

**User**: "Set up my cursor session"

**Action**:
```bash
aiwg session --provider cursor
```

**Flow**: full pre-flight for cursor → deployment check for `.cursor/` → `aiwg mcp inject --provider cursor` (if mcp requested) → prints "Open Cursor in your project directory"

### Example 5: Skip repair

**User**: "Just launch, skip the health checks"

**Action**:
```bash
aiwg session --no-repair
```

## Clarification Prompts

If the user's intent is ambiguous:

- "Which provider should I launch? (claude, codex, opencode, cursor, ...)"
- "Should I inject your configured MCP servers before launching?"

## References

- @$AIWG_ROOT/src/cli/handlers/session.ts — Session command handler
- @$AIWG_ROOT/src/cli/agent-spawn.ts — Provider launch map
- @$AIWG_ROOT/docs/cli-reference.md — CLI reference (session section)
