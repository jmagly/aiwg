---
audience: agent-operator
publication: agent-reference
stable_id: aiwg.agent-reference.cli-usage
---

# AIWG CLI Usage Guide

> **Audience: agents, scripts, and advanced operators.** This guide documents
> execution sequencing and flags for the systems that operate AIWG. General
> users should follow
> [Install, Connect, and Verify](../getting-started/install-connect-verify.md),
> then ask their agent for outcomes in natural language.

> **Note:** The `aiwg` CLI command is only available when installed via npm
> (`npm install -g aiwg`). If you installed AIWG using Claude Code plugins
> (`/plugin install sdlc@aiwg`), you won't have access to the CLI. Plugins
> provide agents, commands, and skills directly within Claude Code without
> requiring a separate CLI tool.

## Installation

```bash
npm install -g aiwg
```

Native PTY and dense-embedding support is optional and is not installed by the
base package. Opt in with `aiwg features install pty` or
`aiwg features install embeddings`; each command uses an isolated user-owned
manifest with a package-specific lifecycle-script allowlist. Run `aiwg doctor`
to distinguish a missing feature from native package files whose build was
blocked or failed.

## Quick Start

```bash
# Check installation health
aiwg doctor

# Preview the guided first-run path without writing files
aiwg wizard --dry-run --goal "help me start a project"

# Deploy the complete end-user surface to your provider
cd your-project
aiwg use all --provider <provider>

# Restart the provider, then invoke aiwg-regenerate in its agent conversation.

# Verify AIWG is engaged in this project
aiwg status --probe --json
```

## Core Commands

### doctor

Check AIWG installation health and diagnose issues.

```bash
aiwg doctor
```

Checks:

- AIWG installation location
- Version info
- Project `.aiwg/` directory
- Deployed agents and commands
- Node.js version
- MCP server availability
- Skill Seekers (optional)
- Optional feature availability and native-module loadability

### features

Inspect and install optional runtime capabilities without changing global npm
script policy.

```bash
aiwg features
aiwg features info pty
aiwg features install pty
```

### use

Deploy a framework to your project.

```bash
# SDLC framework (software development)
aiwg use sdlc

# Marketing framework
aiwg use marketing

# Writing addon (voice profiles)
aiwg use writing

# Complete deployable end-user surface (preferred first-run default)
aiwg use all --provider codex
```

**Options:**

- `--provider <name>`: Target platform (`claude`, `codex`, `copilot`, `cursor`,
  `devin`, `factory`, `grokbot`, `hermes`, `muse`, `opencode`, `openclaw`, `openhuman`, `omp`,
  `pi`, or `warp`). The deprecated `windsurf` selector remains an alias for
  Devin Desktop's `.windsurf/` compatibility paths.
- `--no-utils`: Skip aiwg-utils addon
- `--force`: Overwrite existing deployments
- `--dry-run`: Preview all phases without writing files or claiming readiness
- `--verbose` / `-v`: Include deployment phases, registry diagnostics, index
  build time, and provider reload rationale
- `--json`: Emit one `aiwg.use.result.v1` document; valid JSON is preserved on
  both success and non-zero failure. The document separates per-provider
  deployed counts from the complete framework discovery inventory.

`all` includes the complete deployable end-user surface but intentionally
excludes contributor-only development bundles and non-deployable packages.
The command now deploys, refreshes the capability index, generates canonical
context, verifies artifacts and provider wiring, and reports one of `ready`,
`ready-restart-required`, `degraded`, or `failed`. Follow the reported provider
reload action when present. Standalone `aiwg index build`, `aiwg regenerate`,
`aiwg doctor --deployment`, and `aiwg status --probe --json` remain available
for targeted repair and diagnostics.

The default completion report is intentionally compact. **Deployed to** counts
files copied into provider load paths; **Indexed for discovery** reports the
authoritative framework `totalArtifacts` and every indexed artifact type.

### wizard

Guide first-run provider, project, framework, deploy, and verification choices.

```bash
# Interactive terminal path
aiwg wizard

# No-write preview
aiwg wizard --dry-run --goal "help me start a project"

# Scripted path
aiwg wizard --non-interactive --profile beginner --provider codex
```

**Options:**

- `--goal <text>`: Plain-language goal used to recommend a framework
- `--profile <preset>`: Preset for a common path (`beginner`, `sdlc`,
  `research`, `marketing`, `forensics`, `ops`, `security`, `knowledge-base`,
  `writing`)
- `--provider <name>`: Target provider
- `--framework <name>`: Framework to deploy first
- `--non-interactive`: Use selected or inferred defaults without prompting
- `--dry-run`: Print the plan without writing files
- `--json`: Print the plan as JSON

### -new

Create a new project with full SDLC scaffolding.

```bash
aiwg -new my-project
cd my-project
```

### -status

Show workspace health and installed frameworks.

```bash
aiwg -status
aiwg status --probe --json
```

### issue

Manage project-local issues under `.aiwg/issues/` and move snapshots to or from
Gitea/GitHub. See [Local Issues](../local-issues.md) for sync, backup, and Git
conflict guidance.

```bash
aiwg issue init --prefix PROJECT
aiwg issue new --title "Fix import flow" --body-file issue.md
aiwg issue import --from gitea --snapshot-file gitea-1463.json
aiwg issue import --from github --live --repo org/repo --external-id 42
aiwg issue export PROJECT-0001 --to github --out project-0001.github.json
aiwg issue export PROJECT-0001 --to gitea --live --repo org/repo
aiwg issue sync conflicts PROJECT-0001 --snapshot-file gitea-1463.json --out conflicts.json
aiwg issue sync map-comments PROJECT-0001 --map-file comment-map.json
```

### list

List installed frameworks and addons.

```bash
aiwg list
```

### remove

Remove a framework or addon.

```bash
aiwg remove <id>
```

## MCP Server

### mcp serve

Start the AIWG MCP server.

```bash
aiwg mcp serve
```

### mcp install

Generate MCP client configuration.

```bash
# For Claude Desktop
aiwg mcp install claude

# For Cursor IDE
aiwg mcp install cursor

# For Factory AI
aiwg mcp install factory

# Preview without writing
aiwg mcp install claude --dry-run
```

### mcp info

Show MCP server capabilities.

```bash
aiwg mcp info
```

## Channel Management

### --use-main

Switch to bleeding edge (tracks main branch).

```bash
aiwg --use-main
```

### --use-stable

Switch back to stable (npm releases).

```bash
aiwg --use-stable
```

## Web-Backed Resources (Experimental Partial Implementation)

AIWG ships an experimental partial implementation for web-backed resource
resolution for `aiwg discover`, `aiwg show`, and `aiwg versions`.

```bash
aiwg discover "architecture evolution" --resource-source local --aiwg-version 2026.7.16
aiwg discover "architecture evolution" --resource-source web --aiwg-version stable
aiwg discover "architecture evolution" --resource-source auto --aiwg-version 2026.7.16
aiwg discover "architecture evolution" --offline

aiwg show skill architecture-evolution --resource-source web --aiwg-version 2026.7.16
aiwg show framework sdlc --resource-source web --aiwg-version candidate --offline

aiwg versions list --json
aiwg versions resolve stable --json
aiwg versions resolve stable --write-lock
aiwg versions show 2026.7.18 --json --pretty
aiwg versions resolve '>=2026.7.18 <2026.8.0' --json
aiwg versions resolve sha256:ef5a7112c593d5df90f7940c315a3d4a3d6d6e2a3bd9c063d87de1e811ad80c1
aiwg versions clean-cache --dry-run --json
aiwg doctor
```

Supported `--aiwg-version` values in this beta are exact AIWG CalVer releases,
SemVer ranges, signed manifest digests, and signed channel names:

```bash
aiwg discover "architecture evolution" --resource-source web --aiwg-version 2026.7.18
aiwg discover "architecture evolution" --resource-source web --aiwg-version '>=2026.7.18 <2026.8.0'
aiwg discover "architecture evolution" --resource-source web --aiwg-version sha256:ef5a7112c593d5df90f7940c315a3d4a3d6d6e2a3bd9c063d87de1e811ad80c1
aiwg discover "architecture evolution" --resource-source web --aiwg-version stable
aiwg discover "architecture evolution" --resource-source web --aiwg-version latest
aiwg discover "architecture evolution" --resource-source web --aiwg-version canary
aiwg discover "architecture evolution" --resource-source web --aiwg-version main
```

This partial implementation is active only for `discover`/`show` resource
queries and `versions` release inspection. It does not yet apply to `aiwg use`
or `aiwg regenerate` rollout-wide web defaults. See
[Web-Backed AIWG Resources](../install/web-backed-resources.md) for the planned
operator contract, trust anchors, troubleshooting, and safety model.

Maintainer checkouts can already relocate the project AIWG artifact directory
with the project pointer file written by the CLI:

```bash
aiwg artifacts path
aiwg artifacts path --json --check-write
aiwg artifacts move --to ../aiwg-web-release-ops/corpus/.aiwg
```

The `path` command prints the effective absolute artifact root so scripts and
agent workflows do not accidentally write payloads into a split-root project's
local control plane. The `move` command moves the configured artifact root,
writes `.aiwg-location`,
updates `.gitignore` for the local pointer, rebuilds the project index, and
syncs the Fortemi Core static cache. It retains the repository-local AIWG
control plane while relocating corpus-heavy directories. Diagnose and safely
repair legacy layouts with:

```bash
aiwg status --probe --json
aiwg doctor
aiwg artifacts repair --dry-run
aiwg artifacts repair --apply
```

Repair migrates local-only payload, deduplicates identical content, and archives
divergent local variants without overwriting the external version. It removes
local payload only after byte verification; remote Git synchronization remains
a separate operator step. For one-off sessions,
`AIWG_ARTIFACTS_PATH` can still point at an absolute, project-relative, or
`~/`-relative artifact directory and takes precedence over `.aiwg-location`.

For AIWG's own repository, this is the supported bridge to the private SDLC
corpus. See [Private AIWG Corpus](../development/private-aiwg-corpus.md).

## Maintenance

### -version

Show version and channel info.

```bash
aiwg -version
```

### -update

Check for and apply updates.

```bash
aiwg -update
```

### -help

Show all available commands.

```bash
aiwg -help
```

## Support

- **GitHub Issues**: <https://github.com/jmagly/aiwg/issues>
- **Documentation**: <https://docs.aiwg.io>
- **Examples**: `.aiwgrc.example.json` in repository
