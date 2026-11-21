# AIWG MCP Capability Audit

Status: v2026.8.5 re-audit pass for #2015

AIWG's MCP server is a provider-agnostic optional hook. The baseline integration path for every provider is file deployment plus the CLI bridge: `aiwg discover` to find a capability and `aiwg show <type> <name> --body` to fetch it. MCP adds structured, model-callable access to the same catalog and to selected project operations, but no provider should depend on MCP for basic AIWG reachability.

## Current Tool Inventory

### Core tools, always registered

The default `aiwg mcp serve` surface currently registers 15 tools:

| Tool | Status | Boundary |
|---|---|---|
| `discover` | active | Cross-type ranked search; mirrors `aiwg discover --json` |
| `skill-list` / `skill-show` | active | Skill catalog enumeration with metadata cards and opt-in body fetches |
| `command-list` / `command-show` | active | CLI command catalog and command spec lookup |
| `rule-list` / `rule-show` | active | Rule catalog with metadata cards and opt-in rule body fetches; CLI equivalent is `aiwg show rule <name> --body` |
| `agent-list` / `agent-show` | active | Agent catalog and full agent definition fetch |
| `template-list` / `template-show` / `template-render` | active | Template catalog, raw body fetch, and simple rendering |
| `command-run` | active | Allow-listed CLI dispatch; destructive commands require `confirmed: true` |
| `artifact-read` / `artifact-write` | active | Project-required `.aiwg/` artifact IO |

### Opt-in toolsets

`AIWG_MCP_TOOLSETS` or `aiwg mcp serve --toolsets=<csv>` enables 60 additional tools:

| Toolset | Tools | Count | Boundary decision |
|---|---:|---:|---|
| `flows` | `flow-list`, `flow-show`, `flow-run` | 3 | Declarative YAML Flows are headline orchestration primitives, but `flow-run` can lead to project mutation and shell execution, so this stays opt-in |
| `missions` | `mission-guide`, `mission-dispatch`, `mission-status` | 3 | AIWG Mission is distinct from low-level `mc-*`; dispatch is long-running/cross-stack capable, so this stays opt-in |
| `memory` | `memory-*`, `reflections-*` list/get/put/delete/path | 10 | Project state, off by default because it writes persistent memory |
| `kb` | `kb-*` list/get/put/delete/path | 5 | Knowledge-base state, off by default because it can be large and writeable |
| `research` | `provenance-*`, `research-store-*` list/get/put/delete/path | 10 | Research corpus/provenance state, opt-in by domain |
| `activity-log` | show/append/stats | 3 | Lightweight but project-specific event stream |
| `index` | build/query/deps/stats | 4 | Project graph operations; `index-build` can be expensive |
| `ralph` | start/status/abort/attach | 4 | Long-running loops; start/abort require confirmation semantics |
| `mc` | start/dispatch/status/stop/list | 5 | Mission Control orchestration; stop is destructive |
| `ops` | status/list/use/push | 4 | Operational workspace actions; push is shared-state affecting |
| `sandbox` | fleet list/get/preview/admit/observe/reconcile; activity coverage/timeline/export | 9 | Remote management-plane access, state mutation, and signed evidence export require an explicit opt-in boundary |

`core` is always implicit. `all` expands to all opt-in toolsets. Unknown toolset names warn and are skipped rather than aborting server startup.

## Filesystem containment (#3086)

Artifact tools, template tools, and dynamic `aiwg://prompts`, `aiwg://templates`,
and `aiwg://agents` resources share a pinned filesystem boundary. Templates accept
corpus-relative, framework-relative, or default-template-relative names; absolute
paths and `..` segments are refused. The configured corpus and artifact roots are
pinned once per server, including valid aliases to external stores. Retargeting or
replacing a pinned root refuses access.

Linux uses directory descriptors through `/proc/self/fd`; unavailable descriptor
paths refuse access. macOS and Windows use static component, canonical-path, and
inode/device checks. Unknown identities and multiply-linked reads refuse access.
Linux permits contained read symlinks; static access refuses symlink components.
Artifact writes retain atomic replacement behavior, including replacing hardlinked
destinations without writing their content. Opt-in storage tools inherit the
stricter filesystem storage behavior described in [Storage and PKM](../getting-started/storage-and-pkm.md).

Concurrent tree changes by the same user after final verification are outside this
boundary. A failed write may leave a private `0o600` `.aiwg-write-*.tmp` file.

## CLI to MCP Coverage Matrix

This re-audit keeps the default core lean and classifies the post-#1533 surfaces as follows:

| Surface | MCP status | Decision |
|---|---|---|
| Declarative YAML Flows (`agentic/code/frameworks/*/flows/*.playbook.yaml`) | First-class through opt-in `flows` toolset | `flow-list` and `flow-show` expose the YAML source of truth; `flow-run` is confirmation-gated and returns the playbook plus wrapper skill for host execution until a standalone `aiwg flow` executor exists |
| AIWG Mission (`aiwg-mission` kernel skill) | First-class through opt-in `missions` toolset | `mission-guide` fetches the primitive; `mission-dispatch` delegates durable execution to `aiwg mc dispatch`; `mission-status` reads through `aiwg mc status` |
| Legacy Mission Control (`aiwg mc`) | First-class through opt-in `mc` toolset | Remains the low-level durable session substrate; not merged with `missions` because the abstractions are intentionally different |
| `run skill` | Command-run only | Kept behind `command-run` because it executes script-bearing skills and already has argv/confirmation controls |
| `status` / `doctor` | Command-run only | Read-heavy diagnostic commands; no extra first-class schema justified yet |
| New/renamed CLI commands (`fanout`, `chunk`, `corpus`, `wizard`, `session`, `repo-access`, `features`, `feedback`, `address-issues`, `issue-audit`, `diagnose`, `doc-consolidate`, `best-practices-audit`, `skill-lint`, `agentcard`, `packages`, `local-executor`) | Command-run allow-listed | Unit coverage now compares `loadCommandAllowList()` with the TypeScript command registry so additions fail on drift |
| agentskills.io import/validation (#1569) | Not a separate MCP source yet | Standard-conforming skills should surface through the existing `skill-list`, `skill-show`, `discover`, and `command-run` paths after they enter the AIWG artifact corpus |
| Browser-consumable index export (#1578) | CLI/index toolset boundary | Existing `index-*` MCP tools cover build/query/deps/stats. Browser export remains CLI/API surface until a stable export command needs a schema wrapper |
| Agentic Sandbox v2026.8.3 fleet/activity APIs (#2015) | First-class through opt-in `sandbox` toolset | Management credentials are file-backed server configuration; mutating fleet calls and evidence export are confirmation-gated; 404/405 capability absence and upstream authorization/conflict/unavailable status remain typed |

## Provider-Agnostic Positioning

MCP configuration belongs to the user or workspace, not to a specific AIWG provider adapter. The same `aiwg mcp serve` process can be connected from Claude, Codex, Cursor, Factory, GitHub Copilot, OpenCode, Warp, Devin Desktop, Hermes, OpenClaw, or any other MCP-capable host.

Provider adapters should therefore say:

- Baseline: deploy files and use `aiwg discover` / `aiwg show`.
- Optional enrichment: connect `aiwg mcp serve` for structured tool calls.
- No provider requires MCP for skills, discovery, or rule reachability.

Hermes now follows this framing: rules are compressed into `AGENTS.md` as `### Rule:` sections, with full rule bodies reachable by `aiwg show rule <name> --body`; MCP exposes the same rule path when configured.

## Install, Inject, and Profile UX Check

The current CLI surface is coherent but should be described as two related flows:

| Flow | Commands | Current state |
|---|---|---|
| AIWG's own server | `aiwg mcp serve [--toolsets=...]`, `aiwg mcp install <provider>`, `aiwg mcp info` | Serves the AIWG catalog and project tools; install writes provider-specific config where a file path is known |
| External server registry | `aiwg mcp add/update/remove/list`, `aiwg mcp inject`, `aiwg mcp profile` | Maintains registered third-party MCP servers and injects selected sets into provider configs |

Profiles are named server subsets stored in `~/.aiwg/mcp-profiles.json`. Built-in presets are `minimal`, `dev`, `ops`, `research`, `incident`, and `full`. The profile model is provider-agnostic; provider overrides may deny high-risk tools for a given host.

Ephemeral profile launch remains the cleanest default where supported: `aiwg session --profile <name>` injects a temporary config for Claude and creates a profile-scoped runtime home for Codex. Persistent injection remains available through `aiwg mcp inject --provider <name> --profile <name>`.

## What MCP Uniquely Adds

MCP adds value when the host can call tools directly:

- Structured JSON schemas for catalog lookup, command dispatch, artifact IO, and subsystem operations.
- Runtime tool availability without copying large skill or rule bodies into context.
- Cross-provider access to the same external MCP server registry and profile presets.
- Long-running orchestration controls where the host can poll status tools.
- A standard integration surface for non-AIWG systems that cannot read `AGENTS.md` but can call MCP.

The CLI + `AGENTS.md` bridge already covers:

- Capability discovery through `aiwg discover`.
- Full body fetches through `aiwg show <type> <name> --body` (skill, agent, command, rule, flow, runbook, template, or behavior).
- Rule delivery for providers that load generated context files.
- Operator-driven command execution from a shell.

Decision: keep MCP optional and lean by default. Do not move baseline rule or skill delivery behind MCP. Use opt-in toolsets for writeable, project-specific, expensive, or long-running surfaces.

## Recommendations

- `workflow-run` has been removed from core. Migration path: use `command-run` for general CLI execution, `AIWG_MCP_TOOLSETS=flows` plus `flow-list` / `flow-show` / `flow-run` for declarative YAML Flow access, or `AIWG_MCP_TOOLSETS=missions` plus `mission-guide` / `mission-dispatch` / `mission-status` for Mission access.
- Keep `command-run` in core; it is the structured equivalent of the CLI bridge and preserves one canonical execution path.
- Keep flows, missions, memory, research, activity-log, index, ralph, mc, ops, and sandbox outside core because they expand schema size, touch project or remote state, or trigger long-running/shared-state operations.
- Update provider docs that still say MCP is required or that only the legacy five-tool surface exists.
- Re-measure schema token cost after each toolset change and publish the core/all count in release notes.
