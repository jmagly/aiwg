# MCP Profiles

Named, ordered subsets of registered MCP servers. Profiles let you launch sessions
or inject only the servers relevant to a specific task, without modifying your
default provider configuration.

- **Registry file:** `~/.aiwg/mcp-profiles.json`
- **Schema:** `apiVersion: aiwg.io/v1`, `kind: McpProfileRegistry`

## Why MCP Profiles

Loading every registered MCP server in every session creates two compounding problems:

**Token pressure** — MCP servers inject their tool manifests into the context at the start of every session. The measured impact across the built-in presets:

| Profile | Servers | Approximate token overhead |
|---------|---------|--------------------------|
| `minimal` | none | ~0 |
| `dev` | 3 servers | ~6 K tokens |
| `ops` | 3 servers | ~7 K tokens |
| `incident` | 4 servers | ~9 K tokens |
| `full` | all (5+) | ~15–21 K tokens |

Keeping a heavy code-search server loaded while doing ops work burns budget on every prompt — and the model can't use it for anything relevant.

**Über-agent behaviour** — when a model sees too many tools, it sometimes reaches for an irrelevant one because it looks plausibly useful. A model that can search the codebase *and* write to CMDB *and* read Google Calendar will occasionally try all three on a task that only needed one. Profiles constrain the visible toolset to what the task actually requires.

The preset profiles map directly to common task classes. Run `aiwg mcp profile init-presets` once to install them, then use `aiwg session --profile <name>` at task start.

`git-gitea` is provider-agnostic: any AIWG provider with MCP injection/support can use it. Some provider guides, especially Hermes, may recommend or require MCP wiring for normal tool access, but that is provider setup guidance, not Git MCP ownership or exclusivity.

## Quick Start

```bash
# Install built-in presets
aiwg mcp profile init-presets

# Launch claude with the 'dev' profile (ephemeral — default config unchanged)
aiwg session --profile dev

# Launch codex with the 'ops' profile
aiwg session --provider codex --profile ops
```

## Preset Profiles

Installed by `aiwg mcp profile init-presets`. Do not overwrite existing profiles with the same name.

| Name | Servers | Description |
|------|---------|-------------|
| `minimal` | (none) | Minimal toolset for smoke tests |
| `dev` | git-gitea, codeindex-codehound, memory-fortemi | Code editing + git + memory |
| `ops` | git-gitea, cmdb-itassets, memory-fortemi | Infra + git + CMDB |
| `research` | memory-fortemi, google-drive, google-calendar | Documentation + memory + calendar |
| `incident` | git-gitea, cmdb-itassets, memory-fortemi, codeindex-codehound | Incident response |
| `full` | `__all__` | All registered servers (expands at inject time) |

The `git-gitea` entries in `dev`, `ops`, and `incident` are task-profile choices available to all MCP-capable providers. Provider-specific allow/deny rules may restrict dangerous write tools, but they do not make Git MCP provider-specific.

Profiles scope **external MCP servers** from the registry. AIWG's own server
toolsets are controlled separately by `AIWG_MCP_TOOLSETS` or
`aiwg mcp serve --toolsets=<csv>`. For example, first-class Flow/Mission tools
come from `AIWG_MCP_TOOLSETS=flows,missions`, not from the `minimal/dev/ops`
profile presets. Keep the two boundaries separate: profiles decide which
servers are visible; toolsets decide which optional AIWG tools that one server
registers.

## Profile Management

### Create a profile

```bash
aiwg mcp profile add <name> --servers <a,b> [--description <text>]
```

Server names must exist in the registry (`aiwg mcp list`). Use the special sentinel
`__all__` to expand to all registered servers at inject time.

```bash
aiwg mcp profile add my-work \
  --servers git-gitea,memory-fortemi \
  --description "Daily work — git + memory only"
```

### Inspect profiles

```bash
# List all profiles
aiwg mcp profile list

# Show a profile and its resolved servers
aiwg mcp profile show dev
```

### Edit a profile

```bash
# Add a server
aiwg mcp profile edit my-work --add-server codeindex-codehound

# Remove a server
aiwg mcp profile edit my-work --remove-server memory-fortemi

# Update description
aiwg mcp profile edit my-work --description "Code + search"
```

### Remove a profile

```bash
aiwg mcp profile remove my-work
```

### Import / export

```bash
# Export one profile
aiwg mcp profile export dev --out ./dev-profile.json

# Export all profiles
aiwg mcp profile export --out ./all-profiles.json

# Import from file
aiwg mcp profile import ./shared-profiles.json
```

Importing merges profiles: existing profiles are updated, new profiles are added.
Invalid names are skipped silently.

## Using Profiles in Sessions

### Ephemeral (default)

The provider's default config is **not modified**. A temp config is written for the
duration of the session.

```bash
aiwg session --profile dev                   # claude (default provider)
aiwg session --provider codex --profile ops  # codex
```

For Claude: the temp config is passed via `--mcp-config <path>`.  
For Codex: a per-profile runtime home is set up instead (see [Codex Profiles](./codex-profiles.md)).

### Persistent

Writes the profile's servers into the provider's default config permanently.

```bash
aiwg session --profile dev --persist
```

### Ephemeral inject (direct)

```bash
# Write ephemeral config to a temp file
aiwg mcp inject --provider claude --profile ops --ephemeral

# Write to a specific path
aiwg mcp inject --provider claude --profile ops --ephemeral --out /tmp/ops.json
```

## Provider Support

Profile-aware sessions work differently per provider. AIWG handles the differences behind the scenes — `aiwg session --profile <name>` produces the right behaviour for the active provider.

| Provider | Support level | Mechanism |
|----------|--------------|-----------|
| **Claude Code** | Native | Ephemeral JSON config passed via `claude --mcp-config <tmp>`. Default config unchanged. |
| **Codex** | Emulated | Per-profile runtime home (`HOME=~/.codex/roles-runtime/<profile>/`). OAuth tokens isolated per profile. See [Codex Profiles](./codex-profiles.md). |
| **Cursor** | Native | Standalone `.cursor/mcp.json` written ephemerally or persistently. |
| **OpenCode** | Native | Config file injection via provider adapter. |
| **Windsurf** | Native | Config file injection via provider adapter. |
| **Factory** | Native | Config file injection via provider adapter. |
| **Warp** | Degraded | Warp does not support file-based MCP config switching. `aiwg session --profile` for Warp prints setup instructions and the exact server list to configure via Warp's UI (Settings → AI → MCP Servers). |
| **GitHub Copilot** | Degraded | Copilot MCP configuration is managed through VS Code settings. AIWG generates the correct `mcp` block and prints instructions for manual insertion. |
| **OpenClaw** | Native | Config injection to `~/.openclaw/` profile directory. |

### Ephemeral vs persistent

By default, `aiwg session --profile <name>` uses **ephemeral** mode — a temporary config is created for the session duration and the provider's default config is never modified. When the session ends, the temp file is deleted.

Use `--persist` to write the profile's servers into the provider's default config permanently:

```bash
aiwg session --profile dev --persist   # modifies default config
aiwg session --profile dev             # ephemeral (default)
```

Warp and Copilot do not support ephemeral mode — `--persist` is implicit, and AIWG prints what to copy into the UI rather than modifying config files.

## Provider Overrides

Profiles can carry per-provider tool allow/deny lists. These restrict which tools
from a server are exposed to a specific provider without affecting other providers.

### Structure

```json
{
  "name": "dev",
  "servers": ["git-gitea", "memory-fortemi"],
  "providerOverrides": {
    "codex": {
      "toolDeny": ["git-gitea__delete_*", "git-gitea__actions_config_write"],
      "toolAllow": []
    }
  }
}
```

**`toolDeny`** — glob patterns of tool names to block for this provider.  
**`toolAllow`** — a per-server allowlist: for each server named in an allow pattern, only its listed
tools are exposed. Servers absent from the allow patterns remain unrestricted by `toolAllow`;
`toolDeny` still applies to them. Codex prints a warning naming those unrestricted servers.
Add allow patterns for every server to restrict the entire profile, or deny an omitted server
with `<server>__*`. Provider support and overlap precedence differ as described below.

Claude Code refuses `toolAllow`: its allow rules pre-approve tools and cannot restrict availability.
Codex uses exact tool names; deny rules win an identical allow/deny overlap. OpenCode uses the last
matching key: AIWG emits deny keys before allow keys so an explicit allow can override a matching
wildcard deny. An identical key present in both lists stays denied. Factory, Windsurf and Antigravity
have no documented tool allowlist and warn instead. See [tool filter support](./README.md#profile-tool-filters).

Tool name format: `<server-name>__<tool-name>`, e.g. `git-gitea__delete_branch`.
Glob patterns are supported: `git-gitea__delete_*` blocks all delete operations.

### The `dev` preset and Codex

The built-in `dev` preset ships with a Codex override that blocks destructive Gitea
operations. This prevents accidental branch/repo deletion when running Codex against
a shared Gitea instance:

```json
"providerOverrides": {
  "codex": {
    "toolDeny": ["git-gitea__delete_*", "git-gitea__actions_config_write"]
  }
}
```

### Setting overrides via CLI

Provider overrides are not yet editable via `aiwg mcp profile edit`. Edit
`~/.aiwg/mcp-profiles.json` directly or use import/export to update the JSON.

## Registry File Format

`~/.aiwg/mcp-profiles.json`:

```json
{
  "apiVersion": "aiwg.io/v1",
  "kind": "McpProfileRegistry",
  "profiles": {
    "dev": {
      "name": "dev",
      "description": "Code editing + git + memory",
      "servers": ["git-gitea", "codeindex-codehound", "memory-fortemi"],
      "providerOverrides": {
        "codex": {
          "toolDeny": ["git-gitea__delete_*", "git-gitea__actions_config_write"]
        }
      },
      "createdAt": "2026-04-17T00:00:00.000Z",
      "updatedAt": "2026-04-17T00:00:00.000Z"
    }
  }
}
```

## Migrating from sysops Scripts

If you used `roctinam/sysops` shell wrappers (`claude-role.sh` / `codex-role.sh`), the AIWG profile system is the direct replacement. The mental model is identical — named role, scoped MCP servers, isolated auth for Codex — but it's provider-agnostic and managed by AIWG rather than maintained in a separate repo.

### Claude

| Before | After |
|--------|-------|
| `claude-role dev` | `aiwg session --profile dev` |
| `claude-role ops` | `aiwg session --profile ops` |
| `claude-role minimal` | `aiwg session --profile minimal` |

`aiwg session` passes `--mcp-config` to Claude with an ephemeral config — same mechanism `claude-role.sh` used.

### Codex

| Before | After |
|--------|-------|
| `codex-role dev` | `aiwg session --provider codex --profile dev` |
| `codex-role ops -- login` | `aiwg mcp profile login ops --provider codex` |
| Manual `~/.codex/roles-runtime/dev/` setup | Handled automatically by AIWG on first run |

The runtime home layout (`~/.codex/roles-runtime/<profile>/`) is identical to the sysops implementation, so existing auth tokens in those directories are reused automatically on the first `aiwg session` run. No re-authentication needed.

### Deprecation timeline

Once `aiwg session --profile` is running in your environment, the sysops wrappers can be removed from `.bashrc`. The tab-completion aliases (`alias claude-role=...`) can be replaced with shell aliases pointing to `aiwg session` if preferred:

```bash
# Optional: keep short aliases
alias cr='aiwg session --profile'              # cr dev, cr ops, cr minimal
alias crx='aiwg session --provider codex --profile'  # crx dev, crx ops
```

## Further Reading

- [Codex Per-Profile Runtime Homes](./codex-profiles.md) — OAuth isolation for Codex
- [MCP Server Registry](./README.md) — Registering and managing servers
- [CLI Reference: mcp profile](https://github.com/jmagly/aiwg/blob/main/docs/cli/reference.md#mcp-profile) — Full command reference
