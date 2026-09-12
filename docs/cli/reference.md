---
audience: agent-operator
publication: agent-reference
stable_id: aiwg.agent-reference.cli
---

# AIWG CLI Reference

Complete reference for all `aiwg` CLI commands.

> **Audience: agents, scripts, and advanced operators.** Most people should not
> run these commands directly. Use the
> [installation and repair guide](install-and-repair.md) for the small
> direct-user surface, then describe the outcome you want in your agent
> conversation.

> **How to read this reference (skill-first).** AIWG is agentic-first: raw `aiwg`
> commands **augment** AIWG skills — they do not replace them. Agents should
> reach a capability through its **skill** (which carries the priming: gates,
> preservation logic, recovery), and the skill calls the CLI as an imperative
> step. Two categories:
>
> - **Discovery / status / info commands** (`discover`, `show`, `list`, `status`,
>   `version`, `runtime-info`, `doctor` read-only, `catalog`, `index query`, …)
>   are **direct-callable** — they are the bridge _into_ the skill surface.
> - **Paired action commands** (`use`, `refresh`, `regenerate`, `doctor` repair,
>   `doc-sync`, `ralph`, `sdlc-accelerate`, `mc`, `init`, `promote`, scaffolding,
>   storage `migrate`, ops actions, …) have a **paired skill** — route through it
>   first (e.g. invoke the `aiwg-refresh` skill, not raw `aiwg refresh`). The CLI
>   examples below for those commands are **implementation affordances**: what the
>   skill calls, or what an operator may type explicitly — not the agent's primary
>   surface.
>
> Full rule: `agentic/code/addons/aiwg-utils/rules/cli-secondary.md` (#1272).

**Prerequisites:** Node.js ≥20.0.0 and `npm install -g aiwg`

## Authentication

```bash
aiwg auth login [--device] [--device-label <label>]
aiwg auth status [--json]
aiwg auth logout [--all]
```

Authentication uses the native operating-system credential store. A mode-0600
file fallback requires explicit `--store file --allow-file-store` opt-in. Exit
codes are 0 success, 2 usage, 3 not authenticated, 4 denied/expired, 5
credential-store failure, and 6 network/protocol failure. Status output never
contains access or refresh tokens.

**References:**

- @src/extensions/commands/definitions.ts - Command extension definitions
- @src/extensions/types.ts - Extension type system
- @.aiwg/architecture/unified-extension-schema.md - Extension schema documentation
- @docs/configuration/aiwg-config.md - `.aiwg/aiwg.config` field reference (delivery, remotes, installed)
- @docs/configuration/setup-manifest.md - `setup.aiwg.io/v1` SetupManifest reference
- @docs/configuration/model-configuration.md - `models.json` model role mapping

---

## Table of Contents

- [Maintenance Commands](#maintenance-commands)
- [Programmatic API](#programmatic-api)
- [Framework Management](#framework-management)
- [Project Setup](#project-setup)
- [Workspace Management](#workspace-management)
- [MCP Commands](#mcp-commands)
- [Catalog Commands](#catalog-commands)
- [Toolsmith Commands](#toolsmith-commands)
- [External Job Command](#external-job-command)
- [Utility Commands](#utility-commands)
- [Plugin Commands](#plugin-commands)
- [Scaffolding Commands](#scaffolding-commands)
- [Mission Control Commands](#mission-control-commands)
- [Agent Team Commands](#agent-team-commands)
- [Al Commands](#ralph-commands)
- [Documentation Commands](#documentation-commands)
- [SDLC Orchestration Commands](#sdlc-orchestration-commands)
- [Index Commands](#index-commands)
- [Configuration Commands](#configuration-commands)
- [Agentic Tools (RLM)](#agentic-tools-rlm)
- [Addon Commands](#addon-commands)
- [Storage Commands](#storage-commands)
- [Ops Commands](#ops-commands)

---

> **Storage subsystem:** AIWG persists artifacts (memory, kb, activity-log,
> reflections, provenance, research) through a pluggable adapter system.
> See [`docs/storage/`](../storage/README.md) for the full guide.
>
> Storage CLIs:
>
> - `aiwg storage` — config inspection, migration, doctor probe
> - `aiwg memory` / `aiwg reflections` / `aiwg kb` / `aiwg activity-log` /
>   `aiwg provenance` / `aiwg research-store` — per-subsystem
>   `path` / `list` / `get` / `put` / `delete` / `append-log`

---

## Programmatic API

The installed package exports the same router used by the `aiwg` executable,
plus the signed web-resource helpers. Callers do not need to import private
paths under `dist/`.

```js
import { run, resolveWebRelease } from "aiwg";
// Resource-only consumers may instead import from 'aiwg/resources'.

await run(["discover", "requirements"], { cwd: process.cwd() });
const release = await resolveWebRelease({ version: "latest" });
```

`run()` preserves CLI behavior, including terminal output and command exit
semantics. Use the resource helpers when embedding resolution without CLI
output.

---

## Maintenance Commands

### regenerate

Refresh or adopt the project context graph without redeploying frameworks.

```bash
# Infer the correct branch from workspace state (recommended)
aiwg regenerate [--provider <name>] [--dry-run]

# Force a fresh or already-migrated project refresh
aiwg regenerate --workspace [--provider <name>] [--dry-run] [--force]

# Established project: preview is default, apply is explicit
aiwg regenerate --existing-project [--provider <name>] [--dry-run|--apply]

# Compatibility-only inline branch
aiwg regenerate --full-inject [--provider <name>] [--dry-run]
```

`--existing-project` synthesizes an exact, bounded project snapshot, migrates
provider-only roots to attributed linked files, and commits context outputs in
one rollback-capable transaction. It refuses possible credentials, directive
conflicts, `--force`, and partial `--no-*-md` writes. A successful apply prints
`aiwg workspace-context rollback <transaction-id>`.

`--legacy` aliases `--full-inject`. When no branch is supplied, the selector
inspects canonical workspace markers, extracted project context, stable project
metadata, and legacy operator-authored provider context. It chooses `workspace`
or `existing-project`, then prints the selected branch, whether it was inferred
or explicit, and its evidence. Legacy full injection is explicit-only. The CLI
rejects malformed marker state, unknown flags, missing values, and conflicting
branches with usage status.

### help

Display comprehensive CLI help information.

```bash
aiwg help
aiwg help --json
aiwg -help
aiwg --help
aiwg <command> --help
aiwg <command> -h
```

Per-command help is intercepted before command hooks and normal handler
execution, so requesting help does not enter a state-changing command path.
Commands that declare detailed help return it; all other registered commands
return a non-executing pointer to `aiwg help`.

`aiwg help --json` emits one machine-readable object with
`schema: "aiwg.command-registry.v1"` and a `commandIds` array from the canonical
CLI command registry. It excludes aliases and human-readable examples. The MCP
command allow-list uses this versioned response when source definitions are
unavailable (for example, in an installed package), and fails closed if the
response is unsuccessful or malformed.

**Capabilities:** cli, help, documentation
**Platforms:** All
**Tools:** None required

Shows:

- Available commands grouped by category
- Common usage patterns
- Platform-specific notes
- Links to documentation

---

### version

Show version and channel information.

```bash
aiwg version
aiwg -version
aiwg --version
```

**Capabilities:** cli, version, info
**Platforms:** All
**Tools:** Read

Shows:

- Current AIWG version
- Active channel (stable/main)
- Installation path
- Node.js version

**Example output:**

```
AIWG v2026.5.8 (stable)
Installed: ~/.nvm/versions/node/v24.12.0/lib/node_modules/aiwg
Node.js: v24.12.0
```

---

### context-firewall

Inventory every provider-facing context source, classify trust and drift, scan
for poisoning signals without printing source bodies, and enforce a portable
context budget.

```bash
aiwg context-firewall scan [--provider <name>] [--strict] [--json]
aiwg context-firewall baseline --plan [--output <project-relative-path>]
aiwg context-firewall baseline --write --confirm-reviewed [--output <path>]
```

`baseline` is read-only unless `--write` and `--confirm-reviewed` are both
present. Plan mode prints every affected record before mutation. Baseline paths
must remain within the project root, including after symlink resolution, and the
write is atomic. Use `--budget-tokens <n>`, `--warn-ratio <n>`, `--limit <n>`,
repeatable `--provider <name>`, or `--no-content-scan` as needed.

**Capabilities:** cli, diagnostics, security, context-budget, memory-review
**Platforms:** All
**Tools:** Read, Write, Bash

---

### doctor

Check installation health and diagnose issues.

```bash
aiwg doctor [--provider <name>] [--all-providers] [--project-local] [--quiet]
            [--strict-context] [--context-baseline <path>]
            [--context-budget-tokens <n>]
```

**Flags:**

- `--provider <name>` — Inspect a specific provider's deployment paths (claude, codex, copilot, cursor, factory, hermes, opencode, openclaw, openhuman, omp, pi, warp, or devin). Defaults to auto-detect across deployed providers.
- `--all-providers` — Enumerate every supported provider, including ones with nothing deployed.
- `--project-local` — Show only the project-local artifacts section. Exit code reflects only project-local findings.
- `--quiet` — Suppress informational subsections (counts, shadows). Show only failures.
- `--strict-context` — Fail when the provider context/memory firewall finds a violation or lacks a reviewed baseline.
- `--context-baseline <path>` — Read reviewed context digests and trust labels from this project-relative path (default `.aiwg/context-memory-firewall-baseline.json`).
- `--context-budget-tokens <n>` — Override the portable 200K provider-context budget.

**Capabilities:** cli, diagnostics, health-check
**Platforms:** All
**Tools:** Read, Bash

**Checks:**

- AIWG installation and version
- Node.js version compatibility
- Project `.aiwg/` directory structure
- Framework registry status
- Deployed agents and commands
- Managed Agent Skills source conformance, imported-source integrity, active
  provider degradation, and source/deployed drift
- MCP server availability
- System dependencies (git, jq, etc.)
- `memory.topology` contracts — runs `validateMemoryTopology()` against every installed framework/addon manifest; flags missing required fields, invalid `crossRefStyle` values (must be `at-mention | wikilink | markdown-link | yaml-ref`), namespaces not under `.aiwg/`, empty `derivedPages`, and wrong array shapes for `lintRules`/`ingestRequires` (per ADR-021)
- **Provider context/memory firewall** — separately measures memory, rules, skills, agents, generated bridges, and project-local context; reports deployed/package drift, trust labels, changed reviewed files, and poisoning signals. See the [operator guide](../security/context-memory-firewall.md).
- **Project-local artifacts** ([design](https://github.com/jmagly/aiwg/blob/main/.aiwg/architecture/design-doctor-log-promote.md)) — per-type counts, manifest validation, active shadows (informational vs blocking), denylist violations, deploy-state drift (deployed file hash vs registered `artifactHashes`), provider deployment matrix. Section is suppressed entirely when no project-local content exists.

**Doctor exits 0 when:** no validation errors, no denylist violations, no drift. Shadows alone do not fail doctor — they're informational by design.

**Example output:**

```
✓ AIWG installed: v2026.5.8
✓ Node.js version: v24.12.0 (meets requirement ≥20.0.0)
✓ Project directory: /home/user/my-project
✓ Framework registry: 2 frameworks installed
✓ Agents deployed: 15
✓ Commands deployed: 31
⚠ MCP server not configured
ℹ Run 'aiwg mcp install claude' to configure MCP
```

---

### update

Detect the active AIWG distribution, apply its supported update strategy, and
re-deploy installed frameworks. `aiwg upgrade` is an alias; help and notices
use the canonical `aiwg update` spelling.

```bash
aiwg update
aiwg -update
```

**Capabilities:** cli, update, maintenance
**Platforms:** All
**Tools:** Bash

**Actions:**

- Checks npm registry for newer version
- Full `aiwg` npm installs preserve the configured stable, next, or nightly channel
- Lightweight `@aiwg/cli` installs fetch and verify the selected signed web resource release and are never replaced with the full package
- Source/dev checkouts receive a non-destructive Git/build workflow
- Re-deploys installed frameworks and add-ons after the distribution update step

Updates use the canonical installation identity and its recorded absolute
package-manager executable. A root/method mismatch stops the update before
re-deployment.

On Windows, recorded `.cmd` and `.bat` manager wrappers run through `cmd.exe`.
AIWG quotes the wrapper path and arguments once, then passes that command payload
verbatim so Node does not re-escape paths containing spaces.

**Channel switching:**

```bash
# Switch to bleeding edge (main branch)
aiwg --use-main

# Switch back to stable
aiwg --use-stable
```

---

### installation

Inspect or explicitly recover the provider-neutral global installation
identity.

```bash
aiwg installation show [--json]
aiwg installation adopt [--method <npm|web|source>] [--manager <absolute-path>]
aiwg installation switch --root <path> --method <npm|web|source> \
  [--manager <absolute-path>] [--run-mode <normal|development>]
```

`show` reports canonical and actual method/path, run mode, update strategy,
release channel, and drift. `adopt` deliberately makes the package currently
handling the command canonical. `switch` records another verified root. These
recovery actions remain available when drift blocks ordinary commands.

---

### refresh

Refresh AIWG to the latest version and re-deploy all frameworks to the active provider. **Formerly `aiwg sync`** — `aiwg sync` still works as a deprecated alias (emits a warning, scheduled for removal after the 2026.5.x stable line).

```bash
aiwg refresh
aiwg --refresh
```

**Capabilities:** cli, refresh, sync, maintenance, deploy, self-maintenance
**Platforms:** All
**Tools:** Bash, Read

**Actions:**

- Detects active provider (claude-code, copilot, cursor, etc.)
- Checks current AIWG version
- Updates package to latest (unless `--skip-update`)
- Re-deploys all installed frameworks (or specific ones)
- Runs health check via `aiwg doctor`

If the package update fails, refresh still attempts re-deployment but repeats the
failure in its final summary. Quiet mode reports
`"status":"refreshed-with-update-failure"` so automation cannot mistake the
exit-0 resilience path for a successful package update.

**Flags:**

| Flag                        | Description                                      |
| --------------------------- | ------------------------------------------------ |
| `--dry-run`                 | Show what would change without making changes    |
| `--quiet`                   | Machine-readable JSON output (for orchestration) |
| `--skip-update`             | Skip the installation update                     |
| `--packages-only`           | Refresh remote packages only                     |
| `--provider <name>`         | Target specific provider (default: auto-detect)  |
| `--prune-other-providers`   | Remove stale AIWG-managed trees for providers this run did not refresh (off by default). Git-tracked files are always left in place unless `--prune-tracked` is also given |
| `--prune-tracked`           | Allow `--prune-other-providers` to delete git-tracked files. Separate from `--force` on purpose — see below |
| `--force`                   | Re-write every deployed artifact, replacing files AIWG does not currently manage. Never authorises deleting tracked files |
| `--channel <name>`          | Update channel (stable, main)                    |
| `--frameworks <list>`       | Comma-separated frameworks to re-deploy          |
| `--model <name>`            | Override all deployed agent model tiers          |
| `--reasoning-model <name>`  | Override the reasoning model tier                |
| `--coding-model <name>`     | Override the coding model tier                   |
| `--efficiency-model <name>` | Override the efficiency model tier               |
| `--filter <pattern>`        | Limit model deployment by agent name             |
| `--filter-role <role>`      | Limit model deployment by role                   |
| `--model-tier <tier>`       | Limit model deployment by tier                   |
| `--save`                    | Save model overrides to the project              |
| `--save-user`               | Save model overrides to user configuration       |
| `-h`, `--help`              | Show help without running refresh                |

**Examples:**

```bash
# Full refresh (update + re-deploy + verify)
aiwg refresh

# Check what would change
aiwg refresh --dry-run

# Refresh to specific provider
aiwg refresh --provider copilot

# Re-deploy only SDLC framework, skip update
aiwg refresh --skip-update --frameworks sdlc

# Quiet mode for agent orchestration
aiwg refresh --quiet
```

**Example output:**

```
◆ aiwg refresh
──────────────────────────────
ℹ Detecting provider...
✓ Provider: claude
ℹ Checking version...
✓ Version check complete
ℹ Checking for updates...
✓ Package up to date
ℹ Re-deploying frameworks...
✓ Deployed: all
ℹ Running health check...
✓ Health check passed
──────────────────────────────
✓ Refresh complete
```

---

### diagnose

Produce a shareable support bundle (logs + env + config) for bug reports.

```bash
aiwg diagnose [--stdout] [--include-secrets]
```

**Options:**

- `--stdout` - Emit a single-file JSON manifest to stdout instead of writing a tarball
- `--include-secrets` - Skip log sanitization (inspect the bundle before sharing)

**Capabilities:** cli, diagnostics, troubleshooting, support, bundle
**Platforms:** All
**Tools:** Bash

By default writes `aiwg-diagnose-YYYYMMDDHHMMSS.tar.gz` in the current directory
containing logs, environment info, config snapshot, and recent git activity.
Secrets in logs are sanitized unless `--include-secrets` is passed.

---

### steward

Provider capability awareness — answer "what does my provider support?" and "what command should I use?".

```bash
aiwg steward capabilities [--provider <name>] [--feature <name>] [--all]
aiwg steward find --capability <name>
aiwg steward models --route --capability-type <agent|skill|rule|workflow> \
  --capability <id> --assignment "<bounded work>" [--complex|--high-impact] \
  [--provider <name>] [--allow-premium] [--json]
```

**Subcommands:**

- `capabilities` - Show provider/feature capability matrix entries
- `find` - Routing advice for the current provider
- `models --route` - Bind a selected capability and bounded assignment to the economy, standard, or premium wrapper selected by policy

**Options:**

- `--provider <name>` - Capabilities for a specific provider (claude, copilot, cursor, ...)
- `--feature <name>` - Provider support matrix for a specific feature
- `--all` - Print the full matrix (all providers x all features)
- `--capability <name>` - (with `find`) feature to look up routing for

Provider detection precedence when `--provider` is omitted:
environment variables from the active harness first, then the current
workspace's `.aiwg/aiwg.config` `providers[0]`. Config value `claude`
normalizes to the capability-matrix id `claude-code`; `openai` normalizes to
`codex`.

**Capabilities:** cli, maintenance, capability-matrix, provider-routing, diagnostics
**Tools:** Bash, Read

**Examples:**

```bash
aiwg steward capabilities --provider claude
aiwg steward capabilities --feature cron
aiwg steward find --capability cron
aiwg steward models --route --provider codex --complex \
  --capability-type agent --capability software-implementer \
  --assignment "Implement and verify one bounded change" --json
```

The route envelope reports the canonical tier/role, wrapper agent, provider-compiled
model and enforcement outcome, native versus emulated launch mechanism, selected
capability stable id and packaged source provenance, and wrapper prompt. The
capability must resolve at the requested agent, skill, rule, or workflow type;
missing, ambiguous, and type-mismatched values fail before an envelope is emitted.
Premium routes remain confirmation-gated unless the
invocation or project policy explicitly grants them with `--allow-premium`.

---

## Framework Management

### use

Install and deploy framework or addon to your project. Skills are deployed natively for providers that support them; commands are generated from skill sources for providers that need them. Each provider receives all artifact types (agents, skills, commands, rules) regardless of native platform support.

```bash
aiwg use <framework|addon>
```

**Arguments:**

- `<framework>` - Framework name: `sdlc`, `marketing`, `writing`, `all`
- `<addon>` - Addon name: any addon in `agentic/code/addons/` (e.g., `rlm`, `ralph`, `voice-framework`)

**Options:**

- `--provider <name>` - Target platform (claude, copilot, factory, cursor, devin, warp, codex, opencode, hermes, openclaw, openhuman, pi, local)
- `--scope user` / `--user` - Additively deploy to the project and mirror the
  artifacts into the provider's user-level discovery paths.
- `--global` - Install framework and kernel assets into provider user-level
  discovery paths without retaining a project artifact deployment. The target
  project receives only lightweight `WORKSPACE.md`, `AIWG.md`, and provider
  bootstrap files.
- `--model <name>` - Override model for all tiers (blanket)
- `--reasoning-model <name>` - Override reasoning tier model (alias: `--reasoning`)
- `--coding-model <name>` - Override coding tier model (alias: `--coding`)
- `--efficiency-model <name>` - Override efficiency tier model (alias: `--efficiency`)
- `--save` - Save model overrides to project `models.json`

For providers with a native agent directory, deployment validates the content of
all three model worker wrappers: `aiwg-model-efficiency-worker`,
`aiwg-model-coding-worker`, and `aiwg-model-reasoning-worker`. Validation rejects
missing, empty, malformed, stale, or policy-mismatched artifacts; Codex pins are
compared to the effective offline catalog and Claude aliases to their semantic
role/tier contract. Agent-less providers
are reported as inherited, global-only, informational, or unsupported rather than
being falsely described as pinned.

- `--save-user` - Save model overrides to `~/.config/aiwg/models.json`
- `--no-utils` - Skip aiwg-utils addon installation (frameworks only)
- `--force` - Overwrite existing deployments, including artifacts AIWG does not
  currently manage. This is the supported way to reclaim a provider directory
  left behind by an older AIWG install.
- `--dry-run` - Preview without making changes
- `--verbose` / `-v` - Include deployment phase details, framework-index build
  time, registry diagnostics, and the provider-specific reload rationale. The
  default report stays compact for terminals, logs, and agent transcripts.
- `--json` - Emit one versioned `aiwg.use.result.v1` result document. The
  document remains valid JSON on non-zero failure and includes per-provider
  phases, deployed artifact counts, the complete authoritative framework-index
  inventory, findings, restart actions, aggregate outcome, and exit
  classification.
- `--ci-hooks-enabled` - Also deploy CI workflow files to `.github/workflows/` and/or `.gitea/workflows/` (opt-in; detects forge from `.git/config`). Review deployed files before committing.
- `--harness-agents <list>` - OpenHuman only: emit selected native `spawn_subagent` TOML agents with a comma-separated list (for example `test-engineer,security-auditor`). Without this flag, OpenHuman deploys kernel skills/rules only.
- `--no-harness-agents` - OpenHuman only: explicitly skip native TOML harness agents and deploy only kernel skills/rules.
- `--skip-commands-migration` - Skip deleting the legacy commands directory (warns about duplicate entries in the command palette)
- `--profile <name>` - Select a topology profile for addons that declare multiple page templates (e.g., `llm-wiki` ships `book-companion | personal | research-deep-dive | business-team | generic`). Without the flag, an interactive prompt appears on TTY. The selection is written to `.aiwg/<namespace>/config.json` so subsequent skill invocations pick the right template.

Deployment counts report what the run accounts for: artifacts it wrote, plus
artifacts AIWG already manages. Files in a provider directory that AIWG does not
own are never counted as deployed — they are reported as a separate advisory
naming the files and the command to replace or remove them.

A provider-scoped `aiwg refresh` never mutates another provider's deployed
surface. Stale trees belonging to providers the run did not refresh are reported
with the two concrete next actions; `--prune-other-providers` removes such a
tree as a unit (agents, commands, and rules together) rather than partially.
That prune also defers to version control: git-tracked artifacts are left in
place and reported separately, because deleting an ignored regenerable artifact
and deleting a committed file are not the same act.

Removing them requires `--prune-tracked`, which is deliberately not `--force`.
`--force` governs what gets **written** — it replaces artifacts AIWG does not
currently manage. Deleting files someone committed, in a provider tree the run
was not asked to touch, is a different decision, so habitual `--force` use can
never authorise it.

`aiwg use all` deploys the kernel surface — kernel skills, rules, and behaviors —
and does not deploy agents or commands. It leaves the artifacts other bundles
deployed alone: running it after `aiwg use sdlc` does not remove the SDLC agent
surface. In a project whose only recorded deployment is the bulk install itself,
it still clears flat artifacts left by the pre-kernel bulk default.

**Capabilities:** cli, framework, deployment, addon
**Platforms:** All
**Tools:** Read, Write, Bash, Glob

**Examples:**

```bash
# Deploy SDLC framework for Claude Code (default)
aiwg use sdlc

# Install user-level assets and generate only lightweight project wiring
aiwg use sdlc --provider claude --global

# Deploy to GitHub Copilot
aiwg use sdlc --provider copilot

# Deploy marketing framework
aiwg use marketing

# Deploy all frameworks and addons (auto-discovers all addons in agentic/code/addons/ except those marked devOnly)
aiwg use all

# Deploy RLM addon (recursive context decomposition)
aiwg use rlm

# Deploy RLM addon to Codex
aiwg use rlm --provider codex

# Preview and deploy the Civic Action addon
aiwg use civic-action --dry-run
aiwg use civic-action

# Preview deployment without writing files
aiwg use sdlc --dry-run

# Override model for all tiers
aiwg use sdlc --model sonnet

# Override individual tiers
aiwg use sdlc --reasoning opus --coding sonnet --efficiency haiku

# Use a specific model ID on Factory
aiwg use sdlc --provider factory --coding-model gpt-5.3-codex

# Blanket with per-tier override
aiwg use sdlc --model sonnet --reasoning opus

# Save model overrides for future deployments
aiwg use sdlc --model sonnet --save

# Deploy SDLC with CI workflow files (opt-in; review before committing)
aiwg use sdlc --ci-hooks-enabled

# Preview CI files that would be deployed without writing them
aiwg use sdlc --ci-hooks-enabled --dry-run
```

**Model override precedence:** CLI flags > project `models.json` > user `~/.config/aiwg/models.json` > AIWG defaults

**Completion contract:** `aiwg use` is a composed convenience workflow. It
resolves the selected project, provider, and scope; deploys managed artifacts;
refreshes the applicable capability index; generates canonical context and
provider wiring; verifies the resulting filesystem and installed-state
records; then reports one stable outcome:

| Outcome | Meaning | Exit |
| --- | --- | --- |
| `planned` | Dry-run only; no readiness claim and no writes | 0 |
| `ready` | Required deployment invariants passed | 0 |
| `ready-restart-required` | Verified on disk; reload the provider before the current session can see new assets | 0 |
| `degraded` | Core deployment is usable with explicit advisory limitations | 0 |
| `failed` | At least one required deploy, index, context, registry, or wiring invariant failed | non-zero |

`aiwg doctor --deployment [--provider <name>] [--bundle <id>]
[--scope project|user] [--json]` reruns the same verifier without redeploying.
`aiwg status --probe [--provider <name>] [--bundle <id>]
[--scope project|user] --json` projects the same filtered result into the
stable status probe envelope. The value of `--scope` is never interpreted as a
project path. Standalone index and context commands remain targeted repair
tools; a successful `aiwg use` does not require users to invoke them manually.

The human completion report deliberately distinguishes two inventories:

- **Deployed to `<provider>`** counts the managed files copied into that
  provider's load paths.
- **Indexed for discovery** reports `totalArtifacts` and every `byType` entry
  from `aiwg index stats --graph framework --json`. Core types (`agent`,
  `skill`, `command`, `rule`, `behavior`, `template`, `flow`, `runbook`, and
  `schema`) remain visible at zero, while newly introduced index types appear
  automatically.

Warnings, failures, and remediation remain visible in the default report.
Successful phase-by-phase diagnostics and the explanation for a provider
reload are shown with `--verbose`.

**Shorthand values:** `opus`, `sonnet`, `haiku`, `inherit` — resolved per provider to full model IDs

**Framework options:**

| Framework           | ID          | Description                                        |
| ------------------- | ----------- | -------------------------------------------------- |
| **SDLC Complete**   | `sdlc`      | Full software development lifecycle with 93 agents |
| **Marketing Kit**   | `marketing` | Complete marketing campaign management             |
| **Writing Quality** | `writing`   | Voice profiles and content validation              |
| **All**             | `all`       | Deploy all frameworks                              |

**Addon options:**

| Addon            | ID             | Description                                                                           |
| ---------------- | -------------- | ------------------------------------------------------------------------------------- |
| **Civic Action** | `civic-action` | Evidence-bound civic research, review artifacts, and human-gated validation           |
| **RLM**          | `rlm`          | Recursive Language Models — recursive context decomposition for 10M+ token processing |

**Platform targets:**

| Platform       | `--provider` ID | Artifact dirs                                                                                                         | Behaviors |
| -------------- | --------------- | --------------------------------------------------------------------------------------------------------------------- | --------- |
| Google Antigravity CLI (experimental) | `antigravity` (`agy`) | `.agents/agents/`, `.agents/skills/`, project `AGENTS.md`; global skills unsupported | — |
| Oh My Pi (experimental) | `omp` (`oh-my-pi`) | `.omp/agents/`, `.omp/prompts/`, `.omp/rules/`, `.agents/skills/`, `.omp/AGENTS.md` | Explicit extension bridge |
| Pi Coding Agent (experimental) | `pi` | `.agents/skills/`, `.pi/prompts/`, `.pi/.aiwg/skills/`, project `AGENTS.md` | — |
| Claude Code    | `claude`        | `.claude/agents/`, `.claude/commands/`, `.claude/skills/`, `.claude/rules/`                                           | —         |
| GitHub Copilot | `copilot`       | `.github/agents/`, `.github/copilot-rules/`, `.github/skills/`                                                        | —         |
| Factory AI     | `factory`       | `.factory/droids/`, `.factory/commands/`, `.factory/skills/`, `.factory/rules/`                                       | —         |
| Cursor         | `cursor`        | `.cursor/agents/`, `.cursor/commands/`, `.cursor/skills/`, `.cursor/rules/`                                           | —         |
| Devin Desktop  | `devin`         | `AGENTS.md` (aggregated), `.windsurf/workflows/`, `.windsurf/skills/`, `.windsurf/rules/`                             | —         |
| Warp Terminal  | `warp`          | `.warp/agents/`, `.warp/commands/`, `.warp/skills/`, `.warp/rules/`, `WARP.md` (aggregated)                           | —         |
| OpenAI/Codex   | `codex`         | `.codex/agents/`, `~/.codex/prompts/`, `.agents/skills/`, `.codex/rules/`                                             | —         |
| OpenCode       | `opencode`      | `.opencode/agent/`, `.opencode/commands/`, `.opencode/skill/`, `.opencode/rule/`                                      | —         |
| Hermes         | `hermes`        | `~/.hermes/skills/`, `AGENTS.md` (lean)                                                                               | —         |
| OpenClaw       | `openclaw`      | `~/.openclaw/agents/`, `~/.openclaw/commands/`, `~/.openclaw/skills/`, `~/.openclaw/rules/`, `~/.openclaw/behaviors/` | ✓         |
| OpenHuman      | `openhuman`     | `~/.openhuman/skills/`, `~/.openhuman/.aiwg/rules/`, optional `~/.openhuman/agents/aiwg_*.toml`, project `AGENTS.md`  | —         |
| Local/Ollama   | `local`         | Same as `claude` (local model, Claude Code paths)                                                                     | —         |

**Commands → Skills migration:**

On first run after the commands-to-skills migration, `aiwg use` detects an existing commands directory and offers to delete it before deploying skills. Keeping both causes duplicate entries in the provider command palette. The prompt is shown when running interactively; in CI/non-TTY contexts the migration runs silently. Pass `--skip-commands-migration` to opt out (a warning is printed instead). Home-directory providers (codex, openclaw) are excluded from this migration.

**Notes:**

- **Codex**: Prompts deploy to `~/.codex/prompts/`; skills deploy to the
  project `.agents/skills/` discovery surface. The provider ID is `codex`, not
  `openai`.
- **Devin Desktop**: Agents aggregate into `AGENTS.md`; the adapter intentionally retains `.windsurf/` paths. `windsurf` is a deprecated selector alias.
- **Warp**: Agents and commands also aggregated into `WARP.md` for single-file context loading
- **OpenHuman**: Kernel skills and rule bodies are user-global; the default deploy emits no markdown persona copies. Project context is rendered into `AGENTS.md`, and curated native TOML agents are opt-in with `--harness-agents`.
- **Hermes**: Not a spawnable CLI — access via `ollama run hermes3` or MCP sidecar; deploy sets up skills and a lean AGENTS.md
- **OpenClaw**: Only provider with behaviors support (`~/.openclaw/behaviors/`); all artifacts deploy to home directory
- **Local/Ollama**: Uses Claude Code path layout; specify `--coding-model ollama/<model>` to route coding tasks to the local model

#### Scope models: project vs user (global) — ADR-NUA-001

`aiwg use` writes artifacts at two possible scopes. Both are supported.

| Scope                              | How to invoke                              | Artifact location example (Claude Code)                     | When it fits                                                                                  |
| ---------------------------------- | ------------------------------------------ | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **Project (default, recommended)** | `aiwg use sdlc` from a project root        | `./.claude/agents/`, `./.claude/skills/`                    | A specific codebase or project. Per-project agent set; no bleed across unrelated work.        |
| **User mirror (additive)**         | `aiwg use sdlc --scope user`               | Project paths plus `~/.claude/agents/`, `~/.claude/skills/` | Keep a full project deployment while also making the same assets available to other sessions. |
| **Global bootstrap**               | `aiwg use sdlc --provider claude --global` | User paths plus lightweight project bootstrap files         | Use native user-level assets without managing a framework deployment in each project.         |

**Trade-off (REF-720 cross-bleed).** The same `~/.claude/agents/` directory loads into every Claude Code session, regardless of project. Research from MSR/Salesforce (REF-720, _Lost in Multi-Turn Conversation_, 2025) measured a 39% capability drop when context bleeds across unrelated tasks. Project-scope keeps each project's artifact set isolated; user-scope intentionally trades that isolation for ubiquity. Choose the scope that fits the workflow; neither is wrong, and the project-isolation warning from `aiwg use` surfaces the trade-off at deploy time.

**Per-provider notes for global install:**

- **Claude Code** — `~/.claude/agents/` and `./.claude/agents/` merge at load time. `aiwg status --scope` (when implemented per the rough-edge inventory) helps disambiguate which artifacts came from which scope.
- **Codex** — Prompts use the user-level `~/.codex/prompts/` surface. Skills
  use project `.agents/skills/`, and `AGENTS.md` remains the project context
  bridge. AIWG prunes only its own legacy entries from `~/.codex/skills/`.
- **OpenClaw** — User-scope is the only supported scope. Project-scope is rejected at the CLI layer.
- **Hermes** — User-scope is the canonical mode; `~/.hermes/skills/` is the primary loader path.
- **Copilot / Cursor / Factory / OpenCode / Warp / Windsurf** — Global-install semantics on these providers are pending field validation as part of the Workstream A audit (`.aiwg/studies/novice-user-adoption/working/hookup-matrix.md`).

Status (ADR-NUA-001): **first-class supported flow**. Project-scope remains the recommended default. No deprecation of either mode is planned for the `2026.5.x` line. See `.aiwg/studies/novice-user-adoption/architecture/adr-global-install.md` for the full decision and `.aiwg/studies/novice-user-adoption/working/global-install-rough-edges.md` for the per-provider rough-edge inventory.

---

### list

List installed frameworks and addons.

```bash
aiwg list
```

**Capabilities:** cli, framework, query
**Platforms:** All
**Tools:** Read

**Output format:**

```
Installed Frameworks:
  sdlc-complete (v1.0.0) - Full SDLC framework
  media-marketing-kit (v1.0.0) - Marketing framework

Installed Addons:
  aiwg-utils (v1.0.0) - Core utilities
  voice-framework (v1.0.0) - Voice profiles

Total: 2 frameworks, 2 addons
```

---

### remove

Remove a framework, addon, or project-local bundle.

```bash
aiwg remove <id> [--force] [--dry-run] [--provider <p>] [--keep-registry]
```

**Arguments:**

- `<id>` — Framework, addon, or project-local bundle id (e.g., `sdlc`, `marketing`, `voice-framework`, `my-team-rules`)

**Flags (project-local bundles):**

- `--force` — Skip the case-2 mutation prompt and revert operator-edited deployed files. Does **not** delete bundle source under `.aiwg/<type>/<name>/`. Does **not** authorize deleting another bundle's deployed file.
- `--dry-run` — Print the revert plan; no filesystem or registry changes.
- `--provider <p>` — Restrict revert to one provider (e.g., `claude`, `cursor`).
- `--keep-registry` — Revert deployed files but leave the `installed` entry in `aiwg.config`.

**Capabilities:** cli, framework, uninstall
**Platforms:** All
**Tools:** Read, Write, Bash

**Examples:**

```bash
# Remove an upstream framework
aiwg remove sdlc

# Remove a project-local bundle (revert deploys, preserve source)
aiwg remove my-team-rules

# Preview without changes
aiwg remove my-team-rules --dry-run

# Override mutation refusal
aiwg remove my-team-rules --force
```

**Routing:**

- If `<id>` matches a project-local entry in `aiwg.config.installed`, routes to the project-local revert handler ([design](https://github.com/jmagly/aiwg/blob/main/.aiwg/architecture/design-aiwg-remove-revert.md)) which uses recorded `artifactHashes` to detect pristine vs mutated vs replaced deployed files. The `--provider` and `--keep-registry` flags apply only to this path.
- Otherwise, falls through to the upstream framework / plugin uninstaller, which accepts `--force`, `--keep-data`, and `--dry-run`. Unknown flags are rejected with a clear message (exit 2) instead of being silently ignored, and an unknown `<id>` reports `Plugin '<id>' is not installed` (exit 1) rather than crashing.
- `--provider` is supported only for project-local removal or user-scope removal (`--scope user --provider <p>`). Passing it to an upstream framework removal returns a clear error naming the supported alternatives.

**Source preservation invariant:** `aiwg remove` never deletes content under `.aiwg/<type>/<name>/`. To remove the source, use `rm -rf` explicitly.

**Activity log:** Emits `remove`, plus `remove-mutated` / `remove-conflict` per skipped artifact, plus `remove-force` when `--force` is used.

---

### promote

Graduate a project-local bundle to upstream or to a private corpus path.
Implements the identical-form portability invariant ([ADR #1038](https://github.com/jmagly/aiwg/blob/main/.aiwg/architecture/adr-identical-form-portability.md)) — copies `.aiwg/<type>/<name>/` to its destination and re-hashes every file to verify byte-identical correctness.

```bash
aiwg promote <name> [--to upstream|corpus <path>] [--dry-run] [--cleanup] [--force]
```

**Arguments:**

- `<name>` — Project-local bundle id

**Flags:**

- `--to upstream` (default) — Copy to `agentic/code/addons/<name>/`, `agentic/code/frameworks/<name>/`, or `agentic/code/providers/<name>/` based on bundle type.
- `--to corpus <path>` — Copy to `<path>/<name>/`. The path must exist; `<name>` must not pre-exist there.
- `--dry-run` — Print the plan (source, destination, file count, total bytes); no writes.
- `--cleanup` — Remove the `.aiwg/<type>/<name>/` source after a successful copy.
- `--force` — Bypass the `@.aiwg/` reference refusal (those references will dangle in the destination).

**Capabilities:** cli, framework, graduate, project-local
**Platforms:** All
**Tools:** Read, Write, Bash

**Pre-flight checks (in order):**

1. Bundle exists under `.aiwg/{type}/{name}/`
2. Destination doesn't already exist (refuses overwrite — must `aiwg remove` from upstream first)
3. No `@.aiwg/` references that would dangle (refuse without `--force`)

**Operation:**

1. Snapshot SHA-256 of every source file
2. Recursive `cp` to destination
3. Re-hash every destination file; **roll back** (delete dest) on any mismatch
4. Update registry: `source: 'project-local'` → `'bundled'` (or `'corpus'`)
5. Emit `promote` (or `promote-failed`) to the activity log

**Examples:**

```bash
aiwg promote my-team-rules                           # default --to upstream
aiwg promote my-team-rules --to corpus ~/my-corpus/  # private corpus
aiwg promote my-team-rules --dry-run                 # preview
aiwg promote my-team-rules --cleanup                 # remove .aiwg source after copy
```

---

### new-bundle

Scaffold a project-local bundle under the configured AIWG artifact root (`.aiwg/{type}/{name}/` by default) with a valid manifest, a starter artifact, and a README that includes the identical-form portability reminder.

```bash
aiwg new-bundle <name> [--type extension|addon|framework|plugin|provider] [--starter skill|rule|agent|minimal] [--description "..."]
```

**Arguments:**

- `<name>` — Bundle id (kebab-case: `a-z0-9-`, no leading/trailing hyphen)

**Flags:**

- `--type` — Bundle type (default: `extension`). Inferred from invocation when called via aliases (`new-extension`, `new-addon`, `new-framework`, `new-plugin`, `new-provider`).
- `--starter` — Which starter artifact to drop in. Default: `skill` for addon/extension; `minimal` for framework/plugin/provider.
- `--description` — Free-text human description for the manifest.

**Aliases:** `new-extension`, `new-addon`, `new-framework`, `new-plugin`, `new-provider`

**Capabilities:** cli, scaffolding, project-local
**Platforms:** All
**Tools:** Read, Write, Bash

**Examples:**

```bash
# Default extension with skill starter
aiwg new-bundle my-team-rules

# Addon with rule starter and custom description
aiwg new-bundle pg-helpers --type addon --starter rule --description "Postgres query helpers"

# Framework via alias
aiwg new-framework healthcare-sdlc

# Plugin (minimal starter)
aiwg new-plugin my-distro --starter minimal

# Provider selector that reuses an existing adapter
aiwg new-provider my-provider
aiwg use sdlc --provider my-provider
```

**What gets created:**

- `manifest.json` — valid against the canonical schema, all required fields filled
- `README.md` — usage, customization tips, identical-form reminder, deploy/remove/promote commands
- Provider bundles include `providerConfig.extends`; in phase 0 this reuses an existing writer adapter and does not define new output paths by itself. Optional `providerConfig.capabilities` overrides are consumed by `aiwg steward capabilities --provider <custom>`.
- Starter artifact: `skills/<name>-skill/SKILL.md`, `rules/<name>.md`, or `agents/<name>.md` depending on `--starter`
- Type-specific stubs: `src/.gitkeep` for framework, `payload/.gitkeep` for plugin

The bundle is immediately deployable: `aiwg use <name>`.

---

### install

Install an AIWG-compatible framework, addon, or extension package from a
remote Git repository into the local registry cache. Distinct from
`install-plugin` (Claude Code plugin format).

```bash
aiwg install <ref> [--ref <tag-or-sha>] [--package <id>] [--verify]
  [--deploy] [--provider <name>] [--target <dir>]
  [--project-local|--global] [--refresh]
```

**Arguments:**

- `<ref>` - Git URL or short reference for a package

**Options:**

- `--deploy` - Deploy immediately after install
- `--provider <name>` - Target provider (claude, copilot, cursor, ...) — default `claude`
- `--target <dir>` - Project directory to deploy into — default cwd
- `--refresh` - Force re-pull even if package is already cached
- `--ref <tag-or-sha>` - Resolve and lock this Git ref before deployment
- `--package <id>` - Select a wrapper when the repository contains several
- `--verify` - Require a trusted Ed25519 publisher signature
- `--policy <name|path>` - Apply a named local trust policy or JSON policy
- `--project-local` - Store registry, lock, receipts, and indices below the
  target project's `.aiwg/` directory
- `--global` - Store package state in the user AIWG directory (default)

Mutable refs are resolved to immutable commits and cached by commit. Direct
Git installs support root bundles and validated standalone
`.aiwg/plugins/<id>` wrappers. Without `--verify`, an unsigned but digest-valid
package is reported as `integrity-only`.

**Capabilities:** cli, framework, install, git
**Tools:** Read, Write, Bash

---

### marketplace

Exchange Git-native packages through direct remotes and independently signed
catalogs. Catalog inclusion is an observation, not an AIWG endorsement.

```bash
aiwg marketplace add <catalog-git-url> [--ref <tag-or-sha>]
aiwg marketplace search <query> [--source <id>] [--json]
aiwg marketplace info <package>
aiwg marketplace install <git-url|package> [--ref <tag-or-sha>] [--verify]
aiwg marketplace verify <package|lock-id> [--require-signature]
aiwg marketplace export <package> --output <archive.json>
aiwg marketplace import <archive.json> [--verify]
aiwg marketplace publish <source> --key <pem> --publisher <id>
aiwg marketplace remove <catalog-id>
aiwg marketplace list [--json]
```

**Subcommands:**

- `add` - Verify and register a signed Git catalog
- `search` - Search source adapters and signed catalog observations
- `info` - Show immutable lock, verification status, and catalog observations
- `install` - Install direct Git or catalog coordinates through one lock path
- `verify` - Verify cached bytes and evidence offline and emit a receipt
- `export` / `import` - Move a complete package, receipts, and Fortemi shard
  through an offline portable archive
- `publish` - Create a signed provenance envelope, lock, receipt, and Fortemi
  `2.0.0/full-v1` shard
- `remove` - Remove catalog discovery state while retaining installed locks
- `list` - List installed packages and verification status

**Options:**

- `--source <id>` - Limit search to an adapter or `catalog:<catalog-id>`
- `--json` - Emit structured JSON for programmatic consumption
- `--project-local` / `--global` - Select project or user state and indices
- `--target <dir>` - Select the project for project-local state
- `--policy <name|path>` - Select local signature/trust policy

**Capabilities:** cli, marketplace, search, discovery
**Tools:** Read

**Examples:**

```bash
aiwg marketplace search auth
aiwg marketplace search auth --source catalog:community
aiwg marketplace verify team/auth-tools --project-local
aiwg marketplace export team/auth-tools --output auth-tools.aiwg.json
aiwg marketplace list --json
```

See [Git-Native Package Exchange](../providers/git-native-marketplace.md) for
the envelope, lock, W3C PROV, trust, catalog, mirror, recovery, and key-rotation
contracts.

---

### packages

Manage packages installed via `aiwg install` (the remote-package registry).

```bash
aiwg packages list
aiwg packages info <key>
aiwg packages remove <key>
```

**Subcommands:**

- `list` - List all installed remote packages
- `info <key>` - Show metadata, cache state, and deploy hint for a package
- `remove <key>` - Remove a package from the local registry and cache

**Capabilities:** cli, framework, query, uninstall
**Tools:** Read

---

## Project Setup

For normal use, front project setup through the AIWG agent or setup skill:

```text
Help me set up this project for AIWG.
```

The agent should work with the user interactively to establish repo behavior,
issue storage, delivery policy, signing expectations, provider choices, and any
local issue-store needs. The CLI commands below are the underlying tools the
agent may call while doing that work.

### new

Create new project with SDLC templates.

```bash
aiwg new <project-name>
aiwg -new <project-name>
```

**Arguments:**

- `<project-name>` - Name of project directory to create

**Capabilities:** cli, project, scaffolding
**Platforms:** All
**Tools:** Read, Write, Bash

**Creates:**

```
my-project/
├── .aiwg/
│   ├── intake/
│   ├── requirements/
│   ├── architecture/
│   ├── planning/
│   ├── risks/
│   ├── testing/
│   ├── security/
│   ├── deployment/
│   └── frameworks/
│       └── registry.json
├── .claude/
│   ├── agents/
│   ├── commands/
│   └── skills/
├── CLAUDE.md
└── README.md
```

**Example:**

```bash
aiwg new customer-portal
cd customer-portal

# Framework already deployed, start working
/intake-wizard "Customer portal with real-time chat"
```

### session

Start an agentic session with pre-flight health checks, auto-repair, optional MCP injection, and provider launch.

```bash
aiwg session                        # default provider, full pre-flight + launch
aiwg session mcp                    # inject configured MCPs first, then launch
aiwg session --provider codex       # explicit provider
aiwg session mcp --provider cursor  # MCP inject for cursor + start instructions
aiwg session --no-repair            # skip auto-repair (still checks and reports)
```

**Options:**

- `mcp` - Inject configured MCP servers into the provider config before launching
- `--provider <p>` - Override provider (default: `providers[0]` from `.aiwg/aiwg.config`, then `claude`)
- `--no-repair` - Skip auto-repair; still runs health checks and reports issues
- `--profile <name>` - Launch with a named MCP profile (ephemeral by default — does not modify your provider's default config). For Claude: passes a temp config via `--mcp-config`. For Codex: sets up a per-profile runtime home via `~/.codex/roles-runtime/<profile>/`
- `--persist` - When combined with `--profile`, writes servers to the provider's default config instead of using an ephemeral temp file

**Pre-flight sequence:**

1. **Version check** — updates aiwg if stale (`npm install -g aiwg@latest`)
2. **Health check** — runs `aiwg doctor`; auto-repairs fixable issues via `aiwg refresh`
3. **Deployment check** — redeploys framework files to the provider if missing or stale
4. **MCP inject** (when `mcp` subcommand or `--profile` used) — runs `aiwg mcp inject --provider <p>`
5. **Launch** — spawns binary (claude, codex, opencode) or prints start instructions (IDE providers: cursor, windsurf, copilot, etc.)

**Auto-repair escalation:**

- Strategy 1: `aiwg refresh` (update + redeploy)
- Strategy 2: `npm install -g aiwg@latest` + redeploy all frameworks
- If unresolvable: surfaces `aiwg feedback --type bug` as escape hatch

**Capabilities:** cli, project
**Platforms:** All
**Tools:** Bash

**Examples:**

```bash
# Default: run pre-flight then launch claude
aiwg session

# With MCP servers injected first
aiwg session mcp

# Launch a specific provider
aiwg session --provider opencode

# Set up Cursor (IDE — prints instructions instead of launching)
aiwg session --provider cursor

# Combine MCP + provider
aiwg session mcp --provider codex

# Skip repair if you just want to check and launch
aiwg session --no-repair

# Launch claude with the 'dev' MCP profile (ephemeral — default config unchanged)
aiwg session --profile dev

# Launch codex with the 'ops' profile (isolated OAuth per profile)
aiwg session --provider codex --profile ops

# Persist profile servers into provider's default config
aiwg session --profile incident --persist
```

---

### serve

Start local HTTP dashboard server for sandbox fleet management and HITL relay.

```bash
aiwg serve
aiwg serve --port 8080 --bind 0.0.0.0
aiwg serve --no-open --read-only
```

**Options:**

- `--port <n>` - Port to listen on (default: `7337`)
- `--bind <host>` - Interface to bind (default: `127.0.0.1`)
- `--no-open` - Skip auto-opening browser
- `--read-only` - Disable PTY sessions and session creation

**Capabilities:** cli, server
**Platforms:** All
**Tools:** Read, Bash

**Requires:** `hono`, `@hono/node-server`, `ws` (auto-installed on first use; or `npm install hono @hono/node-server ws`)

**See also:** [Serve Guide](../serve-guide.md) for full API reference, WebSocket protocols, and integration details.

---

### local-executor

Start a no-sandbox host-process executor that boots `DaemonSupervisor` + `ExecutorShim` and registers with `aiwg serve` for mission dispatch. Implements `executor.aiwg.io/v1` Core + HITL conformance with `isolation: none` (#1181).

```bash
aiwg local-executor serve
aiwg local-executor serve --port 7400 --aiwg-serve http://127.0.0.1:7337
aiwg local-executor serve --max-concurrency 4 --executor-id <uuid>
```

**Options:**

- `--port <n>` - Port the executor listens on (default: auto-allocated)
- `--bind <host>` - Interface to bind (default: `127.0.0.1`)
- `--aiwg-serve <url>` - URL of the parent `aiwg serve` to register with (default: `http://127.0.0.1:7337`)
- `--max-concurrency <n>` - Max concurrent missions (default: `2`)
- `--executor-id <uuid>` - Stable executor ID for re-registration (default: generated)

**Conformance:** `executor-contract` v1 — Core + HITL profiles, `isolation: none`.

**Capabilities:** cli, executor, missions, hitl
**Platforms:** All
**Tools:** Bash

**See also:** [Executor Contract ADR](https://github.com/jmagly/aiwg/blob/main/.aiwg/architecture/adr-executor-contract.md), [executor.aiwg.io/v1 spec](https://github.com/jmagly/aiwg/blob/main/.aiwg/architecture/executor.aiwg.io-v1.md).

---

### init

Initialize an AIWG project by creating `.aiwg/aiwg.config` (provider registry,
scripts, delivery policy). Distinct from `aiwg new` (which scaffolds a
brand-new project tree).

```bash
aiwg init [--force] [--non-interactive | --yes]
```

**Options:**

- `--force` - Overwrite an existing `.aiwg/aiwg.config`
- `--non-interactive`, `--yes` - Skip prompts and accept detected defaults

**Capabilities:** cli, project, config, setup
**Tools:** Read, Write

If a config already exists, the command exits without changes unless `--force` is passed.

---

### setup

CLI helper for project-level repository policy, issue tracker routing, delivery
mode, and signing metadata. This command is usually called by an AIWG
agent/skill during the guided setup conversation rather than used as the first
user-facing step.

```bash
aiwg setup project [--yes] [--dry-run] [--target <dir>]
```

The helper detects Git remotes and proposes `remotes.primary`,
`remotes.issue_tracker`, optional `remotes.customer_issue_tracker`,
`remotes.ci`, secondary mirrors, tracker tooling,
delivery policy, committer identity, and signing metadata. Agents should use
`--dry-run` first, discuss the preview with the user, then write only after the
policy choices are understood. In non-interactive contexts it refuses to write
unless `--yes` is present.

Common overrides:

```bash
aiwg setup project --dry-run
aiwg setup project --yes --providers claude,codex
aiwg setup project --yes --issue-provider gitea --tracker-actor-login roctinam
aiwg setup project --yes --issue-provider gitea \
  --customer-issue-tracker github --customer-issue-provider github \
  --customer-tracker-actor-login jmagly
aiwg setup project --yes --delivery-mode direct --default-branch main
aiwg setup project --yes --issue-provider local
```

`--issue-provider` accepts `gitea`, `github`, or `local` and writes
`remotes.issue_provider` so later issue tooling can resolve self-hosted trackers
whose remote URL is ambiguous. Local mode also writes `remotes.issue_tracker:
"local"` and pairs with the `.aiwg/issues/` store managed by `aiwg issue init`.
Self-hosted remotes that cannot be classified from their URL require an explicit
provider choice or confirmation.

The helper validates the proposed repo/tracker/delivery/signing combination
before writing. Manual `.aiwg/aiwg.config` editing remains available for
advanced cases, but the preferred user experience is the agent-led setup flow.

**Capabilities:** cli, project, config, setup, issues, delivery-policy
**Tools:** Read, Write, Bash

---

### issue

Policy-plan and manage the project-local issue store. External issue-authoring
skills use the same composition contract before their tracker-specific write.

```bash
aiwg issue init [--prefix KEY] [--padding N]
aiwg issue plan --title "..." [--body "..."|--body-file path] [--json]
aiwg issue new --title "..." [--body-file path] [--authorize-policy DIGEST]
aiwg issue list [--status open] [--label bug] [--json]
aiwg issue show <KEY> [--comments last:10|all]
aiwg issue comment <KEY> --body "..."
aiwg issue close <KEY> [--reason "..."]
```

`plan` emits `aiwg.issue-composition-plan.v1`. Safe drafts have disposition
`single`; flagged drafts require digest-bound authorization; separable drafts
that would otherwise be rejected become ordered `split` segments; and
non-separable rejected drafts return `blocked` without a write. Split segments
retain labels, priority, provider scope, acceptance content, stable provenance
markers, dependencies, and sibling links. Partial writes return the next
segment and marker set so retry can reuse existing issues.

---

### run

Two routes, dispatched by the first argument:

#### `aiwg run [script-name]` — user scripts from `aiwg.config`

Execute a named script defined in `.aiwg/aiwg.config` (analogous to `npm run`).

```bash
aiwg run [script-name] [--output-mode <id>]... [project-dir]
```

**Arguments:**

- `[script-name]` - Script entry from `aiwg.config`. Omit to list all scripts.
- `[project-dir]` - Project directory (default cwd)

#### `aiwg run skill <name>` — script-bearing skills (#1227)

Execute a skill's declared script entrypoint via the CLI's runtime registry.
Resolves the skill via the artifact index (the same one `aiwg discover` and
`aiwg show` use), reads its `script:` frontmatter block, and dispatches the
entrypoint with the right interpreter (node, python3, bash, sh, pwsh, ruby,
or `auto` by extension/shebang).

```bash
aiwg run skill <stable-id-or-name> [--output-mode <id>]... [--cwd <path>] [-- <args forwarded to script>]
```

The selector accepts either the canonical skill name returned by `aiwg discover`
or that result's stable `aiwg:skill:...` artifact ID. Both resolve through the
same framework, project, and codebase graph normalization used by
`aiwg discover` and `aiwg show`.

Repeated `--output-mode` flags compose invocation-scoped modes with session and
project state. Flags after `--` are forwarded to the child unchanged. The
resolved ordered profiles are exposed to scripts as `AIWG_OUTPUT_MODES` and
`AIWG_OUTPUT_MODES_JSON`; an empty stack exports an empty string and `[]` so
stale parent state cannot leak into a nested run. Provider startup files are
not rewritten.

**Examples:**

```bash
aiwg run skill voice-apply -- --voice technical-authority --input draft.md
aiwg run skill template-engine -- render adr-template.md --vars vars.yaml
aiwg run skill ai-pattern-detection -- --path docs/
```

**CWD invariant:** the script runs from the project root the CLI was invoked
from, **not** from the skill's source directory. Skill scripts live at
`$AIWG_ROOT/agentic/code/...` but operate on the user's project, so relative
paths (`.aiwg/`, `src/`, `package.json`) resolve into the user's tree. Override
via `--cwd <path>` for scripted/CI cases. Per-skill manifest can also set
`cwd: skill-dir` (rare) or `cwd: aiwg-root` (escape hatch).

**Env vars exposed to the script:**

| Var                 | Value                                         |
| ------------------- | --------------------------------------------- |
| `AIWG_PROJECT_ROOT` | absolute path to the calling project's root   |
| `AIWG_SKILL_DIR`    | absolute path to the skill's source directory |
| `AIWG_ROOT`         | AIWG installation root                        |
| `AIWG_OUTPUT_MODES` | comma-separated effective output-mode IDs     |
| `AIWG_OUTPUT_MODES_JSON` | ordered profiles, metadata, and protected-content policy |

**Manifest schema** (in SKILL.md frontmatter):

```yaml
script:
  entrypoint: scripts/voice_loader.py # required, relative to skill dir
  runtime: python3 # required: node|python3|bash|sh|pwsh|ruby|auto
  cwd: project-root # optional, default
  argsHint: "--voice <name> --input <path>" # optional UX hint
```

Skills without a `script:` block remain pure-instructional (no behavior change).
Discovery surfaces script-bearing skills with `"executable": true` and a
`run_hint` in `aiwg discover --json`; human output marks them with `[exec]`.

**Capabilities:** cli, utility, scripts, skills

---

### output-mode

Manage provider-neutral output presentation constraints without rewriting
provider startup files.

```bash
aiwg output-mode list
aiwg output-mode show <id>
aiwg output-mode enable <id> --scope invocation|session|project
aiwg output-mode disable <id> --scope session|project
aiwg output-mode clear --scope session|project
aiwg output-mode status [--output-mode <id>]...
```

The empty effective stack is the byte-preserving `unaltered` path. Profile
resolution is project, user, voice adapter, then built-in; composition order is
semantic, voice, controlled language, structure, presentation. Unknown modes,
undeclared same-kind combinations, explicit conflicts, missing requirements,
and mandatory validation without a configured validator fail safe.

Project profiles live in `.aiwg/output-modes/`. Personal profiles live below
the active user configuration path reported by `aiwg config path`. Selecting a
mode resolves and exports policy; the participating skill, script, or provider
adapter must consume and apply that policy. The `aiwg` package root exports the
registry and `applyOutputModes` runtime for integrations.

See `docs/addons/voice-framework/output-modes.md` for the user guide,
custom-profile authoring, integration contract, and troubleshooting links.

**Capabilities:** cli, voice, controlled-language, presentation
**Tools:** Read, Bash

---

### sandbox

Sandbox agent identity management — alias logical agent names to persistent
identities, resolve aliases, and list known identities.

```bash
aiwg sandbox alias <ref>
aiwg sandbox resolve <ref>
aiwg sandbox identities [--json]
```

**Subcommands:**

- `alias <ref>` - Bind a logical agent name to a persistent identity
- `resolve <ref>` - Resolve a logical name to its identity record
- `identities` - List all known persistent agent identities

**Options:**

- `--json` - (with `identities`) emit structured JSON

**Capabilities:** cli, sandbox, agent-identity, agent-routing
**Tools:** Bash

---

## Workspace Management

### status

Show workspace health and installed frameworks.

```bash
aiwg status
aiwg -status
```

**Capabilities:** cli, workspace, status
**Platforms:** All
**Tools:** Read, Bash

**Shows:**

- Project directory
- Installed frameworks and versions
- Framework health status
- Agent deployment count
- Command deployment count
- Workspace artifact summary
- Git status (if git repo)

**Example output:**

```
Workspace: /home/user/customer-portal
Git: clean (main branch)

Frameworks:
  ✓ sdlc-complete v1.0.0 (93 agents, 42 commands)
  ✓ aiwg-utils v1.0.0

Artifacts:
  Requirements: 12 files
  Architecture: 5 files
  Tests: 8 files

Status: Healthy
```

---

### migrate-workspace

Migrate legacy `.aiwg/` to framework-scoped structure.

```bash
aiwg migrate-workspace
```

**Capabilities:** cli, workspace, migration
**Platforms:** All
**Tools:** Read, Write, Bash

**Migrates:**

From (legacy):

```
.aiwg/
├── intake/
├── requirements/
└── ...
```

To (framework-scoped):

```
.aiwg/
├── frameworks/
│   ├── registry.json
│   └── sdlc-complete/
│       ├── intake/
│       ├── requirements/
│       └── ...
└── shared/
```

**Safety:**

- Creates backup in `.aiwg.backup-<timestamp>/`
- Validates migration before committing
- Preserves all content
- Updates framework registry

---

### rollback-workspace

Rollback workspace migration from backup.

```bash
aiwg rollback-workspace
```

**Capabilities:** cli, workspace, rollback
**Platforms:** All
**Tools:** Read, Write, Bash

**Restores from:**

- `.aiwg.backup-<timestamp>/` directories
- Prompts to select backup if multiple exist
- Validates backup before restoring
- Creates pre-rollback backup

---

## MCP Commands

### mcp

MCP server operations.

```bash
aiwg mcp <subcommand>
```

**Subcommands:**

#### mcp serve

Start the AIWG MCP server.

```bash
aiwg mcp serve
aiwg mcp serve --toolsets=flows,missions,ralph    # opt-in toolsets
aiwg mcp serve --toolsets=all                      # everything (66 tools)
```

**Options:**

- `--toolsets <csv>` — Enable opt-in subsystem toolsets (overrides `AIWG_MCP_TOOLSETS` env var). Known: `flows`, `missions`, `memory`, `kb`, `research`, `activity-log`, `index`, `ralph`, `mc`, `ops`, `all`. The `core` set is always on.

**Actions:**

- Starts stdio-based MCP server
- Exposes 15 core tools by default (discover, _-list/_-show pairs, command-run, and artifact-read/write)
- Additional 51 tools available via opt-in toolsets
- Supports Claude Desktop, Cursor, Factory, Hermes (as MCP sidecar)

**Default surface (15 tools; schema cost should be re-measured after tool changes)**:

- `discover` — semantic search across skills/agents/commands/rules
- `skill-list` / `skill-show`, `command-list` / `command-show`, `rule-list` / `rule-show`, `agent-list` / `agent-show`, `template-list` / `template-render` / `template-show`
- `command-run` — allow-listed CLI dispatch
- `artifact-read` / `artifact-write`

`workflow-run` has been removed from the core MCP surface. Use `command-run`
for general AIWG CLI execution, `AIWG_MCP_TOOLSETS=flows` with
`flow-list` / `flow-show` / `flow-run` for declarative Flow access, or
`AIWG_MCP_TOOLSETS=missions` with `mission-guide` / `mission-dispatch` /
`mission-status` for Mission access.

**Opt-in toolsets**: see [MCP capability audit](../integrations/mcp-capability-audit.md) and [Tool reference](../integrations/hermes-quickstart.md#tool-name-mangling) for details.

#### mcp install

Generate MCP client configuration.

```bash
aiwg mcp install <client>
```

**Arguments:**

- `<client>` - Client name: `claude`, `cursor`, `factory`

**Options:**

- `--dry-run` - Preview without writing

**Actions:**

- Generates client-specific config
- Adds to `~/.config/claude/config.json` (Claude Desktop)
- Adds to `.cursor/config.json` (Cursor)
- Shows manual steps if auto-install fails

**Example:**

```bash
# Install for Claude Desktop
aiwg mcp install claude

# Preview config
aiwg mcp install claude --dry-run
```

#### mcp info

Show MCP server capabilities.

```bash
aiwg mcp info
```

**Shows:**

- MCP protocol version
- Available tools
- Available resources
- Available prompts
- Server status

**Capabilities:** cli, mcp, server
**Platforms:** All
**Tools:** Read, Write, Bash

#### mcp add

Register an MCP server in the AIWG server registry (`~/.aiwg/mcp-servers.json`).

```bash
aiwg mcp add <name> --url <url> [--type http|stdio|sse] [--description <text>]
aiwg mcp add <name> --url <url> --header-env Authorization=ENV_VAR
aiwg mcp add <name> --type stdio --command <cmd> [--args <a,b>] [--env KEY=VAL]
```

**Arguments:**

- `<name>` - Unique server name (referenced by profiles and inject)

**Options:**

- `--type <type>` - Server type: `http` (default), `stdio`, `sse`
- `--url <url>` - URL for http/sse servers
- `--command <cmd>` - Executable for stdio servers
- `--args <a,b>` - Comma-separated args for stdio command
- `--env KEY=VAL` - Environment variable(s) for stdio servers
- `--headers KEY=VAL` - HTTP headers for http/sse servers
- `--header-env HEADER=ENV_VAR` - Resolve a remote HTTP/SSE header from an
  environment variable at connection time. The registry stores only the
  variable name. An `Authorization` reference is sent as a Bearer token.
- `--description <text>` - Human-readable description

**Example:**

```bash
# HTTP server
aiwg mcp add my-api --url http://localhost:3001 --description "Local API server"

# Authenticated Enterprise server; no token is stored in the registry
aiwg mcp add fortemi-enterprise --url https://memory.example.internal/mcp \
  --header-env Authorization=AIWG_FORTEMI_TOKEN

# stdio server
aiwg mcp add git-server --type stdio --command npx --args @gitea/mcp-server
```

#### mcp remove

Remove a server from the AIWG registry.

```bash
aiwg mcp remove <name>
```

Note: does not remove the server from already-injected provider configs. Re-run `aiwg mcp inject --all` to propagate removals.

#### mcp update

Update a registered server's properties.

```bash
aiwg mcp update <name> [--url <url>] [--type <type>] [--command <cmd>] [--description <text>]
```

Re-run `aiwg mcp inject --all` after updating to propagate changes to provider configs.

#### mcp list

List all registered MCP servers.

```bash
aiwg mcp list
```

Shows server name, type, URL or command, description, and which providers it has been injected into.

#### mcp inject

Inject registered servers into a provider's config file.

```bash
aiwg mcp inject --provider <name> [options]
aiwg mcp inject --all [--dry-run]
```

**Options:**

- `--provider <name>` - Target provider: `claude` (`claude-code`),
  `cursor`, `factory` (`factory-ai`), `codex` (`openai`), `opencode`,
  `windsurf` (`devin`, `devin-desktop`), or `warp`
- `--all` - Inject into all providers that have been configured before
- `--profile <name>` - Resolve server set from a named MCP profile (see `mcp profile`)
- `--ephemeral` - Write a standalone temp config without modifying the
  provider's default config. Supported by every listed provider except `warp`;
  `openai` is accepted as an alias for `codex`
- `--out <path>` - Explicit output path for ephemeral config (default: auto-generated temp file)
- `--servers <a,b>` - Comma-separated server name filter (alternative to `--profile`)
- `--dry-run` - Preview what would be written without modifying any files

**Example:**

```bash
# Inject all registered servers into Claude Code config
aiwg mcp inject --provider claude

# Inject servers from the 'dev' profile only
aiwg mcp inject --provider claude --profile dev

# Ephemeral: write to a temp file, don't touch default config
aiwg mcp inject --provider claude --profile ops --ephemeral

# Ephemeral to a specific path
aiwg mcp inject --provider claude --profile ops --ephemeral --out /tmp/ops-mcp.json

# Propagate updates to all previously configured providers
aiwg mcp inject --all

# Preview without writing
aiwg mcp inject --provider cursor --dry-run
```

#### mcp profile

Manage named MCP profiles — ordered subsets of registered servers stored in `~/.aiwg/mcp-profiles.json`.

Profiles let you launch sessions or inject only the servers relevant to a specific task (e.g., `dev` for code editing, `ops` for infrastructure work).

`git-gitea` is a provider-agnostic MCP server option for any MCP-capable AIWG provider. Hermes-specific setup docs may require MCP wiring for Hermes workflows that need tools, but that requirement does not make Git MCP Hermes-exclusive.

```bash
aiwg mcp profile <subcommand>
```

**Subcommands:**

| Subcommand                     | Description                               |
| ------------------------------ | ----------------------------------------- |
| `add <name>`                   | Create a new profile                      |
| `list`                         | List all profiles                         |
| `show <name>`                  | Show profile details and resolved servers |
| `edit <name>`                  | Add/remove servers or update description  |
| `remove <name>`                | Delete a profile                          |
| `import <file>`                | Import profiles from a JSON file          |
| `export [<name>] --out <file>` | Export one or all profiles                |
| `init-presets`                 | Install built-in preset profiles          |

**Preset Profiles** (installed via `aiwg mcp profile init-presets`):

| Name       | Servers                                                       | Description                       |
| ---------- | ------------------------------------------------------------- | --------------------------------- |
| `minimal`  | (none)                                                        | Minimal toolset for smoke tests   |
| `dev`      | git-gitea, codeindex-codehound, memory-fortemi                | Code editing + git + memory       |
| `ops`      | git-gitea, cmdb-itassets, memory-fortemi                      | Infra + git + CMDB                |
| `research` | memory-fortemi, google-drive, google-calendar                 | Documentation + memory + calendar |
| `incident` | git-gitea, cmdb-itassets, memory-fortemi, codeindex-codehound | Incident response                 |
| `full`     | `__all__`                                                     | All registered servers            |

`git-gitea` in the built-in presets means "this task profile needs Git/Gitea tools." Provider-specific policies can deny individual high-risk tools, but the server itself is available to all MCP-capable providers.

**Profile options:**

```bash
# add
aiwg mcp profile add <name> --servers <a,b> [--description <text>]

# edit
aiwg mcp profile edit <name> --add-server <s> --remove-server <s> [--description <text>]

# export
aiwg mcp profile export <name> --out ./my-profile.json
aiwg mcp profile export --out ./all-profiles.json   # export all
```

**Examples:**

```bash
# Install built-in presets
aiwg mcp profile init-presets

# Create a custom profile
aiwg mcp profile add my-work --servers git-gitea,memory-fortemi --description "Daily work"

# List all profiles
aiwg mcp profile list

# Inspect a profile
aiwg mcp profile show dev

# Add a server to an existing profile
aiwg mcp profile edit my-work --add-server codeindex-codehound

# Use a profile in a session
aiwg session --profile dev

# Use a profile for ephemeral inject
aiwg mcp inject --provider claude --profile ops --ephemeral
```

**Profile storage:** `~/.aiwg/mcp-profiles.json` (apiVersion: `aiwg.io/v1`, kind: `McpProfileRegistry`)

**Codex runtime homes:** When `--provider codex` with `--profile` is used, AIWG creates a per-profile runtime home at `~/.codex/roles-runtime/<profile>/`. Each runtime home has an isolated `config.toml` with only the profile's servers, and OAuth tokens are stored separately per profile. Shared state (history, sessions) is symlinked from `~/.codex/`.

---

## Catalog Commands

### catalog

Model catalog operations.

```bash
aiwg catalog <subcommand>
```

**Subcommands:**

#### catalog list

List available models.

```bash
aiwg catalog list
```

**Options:**

- `--provider <name>` - Filter by a provider in the active catalog. The
  built-in catalog currently includes `anthropic`, `openai`, `google`,
  `openrouter`, and `ollama`.
- `--type <type>` - Filter by type (chat, completion, embedding)

#### catalog info

Show model information.

```bash
aiwg catalog info <model-id>
```

**Arguments:**

- `<model-id>` - Model identifier (e.g., `claude-opus-4-6`)

#### catalog search

Search model catalog.

```bash
aiwg catalog search <query>
```

**Arguments:**

- `<query>` - Search terms

**Capabilities:** cli, catalog, models
**Platforms:** All
**Tools:** Read

---

### skills

Search third-party registry adapters and manage standard-aware Agent Skills
imports and exports. agentskills.io defines a directory format; it does not
provide an official registry API.

```bash
aiwg skills <subcommand> [options]
```

**Subcommands:**

- `list [--provider <registry>]` - List skills from configured adapters,
  including managed Agent Skills imports
- `search <query> [--provider <registry>]` - Search configured adapters
- `info <name> [--provider agentskills]` - Inspect metadata, provenance,
  digest, trust, activation, and managed path
- `install <name> [--provider <registry>] [--target <provider>]` - Install from
  a third-party adapter
- `import <directory> [options]` - Validate and byte-preserve a local Agent
  Skills directory
- `import --git <url> --rev <revision> --subpath <path> [options]` - Import an
  explicitly pinned Git skill
- `deploy <name> [--target <provider|all>] [--dry-run] [--json]` - Project a
  trusted active import to provider paths
- `uninstall <name> [--target <provider|all>] [--dry-run] [--json]` - Remove
  only a matching AIWG-managed provider projection
- `publish <path> --provider <registry>` - Publish through a configured
  third-party adapter

**Import options:**

- `--profile strict|compatible` - Validate portable-only or recognized
  AIWG-extended source (default: `strict`)
- `--dry-run` - Validate and plan without writing
- `--update` - Accept changed content from the same source locator
- `--force` - Replace an imported name from a different reviewed source
- `--trust --activate` - Trust and activate the exact source digest
- `--json` - Emit deterministic structured output

**Examples:**

```bash
# Local compatible source: preview, import, inspect
aiwg skills import ./portable-complete --profile compatible --dry-run --json
aiwg skills import ./portable-complete --profile compatible --trust --activate
aiwg skills info portable-complete --provider agentskills

# Pinned Git source
aiwg skills import \
  --git https://example.com/team/skills.git \
  --rev 0123456789abcdef0123456789abcdef01234567 \
  --subpath skills/portable-complete \
  --profile compatible \
  --trust \
  --activate

# Provider lifecycle
aiwg skills deploy portable-complete --target generic --dry-run --json
aiwg skills deploy portable-complete --target generic
aiwg skills uninstall portable-complete --target generic
aiwg skills export aiwg-status --out ./agent-skill-exports --json
```

Validation uses `aiwg validate-metadata --profile <profile>`, where the profile
is `strict`, `compatible`, or `discovery`. Provider projection details, trust
rules, diagnostics, sidecars, updates, and all 14 target paths are documented
in [Agent Skills import and deployment](../skills/agent-skills.md).

**Capabilities:** cli, skills, registry, import, validation, deployment
**Tools:** Read, Bash

---

## Toolsmith Commands

### runtime-info

Show runtime environment summary with tool discovery.

```bash
aiwg runtime-info
```

**Capabilities:** cli, toolsmith, discovery
**Platforms:** All
**Tools:** Read, Bash

**Shows:**

- Platform detection (Claude Code, Cursor, etc.)
- Available tools (Read, Write, Bash, Glob, Grep)
- System utilities (git, jq, curl, etc.)
- Environment variables
- Tool capabilities and limitations

**Example output:**

```
Platform: Claude Code
AI Model: claude-sonnet-4-6

Available Tools:
  ✓ Read (supports images, PDFs)
  ✓ Write
  ✓ Bash (timeout: 2min)
  ✓ Glob
  ✓ Grep

System Utilities:
  ✓ git v2.39.0
  ✓ jq v1.6
  ✓ node v20.10.0
  ✓ npm v10.2.3
  ✗ gh (GitHub CLI not installed)

Scheduler:
  Backend:  native-cron (CronCreate); external trigger outside agent sessions
  Chrony:   ✓ installed (precise NTP)

Environment: Linux 6.14.0-37-generic
```

---

## Schedule Skill

The Schedule skill routes to provider-native tools when they exist. In a
Claude Code agent session it may use `CronCreate`, `CronList`, and
`CronDelete`.

The production CLI does not expose `aiwg schedule`, `aiwg daemon`, or a daemon
scheduler fallback. On Codex, recurring execution is **external**: system cron,
a systemd timer, or CI owns time and launches a reviewed non-interactive
provider command. This is not AIWG emulation.

Use `aiwg steward capabilities --provider codex --feature cron` to inspect the
current classification and `aiwg help` to verify registered top-level commands.

---

## External Job Command

The `job` command implements reviewed, single-shot work launched by an external
scheduler. It does not run a clock or resident daemon.

```bash
aiwg job validate jobs/publish.yaml
aiwg job render-cron jobs/publish.yaml --format cron
aiwg job render-cron jobs/publish.yaml --format systemd
aiwg job render-cron jobs/publish.yaml --format gitea-actions
aiwg job run jobs/publish.yaml --once --json
```

The v1 contract covers a Codex stdin executor, Gitea work-item claims,
approval policy, allowed origins/accounts/attachment roots, stable idempotency,
private run evidence, and completion verification. See
[External-trigger jobs](../guides/external-trigger-jobs.md).

---

## Utility Commands

### prefill-cards

Prefill SDLC card metadata from team profile.

```bash
aiwg prefill-cards
```

**Capabilities:** cli, sdlc, automation
**Platforms:** All
**Tools:** Read, Write

**Actions:**

- Reads `.aiwg/team-profile.json`
- Finds empty SDLC cards (use cases, architecture docs, etc.)
- Fills in standard metadata (author, date, version)
- Preserves existing content

**Example:**

```bash
# Create team profile first
cat > .aiwg/team-profile.json <<EOF
{
  "project": "Customer Portal",
  "team": "Platform Team",
  "defaultAuthor": "Jane Developer",
  "defaultReviewer": "John Architect"
}
EOF

# Prefill all cards
aiwg prefill-cards
```

---

### contribute-start

Start AIWG contribution workflow.

```bash
aiwg contribute-start
```

**Capabilities:** cli, contribution, workflow
**Platforms:** All
**Tools:** Read, Write, Bash

**Actions:**

- Guides through contribution setup
- Creates feature branch
- Sets up development environment
- Links to contribution guidelines

---

### validate-metadata

Validate plugin/agent metadata.

```bash
aiwg validate-metadata [options] [path]
```

**Arguments:**

- `[path]` - Optional path to validate. Defaults to recursive validation of `agentic/code`.

**Options:**

- `--recursive` - Validate all manifests in a directory recursively.
- `--format text|json` - Select text or JSON output.
- `--strict` - Treat warnings as errors.
- `--ci` - CI mode.
- `--fix` - Auto-fix common metadata issues where supported.
- `--profile strict|compatible|discovery` - Select Agent Skills conformance
  policy (default `compatible`).

**Capabilities:** cli, validation, metadata
**Platforms:** All
**Tools:** Read

**Validates:**

- Extension schema compliance
- Required fields present
- Version format correct
- Platform compatibility declared
- Keywords and capabilities present
- Agent Skills frontmatter, standard limits, field profile, and referenced
  resources for every discovered `SKILL.md`

**Example:**

```bash
# Validate all extensions in current directory
aiwg validate-metadata

# Validate specific extension
aiwg validate-metadata .claude/agents/api-designer.md

# Validate a framework's skills
aiwg validate-metadata --recursive agentic/code/frameworks/security-engineering/skills
```

### feedback

Submit a bug report, feature request, or feedback to the AIWG GitHub repository. System context (version, OS, Node, provider, installed frameworks) is collected and prefilled automatically.

```bash
aiwg feedback                              # interactive (if TTY)
aiwg feedback --type bug                   # skip type selection
aiwg feedback --type feature               # feature request
aiwg feedback --type doc                   # documentation gap
aiwg feedback --title "X" --body "Y"       # fully non-interactive
aiwg feedback --no-context                 # skip attaching system context
```

**Aliases:** `report`

**Options:**

- `--type <t>` - Feedback type: `bug`, `feature`, `doc`, `other` (interactive prompt if omitted)
- `--title <text>` - Issue title (interactive prompt if omitted)
- `--body <text>` - Issue description (interactive prompt if omitted)
- `--no-context` - Skip collecting and attaching system context

**Submission flow:**

1. If `gh` CLI is available → `gh issue create --repo jmagly/aiwg` with appropriate label
2. Otherwise → opens browser with pre-filled GitHub issue URL
3. If no browser (non-TTY) → prints formatted issue body to stdout for manual filing

**System context collected automatically:**

| Field        | Source                               |
| ------------ | ------------------------------------ |
| aiwg version | `aiwg version`                       |
| Node.js      | `process.version`                    |
| OS           | `os.type() + os.release()`           |
| Arch         | `os.arch()`                          |
| Provider     | `.aiwg/aiwg.config` `providers[0]`   |
| Frameworks   | `.aiwg/aiwg.config` `installed` keys |
| Shell        | `$SHELL` / `$COMSPEC`                |

**Capabilities:** cli, utility
**Platforms:** All
**Tools:** Bash

**Examples:**

```bash
# Interactive — prompts for type, title, description
aiwg feedback

# File a bug report non-interactively
aiwg feedback --type bug \
  --title "doctor crashes in empty project" \
  --body "Running aiwg doctor in a new directory with no .aiwg causes an unhandled exception."

# Request a feature
aiwg feedback --type feature --title "add --watch flag to aiwg index build"

# Report a doc gap
aiwg feedback --type doc --title "mcp inject workflow not documented"

# Skip system context (for privacy)
aiwg feedback --type bug --title "crash" --body "details" --no-context
```

**Tip:** `aiwg doctor` surfaces `aiwg feedback --type bug` automatically when it finds issues it cannot auto-repair.

---

### lint

Lint AIWG artifacts against declarative rule sets discovered from installed frameworks.

```bash
aiwg lint <target> [--ruleset <name>] [--format full|summary|json]
                   [--ci] [--fail-on error|warn|info] [--dry-run]
aiwg lint --list-rulesets
aiwg lint --list-rules <ruleset>
```

**Arguments:**

- `<target>` - File or directory to lint

**Options:**

- `--ruleset <name>` - Force a specific ruleset (otherwise auto-detected from path)
- `--format full|summary|json` - Output format
- `--ci` - CI-friendly output and exit codes
- `--fail-on error|warn|info` - Severity threshold for non-zero exit
- `--dry-run` - Report what would run without executing rules
- `--list-rulesets` - List all discovered rulesets
- `--list-rules <name>` - List rules contained in a ruleset

**Capabilities:** cli, lint, validation, quality
**Tools:** Bash, Read, Glob, Grep

**Examples:**

```bash
aiwg lint .aiwg/research/ --ruleset research
aiwg lint .aiwg/ --format json --ci --fail-on warn
aiwg lint --list-rulesets
```

---

### skill-lint

Score `SKILL.md` files against a quality rubric (schema, description, discoverability, body).

```bash
aiwg skill-lint <path> [--rubric strict|standard|lenient] [--profile strict|compatible|discovery] [--json]
```

**Arguments:**

- `<path>` - File or directory containing skills (default `agentic/code`)

**Options:**

- `--rubric strict|standard|lenient` - Threshold profile (default `standard`)
- `--profile strict|compatible|discovery` - Agent Skills conformance profile
  (default `compatible`)
- `--json` - Emit structured JSON report

**Capabilities:** cli, validation, metadata, quality
**Tools:** Read

Output reports the shared Agent Skills conformance result, per-file quality
scores with dimension-level notes, and an aggregate average. Conformance errors
fail the file regardless of its quality score.

---

## Plugin Commands

**Note:** Plugin commands are specific to Claude Code integration.

### Published plugins

The AIWG marketplace publishes **40 plugins**. The authoritative names,
descriptions, versions, and sources live in `.claude-plugin/marketplace.json`.
Local packages resolve from `./agentic/code/plugins/<name>`; `training` is the
only externally sourced package.

- Frameworks: `sdlc`, `marketing`, `forensics`, `security-engineering`,
  `research`, `media-curator`, `ops`, `knowledge-base`, and `validation-complete`.
- Agent runtime: `agent-loop`, `agent-persistence`, `guided-implementation`,
  `context-curator`, `daemon`, `droid-bridge`, `prose-integration`, and `rlm`.
- Memory and knowledge: `auto-memory`, `line-memory`, `compound-memory`,
  `semantic-memory`, `llm-wiki`, and `doc-intelligence`.
- Quality and delivery: `aiwg-evals`, `testing-quality`, `uat-mcp`,
  `twelve-factor`, `agentic-installer`, `skill-factory`, `aiwg-dev`, and `nlp-prod`.
- Writing and design: `voice`, `writing`, `verbalized-sampling`, `color-palette`,
  `star-prompt`, and `training`.
- Utilities and integration: `utils`, `hooks`, and `browser-control`.

Install any of them with `/plugin install <name>@aiwg` after running `/plugin marketplace add jmagly/ai-writing-guide` once.

### install-plugin

Install Claude Code plugin.

```bash
aiwg install-plugin <name> [--source <local-path>] [--dry-run]
```

**Arguments:**

- `<name>` - Plugin name from marketplace
- `--source <local-path>` - Compatibility input for legacy framework/add-on/extension manifests. Standalone plugin wrappers return an actionable migration to `aiwg install <path>` followed by `aiwg use <plugin-id>`.

Git URLs and standalone local wrappers use the package workflow directly:

```bash
aiwg install <path-or-git-url> --dry-run
aiwg use <plugin-id>
```

**Capabilities:** cli, plugin, install
**Platform:** Claude Code only
**Tools:** Read, Write, Bash

**Example:**

```bash
aiwg install-plugin sdlc@aiwg
```

---

### uninstall-plugin

Uninstall Claude Code plugin.

```bash
aiwg uninstall-plugin <name>
```

**Arguments:**

- `<name>` - Plugin name

**Capabilities:** cli, plugin, uninstall
**Platform:** Claude Code only
**Tools:** Read, Write, Bash

---

### plugin-status

Show Claude Code plugin status.

```bash
aiwg plugin-status
```

**Capabilities:** cli, plugin, status
**Platform:** Claude Code only
**Tools:** Read

**Shows:**

- Installed plugins
- Plugin versions
- Enabled/disabled status
- Marketplace connection

---

### package-plugin

Package a built-in wrapper or a standalone project-local wrapper. Project-local
plugins are discovered under `.aiwg/plugins/<name>/` before the built-in
catalog.

```bash
aiwg package-plugin <name>
aiwg package-plugin <name> --provider all --output dist/plugins
aiwg package-plugin <name> --source wrappers/<name> --provider codex
```

**Arguments:**

- `<name>` - Plugin name to package
- `--source <path>` - Explicit wrapper source inside the current repository
- `--output <path>` - Standalone archive directory (default `dist/plugins`)
- `--provider <claude|codex|all>` - Standalone provider format
- `--clean` - Replace colliding generated archives
- `--dry-run` - Validate and preview without writing

**Capabilities:** cli, plugin, packaging
**Platforms:** Claude Code, Generic
**Tools:** Read, Write, Bash

**Creates:**

- Deterministic `dist/plugins/<name>-<version>-<provider>.tar.gz` archives
- Wrapper and payload manifest/path validation
- Provider-native Claude Code or Codex marketplace metadata
- Byte-identical payload content

---

### package-all-plugins

Package all plugins for Claude Code marketplace.

```bash
aiwg package-all-plugins
```

**Capabilities:** cli, plugin, packaging
**Platforms:** Claude Code, Generic
**Tools:** Read, Write, Bash

**Creates:**

- Packages for: sdlc, marketing, utils, voice
- Validates all manifests
- Generates marketplace index

---

## Scaffolding Commands

Commands for creating new extensions within addons/frameworks.

### Skills vs Commands — Provider Support

Skills are the **canonical source type** for agentic workflows. During `aiwg use` deployment:

| Provider support                                             | Behavior                                                           |
| ------------------------------------------------------------ | ------------------------------------------------------------------ |
| **Native skill support** (Claude Code, OpenCode, Warp, etc.) | Skill deployed as-is to `.{platform}/skills/{id}/SKILL.md`         |
| **Generated-command providers** (Copilot, Factory, etc.)     | Command file generated from skill source, deployed alongside skill |
| **Legacy direct commands**                                   | Authored command files still supported; not generated from a skill |

**Authoring guidance:**

- New workflow? → `aiwg add-skill` — AIWG handles deployment and command generation
- Modifying an existing workflow? → Edit the `SKILL.md` source, not the generated command files
- Advanced direct command? → `aiwg add-command` (deprecated path, still supported)

### add-agent

Add agent to addon/framework.

```bash
aiwg add-agent <name>
```

**Arguments:**

- `<name>` - Agent name (e.g., "API Designer")

**Capabilities:** cli, scaffolding, agent
**Platforms:** All
**Tools:** Read, Write

**Creates:**

- Agent markdown file with frontmatter
- Extension definition entry
- Platform-specific adaptations

**Example:**

```bash
aiwg add-agent "API Designer"
```

Creates: `agents/api-designer.md`

---

### add-command

> **Deprecated**: Use `aiwg add-skill` instead. Skills are the primary workflow extension type; commands are generated from skills during deployment. `add-command` remains available for direct command authoring in advanced cases.

Add command to addon/framework.

```bash
aiwg add-command <name>
```

**Arguments:**

- `<name>` - Command name (e.g., "validate-api")

**Capabilities:** cli, scaffolding, command
**Platforms:** All
**Tools:** Read, Write

---

### add-skill

Add skill to addon/framework.

```bash
aiwg add-skill <name>
```

**Arguments:**

- `<name>` - Skill name (e.g., "project-awareness")

**Capabilities:** cli, scaffolding, skill
**Platforms:** All
**Tools:** Read, Write

---

### add-behavior

Scaffold a new behavior with BEHAVIOR.md and scripts.

```bash
aiwg add-behavior <name> [options]
```

**Arguments:**

- `<name>` - Behavior name (kebab-case recommended)

**Options:**

- `--description, -d` - Behavior description
- `--hooks` - Comma-separated hook events (default: `on_file_write`). Available: `on_file_write`, `on_tool_complete`, `on_schedule`, `on_commit`, `on_pr_open`, `on_deploy`, `on_session_start`, `on_session_end`
- `--category` - Behavior category (default: `general`)
- `--dry-run, -n` - Preview what would be created

**Capabilities:** cli, scaffolding, behavior
**Platforms:** Claude Code, OpenClaw
**Tools:** Read, Write

**Creates:**

```
agentic/code/behaviors/<name>/
├── BEHAVIOR.md          # Pre-filled with hooks and triggers
└── scripts/
    └── main.sh          # Entry point stub
```

**Examples:**

```bash
aiwg add-behavior security-scanner
aiwg add-behavior test-watcher --hooks on_file_write,on_schedule --category testing
aiwg add-behavior deploy-guard --hooks on_deploy --description "Pre-deploy validation"
```

---

### add-template

Add template to addon/framework.

```bash
aiwg add-template <name>
```

**Arguments:**

- `<name>` - Template name (e.g., "use-case-template")

**Capabilities:** cli, scaffolding, template
**Platforms:** All
**Tools:** Read, Write

---

### scaffold-addon

Create new addon package.

```bash
aiwg scaffold-addon <name>
```

**Arguments:**

- `<name>` - Addon name (e.g., "my-addon")

**Capabilities:** cli, scaffolding, addon
**Platforms:** All
**Tools:** Read, Write

**Creates:**

```
agentic/code/addons/my-addon/
├── manifest.json
├── README.md
├── agents/
├── commands/
├── skills/
└── templates/
```

---

### scaffold-extension

Create new extension package.

```bash
aiwg scaffold-extension <name>
```

**Arguments:**

- `<name>` - Extension name

**Capabilities:** cli, scaffolding, extension
**Platforms:** All
**Tools:** Read, Write

---

### scaffold-framework

Create new framework package.

```bash
aiwg scaffold-framework <name>
```

**Arguments:**

- `<name>` - Framework name (e.g., "security-framework")

**Capabilities:** cli, scaffolding, framework
**Platforms:** All
**Tools:** Read, Write

**Creates:**

```
agentic/code/frameworks/security-framework/
├── manifest.json
├── README.md
├── agents/
├── commands/
├── skills/
├── templates/
└── docs/
```

---

## Daemon Commands

Commands for managing the AIWG daemon and its subsystems.

### behavior

Manage behavior YAML bundles that bind directives and toolsets to agent types.

```bash
aiwg behavior <list|info|apply|remove> [name] [options]
```

**Subcommands:**

- `list` - List all available behaviors
- `info <name>` - Show behavior details (BEHAVIOR.md content)
- `apply <name>` - Apply a behavior to the daemon
- `remove <name>` - Remove a behavior from the daemon

**Capabilities:** cli, behavior, daemon, configuration
**Platforms:** Claude Code
**Tools:** Read, Bash, Write

**Examples:**

```bash
aiwg behavior list
aiwg behavior info security-sentinel
```

---

### daemon-init

Initialize daemon config from a profile template.

```bash
aiwg daemon-init [profile-name] [--force]
```

**Arguments:**

- `[profile-name]` - Profile template to use (default: `manager`)

**Options:**

- `--force` - Overwrite existing config

**Capabilities:** cli, daemon, configuration, scaffolding
**Platforms:** Claude Code
**Tools:** Bash, Read, Write

**Creates:**

- `.aiwg/daemon.yaml` from the selected profile template
- `.env.example` with required environment variables

---

## Remote Transport Commands

### uhp

Inspect or smoke-test an explicitly selected experimental UHP endpoint profile.
AIWG is a UHP client only and does not claim server conformance.

```bash
aiwg uhp discover --profile <name>
aiwg uhp harnesses --profile <name>
aiwg uhp models --profile <name> [--harness <id>]
aiwg uhp run --profile <name> --input <text> \
  [--harness <id>] [--model <id>] [--stream]
```

Every operation requires `--profile`; endpoint and bearer overrides are not
accepted. `discover` is unauthenticated. Other operations resolve the profile's
environment secret locator only at request time. The client pins UHP
`2026-08-11` and does not fall back to A2A or another version.

The CLI covers discovery, catalogues, and task smoke tests. Stored reads,
continuation, cancellation, uploads, and artifact retrieval are available from
the exported `UhpClient` package API. See the [experimental UHP client
guide](../uhp-client.md) for configuration, complete examples, recovery,
security, limitations, and upgrades.

**Capabilities:** cli, transport, uhp, remote-harness, experimental
**Platforms:** All
**Tools:** Network

---

## Mission Control Commands

Mission Control provides multi-loop background orchestration for parallel long-running agents.

### mc

Multi-loop background orchestration dashboard.

```bash
aiwg mc <subcommand> [options]
aiwg mission-control <subcommand> [options]
```

**Capabilities:** cli, orchestration, ralph, background, multi-loop, mission-control
**Platforms:** All
**Tools:** Bash, Read, Write

**Subcommands:**

| Subcommand                    | Description                                             |
| ----------------------------- | ------------------------------------------------------- |
| `start`                       | Start a new Mission Control session                     |
| `dispatch <id> "<objective>"` | Add a background mission to session                     |
| `run [<id>] [--accept-cost]`  | Drain the queue — launch queued missions as ralph loops |
| `status [<id>] [--json]`      | View mission status dashboard                           |
| `watch [<id>]`                | Live monitor (streaming)                                |
| `abort <session> <mission>`   | Abort a specific mission                                |
| `pause [<id>]`                | Pause active session                                    |
| `resume [<id>]`               | Resume paused session                                   |
| `stop [<id>] [--drain]`       | Shut down session                                       |
| `list [--json]`               | List all sessions                                       |

**`mc dispatch` options** (the LFD ceilings mirror `aiwg ralph`; same names/units, #1585):

- `--completion "<criteria>"` - Verifiable completion criteria (required for `mc run`)
- `--priority <level>` - Priority hint (default: normal)
- `--max-iterations <n>` - Ralph iteration cap when launched (default: 10)
- `--max-total-tokens <n>` / `--max-output-tokens <n>` / `--max-tool-calls <n>` - Hard cumulative usage ceilings (when observable)
- `--max-total-cost <usd>` - Hard cumulative spend ceiling (when observable)
- `--max-wall-clock-minutes <m>` - Hard cumulative wall-clock ceiling (always observable)
- `--exploration-quota <k>` - Structural variant after `k` flat cycles (off unless declared; no default `k`)
- `--budget-stop-policy <p>` - `completion-wins` (default) | `budget-wins`

> Invalid numeric budget values are a hard usage error — `mc dispatch` refuses rather than dispatching an unbounded mission (#1770). `--flag=value` syntax is accepted.

**Examples:**

```bash
# Start a named session
aiwg mc start --name "Construction Sprint 4"

# Dispatch missions
aiwg mc dispatch mc-abc123 "Fix auth service" --completion "tests pass" --priority high
aiwg mc dispatch mc-abc123 "Add pagination" --completion "paginated responses"

# Dispatch with LFD ceilings (wall-clock is the provider-independent hard stop)
aiwg mc dispatch mc-abc123 "Refactor auth" --completion "tests pass" \
  --max-wall-clock-minutes 30 --max-total-cost 5 --exploration-quota 3

# Monitor
aiwg mc status mc-abc123
aiwg mc status mc-abc123 --json

# Drain and stop (let running missions finish)
aiwg mc stop mc-abc123 --drain
```

**Example output:**

```
◆ MISSION CONTROL — Construction Sprint 4  [mc-abc123]
──────────────────────────────────────────────────────────
  #    Mission                       Status       Loop     Started
──────────────────────────────────────────────────────────
  1    Fix auth service              ✓ DONE       4/10     14:22
  2    Add pagination                ⏳ RUNNING   3/10     14:25
  3    Write integration tests       ⏺ QUEUED     —        —
──────────────────────────────────────────────────────────
  3 missions  |  1 done  |  1 running  |  1 queued  |  0 failed
```

**State persistence:** Session state is stored in `.aiwg/ralph-external/mc/sessions/` and survives context resets.

---

## Agent Team Commands

Agent teams provide a provider-agnostic abstraction for multi-agent
collaboration. Claude Code, Factory AI, and Oh My Pi use their reviewed native
team or task surfaces. Providers without a native team surface route through
`aiwg mc` (Mission Control) orchestration when that emulation is available.

### team

Multi-agent team orchestration across all providers.

```bash
aiwg team <subcommand> [options]
aiwg teams <subcommand> [options]
```

**Capabilities:** orchestration, agent-teams, multi-provider, mission-control
**Platforms:** All (native on Claude Code, Factory AI, and Oh My Pi; emulated
via `aiwg mc` where supported)
**Category:** orchestration

#### Subcommands

| Subcommand    | Description                     |
| ------------- | ------------------------------- |
| `run <name>`  | Execute a team workflow         |
| `list`        | List available teams            |
| `info <name>` | Show team definition and roster |

#### Provider Routing

| Provider | Backend | Behavior |
| --- | --- | --- |
| Claude Code | Native | Agent dispatch instructions |
| Factory AI | Native | Factory Missions and task dispatch |
| Oh My Pi | Native | Bounded native task-agent scheduling |
| Other supported providers | `aiwg mc` emulation | Generates `mc start` and `mc dispatch` commands when available |

#### Options

| Option                 | Description                                   |
| ---------------------- | --------------------------------------------- |
| `--provider <p>`       | Override provider detection                   |
| `--objective "<text>"` | Objective string passed to mc dispatch agents |
| `--json`               | Machine-readable output                       |

#### Examples

```bash
# Run a team (auto-detects provider)
aiwg team run sdlc-review

# Run with explicit provider override
aiwg team run sdlc-review --provider cursor

# Run with custom objective
aiwg team run security-review --objective "Pre-release audit for SOC2"

# List all available teams
aiwg team list

# Machine-readable team list
aiwg team list --json

# Inspect team definition
aiwg team info sdlc-review
aiwg team info api-development --json
```

#### Built-in Teams (sdlc-complete framework)

| Team              | Agents | Dispatch   | Best For                      |
| ----------------- | ------ | ---------- | ----------------------------- |
| `api-development` | 4      | sequential | API design and implementation |
| `full-stack`      | 4      | sequential | Full-stack feature delivery   |
| `greenfield`      | 4      | sequential | New project setup             |
| `maintenance`     | 4      | sequential | Code review and bug fixing    |
| `migration`       | 4      | sequential | Technology migrations         |
| `sdlc-review`     | 4      | parallel   | Phase gate validation         |
| `security-review` | 3      | sequential | Security audits               |

#### Team Definition Format

Teams are defined as JSON files (with an optional `dispatch` field for `parallel | sequential | consensus`):

```json
{
  "name": "SDLC Review Team",
  "slug": "sdlc-review",
  "description": "Full SDLC phase gate review team",
  "dispatch": "parallel",
  "agents": [
    { "agent": "security-architect", "role": "reviewer" },
    { "agent": "test-architect", "role": "reviewer" },
    { "agent": "requirements-analyst", "role": "reviewer" },
    { "agent": "technical-writer", "role": "reviewer" }
  ],
  "use_cases": ["Phase gate validation", "Release readiness review"],
  "sdlc_phases": ["inception", "elaboration", "construction", "transition"]
}
```

Custom teams can be placed in `.aiwg/teams/<slug>.json` for project-local overrides.

**Source:** `agentic/code/frameworks/sdlc-complete/teams/`
**Schema:** `agentic/code/frameworks/sdlc-complete/teams/schema.json`

---

## Agent Loop Commands

Al is the iterative task execution loop with advanced control layers (Epic #26).

### ralph

Start Al task execution loop.

```bash
aiwg ralph "<task-description>"
```

**Arguments:**

- `<task-description>` - Natural language task description

**Options:**

**Core Options:**

- `--completion "<criteria>"` - Success criteria (e.g., "npm test passes")
- `--max-iterations <n>` - Maximum iterations (default: 5)
- `--timeout <minutes>` - Per-iteration timeout in minutes (default: 60)
- `--provider <name>` - CLI provider: `claude` (default), `codex`, `opencode`, `factory`
- `--budget <usd>` - Budget per iteration in USD (default: 5.0)
- `--gitea-issue` - Create/link Gitea issue for tracking
- `--mcp-config <json>` - MCP server configuration JSON

**LFD Loop Controls (#1585):**

Hard cumulative ceilings that stop the loop and emit a best-output report.
Invalid values or unknown flags cause `aiwg ralph` to refuse to launch (#1770).

- `--max-total-tokens <n>` - Hard cumulative total-token ceiling (when the provider reports usage)
- `--max-output-tokens <n>` - Hard cumulative output-token ceiling (when the provider reports usage)
- `--max-tool-calls <n>` - Hard cumulative tool-call ceiling (when the provider reports usage)
- `--max-total-cost <usd>` - Hard cumulative spend ceiling (when the provider reports cost)
- `--max-wall-clock-minutes <m>` - Hard cumulative wall-clock ceiling (always observable; the provider-independent hard stop)
- `--exploration-quota <k>` - Require a structural strategy variant after `k` flat (non-improving) cycles. **OFF unless declared** — there is no default `k`; each loop declares its own (#1770)
- `--budget-stop-policy <p>` - `completion-wins` (default): a task completing on the ceiling-crossing iteration reports success with the crossing annotated; `budget-wins`: exhaustion always terminates as `budget_exhausted` (#1767)
- `--allow-exhausted-resume` - Permit `--resume` of a loop whose declared ceilings are already exhausted (pair with raised `--max-*` limits) (#1765)

> Token/spend ceilings are **unobservable** on providers that report no usage (a one-time warning is printed); use `--max-wall-clock-minutes` for a provider-independent hard stop (#1766). These flags are also accepted by `aiwg mc dispatch` and the MCP `ralph-dispatch` / `mission-dispatch` tools with the same names and units.

**Research-Backed Options (REF-015, REF-021):**

- `-m, --memory <n|preset>` - Memory capacity Ω: 1-10 or preset (simple, moderate, complex, maximum). Default: 3
- `--cross-task` / `--no-cross-task` - Enable/disable cross-task learning (default: enabled)
- `--no-analytics` - Disable iteration analytics. **Note:** this also disables the LFD budget stops and exploration quota, which live in the analytics subsystem (#1766)
- `--no-best-output` - Disable best output selection (use final iteration)
- `--no-early-stopping` - Disable early stopping on high confidence

**Epic #26 Control Options:**

- `--enable-pid-control` - Enable PID control layer (default: true)
- `--disable-pid-control` - Disable PID control layer
- `--enable-overseer` - Enable oversight layer (default: true)
- `--disable-overseer` - Disable oversight layer
- `--enable-semantic-memory` - Enable cross-loop memory (default: true)
- `--disable-semantic-memory` - Disable cross-loop memory
- `--gain-profile <name>` - PID gain profile: `conservative`, `standard`, `aggressive`, `recovery`, `cautious` (default: `standard`)
- `--validation-level <level>` - Validation strictness: `minimal`, `standard`, `strict` (default: `standard`)
- `--intervention-mode <mode>` - Oversight intervention mode: `permissive`, `balanced`, `strict` (default: `balanced`)

**Capabilities:** cli, ralph, orchestration
**Platforms:** All
**Tools:** Read, Write, Bash

**Examples:**

```bash
# Basic task execution
aiwg ralph "Fix all failing tests" --completion "npm test passes"

# Conservative run for security fix (Epic #26)
aiwg ralph "Fix SQL injection" \
  --completion "security scan passes" \
  --gain-profile conservative \
  --validation-level strict

# Fast documentation generation (Epic #26)
aiwg ralph "Generate API docs" \
  --completion "docs/ updated" \
  --gain-profile aggressive \
  --disable-overseer

# Leverage cross-loop memory (Epic #26)
aiwg ralph "Fix auth tests" \
  --completion "tests pass" \
  --enable-semantic-memory

# Refactoring with balanced controls
aiwg ralph "Extract common utilities to shared module" \
  --completion "No lint errors" \
  --gain-profile standard \
  --intervention-mode balanced

# Multi-provider: run with Codex
aiwg ralph "Migrate utils to TypeScript" \
  --completion "npx tsc --noEmit exits 0" \
  --provider codex \
  --budget 3.0

# Research-backed: enhanced memory with cross-task learning
aiwg ralph "Fix all integration tests" \
  --completion "npm test passes" \
  --memory complex \
  --cross-task
```

**Iteration pattern:**

1. Analyze current state (with PID control input)
2. Plan next step (informed by semantic memory)
3. Execute step
4. Verify progress (oversight validation)
5. Check completion criteria
6. Repeat or finish

**Control Layers (Epic #26):**

**PID Control Layer:**

- Adjusts agent autonomy based on progress
- Prevents oscillation and runaway behavior
- Gain profiles optimize for different scenarios:
  - `conservative`: Slow, cautious (Kp=0.3, Ki=0.05, Kd=0.1)
  - `standard`: Balanced (Kp=0.5, Ki=0.1, Kd=0.2) - default
  - `aggressive`: Fast, high autonomy (Kp=0.8, Ki=0.2, Kd=0.3)
  - `recovery`: Designed for error recovery (Kp=0.4, Ki=0.15, Kd=0.25)
  - `cautious`: Extra validation (Kp=0.2, Ki=0.03, Kd=0.05)

**Semantic Memory:**

- Remembers learnings across loop runs
- Queries similar past situations
- Prevents repeating mistakes
- Shares insights between tasks

**Oversight Layer:**

- Validates actions before execution
- Flags risky operations
- Requires confirmation for critical changes
- Intervention modes:
  - `permissive`: Minimal intervention, trust agent
  - `balanced`: Standard safety checks - default
  - `strict`: Maximum oversight, confirm everything

**Crash recovery:** State saved in `.aiwg/ralph/current-loop.json`

---

### ralph-status

Show agent loop status.

```bash
aiwg ralph-status
```

**Capabilities:** cli, ralph, status
**Platforms:** All
**Tools:** Read

**Shows:**

- Current loop active/inactive
- Task description
- Iterations completed
- Success criteria
- Last state
- Completion percentage estimate
- **Epic #26 status:**
  - PID control state (current gains, control signal, error metrics)
  - Memory layer stats (entries retrieved, last query, similarity scores)
  - Oversight status (active interventions, warnings issued, health score)

**Example output:**

```
Agent Loop Status: Active

Task: Fix all failing tests
Iterations: 3/10
Success Criteria: npm test passes

Last Action: Fixed auth service test
State: In progress
Progress: ~40%

=== Epic #26 Control Layers ===

PID Control:
  Gain Profile: standard
  Current Gains: Kp=0.5, Ki=0.1, Kd=0.2
  Control Signal: 0.42 (moderate autonomy)
  Error: -0.15 (slightly below target progress)
  Integral: 0.08
  Derivative: -0.03

Semantic Memory:
  Total Entries: 127
  Last Retrieval: 2 similar situations found
  Top Match: "auth-test-fix-2024-01" (similarity: 0.87)
  Applied Learnings: 3

Oversight:
  Intervention Mode: balanced
  Active Interventions: 1 (validation flag on file deletion)
  Warnings Issued: 0
  Health Score: 0.92 (healthy)

Next: Resume with '/ralph-resume'
```

---

### ralph-abort

Abort running agent loop.

```bash
aiwg ralph-abort
```

**Capabilities:** cli, ralph, control
**Platforms:** All
**Tools:** Read, Write

**Actions:**

- Stops current loop
- Saves final state (including Epic #26 control state)
- Archives loop history
- Cleans up temporary files
- Preserves semantic memory learnings

---

### ralph-resume

Resume paused agent loop.

```bash
aiwg ralph-resume
```

**Capabilities:** cli, ralph, control
**Platforms:** All
**Tools:** Read, Write

**Actions:**

- Loads last saved state (including Epic #26 control layers)
- Restores PID controller state
- Reloads semantic memory context
- **Restores the LFD analytics counters** — cumulative token/spend/wall-clock usage survives resume, so declared budget ceilings are re-enforced across a crash/restart (#1765)
- Continues from last iteration
- Applies same completion criteria
- Respects remaining iteration budget

**LFD resume semantics (#1765):**

- Persisted budget/quota/policy config is preserved; only explicitly passed flags override it.
- Resuming a loop whose declared ceilings are already exhausted is **refused** unless `--allow-exhausted-resume` is passed (pair with raised `--max-*` limits).

---

### ralph-attach

Attach to a running agent loop's live output stream.

```bash
aiwg ralph-attach
```

**Capabilities:** cli, ralph, control, monitoring
**Platforms:** All
**Tools:** Read

**Actions:**

- Attaches to a running external agent loop
- Streams live output (press Ctrl+C to detach)
- Shows current iteration progress in real time
- Does not affect the running loop

---

### agent-loop-ext

Start external agent loop with full crash recovery. (Legacy alias: `ralph-external`)

```bash
aiwg agent-loop-ext "<task-description>"
```

**Arguments:**

- `<task-description>` - Natural language task description

**Options:**

All options from `ralph` command plus:

**External-Specific Options:**

- `--checkpoint-interval <n>` - Checkpoint every N iterations (default: 1)
- `--crash-recovery` - Enable crash recovery (default: true)
- `--state-file <path>` - Custom state file location (default: `.aiwg/ralph-external/state.json`)

**Epic #26 Control Options:**

- Same as `ralph` command

**Capabilities:** cli, ralph, orchestration, external
**Platforms:** All
**Tools:** Read, Write, Bash

**Examples:**

```bash
# External loop with crash recovery
aiwg ralph-external "Refactor payment module" \
  --completion "tests pass" \
  --checkpoint-interval 2

# Critical task with strict controls
aiwg ralph-external "Migrate database schema" \
  --completion "migration complete" \
  --gain-profile conservative \
  --validation-level strict \
  --intervention-mode strict \
  --checkpoint-interval 1
```

**Difference from `ralph`:**

- Designed for longer-running tasks
- Full state persistence to disk
- Automatic checkpoint creation
- Recoverable across process restarts
- Ideal for CI/CD integration

---

### ralph-memory

Manage semantic memory (Epic #26).

```bash
aiwg ralph-memory <subcommand>
```

**Subcommands:**

#### ralph-memory list

List all semantic memory learnings.

```bash
aiwg ralph-memory list
```

**Options:**

- `--limit <n>` - Limit results (default: 20)
- `--sort <field>` - Sort by: `date`, `similarity`, `usage_count` (default: `date`)

**Example output:**

```
Semantic Memory Learnings (127 total)

1. auth-test-fix-2024-01 (2024-01-15)
   Situation: Fixing authentication test failures
   Learning: Check token expiration config first
   Used: 5 times

2. sql-injection-fix-2024-02 (2024-01-20)
   Situation: SQL injection vulnerability
   Learning: Use parameterized queries, not string concat
   Used: 3 times

...
```

#### ralph-memory query

Query semantic memory for similar situations.

```bash
aiwg ralph-memory query "<pattern>"
```

**Arguments:**

- `<pattern>` - Query text or pattern

**Options:**

- `--threshold <n>` - Similarity threshold 0-1 (default: 0.7)
- `--limit <n>` - Max results (default: 10)

**Example:**

```bash
aiwg ralph-memory query "authentication failing"
```

#### ralph-memory prune

Clean old or unused memory entries.

```bash
aiwg ralph-memory prune [--older-than <days>]
```

**Options:**

- `--older-than <days>` - Remove entries older than N days (default: 90)
- `--unused` - Remove entries never referenced
- `--dry-run` - Preview without deleting

#### ralph-memory export

Export memory to JSON.

```bash
aiwg ralph-memory export <file>
```

**Arguments:**

- `<file>` - Output file path

**Example:**

```bash
aiwg ralph-memory export memory-backup.json
```

#### ralph-memory import

Import memory from JSON.

```bash
aiwg ralph-memory import <file>
```

**Arguments:**

- `<file>` - Input file path

**Options:**

- `--merge` - Merge with existing (default: replace)

**Capabilities:** cli, ralph, memory
**Platforms:** All
**Tools:** Read, Write

---

### ralph-config

View and configure Epic #26 control layers.

```bash
aiwg ralph-config <subcommand>
```

**Subcommands:**

#### ralph-config show

Show current Al configuration.

```bash
aiwg ralph-config show
```

**Example output:**

```
Al Configuration

PID Control:
  Enabled: true
  Gain Profile: standard
  Gains: Kp=0.5, Ki=0.1, Kd=0.2

Semantic Memory:
  Enabled: true
  Database: .aiwg/ralph/memory.db
  Entry Count: 127

Oversight:
  Enabled: true
  Intervention Mode: balanced
  Validation Level: standard

Checkpoints:
  Enabled: true
  Interval: 1 iteration
  Location: .aiwg/ralph/
```

#### ralph-config set

Set configuration value.

```bash
aiwg ralph-config set <key> <value>
```

**Arguments:**

- `<key>` - Configuration key (dot-notation)
- `<value>` - New value

**Examples:**

```bash
# Change gain profile
aiwg ralph-config set pid.gain_profile aggressive

# Disable overseer
aiwg ralph-config set oversight.enabled false

# Change validation level
aiwg ralph-config set oversight.validation_level strict
```

#### ralph-config reset

Reset to default configuration.

```bash
aiwg ralph-config reset
```

**Options:**

- `--confirm` - Skip confirmation prompt

#### ralph-config preset

Apply configuration preset.

```bash
aiwg ralph-config preset <name>
```

**Arguments:**

- `<name>` - Preset name: `conservative`, `balanced`, `aggressive`

**Presets:**

| Preset         | Use Case                         | Settings                                                   |
| -------------- | -------------------------------- | ---------------------------------------------------------- |
| `conservative` | Security fixes, critical systems | Cautious gains, strict validation, strict oversight        |
| `balanced`     | General development (default)    | Standard gains, standard validation, balanced oversight    |
| `aggressive`   | Documentation, rapid iteration   | Aggressive gains, minimal validation, permissive oversight |

**Example:**

```bash
# Set conservative preset for security work
aiwg ralph-config preset conservative
```

**Capabilities:** cli, ralph, configuration
**Platforms:** All
**Tools:** Read, Write

---

## Documentation Commands

### doc-sync

Synchronize documentation and code with bounded, scope-first drift checks.

```bash
aiwg doc-sync <direction> [options]
```

**Arguments:**

- `<direction>` - Sync direction: `code-to-docs`, `docs-to-code`, `full`

**Options:**

- `--interactive` - Prompt for each sync decision
- `--guidance "text"` - Human guidance for ambiguous cases
- `--scope "path"` - Limit to specific directory (default: `.`)
- `--dry-run` - Audit only, no modifications
- `--parallel N` - Max concurrent audit agents (default: 2, maximum: 4)
- `--incremental` - Git-diff since last sync instead of full scan
- `--verbose` - Detailed per-file findings
- `--no-commit` - Skip auto-commit
- `--max-iterations N` - agent loop refinement iterations (default: 3)

**Capabilities:** cli, documentation, synchronization, audit
**Platforms:** All
**Tools:** Task, Read, Write, Bash, Glob, Grep, Edit

**Directions:**

| Direction      | Description                                   |
| -------------- | --------------------------------------------- |
| `code-to-docs` | Code is truth, update docs to match           |
| `docs-to-code` | Docs are truth, generate TODOs/fixes for code |
| `full`         | Bidirectional reconciliation                  |

**Execution phases:**

1. Inspect changed files and derive a bounded scope
2. Select only the audit lanes relevant to that scope
3. Run capped auditors with concise findings and detailed notes under `.aiwg/working/doc-sync/`
4. Merge summaries into a drift report
5. Apply high-confidence fixes when not running `--dry-run`
6. Validate modified files with targeted checks
7. Record sync state and commit only when requested by the surrounding workflow

**Examples:**

```bash
# Dry-run audit
aiwg doc-sync code-to-docs --dry-run

# Incremental sync after code changes
aiwg doc-sync code-to-docs --incremental --verbose

# Full bidirectional with guidance
aiwg doc-sync full --interactive --guidance "Focus on CLI reference"

# Scoped to specific directory
aiwg doc-sync code-to-docs --scope docs/extensions/
```

**Output locations:**

- Audit report: `.aiwg/reports/doc-sync-audit-{date}.md`
- Sync state: `.aiwg/.last-doc-sync`

---

## SDLC Orchestration Commands

### sdlc-accelerate

End-to-end SDLC ramp-up from idea to construction-ready.

```bash
aiwg sdlc-accelerate <description> [options]
```

**Arguments:**

- `<description>` - Project description (idea entry point)

**Options:**

- `--from-codebase <path>` - Scan existing code instead of starting from idea
- `--interactive` - Full interactive mode at every step
- `--guidance "text"` - Project-level guidance for all phases
- `--auto` - Auto-proceed on CONDITIONAL gates
- `--dry-run` - Show pipeline plan without executing
- `--skip-to <phase>` - Jump to specific phase (validates prereqs)
- `--resume` - Resume from detected current phase

**Capabilities:** cli, sdlc, orchestration, pipeline, accelerate
**Platforms:** All
**Tools:** Task, Read, Write, Glob, TodoWrite

**Pipeline phases:**

```
INTAKE → GATE_LOM → ELABORATION → GATE_ABM → CONSTRUCTION_PREP → BRIEF
```

| Phase             | Description                     | Delegates To                                |
| ----------------- | ------------------------------- | ------------------------------------------- |
| Intake            | Project intake and inception    | `/intake-wizard` or `/intake-from-codebase` |
| LOM Gate          | Lifecycle Objective Milestone   | `/flow-gate-check inception`                |
| Elaboration       | Architecture and requirements   | `/flow-inception-to-elaboration`            |
| ABM Gate          | Architecture Baseline Milestone | `/flow-gate-check elaboration`              |
| Construction Prep | Iteration planning              | `/flow-elaboration-to-construction`         |
| Brief             | Construction Ready Brief        | Template generation                         |

**Entry point detection:**

| Condition                       | Entry                       |
| ------------------------------- | --------------------------- |
| No `.aiwg/` + description       | `intake-wizard`             |
| No `.aiwg/` + `--from-codebase` | `intake-from-codebase`      |
| `.aiwg/` exists + `--resume`    | Detect and resume           |
| `--skip-to`                     | Jump with prereq validation |

**Examples:**

```bash
# New project from idea
aiwg sdlc-accelerate "Customer portal with real-time chat"

# From existing codebase
aiwg sdlc-accelerate --from-codebase ./src "E-commerce platform"

# Resume interrupted pipeline
aiwg sdlc-accelerate --resume

# Preview pipeline plan
aiwg sdlc-accelerate --dry-run "Mobile banking app"

# Skip to elaboration
aiwg sdlc-accelerate --skip-to elaboration

# Auto-approve everything
aiwg sdlc-accelerate --auto "Quick prototype"
```

**State tracking:** `.aiwg/reports/accelerate-state.json`
**Output:** `.aiwg/reports/construction-ready-brief.md`

---

### best-practices-audit

Research-grounded validation of a target (file, directory, or freeform topic)
against current external best practices, vendor documentation, and
practitioner discussion.

```bash
aiwg best-practices-audit <target> [options]
```

**Arguments:**

- `<target>` - Path or freeform topic to audit

**Options:**

- `--focus <area>` - Focus area (security, performance, accessibility, licensing, ...)
- `--framework <name>` - Bias toward a named stack (React, Kubernetes, ...)
- `--standard <name>` - Align to a standard (OWASP, SOC2, WCAG 2.2, ...)
- `--recency <window>` - Source recency window (default `18m`)
- `--depth quick|standard|deep` - Research effort budget (default `standard`)
- `--sources <list>` - Restrict to source classes (vendor-docs, standards-bodies, ...)
- `--exclude <list>` - Exclude domain classes (e.g., SEO-spam)
- `--cite-threshold <N>` - Minimum distinct sources before reporting a finding (default `2`)
- `--dissent` - Surface practitioner disagreement, not just consensus
- `--validate` - Re-validate existing claims in the target instead of fresh audit
- `--output <path>` - Output path (default `.aiwg/reports/best-practices-audit-<slug>-<date>.md`)
- `--provider <name>` - Agent system to use (default `claude`)
- `--dangerous` - Enable provider's unrestricted mode
- `--params "<args>"` - Pass arbitrary args verbatim to the agent binary

**Capabilities:** cli, research, validation, audit, citations
**Tools:** Read, Write, Glob, Grep, Bash, WebFetch, WebSearch

**Examples:**

```bash
aiwg best-practices-audit ".aiwg/architecture/SAD.md" --focus security --standard OWASP
aiwg best-practices-audit "src/auth/" --focus security --depth deep --dissent
aiwg best-practices-audit "FastAPI request validation patterns" --recency 6m
aiwg best-practices-audit ".aiwg/architecture/" --validate
```

---

## Planning Skills

### issue-audit

Audit and triage issue backlogs without starting implementation work. Use this when you want cleanup recommendations, duplicate/overlap detection, stale issue review, epic child-state refresh, or next-issue prioritization before running `address-issues`.

```bash
/issue-audit [options]
```

**Options:**

- `--all-open` — Audit all open issues. This is the default when no filter is supplied.
- `--filter "query"` — Reuse issue-list/address-issues style filters, such as `status:open label:bug`.
- `--interactive` — Ask one focused triage decision at a time.
- `--guidance "text"` — Steer the audit lens without interactive prompts.
- `--provider gitea|github|local` — Override configured issue provider.
- `--dry-run` — Never mutate tracker state; emit recommendations only. This is the default behavior.
- `--apply` — Apply explicitly approved cleanup actions such as comments, closures, relationship links, or epic refreshes.

**Common workflows:**

| Workflow                 | Example                                                                                             |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| Open backlog audit       | `/issue-audit --all-open`                                                                           |
| Stale deferred cleanup   | `/issue-audit --filter "status:open label:deferred" --guidance "add check dates or close mistakes"` |
| Epic child-state refresh | `/issue-audit --filter "status:open label:epic" --guidance "find stale child tables"`               |
| Duplicate/overlap audit  | `/issue-audit --guidance "find duplicate or overlapping feature tracks"`                            |
| Priority/blocker audit   | `/issue-audit --guidance "rank next issues for address-issues"`                                     |

**Output:** a structured report with counts, grouped findings, recommended actions, and a short list of next moves. The command is read-only unless `--apply` is explicitly supplied.

**Related:** `issue-list`, `issue-comment`, `issue-close`, `issue-sync`, `address-issues`.

**Skill location:** `agentic/code/frameworks/sdlc-complete/skills/issue-audit/SKILL.md`

---

### issue-planner

Transform a high-level objective into a fully researched, SDLC-gated issue backlog — ready for `address-issues` — without manually researching, writing docs, or deciding priority order.

```bash
/issue-planner "<objective>" [options]
```

**Arguments:**

- `<objective>` — Feature, capability, integration, or initiative to plan. One-liner or multi-paragraph brief.

**Options:**

- `--interactive` — Ask discovery questions before researching (scope constraints, excluded technologies, target phase, priority bias)
- `--dry-run` — Generate full plan and issue list but do not file anything. Outputs a preview table.
- `--guidance "text"` — Upfront direction shaping research focus, prioritization, and scope without interactive prompts
- `--provider gitea|github|local` — Override default issue tracker
- `--skip-research` — Skip parallel research pass, go straight to SDLC doc generation
- `--phase inception|elaboration|construction|transition` — Target SDLC phase for artifact templates
- `--induct-research <target>` — After research synthesis, extract discovered references and file tracking tasks to induct into a research repository

**Capabilities:** planning, research, sdlc, issues, orchestration
**Platforms:** All
**Tools:** Read, Write, Glob, Grep, Bash, Agent, mcp**gitea**issue_write, WebSearch, WebFetch

**Phases:**

| Phase                | What Happens                                                        |
| -------------------- | ------------------------------------------------------------------- |
| 1. Parallel Research | Three agents in parallel: best practices, prior art, vendor docs    |
| 2. Synthesis         | Consolidated brief written to `.aiwg/working/issue-planner/`        |
| 3. SDLC Doc Corpus   | Phase-appropriate artifacts generated using sdlc-complete templates |
| 4. Issue Generation  | Issues with type, priority (P0–P3), phase, and dependency mapping   |
| 5. Human Approval    | Full plan table presented — no filing until user approves           |
| 6. Filing + Handoff  | Issues filed in wave order; `address-issues` invocation output      |

**Issue labels generated:**

| Label                                                | Meaning                                    |
| ---------------------------------------------------- | ------------------------------------------ |
| `feat`, `docs`, `test`, `infra`, `spike`, `security` | Type                                       |
| `P0`–`P3`                                            | Priority (P0 = gate blockers and security) |
| `elaboration`, `construction`, etc.                  | Target SDLC phase                          |

**Examples:**

```bash
# Basic planning run
/issue-planner "Add OAuth2 SSO support"

# Preview without filing
/issue-planner "Refactor auth module" --dry-run

# With guidance — skip Inception artifacts
/issue-planner "Add pagination to list endpoints" \
  --guidance "We're in Construction phase, skip Inception artifacts"

# Interactive with research induction
/issue-planner "Integrate OpenTelemetry" --interactive \
  --induct-research roctinam/research-inbox

# Skip research if already done externally
/issue-planner "Implement rate limiting" --skip-research \
  --phase elaboration
```

**Output:**

```
.aiwg/working/issue-planner/
├── research-brief.md          # Synthesized research findings
├── sdlc-artifacts/            # Generated use cases, risk register, etc.
├── issue-plan.md              # Full issue plan table (approval gate)
└── wave-manifest.json         # Dependency wave ordering
```

**Trigger patterns** (natural language):

- "plan out `<feature>`" → full research + issue filing workflow
- "file issues for `<objective>`" → issue-planner with dry-run preview first
- "create a backlog for `<objective>`" → issue-planner with priority ordering
- "research and plan `<topic>`" → parallel research pass then issue filing
- "using the AIWG research team in parallel... `<objective>`" → canonical trigger

**Skill location:** `agentic/code/frameworks/sdlc-complete/skills/issue-planner/SKILL.md`

---

## Discovery

Top-level capability search across AIWG operational assets: skills, agents, commands, rules, flows, runbooks, templates, and behaviors. **Reach for `aiwg discover` early and often** — it is the first-class operator surface for finding the right AIWG capability for a need, and the kernel skill set deliberately deploys only a small directory of quickrefs to your platform's flat skill listing. Everything else lives at `<provider-dir>/.aiwg/skills/` and is reachable only through this command.

### discover

Find AIWG operational assets by capability — index-driven on-demand discovery (#1212).

```bash
aiwg discover "<phrase>" [options]
```

**Options:**

- `--limit <N>` — Max ranked results (default: 5)
- `--type <kinds>` — Comma-separated filter; defaults to `skill,agent,command,rule,flow,runbook,template,behavior`. Examples: `--type skill`, `--type runbook`, `--type skill,agent`
- `--json` / `--format json` — Emit a stable JSON schema (`id`, `type`, `name`, `title`, `score`, `triggers`, `capability`, `kernel`, `provenance`) for programmatic agent consumption. Paths are intentionally omitted from discover output; use `aiwg show metadata <id>` when path/debug metadata is required.
- `--format text` — Emit readable text output (default).
- `--pretty` — Pretty-print JSON output with indentation (default for compatibility).
- `--compact` — Emit single-line JSON output for scripts.
- `--graph <name>` — Select one graph explicitly. Default local capability
  discovery combines `project`, `user` (when project policy permits), and
  `framework`. Default discovery and show use an existing local project index
  when its Fortemi cache is unavailable or stale, with one actionable warning
  on stderr. Normal lookup needs no graph or backend override; explicit graph
  selection retains cache diagnostics.
- `--backend <fortemi-core|local>` — Query backend. Default is
  `fortemi-core`; `local` selects the legacy local fallback. The Fortemi Core
  backend reads the static cache created by `aiwg index sync`. For the
  `framework` graph it can
  fall back to the packaged prebuilt index described in
  [`docs/fortemi-core-prebuilt-indices.md`](../fortemi-core-prebuilt-indices.md).
- `--resource-source <local|web|auto>` — Select installed resources, signed
  web resources, or local-first fallback for this call. The full `aiwg`
  distribution defaults to `local`; the lightweight `@aiwg/cli` distribution
  defaults to `web`. The current `web` slice requires the `framework` graph and
  the `fortemi-core` backend.
- `--aiwg-version <version-or-channel>` — Select the exact signed resource
  release or channel (`stable`, `candidate`, `nightly`) for web resolution.
- `--offline` — For web resolution, use only previously verified cached release
  metadata, index data, and resource bodies; do not make network requests.

**Examples:**

```bash
aiwg discover "create intake"                       # ranks intake-* skills + intake-coordinator agent
aiwg discover "deploy production" --limit 3         # flow-deploy-to-production tops at score 0.51
aiwg discover "audit security" --type skill         # narrow to skills only
aiwg discover "rotate service certificates" --type runbook # procedural runbooks only
aiwg discover "review code" --type agent --format json --compact # JSON for sub-agent consumption
aiwg discover "static retrieval" --json                # legacy JSON alias
aiwg discover "architecture evolution"                 # @aiwg/cli selects signed stable web resources
aiwg discover "architecture evolution" --resource-source web --aiwg-version stable
aiwg discover "architecture evolution" --resource-source web --offline
```

**Output (default):**

Readable format optimized for agent follow-up — names the stable id, type, score, top trigger phrase, capability description, and the next `aiwg show` command.

```
Discovery results for "deploy production" (3 matches, 16ms):

1. Flow Deploy To Production
   type: flow  score: 0.51
   id: aiwg:flow:6f1477d99813ca8d
   name: flow-deploy-to-production
   capability: Orchestrate production deployment with strategy selection, validation,
   trigger: "deploy production"
   show: aiwg show flow aiwg:flow:6f1477d99813ca8d

Use `--format json` for machine-readable output. Use `aiwg show metadata <id>` for paths and full metadata.
```

**How scoring works:**

| Field matched               | Weight   | Notes                                                                             |
| --------------------------- | -------- | --------------------------------------------------------------------------------- |
| Trigger phrase, exact match | 4×       | The strongest signal — hits a skill's declared `## Triggers` line                 |
| Trigger phrase, substring   | 4× × 0.6 | Partial trigger overlap                                                           |
| Capability description      | 2×       | Frontmatter `description` (or first body paragraph fallback)                      |
| Title                       | 3×       | Boost for exact title match                                                       |
| Tags                        | 2×       | Per-tag                                                                           |
| Structured search terms     | 1.5×     | Process headings, step/capability identifiers, and verification/rollback language |
| Summary                     | 1×       | Body summary                                                                      |
| Path                        | 0.5×     | Filename / path substring                                                         |

YAML workflow-metalanguage resources remain `type: flow` and retain their exact
declarative `kind` (for example, `FlowPlaybook` or `OpsInventory`). Markdown or
YAML runbooks use the separate `type: runbook`; Markdown runbooks also retain
their physical `sourceType` (`template` or `document`). Runbook extraction is
section-aware and indexes procedure, verification, rollback, diagnosis,
remediation, monitoring, and escalation language rather than flattening the
file to its first paragraph.

Multi-token queries require ≥50% token overlap to surface partial matches — gibberish queries return zero results rather than incidental hits.

### show

Print the full text of a specific AIWG skill, agent, command, or rule by name (#1218). The companion to `discover`: where discover ranks candidates, show fetches the body so consumers don't navigate AIWG's storage paths themselves.

```bash
aiwg show <type> <id-or-name-or-path> [options]
aiwg show metadata <id-or-name-or-path> [options]
aiwg index show <type> <name> [options]      # equivalent
```

**Type** is positional for body lookup. Allowed values: `skill`, `agent`, `command`, `rule`. Metadata lookup uses `metadata` as the subcommand and accepts the same identifier/name/path forms.

**Options:**

- `--json` — For body lookup, emit `{ id, path, type, name, title, kernel, providerModels, content }`. For `show metadata`, emit `{ id, backend, type, name, title, paths, provenance, providerModels, metadata }`. `providerModels` lists the reasoning, coding, and efficiency model names plus their model-pinned worker wrapper for providers installed in `.aiwg/aiwg.config`. Default body mode streams the file unmodified.
- `--first` — On ambiguity, pick the top match instead of erroring with the disambiguation list.
- `--graph <name>` — Override the default graph (defaults to `framework` then `project`).
- `--backend <fortemi-core|local>` — Lookup backend. Default is
  `fortemi-core`; `local` selects the legacy local fallback. The Fortemi Core
  backend reads the static cache created by `aiwg index sync`.
- `--resource-source <local|web|auto>` — Select installed resources, signed
  web resources, or local-first fallback for this call. The full `aiwg`
  distribution defaults to `local`; the lightweight `@aiwg/cli` distribution
  defaults to `web`. The current `web` slice requires the `framework` graph and
  the `fortemi-core` backend.
- `--aiwg-version <version-or-channel>` — Select the exact signed resource
  release or channel (`stable`, `candidate`, `nightly`) for web resolution.
- `--offline` — For web resolution, use only previously verified cached release
  metadata, index data, and resource bodies; do not make network requests.

**Lookup order:**

1. Stable discover/Fortemi id from `aiwg discover --json`
2. Exact path match against any indexed entry's stored path (backward-compatible fallback)
3. Basename match (skill directory name like `intake-wizard`, or filename stem for agents)
4. Title match (case-insensitive)

**Examples:**

```bash
aiwg show skill aiwg:skill:6f1477d99813ca8d         # streams SKILL.md to stdout
aiwg show skill flow-deploy-to-production --json    # id + path + content envelope
aiwg show skill architecture-evolution              # @aiwg/cli selects signed stable web resources
aiwg show skill architecture-evolution --resource-source web --aiwg-version stable
aiwg show metadata aiwg:skill:6f1477d99813ca8d --json # full Fortemi metadata + paths
aiwg show agent aiwg-steward                        # agent definition
aiwg show command discover                          # CLI command spec
aiwg show rule no-attribution                       # rule body
aiwg show skill research-query --json
aiwg show agent aiwg-model-coding-worker --json | jq '.providerModels'
```

AIWG deploys three provider-native subagent wrappers:
`aiwg-model-reasoning-worker`, `aiwg-model-coding-worker`, and
`aiwg-model-efficiency-worker`. Their provider output pins the current catalog
model for that role. Give a wrapper any bounded assignment; it discovers and
loads the required AIWG agent, skill, rule, or workflow before executing it.
Use the `providerModels` mapping rather than hard-coding model identifiers.

### Provider inventory

Provider configuration is not proof that a provider is installed. Use the
runtime inventory before selecting a launcher or refreshing models:

```bash
aiwg runtime-info --providers
aiwg runtime-info --providers --json
```

Each provider reports independent `configured`, `deployed`, `detected`,
`available`, and `active` states. Evidence identifies project/user/runtime
scope and the exact signal: configuration, deployment record, runtime
environment, process ancestry, executable, or provider configuration file.
An unavailable configured provider includes an actionable reason rather than
being silently advertised as launchable.

### Dynamic model sources

```bash
aiwg models sources --json
aiwg models refresh --json
aiwg models refresh --drift --json
aiwg models refresh --url https://catalog.example/model-catalog.v1.json --json
```

`models sources` is offline: it reads a fresh user cache when present and
otherwise returns the committed catalog. `models refresh` consults a public
JSON feed only when `--url` or `AIWG_MODEL_CATALOG_URL` configures one, then
runs supported native discovery only for
providers marked available by the provider inventory. Codex uses the
machine-readable app-server `model/list` protocol; Claude Code currently has
no supported local model-list command, so its stable aliases or public/static
catalog remain the fallback.

The cache lives at `~/.cache/aiwg/model-catalog.v1.json` and expires after 24
hours. Each result records source (`native`, `remote`, `cache`, or `static`),
observation time, and account scope. Deployment never accesses the network: it
uses a fresh cache or the committed catalog deterministically. Override the
feed with `AIWG_MODEL_CATALOG_URL`. A hosted or nightly catalog is therefore
optional, not a runtime dependency. Account-specific native results are marked
`local-account` and are never represented as globally available.
`--drift` compares resolved role mappings with the committed catalog and emits
a reviewable, non-mutating provider/role before-and-after report.

AIWG does not currently operate a built-in public feed. See
[the feed decision record](../architecture/adr-optional-model-catalog-feed.md)
and the
[provider discovery matrix](../models/model-discovery-provider-decisions.md).

**Errors:**

- Calling `aiwg show <name>` with the type omitted succeeds only when the identifier/name/path is unambiguous across artifact types.
- Ambiguous matches list all candidates and exit 2 unless `--first` is supplied.

**Why a separate command:** the kernel pivot (#1212) intentionally hides ~460 skills from the platform's flat scan; the no-copy default (#1217) leaves them at `$AIWG_ROOT` rather than mirroring per-project. `aiwg show` makes them trivially reachable without the consumer needing to know the storage layout. Pair with `aiwg discover` for find → fetch, and use `aiwg show metadata <id>` only when you need the full metadata/path envelope.

### Best-practice usage guidance

Discovery is the operator surface that makes the **kernel + on-demand model** work across all 15 named provider integrations (Google Antigravity CLI, Claude Code, OpenAI Codex, GitHub Copilot, Cursor, DeepSeek Harness, Factory AI, Hermes, OpenCode, OpenClaw, OpenHuman, Pi Coding Agent from pi.dev, Oh My Pi, Warp Terminal, and Devin Desktop). Each provider deploys a small kernel set on its supported skill surface; everything else is reached via `aiwg discover`.

**Lead with discovery, not with memory.** When a user describes a capability, query first:

```bash
aiwg discover "<the user's need, paraphrased>" --limit 3
```

Then surface the top match (or top-3 candidates) — this makes your reasoning auditable and gives the user a chance to redirect.

**Use type filters to tighten results.** When the user wants a workflow, restrict to `--type skill`. When they want to know who handles something, `--type agent`. When they ask about enforcement, `--type rule`.

**Use `--json` from sub-agents.** The JSON schema (`id / type / name / title / score / triggers / capability / kernel / provenance`) is stable and compact enough to forward to a subagent without context-bloat. It avoids filesystem paths by default; fetch paths separately with `aiwg show metadata <id> --json` when needed.

**Don't skip discovery before declining or improvising.** The `skill-discovery` HIGH framing rule mandates `aiwg discover` before saying "AIWG can't do that" or writing a custom workflow from scratch. Most AIWG skills (~460 of 480 today) are NOT in your loaded context — the kernel set is just the orientation layer + self-maintenance ops.

**Read skill bodies via `aiwg show`, not via filesystem paths.** When discovery returns a candidate and you need its full body, call `aiwg show skill <id>` (or the stable name if that is all you have). Don't construct paths or `cat` files directly — the CLI is the access point and works the same regardless of where AIWG is installed. Exact path parameters remain supported for compatibility, but identifier lookup is the primary path.

**Skip discovery only when:**

- The user named a specific skill or command (e.g., `/flow-deploy-to-production`)
- The capability is clearly outside AIWG's scope
- You ran the same query in this session and the result is in working memory
- A kernel quickref directly lists the skill — you've already done the lookup

**The framework graph stays fresh automatically.** `aiwg use` rebuilds the framework artifact index post-deploy (best-effort), so `aiwg discover` queries always reflect the current installed surface. You don't need to invoke `aiwg index build --graph framework` manually unless you've edited skill source between deploys.

**Backward compatibility:** `aiwg index discover` still works (same dispatch). The top-level `aiwg discover` is the canonical surface; the index-namespaced form is preserved so older skill bodies and external references don't break.

---

## Index Commands

Commands for building and querying the artifact index. The index provides structured, pre-computed metadata about project artifacts, enabling agents and developers to navigate artifacts without manual file searching.

> **Looking for `aiwg discover`?** It moved to a top-level command (see [Discovery](#discovery) above). The legacy `aiwg index discover` form still works.

The index uses a **multi-graph architecture** with three built-in graph types plus user-defined graphs:

| Graph            | Scans                                                   | Storage                            | Built by default             |
| ---------------- | ------------------------------------------------------- | ---------------------------------- | ---------------------------- |
| `project`        | configured AIWG artifact root (virtualized as `.aiwg/`) | `<artifact-root>/.index/project/`  | Yes                          |
| `codebase`       | JS/TS: `src/`, `test/`, `tools/`; Python: detected package, `tests/`, `scripts/` roots | `<artifact-root>/.index/codebase/` | Yes (skipped if dirs absent) |
| `framework`      | `agentic/code/`, `docs/`                                | `.aiwg/.index/framework/`          | No (use `--graph framework`) |
| _(user-defined)_ | configured in the artifact root's `aiwg.config` (#1491) | `<artifact-root>/.index/<name>/`   | Configurable                 |

The artifact root defaults to `<project>/.aiwg`, but `AIWG_ARTIFACTS_PATH` or
`.aiwg-location` may point it elsewhere or rename it. Index entries for project
artifacts keep stable virtual paths like `.aiwg/requirements/UC-001.md`, while
file reads, graph config, and writes resolve through the configured root.

**`defaultBuild` behavior**: When you run `aiwg index build` with no `--graph` flag, every graph with `defaultBuild: true` is built. The `codebase` graph preserves the JavaScript/TypeScript defaults and, when `pyproject.toml`, `setup.py`, or `setup.cfg` is present, adds `.py`/`.pyi`, top-level package directories containing `__init__.py`, and existing `tests/` and `scripts/` roots. If no supported scan directory exists (for example, in a docs-only repo), the graph is skipped with a warning rather than erroring. To require a graph's directories to exist, request it explicitly: `aiwg index build --graph codebase`.

All commands without `--graph` operate across all available project-local graphs (`project` + `codebase`). Use `--graph <name>` to target a specific graph, including user-defined ones.

### index

Artifact index commands (build, query, deps, stats).

```bash
aiwg index <subcommand> [options]
```

**Subcommands:**

- `build` - Build/rebuild the artifact index
- `query` - Search artifacts by keyword, type, phase, tags
- `discover` - Capability search across AIWG skills/agents/commands/rules (canonical form is the top-level [`aiwg discover`](#discover); this subcommand is preserved for backward compatibility)
- `show` - Print the full text of a specific skill/agent/command/rule (canonical form is the top-level [`aiwg show`](#show))
- `sync` - Materialize the Fortemi Core static index cache for a graph
- `migrate-legacy` - Move compatible legacy root indexes into graph sidecar indexes without modifying packaged/prebuilt indexes
- `deps` - Show artifact dependency graph
- `stats` - Show index statistics
- `status` - Enumerate the durable index-graph registry (built-in + module + operator graphs) with build state, freshness, and drift; flags registered-but-unbuilt indices, on-disk dirs matching no graph, and graph-config defs that previously failed to load silently (#1624). Alias: `list`. Add `--json` for a stable envelope.
- `neighbors` - Get neighbors of a node in a graph
- `set` - Set operations (intersection, union, difference) on neighbor sets
- `watch` - Filesystem watcher for automatic incremental updates

**Global option (all subcommands):**

- `--graph <name>` - Target a specific graph: built-in (`project`, `codebase`, `framework`) or user-defined

### artifacts

Manage the configured project AIWG artifact root.

```bash
aiwg artifacts path [--json] [--check-write]
aiwg artifacts move --to <path> [--from <path>] [--dry-run] [--no-reindex] [--no-sync]
aiwg artifacts attach --to <existing-path> [--dry-run] [--no-reindex] [--no-sync]
aiwg artifacts repair --dry-run
aiwg artifacts repair --apply
```

`path` prints the resolved absolute artifact root for scripts and agent
workflows; `--json` returns the stable `aiwg.artifacts.path.v1` envelope. It
honors artifact-root environment overrides and `.aiwg-location`.
The JSON envelope reports whether the root is external and write-ready, plus
the exact repository-local control-file exceptions. Add `--check-write` before
an agent or workflow write: it exits non-zero when an explicitly external root
is unavailable instead of recreating or falling back to local payload.

`move` relocates or renames the current artifact root, writes `.aiwg-location`
in the project root, updates `.gitignore` so the pointer remains local,
rebuilds the project index, and syncs the Fortemi Core cache. `--from` overrides
the source root; otherwise AIWG resolves it the same way runtime config does.
`attach` adopts an already populated artifact root without moving or
overwriting the local or external tree; it validates that `aiwg.config` exists,
writes the same pointer, and rebuilds the external index.
Both commands retain a minimal repository-local control plane (`AIWG.md`,
`aiwg.config`, and `frameworks/registry.json`) while corpus-heavy directories
live under the configured artifact root. `repair` audits legacy split-root
workspaces and previews every action. With explicit `--apply`, local-only
payload is copied to the external corpus, byte-identical duplicates are
deduplicated, and divergent local variants are preserved under
`archive/local-corpus-migration/conflicts/local/` with a content-hash suffix.
The external variant is never overwritten, and local payload is removed only
after byte-for-byte verification of its external or archived copy. Divergent
control-plane files still require manual reconciliation. The same classification
is reported by `aiwg status --probe --json` and `aiwg doctor`.
`AIWG_ARTIFACTS_PATH` still has highest precedence for per-call overrides.

**Capabilities:** cli, index, artifacts, search, dependencies
**Platforms:** All
**Tools:** Read, Glob, Grep

---

### index build

Build or rebuild the artifact index.

```bash
aiwg index build [options]
```

**Options:**

- `--force` - Full rebuild (ignore checksums, re-index everything)
- `--verbose` - Show detailed progress during indexing
- `--all` - Build all known graphs (built-in + user-defined)
- `--scope <dir>` - Limit scan to a specific subdirectory (relative to project root)
- `--graph <name>` - Build a single graph only — built-in (`project`, `codebase`, `framework`) or user-defined

**Default behavior** (no `--graph`): Builds all graphs with `defaultBuild: true`. Built-in defaults: `project` (always) and `codebase` (JavaScript/TypeScript roots plus detected conventional Python layouts; skipped with a warning only when no supported roots exist). The `framework` graph covers AIWG framework source (`agentic/code/`, `docs/`) and must be built explicitly with `--graph framework`.

**Incremental mode** (default): Only re-indexes files whose checksum has changed. Use `--force` for a full rebuild.

**Post-clone bootstrap.** The index output (`.aiwg/.index/`) is a regenerable build artifact and is **gitignored by default** (added to `.gitignore` by `aiwg use`, `aiwg regenerate`, and project scaffolding). It is not committed, so a fresh clone has no index. Rebuild it with:

```bash
aiwg index build --all     # standard post-clone bootstrap — builds every known graph
```

`aiwg doctor` reports the index as `info` when it is absent (and the project declares an `index` block in `.aiwg/aiwg.config`, or legacy `.aiwg/config.yaml`) and `warn` when it is present but stale (recorded source files have changed since the last build). Both point you back to `aiwg index build`. If you prefer to commit the index as a zero-rebuild cache for teammates, you can un-ignore `.aiwg/.index/` in your `.gitignore` — but the default is ignore-and-rebuild.

**User-defined graphs**: Define custom index graphs under `index.graphs` in **`.aiwg/aiwg.config`** (JSON) — the canonical, schema-validated home as of #1491. Each graph gets its own named index under `.aiwg/.index/<name>/`.

```json
// .aiwg/aiwg.config (excerpt)
{
  "index": {
    "graphs": {
      "references": {
        "scanDirs": ["documentation/references"],
        "extensions": [".md"],
        "defaultBuild": false
      }
    }
  }
}
```

> **Config home & migration (#1491).** Index config was consolidated from the legacy `.aiwg/config.yaml` (YAML, unvalidated) into `.aiwg/aiwg.config` (JSON, validated against `aiwg.config.v1.json`). `aiwg index build` and `aiwg doctor` now validate `index.graphs` and reject malformed defs at validate time (unknown graph type, missing `scanDirs`, bad regex, typo'd keys, malformed manifest). **To migrate:** move the `index:` block out of `.aiwg/config.yaml` into `.aiwg/aiwg.config` as JSON under the top-level `"index"` key, then delete it from `config.yaml`. The legacy `config.yaml` `index:` block still works as a deprecated fallback — `aiwg doctor` warns when it's in use — so migration is non-blocking. The YAML snippets below are illustrative; place them in `aiwg.config` as JSON.

Fields:

- `scanDirs` (required) — directories to scan, relative to project root
- `extensions` — file extensions to index (default: `.md`, `.yaml`, `.json`)
- `defaultBuild` — whether to include in `aiwg index build` with no `--graph` (default: `true`)
- `shared` — whether the graph is shared across projects (default: `false`)

User-defined graph names cannot override built-in names (`project`, `codebase`, `framework`).

The same `index.graphs` contract is accepted in `~/.aiwg/aiwg.config` for shared
user-level graphs; those graphs also default `defaultBuild` to `true` and are
reported by bare `aiwg index stats` after they have been built. The concise
`indices.user.roots` form is different: it creates explicit-build user roots
with `defaultBuild: false`; use `index.graphs` when a user-level graph should be
part of the default build/stats set.

To replace only the built-in `codebase` graph's scan roots or extension allow-list, use the bounded `index.graphOverrides.codebase` contract. Present fields replace the detected/default value; omitted fields retain it. The graph identity, storage location, sharing mode, build policy, and backend cannot be widened through an override.

```json
{
  "index": {
    "graphOverrides": {
      "codebase": {
        "scanDirs": ["backend", "spec", "scripts"],
        "extensions": [".py", ".pyi"]
      }
    }
  }
}
```

**Advanced graph config fields:**

| Field                   | Type                               | Description                                              |
| ----------------------- | ---------------------------------- | -------------------------------------------------------- |
| `scanDirs`              | string[]                           | Directories to scan (required)                           |
| `extensions`            | string[]                           | File extensions (default: `.md`, `.yaml`, `.json`)       |
| `defaultBuild`          | boolean                            | Include in default `aiwg index build` (default: `true`)  |
| `shared`                | boolean                            | Shared across projects (default: `false`)                |
| `graphBackend`          | `json` \| `graphology` \| `sqlite` | Graph storage backend (default: `json`)                  |
| `nodeStrategy`          | `default` \| `filename-metadata`   | How node metadata is derived (default: `default`)        |
| `filenamePattern`       | string                             | Regex with named groups for `filename-metadata` strategy |
| `edgeExtraction.parser` | string                             | Parser for edge extraction (e.g., `citation-sidecar`)    |
| `edgeExtraction.edges`  | array                              | Edge type declarations for the parser                    |

**Graph backends**: The default `json` backend requires no extra packages. For larger corpora or richer traversal, install an optional backend:

```bash
# Graphology — community detection, shortest path, <50k nodes
aiwg features install graph

# SQLite — persistent, incremental, SQL set ops, 5k–500k nodes
aiwg features install sqlite
```

Activate per-graph in `.aiwg/config.yaml`:

```yaml
index:
  graphs:
    citation-network:
      graphBackend: sqlite
    summaries:
      graphBackend: graphology
```

**Semantic embedding index**: Orthogonal to graph backends — adds dense vector search to any tier:

```bash
aiwg features install embeddings
```

```yaml
index:
  embedding:
    enabled: true
    model: Xenova/all-MiniLM-L6-v2 # ~22MB, cached to ~/.cache/aiwg/models/
    topK: 10
```

See [Graph Backends](../extensions/graph-backends.md) for full backend documentation.

**Documentation-only repos**: If your repo has none of the JavaScript/TypeScript roots and no detected Python package layout, `aiwg index build` will skip the `codebase` graph with a warning and still build the `project` graph. To index documentation under a custom path, define a user-defined graph:

```yaml
# .aiwg/config.yaml
index:
  graphs:
    docs:
      scanDirs:
        - documentation
        - guides
      extensions:
        - .md
      defaultBuild: true
```

Then `aiwg index build` will automatically include your `docs` graph.

**Examples:**

```bash
# Build project + codebase (default; codebase skipped if src/test/tools absent)
aiwg index build

# Full rebuild
aiwg index build --force

# Verbose output
aiwg index build --verbose

# Build framework graph (agentic/code/ + docs/)
aiwg index build --graph framework

# Build a single built-in graph
aiwg index build --graph project

# Build a user-defined graph
aiwg index build --graph references

# Build all graphs including user-defined
aiwg index build --all

# Scope to a specific subdirectory
aiwg index build --scope documentation/references
```

**Output structure:**

```
.aiwg/.index/
├── project/          # .aiwg/ artifacts
│   ├── metadata.json
│   ├── tags.json
│   ├── dependencies.json
│   └── stats.json
└── codebase/         # src/, test/, tools/
    ├── metadata.json
    ├── tags.json
    ├── dependencies.json
    └── stats.json
```

---

### index query

Search artifacts by keyword, type, phase, tags, or path pattern.

```bash
aiwg index query [search-text] [options]
```

**Arguments:**

- `[search-text]` - Optional keyword search (weighted: title 3x, tags 2x, summary 1x, path 0.5x)

**Options:**

- `--type <type>` - Filter by artifact type (e.g., `use-case`, `adr`, `test-plan`)
- `--phase <phase>` - Filter by SDLC phase (e.g., `requirements`, `architecture`, `testing`)
- `--tags <tag1,tag2>` - Filter by tags (AND logic — all tags must match)
- `--path <glob>` - Filter by file path glob pattern
- `--updated-after <date>` - Filter by last-modified date
- `--limit <n>` - Maximum number of results (default: 20)
- `--graph <type>` - Search a specific graph only
- `--fulltext` - Lexical full-text search over artifact **bodies** (BM25), instead of the default metadata scoring. Distinct from `--semantic` (conceptual).
- `--semantic` - Use Fortemi Core static semantic scoring by default, or the legacy embedding index with `--backend local`
- `--hybrid` - Use Fortemi Core static hybrid scoring plus the type/phase/tag/path filters
- `--backend <fortemi-core|local>` - Query backend. Default is `fortemi-core`; `local` is the legacy fallback during the deprecation window. Fortemi Core reads the static cache created by `aiwg index sync`. For `--graph framework`, packaged releases can fall back to the prebuilt index described in [`docs/fortemi-core-prebuilt-indices.md`](../fortemi-core-prebuilt-indices.md).
- `--set-query <expr>` - Set-theoretic query, e.g. `"cited_by(REF-008) AND cited_by(REF-016)"` (SQLite backend recommended)
- `--json` - Output as JSON (recommended for agents)

**Default behavior** (no `--graph`): Searches across `project` + `codebase` graphs combined.

**What `query` searches (per-graph scope):**

| Mode                         | Scope                                                                                                                                                                              | Ranking                                                                          |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Default (any graph)          | **Metadata only** — title (3x), tags (2x), capability/triggers, the 500-char summary (1x), path (0.5x). The index stores a truncated summary, **not** the full body.               | Weighted field-match                                                             |
| `--fulltext` (local backend) | **Full artifact body** — reads each candidate node's source file and matches body text (frontmatter stripped). Catches content that never reaches the summary.                     | BM25 (top hit normalized to 1.0; JSON adds `matched` terms + `mode: "fulltext"`) |
| `--fulltext`                 | Fortemi static-cache text/chunks exported by `aiwg index sync`. Preserves type/phase/tag/path filters without rereading source files. Use `--backend local` for legacy body reads. | BM25 over exported static text/chunks                                            |
| `--semantic`                 | Fortemi static semantic scoring by default. Use `--backend local` for the legacy embedding index.                                                                                  | Static Fortemi chunk scoring or cosine over local embeddings                     |
| `--hybrid`                   | Fortemi static semantic scoring filtered by path/type/phase/tags.                                                                                                                  | Static Fortemi score plus filter/facet matches                                   |

Use the default for "find the artifact named/about X"; `--fulltext` for "find the document whose **body** discusses X"; `--semantic` for "find documents conceptually near X"; `--hybrid` for Fortemi static-cache semantic ranking constrained by metadata filters. Pass `--backend local` only when you need the legacy local index path during the phase-out window.

**Examples:**

```bash
# Search all project-local graphs (metadata-scoped)
aiwg index query "authentication"

# Search framework source only
aiwg index query "artifact discovery" --graph framework

# Filter by type
aiwg index query --type use-case

# Combined filters
aiwg index query "login" --type use-case --phase requirements

# Full-text over REF/sidecar bodies (lexical, BM25) — content not in the summary
aiwg index query "mixture of experts routing" --fulltext --graph papers

# Fortemi static-cache fulltext over exported record text/chunks
aiwg index query "static retrieval evidence" --fulltext --graph project --json

# Semantic similarity search (embedding index required)
aiwg index query "dense retrieval for question answering" --semantic --graph citation-network

# Fortemi static-cache semantic search
aiwg index query "static retrieval evidence" --semantic --graph project --json

# Fortemi static-cache hybrid search with metadata filters
aiwg index query "static retrieval architecture" --hybrid --type adr --tags search --path .aiwg/architecture --json

# Set-theoretic: papers citing both REF-008 and REF-016
aiwg index query --set-query "cited_by(REF-008) AND cited_by(REF-016)" --graph citation-network

# JSON output for agents
aiwg index query "auth" --json
```

---

### index neighbors

Show graph neighbors of a node — direct dependencies or typed edges in a
specific index graph. Use `aiwg index similar` for semantic-neighbor lookup.

```bash
aiwg index neighbors --graph <name> --node <id> [options]
```

**Options:**

- `--graph <name>` - Target graph to query (required)
- `--node <id>` - Node identifier (e.g., `REF-008`, `.aiwg/requirements/UC-001.md`)
- `--direction <dir>` - `in`, `out`, or `both` (default: `both`)
- `--edge-type <type>` - Filter by edge type (e.g., `cites`, `cited-by`, `implements`, `depends-on`)
- `--backend <fortemi-core|local>` - Query backend. Default is `fortemi-core`;
  Fortemi Core reads graph relationships from the static cache, while `local`
  uses the legacy graph files during the phase-out window.
- `--json` - Output as JSON

**Examples:**

```bash
# All neighbors of a node
aiwg index neighbors --graph citation-network --node REF-008

# Papers that cite REF-008 (incoming cites edges)
aiwg index neighbors --graph citation-network --node REF-008 --direction in --edge-type cites

# What REF-008 cites (outgoing)
aiwg index neighbors --graph citation-network --node REF-008 --direction out --edge-type cites

# Artifacts that implement a use case (SDLC)
aiwg index neighbors --graph project --node .aiwg/requirements/UC-001.md --edge-type implements

# Fortemi static-cache graph traversal
aiwg index neighbors --graph kb --node retrieval.md --json
```

**Typed edge types:**

| Domain              | Edge types                                                  |
| ------------------- | ----------------------------------------------------------- |
| Research / citation | `cites`, `cited-by`, `summarizes`, `discusses`              |
| SDLC                | `depends-on` (default), `implements`, `tests`, `supersedes` |

---

### index embed

Build the semantic embedding index for a graph (so `--semantic`, `index similar`, and `index dedup-report` work). Enable the optional runtime with `aiwg features install embeddings` first. Semantic search is opt-in; without the feature the command prints public CLI guidance and exits.

```bash
aiwg index embed --graph papers              # embed the papers graph's metadata (title + summary)
aiwg index embed --graph papers --model Xenova/all-MiniLM-L6-v2   # explicit model
aiwg index embed --graph papers --embed-body # embed title + summary + chunked source body
aiwg index embed --graph papers --granularity body # explicit body-granularity form
```

Embeddings are written to `<graph index dir>/embeddings/` (regenerable; gitignored with the rest of `.aiwg/.index/`). Re-run after `aiwg index build` to refresh.

By default, AIWG embeds each node's title and summary. `--embed-body` (equivalent
to `--granularity body`) strips source frontmatter, embeds bounded overlapping
body chunks, and mean-pools them into one normalized vector per node. The
manifest records the canonical granularity (`title-summary` or `body`), and
local semantic-query and dedup-report output identify the granularity and model
they loaded.

### index similar

Find semantic neighbors of a node (conceptually nearest artifacts).

```bash
aiwg index similar --node REF-394 --graph papers --top 10
aiwg index similar --node REF-394 --graph papers --json
```

### index dedup-report

Surface near-duplicate node pairs above a cosine-similarity threshold — high-value corpus maintenance (catches the same paper inducted twice).

```bash
aiwg index dedup-report --graph papers                    # threshold 0.92
aiwg index dedup-report --graph papers --threshold 0.85   # looser; more candidate pairs
aiwg index dedup-report --graph papers --json
```

Each pair lists both node ids + their titles, most-similar-first. With the
default `title-summary` granularity this catches title/abstract-level
duplicates; build the index with `--embed-body` to detect content-level
duplicates whose summaries differ. Lower the threshold to surface looser
matches.

---

### index deps

Show artifact dependency graph based on @-mention references.

```bash
aiwg index deps <path> [options]
```

**Arguments:**

- `<path>` - Path to the artifact (e.g., `.aiwg/requirements/UC-001.md`)

**Options:**

- `--direction <dir>` - Direction: `upstream`, `downstream`, or `both` (default: `both`)
- `--depth <n>` - Maximum traversal depth (default: 3)
- `--graph <type>` - Use a specific graph's dependency data
- `--backend <fortemi-core|local>` - Query backend. Default is `fortemi-core`;
  Fortemi Core reads dependency relationships from the static cache, while
  `local` reads dependency relationships from the legacy graph files during the
  phase-out window.
- `--json` - Output as JSON (recommended for agents)

**Behavior:**

- `upstream` - What this artifact depends on (its @-mentions and scoped Markdown links)
- `downstream` - What depends on this artifact (mentions it)
- `both` - Both directions

**Default behavior** (no `--graph`): Merges dependency data from `project` + `codebase` graphs.

**Examples:**

```bash
# Show all dependencies
aiwg index deps .aiwg/requirements/UC-001.md

# Downstream only (what would break if I change this?)
aiwg index deps .aiwg/requirements/UC-001.md --direction downstream

# JSON output with limited depth
aiwg index deps .aiwg/architecture/adr-001.md --depth 2 --json

# Deps within framework source
aiwg index deps agentic/code/frameworks/sdlc-complete/rules/artifact-discovery.md --graph framework

# Fortemi static-cache dependency traversal
aiwg index deps .aiwg/architecture/search-adr.md --graph project --json
```

---

### index stats

Show artifact index statistics and project health metrics.

```bash
aiwg index stats [options]
```

**Options:**

- `--graph <type>` - Show stats for a specific graph only
- `--json` - Output as JSON (recommended for agents)

**Default behavior** (no `--graph`):

- Human-readable: shows each available graph with a section header
- JSON: returns an object keyed by graph name with all stats

**Reports:**

- Artifact counts by SDLC phase and type
- Tag distribution
- Dependency graph metrics (edges, orphaned artifacts)
- Index coverage (indexed vs. total files)

**Examples:**

```bash
# Show all project-local graphs
aiwg index stats

# JSON output (aggregated, keyed by graph name)
aiwg index stats --json

# Single graph
aiwg index stats --graph project --json

# Framework graph stats
aiwg index stats --graph framework
```

### index migrate-legacy

Move compatible legacy root index files into the graph sidecar layout used by
Fortemi Core search. Project scope migrates `.aiwg/.index/*.json` into
`.aiwg/.index/project/*.json`, then refreshes the project Fortemi Core static
cache. User and global scopes are available for sidecar-index migration work and
report missing legacy roots without touching packaged/prebuilt AIWG indexes.

```bash
aiwg index migrate-legacy [--scope project|user|global | --all] [options]
```

**Options:**

- `--scope <name>` - Scope to migrate: `project`, `user`, or `global` (default: `project`)
- `--all` - Inspect/migrate project, user, and global scopes
- `--dry-run` - Report planned changes without writing files
- `--no-fortemi-sync` - Skip Fortemi Core cache refresh for project scope
- `--generated-at <iso>` - Deterministic timestamp for fixtures/support repros
- `--json` - Print the migration report as JSON

Examples:

```bash
aiwg index migrate-legacy --scope project --dry-run
aiwg index migrate-legacy --scope project
aiwg index migrate-legacy --all --json
```

If `metadata.json` is missing, unreadable, or has an incompatible schema
version, the command reports `needs-rebuild` instead of silently falling back.

---

## Storage Commands

AIWG persists artifacts (memory pages, knowledge-base entries, activity log, reflections, provenance records, research corpus, sandbox identities) through a pluggable storage adapter system (#934). By default everything lives on the local filesystem under `.aiwg/`. With `.aiwg/storage.config` you can route any subsystem to Obsidian, Logseq, the legacy Fortemi MCP storage adapter, or a different filesystem location.

The `fortemi` storage backend is separate from Fortemi Core index/search. Use
`aiwg index sync` and query commands with
`--backend local` for legacy fallback for the new static-cache search path and packaged
prebuilt framework fallback.

**See [`docs/storage/`](../storage/README.md) for the full guide** — overview, security model, migration walkthrough, and per-backend pages.

### storage

Inspect and operate on the storage adapter system.

```bash
aiwg storage <subcommand>
```

**Subcommands:**

| Subcommand            | Purpose                                                                |
| --------------------- | ---------------------------------------------------------------------- |
| `show`                | Print effective config + resolved physical paths per subsystem         |
| `list-backends`       | Inventory of compiled-in adapters with READY/STUB status               |
| `test <subsystem>`    | Round-trip write/read/list/delete probe through the configured backend |
| `migrate <subsystem>` | Copy entries from one backend to another (#955)                        |
| `import-corpus`       | Ingest local research text through an implemented storage backend (#1508) |

**Examples:**

```bash
# Inspect what's configured
aiwg storage show

# Which backends are implemented vs planned
aiwg storage list-backends

# Verify connectivity for the activity_log subsystem
aiwg storage test activity_log

# Preview local-workstation research ingest without connecting
aiwg storage import-corpus --dry-run

# Route through another implemented storage backend
aiwg storage import-corpus --to obsidian:~/vault

# Ingest through an authenticated Enterprise MCP registry entry
aiwg storage import-corpus --server fortemi-enterprise

# Migrate AIWG memory from local fs to an Obsidian vault
aiwg storage migrate memory \
  --from fs:.aiwg/memory \
  --to obsidian:~/vaults/main \
  --to-folder AIWG/memory \
  --dry-run

# Without --dry-run when the preview looks right
aiwg storage migrate memory \
  --from fs:.aiwg/memory \
  --to obsidian:~/vaults/main \
  --to-folder AIWG/memory
```

**Implemented backends:** `fs`, `obsidian`, `logseq`, `fortemi` (alpha MCP storage adapter; legacy for search).
**Stub (tracked):** `notion` (#959), `anythingllm` (#960), `s3` (#962), `webdav` (#963).

**Migrate spec format:** `<type>:<location>` (e.g., `fs:./dir`, `obsidian:~/vault`, `logseq:./graph`, `fortemi:server-name`). Use `--from-folder`/`--to-folder` for Obsidian subfolders. See `docs/storage/migration.md` for details.

---

### activity-log

Query and manage `.aiwg/activity.log` — a chronological record of cross-framework operations. Routes through `resolveStorage('activity_log')`.

```bash
aiwg activity-log <subcommand>
```

**Subcommands:**

| Subcommand                                               | Purpose                                                 |
| -------------------------------------------------------- | ------------------------------------------------------- |
| `show [--since YYYY-MM-DD] [--operation OP] [--limit N]` | Display entries newest-first                            |
| `append <operation> "<summary>"`                         | Append a canonical-format entry (atomic via `O_APPEND`) |
| `stats`                                                  | Operation-count breakdown + date range                  |
| `rotate [--keep-last <Nd\|N>] [--to <path>]`             | Archive entries to a sibling file (#977)                |

**Operations** (one per entry): `ingest`, `create`, `update`, `delete`, `query`, `lint`, `deploy`, `archive`, `promote`.

**Wire format:** `## [YYYY-MM-DD HH:MM] <operation> | <summary>`

**Environment:**

- `AIWG_SKIP_ACTIVITY_LOG=1` — suppress append (per the activity-log rule)

**Examples:**

```bash
# Recent activity
aiwg activity-log show --limit 10

# Filter
aiwg activity-log show --since 2026-04-01 --operation deploy

# Append (atomic — concurrent agents don't race)
aiwg activity-log append create ".aiwg/requirements/UC-007.md"

# Stats
aiwg activity-log stats

# Rotate: archive everything older than 90 days, keep recent inline
aiwg activity-log rotate --keep-last 90d
```

**Auto-append hook (#978):** A post-command hook auto-logs qualifying CLI commands (`use`, `refresh`, `remove`, `add-{agent,command,skill,template,behavior}`, `validate-metadata`, `index`, `ops`). Honors `AIWG_SKIP_ACTIVITY_LOG=1`. Failures non-fatal.

---

### command-log

Report the optional local CLI command invocation log. This is off by default and
separate from `activity-log`: `activity-log` is an audit trail of AIWG artifact
operations, while `command-log` is a privacy-preserving usage analysis stream
for future heatmap/suggestion work (#1611).

```bash
aiwg command-log [--json] [--scope project|global|all] [--limit N]
```

**Enable logging:**

```bash
# Project-local store only
aiwg config set --project command_log.enabled true
aiwg config set --project command_log.scopes project

# Project + operator-global stores
aiwg config set --project command_log.scopes project,global

# One invocation or shell session override
AIWG_COMMAND_LOG=project aiwg doctor
AIWG_COMMAND_LOG=global aiwg doctor
AIWG_COMMAND_LOG=both aiwg doctor
AIWG_COMMAND_LOG=off aiwg doctor
```

**Precedence:** `AIWG_COMMAND_LOG` overrides `.aiwg/aiwg.config`
`command_log.*` for that process. With no env override, project config controls
logging. With no project config, logging is disabled.

**Stores:**

- Project: `.aiwg/telemetry/cli-commands.jsonl`
- Global: `$XDG_STATE_HOME/aiwg/cli-commands.jsonl` or `~/.local/state/aiwg/cli-commands.jsonl`

**Privacy model:** events include command identity, timestamp, duration, exit
status, AIWG version, scope, flag names, positional argument count, hashed cwd,
and hashed project root plus project-relative cwd when available. Events do not
store prompts, stdout/stderr, file contents, secrets, full raw argv, or absolute
local paths by default.

**Bounds:** stores rotate to `.1` when `command_log.max_bytes` or
`AIWG_COMMAND_LOG_MAX_BYTES` is exceeded. The default bound is 1 MiB per store.

**Examples:**

```bash
aiwg command-log
aiwg command-log --json
aiwg command-log --scope global --limit 50
```

---

### skill-usage

Report the optional local skill, agent, and command usage stream. This is off by
default and records CLI-derived utilization such as `aiwg run skill <name>`,
`aiwg run agent <name>`, `aiwg show skill|agent <name>`, `discover`, and
top-level commands. It can also ingest a targeted Claude Code JSONL transcript
when the operator points it at a specific file.

Transcript ingestion currently supports `claude-code` only. Other provider
values fail explicitly; their records are never parsed with the Claude adapter
or relabeled.

```bash
aiwg skill-usage [--json] [--scope project|global|all] [--limit N] [--suggest-for "query"]
aiwg skill-usage ingest-transcript <path> --provider claude-code [--project-root <path>] [--dry-run] [--json]
```

**Enable logging:**

```bash
# Project-local store only
aiwg config set --project telemetry.skill_usage.enabled true
aiwg config set --project telemetry.skill_usage.scopes project

# Project + operator-global stores
aiwg config set --project telemetry.skill_usage.scopes project,global

# One invocation or shell session override
AIWG_SKILL_USAGE=project aiwg run skill issue-audit
AIWG_SKILL_USAGE=global aiwg show agent security-auditor
AIWG_SKILL_USAGE=both aiwg discover "issue triage"
AIWG_SKILL_USAGE=off aiwg doctor
```

**Compatibility:** `telemetry.skill_usage.*` is the preferred switch. Existing
`command_log.*` opt-ins also enable skill-usage events until the command-log
compatibility path is retired.

**Stores:**

- Project: `.aiwg/telemetry/skill-usage.jsonl`
- Global: `$XDG_STATE_HOME/aiwg/skill-usage.jsonl` or `~/.local/state/aiwg/skill-usage.jsonl`

**Report model:** JSON output includes `summary`, `heatmap`, `cold_spots`,
`suggestions`, and a retained-segment `window`. Reports read the active file
and retained `.1` segment, and disclose when history predates that window.
The heatmap buckets each artifact by frequency and recency.
Cold spots are local bundled skills with no usage events. Suggestions are
deterministic under-used skill matches for `--suggest-for`.

**Privacy model:** events include artifact kind/id, action, timestamp, duration,
outcome, AIWG version, scope, hashed cwd, and hashed project root plus
project-relative cwd when available. Reports derive counts from those events
and local skill metadata. Events do not store prompts, stdout/stderr, file
contents, secrets, full raw argv, chat content, or absolute local paths.
Provider metadata is reduced to the explicit provider and normalized artifact
identity before storage. Skill-usage telemetry is not automatically copied
into the session catalog; doing so requires that catalog's separate source
authorization and sanitization policy.

**Envelope and replay:** legacy schema-version 1 JSONL events remain readable.
Transcript imports write schema-version 2 events with distinct source
`timestamp` and `observed_timestamp`, stable event/source-generation identity,
and an import receipt. Replaying an unchanged source is idempotent across the
retained window.

**Bounds:** transcript input is streamed with per-line, record-count, and total
byte limits. Stores rotate before an append whose projected size would exceed
`telemetry.skill_usage.max_bytes`, `command_log.max_bytes`, or
`AIWG_SKILL_USAGE_MAX_BYTES`. The default is 1 MiB. A single encoded event
larger than the configured bound is isolated in an otherwise-empty active
segment and marked `oversized_record`; no additional event is appended to that
segment before rotation.

**Consent, retention, access, export, deletion:** collection is off by default
and requires the configuration or environment opt-in above. Files inherit
normal filesystem access controls. `aiwg skill-usage --json` is the export
surface. Retention is the active segment plus `.1`; older `.1` content is
disposed during rotation. To delete telemetry, remove the project/global
`skill-usage.jsonl` and `.1` files after disabling collection. Session
tombstone/purge does not delete this separately consented store.

**Examples:**

```bash
aiwg skill-usage
aiwg skill-usage --json
aiwg skill-usage --scope project --limit 50
aiwg skill-usage --suggest-for "issue audit"
aiwg skill-usage ingest-transcript ~/.claude/projects/example/session.jsonl --provider claude-code --project-root .
```

---

### memory

Storage operations on the AIWG memory subsystem. Routes through `resolveStorage('memory')`. Used by `memory-ingest` / `memory-lint` / `memory-log-append` / `memory-query-capture` skills (#966).

```bash
aiwg memory <subcommand>
```

**Subcommands:** `path` / `list` / `get` / `put` / `delete` / `append-log`.

**Examples:**

```bash
aiwg memory path                                         # resolved root (fs only)
aiwg memory list --prefix research-complete/
aiwg memory get research-complete/index.md
echo "# index" | aiwg memory put research-complete/index.md
echo '{"op":"ingest","summary":"foo"}' \
  | aiwg memory append-log research-complete/.log.jsonl
```

**`append-log` semantics:** reads a single JSON object from stdin, appends as one JSONL line. Atomic via `adapter.append` (#976) on backends that support it.

---

### reflections

Storage operations on the reflections subsystem. Routes through `resolveStorage('reflections')`. Used by `ralph-reflect` and `reflection-injection` skills (#967).

```bash
aiwg reflections <subcommand>
```

Same surface as `aiwg memory`: `path` / `list` / `get` / `put` / `delete` / `append-log`.

```bash
aiwg reflections list --prefix sessions/
aiwg reflections get sessions/2026-04-28.md
echo '{"event":"reflect"}' | aiwg reflections append-log sessions/log.jsonl
```

---

### kb

Storage operations on the knowledge-base subsystem. Routes through `resolveStorage('kb')`. Used by `kb-ingest` and `kb-health` skills (#965).

```bash
aiwg kb <subcommand>
```

**Subcommands:** `path` / `list` / `get` / `put` / `delete`.

```bash
aiwg kb path                          # resolved root
aiwg kb path entities/foo.md          # absolute path to that file
aiwg kb list --prefix entities/
aiwg kb get entities/foo.md
echo "# foo" | aiwg kb put entities/foo.md
aiwg kb delete entities/old.md
```

**Note:** kb-ingest/kb-health skills' `--kb <path>` argument now defaults to whatever `aiwg kb path` resolves — `.aiwg/kb/` on the default `fs` backend, or whatever `roots.kb` / `backends.kb` redirects to.

---

### provenance

Storage operations on the provenance subsystem (W3C PROV records). Routes through `resolveStorage('provenance')`. Used by `provenance-create` / `provenance-query` / `provenance-report` / `provenance-validate` / `auto-provenance` skills (#968).

```bash
aiwg provenance <subcommand>
```

Same surface as `aiwg memory`.

```bash
aiwg provenance list --prefix activities/
aiwg provenance get activities/2026-04-28-deploy.json
```

---

### research-store

Storage operations on the research subsystem. Routes through `resolveStorage('research')`. Used by `research-acquire`, `induct-research`, `corpus-*` skills (#968). Named `research-store` (suffixed) to disambiguate from the many existing `research-*` workflow commands.

```bash
aiwg research-store <subcommand>
```

Same surface as `aiwg memory`.

```bash
aiwg research-store path                            # resolved corpus root
aiwg research-store list --prefix sources/
aiwg research-store get sources/paper-123.md
```

**Heavy artifacts on a secondary drive:** set `roots.research` in `.aiwg/storage.config` — one of the headline #934 use cases.

---

## Ops Commands

Manage AIWG ops ecosystem workspaces (sysops, devops, itops, streamops). See `agentic/code/frameworks/ops-complete/`.

### repo-access

Resolve members from the canonical `.aiwg/aiwg.config` `workspace` + `repos`
manifest and apply deny-by-default operation authorization. Legacy YAML
repo-access manifests remain a fallback.

```bash
aiwg repo-access list
aiwg repo-access status
aiwg repo-access explain --path <repo-or-file>
aiwg repo-access check --path <repo-or-file> \
  --action <read|write|commit|push|issue-comment|service-action|destructive>
```

`list` and `status` include the member config path, provider/domain, delivery
mode, tracker route, and drift. `check` exits `0` for allow, `1` for deny, and
`2` for invalid input/config.

### ops

```bash
aiwg ops <subcommand>
```

**Subcommands:**

| Subcommand               | Purpose                                                  |
| ------------------------ | -------------------------------------------------------- |
| `init`                   | Bootstrap a new ops workspace                            |
| `status [--all]`         | Show workspace health                                    |
| `use <workspace>`        | Switch active workspace                                  |
| `list` (alias `ls`)      | List registered workspaces                               |
| `push [--workspace <n>]` | Push workspace repos to remote                           |
| `discover [root...]`     | Scan filesystem for orphaned ops-workspace clones (#937) |
| `adopt <path>`           | Register an existing local clone as a repo entry (#936)  |

**`init` flags:**

| Flag                 | Description                                                     |
| -------------------- | --------------------------------------------------------------- |
| `--silent`           | Skip interactive prompts                                        |
| `--workspace <name>` | Workspace name (default: `default`)                             |
| `--home <path>`      | Parent directory for repos                                      |
| `--mode <mode>`      | `single-repo` or `multi-repo` (default: `multi-repo`)           |
| `--ext <list>`       | Comma-separated extensions: `sys,it,dev,stream,repo-maintainer` |
| `--prefix <name>`    | Repo naming prefix (e.g., `myorg`)                              |
| `--provider <name>`  | Remote provider for auto-push (`github`, `gitea`, or URL)       |
| `--from <git-url>`   | Clone the URL into the target repo instead of init (#936)       |

**Nesting refusal (#935):** `init` walks up from the target home looking for `OpsInventory.yaml`. If an ancestor has one, init refuses with a suggested sibling path — ops workspaces must be siblings, never nested.

**Examples:**

```bash
# Multi-repo workspace under ~/ops/personal/
aiwg ops init --workspace personal --ext sys,dev,it

# Clone an existing remote into the target instead of git init (#936)
aiwg ops init --workspace itops --ext it \
  --from https://git.integrolabs.net/me/itops.git

# Adopt an already-cloned repo (#936)
aiwg ops adopt ~/sysops --workspace home --ext sys

# Scan the filesystem for orphaned ops clones (#937)
aiwg ops discover ~                          # preview only
aiwg ops discover ~ --register --workspace home

# Standard lifecycle
aiwg ops status
aiwg ops list
aiwg ops use client-acme
aiwg ops push --workspace personal
```

When the ops workspace home contains a canonical workspace config, `ops push`
uses each member's configured primary remote/default branch and skips members
that do not allow `push`. The ops registry remains a specialization and
compatibility source, not a parallel authorization manifest.

**`adopt` flags:**

| Flag                 | Description                                            |
| -------------------- | ------------------------------------------------------ |
| `--workspace <name>` | Workspace bucket (default: `default`)                  |
| `--ext <list>`       | Comma-separated extensions to record on the repo entry |
| `--name <name>`      | Override repo name (default: basename of path)         |
| `--silent`           | Suppress informational logging                         |

**`discover` flags:**

| Flag                              | Description                                                     |
| --------------------------------- | --------------------------------------------------------------- |
| `--max-depth <n>`                 | Walk depth from each root (default: 3)                          |
| `--register` (alias `--yes`/`-y`) | Write NEW candidates to `ops.json`                              |
| `--workspace <name>`              | Bucket workspace for registered entries (default: `discovered`) |
| `--json`                          | Machine-readable output                                         |

---

## Code Analysis Commands

### cleanup-audit

Audit codebase for dead code, unused exports, orphaned files, and stale manifests.

```bash
aiwg cleanup-audit [--scope <path>] [--fix] [--verbose]
```

**Capabilities:** cli, analysis, code-quality, dead-code, cleanup
**Platforms:** All
**Tools:** Bash, Glob, Grep, Read, Write, Edit

**Actions:**

- Scans for unused exports, orphaned files, and dead code
- Detects stale manifest entries and broken references
- Reports findings with severity classification
- Optionally applies auto-fixes with `--fix`

---

## Configuration Commands

### config

Manage user-level AIWG configuration (preferences persisted across projects).

```bash
aiwg config <subcommand> [args] [--config-dir <path>]
```

**Subcommands:**

- `get <key>` - Read a configuration value
- `set <key> <value>` - Write a configuration value
- `list` - List all configuration keys and values
- `validate` - Check the config file against the schema
- `reset` - Restore defaults
- `path` - Print the resolved config file path
- `edit` - Open the config in `$EDITOR`

**Options:**

- `--config-dir <path>` - Override the config directory

**Capabilities:** cli, configuration, user-config, preferences
**Tools:** Read, Write, Bash

Resolution order: `$AIWG_CONFIG` env var → `--config-dir` flag → `~/.aiwg/` → `~/.config/aiwg/`.

---

## Agentic Tools (RLM)

Recursive Language Model utilities for processing content larger than a
single context window — chunk, fan out queries, and synthesize results.

### chunk

Split a file into overlapping chunks suitable for parallel fanout processing.

```bash
aiwg chunk <file> [--size N] [--overlap N] [--format json|text] [--output <dir>]
```

**Arguments:**

- `<file>` - Source file to split

**Options:**

- `--size N` - Target chunk size
- `--overlap N` - Overlap between adjacent chunks
- `--format json|text` - Output format
- `--output <dir>` - Destination directory for chunks and manifest

**Capabilities:** rlm, chunking, agentic-tools, context-decomposition
**Tools:** Read, Write, Bash

Writes chunk files plus a JSON manifest describing chunk locations and metadata.

---

### fanout

Dispatch the same query to multiple subagents in parallel across a chunk manifest.

```bash
aiwg fanout <query> --chunks <dir|manifest.json> [--parallel N] [--model haiku|sonnet|opus]
```

**Arguments:**

- `<query>` - Query to dispatch to each chunk

**Options:**

- `--chunks <dir|manifest.json>` - Chunk directory or manifest produced by `aiwg chunk` / `aiwg rlm-prep`
- `--parallel N` - Maximum concurrent subagents
- `--model haiku|sonnet|opus` - Model tier per subagent

**Capabilities:** rlm, fanout, agentic-tools, parallel-search
**Tools:** Read, Bash, Glob, Grep

---

### rlm-prep

Prepare source content for RLM processing — chunk, index, and write a manifest.

```bash
aiwg rlm-prep <file|dir> [--output <dir>]
                         [--strategy semantic-boundary|fixed-count|adaptive]
                         [--size N]
```

**Arguments:**

- `<file|dir>` - Source file or directory

**Options:**

- `--output <dir>` - Destination for chunks + manifest
- `--strategy <name>` - Chunking strategy (default `semantic-boundary`)
- `--size N` - Chunk size hint

**Capabilities:** rlm, prep, agentic-tools, indexing
**Tools:** Read, Write, Glob, Bash

---

### rlm-search

Full recursive search pipeline: prep, fanout, recurse, synthesize.

```bash
aiwg rlm-search <query> --source <file|dir>
                        [--depth N] [--parallel N|--max-parallel N] [--budget N]
```

**Arguments:**

- `<query>` - Search query

**Options:**

- `--source <file|dir>` - Source content to search
- `--depth N` - Maximum recursion depth
- `--parallel N` - Subagent concurrency cap
- `--max-parallel N` - Alias for `--parallel N`; accepted for skill/doc compatibility
- `--budget N` - Token or cost budget ceiling

**Capabilities:** rlm, search, agentic-tools, recursive, synthesis
**Tools:** Read, Write, Glob, Grep, Bash

Runs `rlm-prep` if needed, fans out across all chunks, recurses if results
exceed context, and produces a synthesized answer with provenance and cost
summary. Prep reuse is source-aware and coverage-checked before search:
single-chunk files are indexed, and incomplete or stale prep indexes are rebuilt
instead of silently dropping files from the search plan.

---

### rlm-status

Show active RLM task tree, progress per node, and cost breakdown.

```bash
aiwg rlm-status [--cost] [--tree] [--json] [--task-id <id>]
```

**Options:**

- `--cost` - Include cost breakdown
- `--tree` - Render the task tree
- `--json` - Emit structured JSON
- `--task-id <id>` - Inspect a specific task

**Capabilities:** rlm, status, agentic-tools, monitoring
**Tools:** Read, Bash

State source: `.aiwg/ralph/rlm-state.json`.

---

## Addon Commands

Commands contributed by installed addons. Available after running `aiwg use <addon>`.

### civic-action

The prompt-first user journey is in the
[Civic Action quickstart](../addons/civic-action/quickstart.md). Operators and
automation may preview and enable the same addon directly:

```bash
aiwg use civic-action --dry-run
aiwg use civic-action
```

After deployment, the addon contributes three deterministic validation gates:

```bash
aiwg civic source-gate <source-registry.json>
aiwg civic meeting-gate <vote-ledger.json> <meeting-reconciliation.json>
aiwg civic publish-gate <publication-packet.json>
```

Each gate writes a versioned JSON report to standard output. Exit `0` means no
blocking finding was detected in the declared fields, exit `1` means at least
one blocking finding, and exit `2` means invalid input or usage. A zero exit is
review evidence only; it does not authorize acquisition, recording, request
submission, contact, identification, correction release, or publication.

### composition

Validate and normalize provider-neutral Flow execution graphs from the
`composition-engine` addon:

~~~bash
aiwg use composition-engine
aiwg composition validate <manifest.yaml|json> [--format human|json] [--catalog <index.json>]
aiwg composition run <manifest.yaml|json> --adapter <module.mjs> [--format human|json]
aiwg composition benchmark <benchmark.json> [--format json|markdown] [--raw-out <file>] [--summary-out <file>]
~~~

The manifest uses `apiVersion: flow.aiwg.io/v1alpha1` and `kind: FlowGraph`.
The graph kind distinguishes the profile without a fourth-level DNS group.
Validation is strict: unknown fields, unresolved stable AIWG references,
incompatible schemas, unreachable nodes, duplicate IDs, unbounded cycles,
impossible joins, undeclared capabilities, permission widening, and unsafe
retry modes are errors.

`--format json` emits a stable `FlowGraphValidationReport`. A valid report
includes the provider-neutral normalized graph with graph, node, and edge
identities. `--catalog` additionally proves the manifest's authorized stable
IDs against a captured AIWG index export.

`composition run` validates the graph, loads an explicit provider/transport
adapter, and executes the bounded deterministic planner. The adapter must
export `invokeNode(request)` and may export `parallelDispatch` and
`evaluatePredicate`. Runtime options include:

- `--run-id <id>` — choose the stable execution identity.
- `--checkpoint <file.json>` — atomically persist checkpoint projections for
  the MissionConductor-owned ledger.
- `--resume <file.json>` — resume without re-invoking completed or receipted
  exactly-once work.

The runtime enforces phase and track order, typed reducers, all supported join
modes, independent resource ceilings, capability/permission narrowing,
retry-safe mutation keys, output gates, and trace redaction. Final-only output
does not stream intermediate drafts. Execution metadata contains no private
chain-of-thought.

`composition benchmark` compares fixed composition policies with a single-pass
baseline and emits requested-versus-realized resources, success-conditioned
efficiency, speed-of-accuracy curves, strict-LCM-versus-adaptive deltas,
independent-evaluator bias, ablations, and failure-injection outcomes. The
shipped manifest and evidence are labeled synthetic conformance and keep the
empirical quality/efficiency claim gate blocked.

## Extension System

### Unified Extension Schema

All commands are registered as extensions in the unified schema. This enables:

- **Dynamic discovery**: Commands found via semantic search
- **Capability-based routing**: Match commands by what they do
- **Safe help routing**: Registry overviews plus optional command-owned detail
  and a non-executing fallback
- **Platform awareness**: Deploy to correct platform paths

**Extension properties:**

- `id`: Unique identifier (kebab-case)
- `type`: Extension type (`command`, `agent`, `skill`, etc.)
- `name`: Human-readable name
- `description`: Brief description
- `capabilities`: What it can do
- `keywords`: Search terms
- `platforms`: Platform compatibility
- `metadata`: Type-specific data

**See also:**

- @src/extensions/types.ts - Full type definitions
- @.aiwg/architecture/unified-extension-schema.md - Schema documentation

---

## Command Categories

| Category                | Count | Commands                                                                                                                                                                                              |
| ----------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Maintenance**         | 13    | help, version, doctor, update, installation, refresh, regenerate, workspace-context, steward, cleanup-audit, features, diagnose, feedback                                                             |
| **Framework**           | 7     | use, list, remove, promote, install, packages, marketplace                                                                                                                                            |
| **Catalog**             | 3     | models, catalog, skills                                                                                                                                                                               |
| **Utility**             | 17    | cockpit, run, prefill-cards, contribute-start, validate-metadata, skill-lint, repo-access, lint, storage, activity-log, command-log, skill-usage, kb, memory, reflections, provenance, research-store |
| **Scaffolding**         | 9     | new-bundle, add-agent, add-command, add-skill, add-behavior, add-template, scaffold-addon, scaffold-extension, scaffold-framework                                                                     |
| **Project**             | 12    | quickref, new, init, setup, issue, issue-audit, address-issues, serve, local-executor, local-executor-serve, sandbox, session                                                                         |
| **Workspace**           | 4     | status, wizard, migrate-workspace, rollback-workspace                                                                                                                                                 |
| **MCP**                 | 1     | aiwg-mcp-server                                                                                                                                                                                       |
| **Toolsmith**           | 2     | runtime-info, agentcard                                                                                                                                                                               |
| **Plugin**              | 5     | install-plugin, uninstall-plugin, plugin-status, package-plugin, package-all-plugins                                                                                                                  |
| **Ralph**               | 8     | ralph, ralph-status, ralph-abort, ralph-resume, ralph-attach, agent-loop-ext, ralph-memory, ralph-config                                                                                              |
| **Orchestration**       | 2     | mc, team                                                                                                                                                                                              |
| **Metrics**             | 3     | cost-report, cost-history, metrics-tokens                                                                                                                                                             |
| **Documentation**       | 2     | doc-sync, doc-consolidate                                                                                                                                                                             |
| **SDLC Orchestration**  | 1     | sdlc-accelerate                                                                                                                                                                                       |
| **Research Validation** | 1     | best-practices-audit                                                                                                                                                                                  |
| **Index**               | 6     | index, artifacts, corpus, research-query, discover, show                                                                                                                                              |
| **Reproducibility**     | 4     | execution-mode, snapshot, checkpoint, reproducibility-validate                                                                                                                                        |
| **Daemon**              | 2     | behavior, daemon-init                                                                                                                                                                                 |
| **Configuration**       | 1     | config                                                                                                                                                                                                |
| **Operations**          | 1     | ops                                                                                                                                                                                                   |
| **Agentic Tools**       | 6     | chunk, fanout, rlm-prep, rlm-search, rlm-status, rlm-cache                                                                                                                                            |

**Total:** 109 registered command definitions. Run `aiwg help` for the current
runtime surface and subcommand details; addon commands require their addon to be
installed with `aiwg use <addon>`.

---

## Exit Codes

| Code | Meaning              |
| ---- | -------------------- |
| 0    | Success              |
| 1    | General error        |
| 2    | Invalid arguments    |
| 3    | Missing dependencies |
| 4    | Configuration error  |
| 5    | Network error        |
| 10   | Validation error     |
| 20   | File system error    |

---

## Environment Variables

| Variable              | Purpose                               | Default       |
| --------------------- | ------------------------------------- | ------------- |
| `AIWG_HOME`           | AIWG installation directory           | Auto-detected |
| `AIWG_CHANNEL`        | Update channel (stable/main)          | `stable`      |
| `AIWG_LOG_LEVEL`      | Logging level (debug/info/warn/error) | `info`        |
| `AIWG_USE_NEW_ROUTER` | Enable experimental router            | `false`       |
| `AIWG_LEGACY_MODE`    | Force legacy routing                  | `false`       |

---

## Configuration File

Optional `.aiwgrc.json` in project root:

```json
{
  "defaultProvider": "claude",
  "autoUpdate": false,
  "frameworks": {
    "sdlc": {
      "agents": "all",
      "commands": ["use", "status", "help"]
    }
  },
  "teamProfile": {
    "project": "My Project",
    "team": "Platform Team",
    "defaultAuthor": "Developer Name"
  },
  "ralph": {
    "pid": {
      "enabled": true,
      "gain_profile": "standard"
    },
    "semantic_memory": {
      "enabled": true,
      "max_entries": 1000
    },
    "oversight": {
      "enabled": true,
      "intervention_mode": "balanced",
      "validation_level": "standard"
    }
  }
}
```

---

## Common Workflows

### Initial Setup

```bash
# Install globally
npm install -g aiwg

# Check installation
aiwg doctor

# Create new project
aiwg new my-project
cd my-project
```

### Deploy to Existing Project

```bash
cd existing-project

# Deploy SDLC framework
aiwg use sdlc

# Check status
aiwg status

# Verify deployment
ls .claude/agents
ls .claude/commands
```

### Multi-Platform Deployment

```bash
# Claude Code (default — auto-detected)
aiwg use sdlc

# GitHub Copilot
aiwg use sdlc --provider copilot

# Cursor
aiwg use sdlc --provider cursor

# Devin Desktop (uses .windsurf/ compatibility paths)
aiwg use sdlc --provider devin

# Warp Terminal
aiwg use sdlc --provider warp

# Factory AI
aiwg use sdlc --provider factory

# OpenAI / Codex  (commands + skills deploy to ~/.codex/)
aiwg use sdlc --provider codex

# OpenCode
aiwg use sdlc --provider opencode

# Hermes (MCP sidecar — skills + lean AGENTS.md)
aiwg use sdlc --provider hermes

# OpenClaw (includes behaviors in ~/.openclaw/behaviors/)
aiwg use sdlc --provider openclaw

# Local / Ollama  (Claude Code paths, route coding tasks to local model)
aiwg use sdlc --provider local --coding-model ollama/qwen3.5:9b

# All platforms at once
aiwg use sdlc --provider all
```

### Framework Management

```bash
# List installed
aiwg list

# Remove framework
aiwg remove marketing

# Reinstall with force
aiwg use marketing --force
```

### Agent Loop Task Execution (Epic #26)

```bash
# Basic task
aiwg ralph "Fix failing tests" --completion "npm test passes"

# Security-critical with strict controls
aiwg ralph "Fix SQL injection" \
  --completion "security scan passes" \
  --gain-profile conservative \
  --validation-level strict \
  --intervention-mode strict

# Fast doc generation with minimal oversight
aiwg ralph "Update API docs" \
  --completion "docs/ updated" \
  --gain-profile aggressive \
  --disable-overseer

# Leverage past learnings
aiwg ralph "Optimize database queries" \
  --completion "benchmarks pass" \
  --enable-semantic-memory

# Check status mid-run
aiwg ralph-status

# Apply preset for common scenarios
aiwg ralph-config preset conservative
aiwg ralph "Migrate database" --completion "migration complete"
```

---

## Troubleshooting

### Command Not Found

```bash
# Check if installed globally
npm list -g aiwg

# Reinstall if missing
npm install -g aiwg

# Check PATH
echo $PATH
```

### Permission Errors

```bash
# Fix npm permissions (Linux/Mac)
mkdir ~/.npm-global
npm config set prefix '~/.npm-global'
echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.bashrc
source ~/.bashrc

# Reinstall
npm install -g aiwg
```

### Deployment Failures

```bash
# Run doctor
aiwg doctor

# Force reinstall
aiwg use sdlc --force

# Check logs
cat .aiwg/logs/deployment.log
```

### MCP Issues

```bash
# Verify MCP server
aiwg mcp info

# Reinstall config
aiwg mcp install claude --force

# Test manually
aiwg mcp serve
```

### Agent Loop Issues (Epic #26)

```bash
# Check current status
aiwg ralph-status

# View configuration
aiwg ralph-config show

# Reset to defaults
aiwg ralph-config reset

# Inspect semantic memory
aiwg ralph-memory list

# Export state for debugging
aiwg ralph-memory export debug-memory.json

# Try different gain profile
aiwg ralph-config set pid.gain_profile conservative
aiwg ralph-resume
```

---

## Support

- **Documentation**: [https://aiwg.io/docs](https://aiwg.io/docs)
- **GitHub Issues**: [https://github.com/jmagly/aiwg/issues](https://github.com/jmagly/aiwg/issues)
- **Discord**: [https://discord.gg/BuAusFMxdA](https://discord.gg/BuAusFMxdA)
- **Telegram**: [https://t.me/+oJg9w2lE6A5lOGFh](https://t.me/+oJg9w2lE6A5lOGFh)

---

## References

- @src/extensions/commands/definitions.ts - All command definitions
- @src/extensions/types.ts - Extension type system
- @.aiwg/architecture/unified-extension-schema.md - Extension schema
- @.aiwg/architecture/unified-extension-system-implementation-plan.md - Implementation details
- @.aiwg/planning/epic-26-ralph-control-improvements.md - Epic #26 specification
- @tools/ralph-external/ - Al external implementation
- @.aiwg/ralph/ - agent loop state and memory storage
- @CLAUDE.md - Project-level CLI integration
- @README.md - Quick start guide
