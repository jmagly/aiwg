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

Artifact containment holds against any path the caller supplies; it does not hold against concurrent modification of the artifact tree by another local process. Leftover temporary files after a failed write are possible.

Artifact stores configured by `.aiwg-location` or the artifact-root environment override are resolved and pinned at server start for the default project, and on first use for other `project_dir` selections. Linux uses descriptor-anchored I/O; macOS and Windows use static containment, symlink, and link-count checks. `artifact-write` refuses location pointer filenames.

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

`aiwg mcp install` resolves the same registry credential policy (stored
policy, organisation floor and `AIWG_MCP_CREDENTIAL_POLICY`) as `aiwg mcp
inject` and asserts it against every install-generated server definition
before writing, so a `references`/`none` policy still refuses any literal
credential an install target might carry. `AIWG_ROOT` is a filesystem path
to the AIWG installation, not an authorization credential, so it is a named,
narrow exemption from that check - `INSTALL_POLICY_EXEMPT_ENV` in
`src/mcp/credentials.mjs` - scoped to exactly this key on the built-in
`aiwg` server entry. It does not exempt any other env/header field, nor any
other server name.
`aiwg mcp inject --provider claude --scope user` (or `aiwg mcp install claude
--scope user`) writes the top-level `mcpServers` of private `~/.claude.json`.
User config writes always set mode `0600`, including existing files.
Project-scope inject refuses literal `env`/`headers` values, populated
`auth`/`oauth` fields, credential-bearing argument values, and URL userinfo,
reporting only server, key and flag names — never secret values. For `env` and
`headers`, empty strings and supported reference forms (`${VAR}`, `${env:VAR}`,
`{env:VAR}`) may be committed; non-string map values are rejected as invalid.
`auth`/`oauth` are stricter: every field except `type` is refused once it is
non-empty - `credentialId`, `callbackPort`, a `${VAR}`-shaped string, or any
other value - because OMP persists them alongside the secrets they describe
and this registry does not distinguish a reference-shaped OAuth field from a
literal one. The refusal names the provider's real private destination when
it documents one, otherwise it points at `--header-env`/`--env-from`
references, because `.mcp.json` is meant to be committed. A `--scope user`
request for a provider without a user-scope destination (Cursor, OpenCode) is
refused instead of writing the project file; this scope/destination decision
applies to every MCP config writer - `inject`, generic `install`, and OMP's
`install`/`uninject` - not only `inject`, and a provider's own environment
override for its config location (for example OMP's `PI_CODING_AGENT_DIR`)
never substitutes for the actual resolved destination.
Config writes reject symlink destinations; writes whose destination is inside
the project directory also reject symlink parents below the project directory.
JSON installation refuses malformed JSON,
non-object roots, and non-object server maps without changing the file.
Writes use atomic replacement; existing files keep their mode while newly
created registry files start at `0600`. Parent-directory checks are repeated
before the final rename, but when a parent directory is attacker-writable a
swap between that last check and the rename can still redirect the write.
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

## Layered Configuration

`AIWG_CONFIG_LAYERS` lists configuration directories, lowest precedence first, separated by the
platform path delimiter (`:` on Linux and macOS, `;` on Windows). Each directory may hold
`mcp-servers.json` and `mcp-profiles.json`. Use it to keep an organisation's servers and profiles in
one directory and a person's overlay for that organisation in another:

```bash
export AIWG_CONFIG_LAYERS=/etc/aiwg/acme:$HOME/.aiwg/acme-identity
aiwg mcp profile add acme-dev --extends acme-base --servers tracker
aiwg mcp inject --provider claude --profile acme-dev --ephemeral --out /tmp/acme-dev.json
```

| Rule | Behaviour |
| --- | --- |
| Precedence | A server or profile in a later layer replaces the entry of the same name in an earlier one, whole |
| `credentialPolicy` | Lower (organisation) layers fold to an enforced floor by strictness; the write layer's own value is a personal default that a flag or environment value may relax within that floor; inherited settings are never copied on writes |
| Writes | Last layer only; atomic replacement refuses symlink files and overlapping layer targets |
| Lower-layer entries | Updating one copies it into the last layer; removing one is refused |
| `extends` | A profile inherits the servers of each base profile (base first), from any layer |
| Tool filters under `extends` | `toolDeny` accumulates; the most-derived `toolAllow` wins |
| Set | `AIWG_CONFIG` is ignored for MCP servers and profiles |
| Unset | `AIWG_CONFIG` or `~/.aiwg` is the single directory, as before |

Injection records (`injectedProviders`, used by `inject --all`) for a server defined in a lower layer
are not persisted, so that the last layer holds no copy of an unchanged organisation entry.
Inherited top-level settings are also left out of writes; `apiVersion` and `kind` remain as format fields.
After an update copies an entry into the write layer, the same registry instance can remove that overlay.
The lower-layer entry becomes visible again immediately on that instance, and adding its name is refused.
Removing an override is not revocation: when the lower-layer entry still carries worker qualification, removal
is refused instead of silently re-exposing that qualification. The guard checks the lower-layer entry's own
qualification, not the override's, so restoring the override's command and re-qualifying the override does not
lift the refusal. The only way to remove it is to remove or change the entry in the lower layer that owns it -
which requires write authority over that layer. A user who can write only the identity layer, and whose
organisation layer is read-only to them, cannot remove such an override through this registry; this is a known
limitation, not a workaround. Selecting the identity directory directly (bypassing the layered registry
entirely) also bypasses this guard and can re-expose a qualified lower entry; that is not a qualification-safe
route either.
A profile cannot be removed while other profiles in any layer extend it; the error names the dependents.
Rejected mutations leave the cached view unchanged. An empty profile injects zero servers in either mode.
Config directory aliases and symlinked ancestors are supported, including dotfile-manager links.
Symlinks below the config directory and symlinked files remain refused. Overlap uses resolved realpaths;
missing suffixes are compared with case folding on case-insensitive filesystems. A temporary probe in the
nearest existing ancestor detects filesystem behavior; unprobeable ancestors use conservative case folding.
Profile import validates the complete candidate `extends` graph across all layers before writing;
cycles and missing bases are refused with the offending profile names.

Any lower (non-write) layer that sets `credentialPolicy` establishes an enforced organisation floor:
strictness is `literal` < `references` < `none`, and the floor is the strictest value set across every
lower layer. The write (identity) layer's own `credentialPolicy` is a personal default, not a second
floor - `aiwg mcp credential-policy <policy>` can set it to anything at or stricter than the floor;
CLI attempts to relax it below that floor are refused. A rendering flag or `AIWG_MCP_CREDENTIAL_POLICY`
may then freely relax or tighten that personal default for one invocation, but still cannot relax
below the organisation floor - such an attempt is ignored with a warning once per process per
attempted value, and the floor is used instead. The warning and the "cannot relax" refusal both name
the config file of the lower layer that set the floor. To change the floor itself, adjust that layer.
An unrelated save preserves an owned policy without copying an inherited floor; a stale overlay value
weaker than the floor is dropped with a warning on the next save. Explicit policy writes are preserved,
including a write equal to the floor. Invalid values in layer files report the file path.

## Profile Tool Filters

A profile can deny or allow individual tools. Patterns name a tool as `<server>__<tool>`; `<tool>` may
contain `*`, and `<server>__*` covers the whole server. The `*` provider key applies to every
provider, and a provider's own key adds to it:

```bash
aiwg mcp profile edit dev --tool-deny git-gitea__delete_repo
aiwg mcp profile edit dev --provider codex --tool-allow git-gitea__list_repos,git-gitea__get_file
aiwg mcp profile edit dev --provider codex --clear-tool-filters
```

`aiwg mcp inject --profile <p>` renders the filters into each provider's own setting. Anything a
provider cannot express is printed as a `WARNING` line on stderr; it is not applied. Claude Code
`toolAllow` is refused, as described below.

| Provider | toolDeny | toolAllow | Globs |
| --- | --- | --- | --- |
| Claude Code | `permissions.deny`: `mcp__<server>__<tool>` | refused (no restrict-only allowlist) | yes |
| Codex | `disabled_tools`; `enabled = false` for `<server>__*` | `enabled_tools` | no |
| opencode | `tools` map entry `<server>_<tool>: false` | `<server>_*: false`, then each tool `true` | yes |
| Factory, Antigravity | `disabledTools`; `disabled: true` for `<server>__*` | not supported | no |
| Windsurf | `disabledTools` | not supported | no |
| Cursor, Warp, OMP, Grok Build | not supported | not supported | |

`toolAllow` is per-server. Only servers named in an allow pattern enter allowlist mode; other
servers remain unrestricted by `toolAllow` and still receive any `toolDeny` rules. Codex warns
with their names. To restrict every server, list allowed tools for every server or use
`toolDeny: ["<server>__*"]` for servers that should be disabled.

Claude Code reads deny rules from settings, not from the MCP file. Persistent injection uses
`.claude/settings.local.json` (`~/.claude/settings.json` with `--scope user`). AIWG tracks the deny
rules it actually added in private `claude-tool-permissions/<path-hash>.json` records in the AIWG
config directory. The hash uses the settings parent directory's realpath plus the basename, so
project and dotfile aliases share ownership. Records also store a digest of `permissions.deny`,
independent of the rest of the settings file. When this array is unchanged, switching profiles
removes obsolete managed rules; `--clear-tool-filters` followed by re-injection removes them all.
If the array changed or a legacy record has no deny digest, AIWG preserves uncertain rules, keeps
tracking them, and warns with their names and the settings path. Later injections keep those rules;
remove them manually from `permissions.deny` when no longer wanted. Pre-existing user rules never
become managed, including identical deny rules. Unrelated settings changes do not prevent cleanup.
Keep ownership records across runs; deleting a record resets ownership and treats remaining rules
as user-owned. Invalid-record diagnostics name the record path and explain this reset.

Claude Code has no restrict-only allowlist: `permissions.allow` pre-approves tools rather than
restricting availability. Deny rules cannot express "all except", and allow rules cannot carve
exceptions out of deny rules. See [Claude Code permissions](https://code.claude.com/docs/en/permissions).
Injection, ephemeral injection and profile sessions therefore refuse any resolved Claude `toolAllow`
entries, including those inherited from `*`, and name the offending patterns. `toolDeny` still works.
Maintainers can remove these allow entries or scope them to providers with true allowlists; explicit
pre-approval remains a separate choice in Claude's own settings.

`--ephemeral --out run.json` writes `run.settings.json` for Claude deny rules and prints
`claude --mcp-config run.json --settings run.settings.json`. Claude profile sessions use the path
reported by injection and check that it exists before passing `--settings`; a missing expected
sidecar refuses launch. Settings destinations reject a symlinked file. For project writes, AIWG
also checks directories between the project root and file; the root itself may be a symlink.
User settings may use a symlinked `~/.claude` directory. Explicit ephemeral output paths check
parents from the filesystem root. The remaining parent-swap window between the final check and
rename is residual, as with other MCP config writes.

An implicit sidecar must be absent or an unchanged AIWG-created sidecar; it cannot overwrite an
unrelated file or share the MCP file's destination. Choose another `--out` path to resolve a
collision. New project settings, user settings and ephemeral files use mode `0600`; existing
project settings retain their mode. Settings JSON, its object root, permission object and rule
arrays are validated, and the ownership-record directory is checked for write access before
configuration writes. MCP config, settings and ownership records are written in that order;
a failed write restores earlier files and their modes, or removes outputs that did not exist.
This rollback handles reported write failures; it is not a crash-atomic transaction.

OpenCode uses the last matching tool rule. On each injection AIWG's keys follow existing keys,
with deny keys first and allow keys afterward. Explicit allows therefore override matching
wildcard denies; an identical allow/deny key stays denied. Preserved Antigravity server entries
receive profile filters while keeping their launch configuration. A non-array existing
`disabledTools` is refused with a diagnostic.

OpenCode `tools` keys and Antigravity `disabledTools` from an earlier profile are not tracked or
removed when switching profiles. Remove obsolete keys or disabled tools manually before switching
if they should no longer apply; Antigravity unions new disabled tools with the preserved array.

`aiwg session --provider codex --profile <p>` writes Codex filters into the profile's runtime config.
Persistent injection, installation and hook translation honor `CODEX_HOME` (default `~/.codex`); profile launches
set both `HOME` and `CODEX_HOME` to the isolated runtime home.

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
| `references` | `--strict-credentials` | references only; refuses literal credentials |
| `none` | `--no-credentials` | refuses every credential-bearing field, references included |

`references` refuses literal `env`/`headers`, URL userinfo and OAuth client secrets.

A refusal names each server and field, exits non-zero and writes nothing, including in `--ephemeral`
mode. The stored registry policy is a personal default: `AIWG_MCP_CREDENTIAL_POLICY` and the rendering
flag may each freely relax or tighten it for one invocation - the most specific source wins (flag over
environment over the stored policy), including a relaxation. This restores the single-registry
behavior from before the organisation floor existed (#280): with `AIWG_CONFIG_LAYERS` unset, there is
no floor, so a command flag or environment value can relax the stored policy.
When `AIWG_CONFIG_LAYERS` is set and a lower (organisation) layer declares `credentialPolicy`, that
value becomes an enforced floor that neither the stored policy, the environment nor the rendering flag
can relax - an attempt warns once per process per attempted value, names the config file of the layer
enforcing the floor, and the floor is used instead.
Stricter-than-floor values from any source are always allowed. The exported `injectServers` API
enforces the same floor, including when its policy option is omitted; so does the exported Codex
runtime writer `writeProfileConfig` when its caller passes `floorPolicy` (see `McpServerRegistry#
getCredentialPolicyFloor`), and `aiwg mcp install` (see below).
Policy values must be `literal`, `references` or `none`; present `null`, `""`, `false` and `0` are invalid.
An empty `AIWG_MCP_CREDENTIAL_POLICY` environment string is treated as unset.
Set the registry's own policy with `aiwg mcp credential-policy <policy>`; the command refuses a value
below an enforced organisation floor and names the enforcing layer's config file.
`aiwg session --provider codex --profile <p>` applies the same
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
