# Agentic Install Runbook

## Canonical agentic installer

This is the fastest supported route from an AI conversation to a verified AIWG
project. The user pastes one prompt; the provider inspects, plans, asks only for
decisions it cannot safely infer, installs or repairs AIWG, then runs the guided
interview → review → apply sequence and reports readiness.

For a new, outdated, broken, duplicate, or development-mode installation, use
the public [`SetupManifest`](../setup.aiwg.yaml). A user can paste:

```text
Install or repair AIWG for this project by following
https://aiwg.io/setup.aiwg.yaml
Explain the plan before changing anything, preserve my existing work, and ask
me only for choices you cannot safely determine.
```

The manifest is the canonical flow. It requires inspection before mutation,
explicit approval for repairs and mode switches, preservation of source
checkouts, a saved interview plan, read-only review, explicit apply, and
evidence-based verification. Guided apply selects a framework from usage intent:
`code`/`mixed` selects SDLC, `docs` selects writing, and `ops` selects ops. Use the manual notes below when the manifest
cannot be retrieved.

The public manifest declares `metadata.execution_mode: provider-orchestrated`.
Give it to a supported AI provider; do not run it with `aiwg setup-run`.
`setup-run` is the deterministic runner for script-first application manifests.
This distinction is intentional: AIWG installation repair must reason about
existing checkouts, duplicate binaries, provider state, and user-authored files.

### Which path applies?

| Scenario | Route |
|---|---|
| New project, existing project, stale/broken install, or development checkout | Paste the canonical prompt into the provider |
| Multiple providers in one project | Use the prompt and have the installer deploy and verify each provider separately |
| CI, cloud-init, container image, SSH-only, or other headless provisioning | Use [Non-Interactive Installation](/install/non-interactive) |
| Offline or restricted registry/proxy environment | Use an approved package/cache source, then follow the manual verification sequence below |
| Provider cannot retrieve the URL | Paste the manifest contents or use the manual fallback |
| Provider cannot execute local tools | Use the manual fallback, then ask the provider only to verify engagement |
| Read-only workspace or insufficient permissions/disk | Resolve the environment constraint before deployment; do not force partial setup |

Use this runbook when an agent or steward needs to take a machine or project
from zero to a working AIWG session. The human-facing path is short: install
AIWG, deploy the right artifacts, open the chosen agentic platform, and ask the
steward to verify setup. Most AIWG CLI commands are tools for the agent to call
inside the session, not commands the user has to learn.

## Choose The Setup Scope

Use **project-local setup** for a repository, product, investigation, campaign,
or research corpus. This is the default and keeps project context with its repository.

Use **global/user-scope setup** when the user wants the same AIWG agent surface
available across many workspaces. This is useful for personal defaults and for
providers whose primary artifact location is under the user's home directory,
but it can make unrelated projects share more context than expected.

For a single project, project-local setup is the simplest start.

For multi-repository work, see [Working Across Multiple Projects](guides/multi-project-workspaces.md).

## Prerequisites

AIWG requires Node.js 24 or newer. Node 24 is the standard runtime. Reuse a healthy version manager already present; do not stack managers.
When none is installed, prefer `nvm-sh` on macOS, Linux, and WSL, or
`nvm-windows` on native Windows.

```bash
node --version
npm --version
```

If Node or npm is missing, install them before continuing. On macOS, use the
[macOS Install Guide](getting-started/macos-install.md) when npm global installs
fail with `EACCES`.

## Install AIWG

Install AIWG once for the user:

```bash
npm install -g aiwg
aiwg --version
```

If `aiwg` is not on `PATH`, use npm's global prefix to find the binary:

```bash
npm config get prefix
"$(npm config get prefix)/bin/aiwg" --version
```

In automation or fresh shells where PATH may be unreliable, use `npx` with an
explicit package name and version policy approved for that environment:

```bash
npx aiwg --version
```

## Guided project setup

Run the interview from the intended project root. Select one provider or a
comma-separated list:

```bash
cd /path/to/project
aiwg setup --scope project --providers claude,codex
aiwg setup --review
aiwg setup --apply
```

The interview collects targets, intent, toolchains, credential references, and
optional capabilities. It saves the plan beneath the configured artifact root
without writing provider configuration. `--review` is read-only; a bare
`--dry-run` also reviews an existing saved plan. Apply confirms before mutation
and delegates to existing owners for configuration, framework deployment,
registration, Jev setup, and direct-worker qualification. Do not append
standalone maintenance commands to a successful setup.

For CI or SSH provisioning, bootstrap Node and the CLI using the non-interactive
installation guide, then use answer flags with `--non-interactive`. Headless
apply requires `--yes`. Missing required choices fail with the needed flag;
headless runs never prompt. See the [guided setup reference](getting-started/guided-setup.md)
for runnable examples, scope and monorepo choices, credentials, and recovery.

Jev and direct workers require explicit opt-in. Installed CLIs are distinct
from authenticated and qualified workers. Credential input is resolved only at
apply, and plans store references rather than secret values. Report core
readiness and optional failures separately from `aiwg.setup.apply.v1`.

A second successful apply makes no writes. After a failure or interruption,
review and apply again to resume failed, skipped, or unreceipted actions. An
interactive cancellation leaves the last saved plan intact. If environment
facts become stale, rerun the interview/discovery before applying. Saved
receipts cannot provide a transaction across an external side effect and the
following receipt write; review the affected owner after a crash in that gap.

For a direct complete-system deployment when no guided plan is needed, use
`aiwg use all --provider <provider>`. The older `aiwg wizard` remains a separate
goal-based deployment assistant.

## Global Or User-Scope Setup

In guided setup, `--scope user` records user-level provider deployment rather
than installing the CLI globally. It still writes project policy and registry
state through their existing owners. Review project/user conflicts before
applying; guided user scope does not mean `aiwg use --global`.


Use `--global` when the user wants provider-native AIWG assets across many
workspaces without a full deployment in every project:

```bash
cd /path/to/current/project
aiwg use all --provider claude --global
```

This installs framework and base kernel assets at user scope, then writes only
the lightweight `WORKSPACE.md`/`AIWG.md`/provider bootstrap files in the
current project. In additional projects, run
`aiwg regenerate --provider <name>` to create those context-only hooks.

The same applies when the current directory is `$HOME`: a second project-scope
`aiwg use all` in the home folder is **not required**. `aiwg status --probe --json`
uses the user registry when no project deployments are recorded, and verifies
the user assets and current directory's context hooks. An explicit
`--scope project` inspects only project deployments; `--scope user` inspects only
user deployments. In a new directory without context hooks, the probe directs
you to `aiwg regenerate --provider <name>`.

Use `--scope user` instead when an additive project deployment is intentional:

```bash
aiwg use all --provider claude --scope user
```

Consult the provider matrix before using `--global`; providers without a
filesystem-discovered user scope still need their documented project adapter.

For non-interactive provisioning, target a project directory explicitly:

```bash
npx aiwg use all --provider claude --prefix /path/to/project
npx aiwg doctor --prefix /path/to/project
```

Use the non-interactive guide for cloud-init, Docker, and CI examples:
[Non-Interactive Installation](/install/non-interactive).

## Provider Handoff

After deployment, open the chosen agentic platform in the project or workspace
that was just configured. Then ask:

```text
Check that AIWG is installed correctly and tell me what I can do here.
Read aiwg status --probe, report the engaged state, project root, provider
files, deployed frameworks, and one recommended next action.
```

Provider notes:

| Provider | Open after deploy | First check |
|---|---|---|
| Claude Code | Continue in the project; restart only if verification finds cached context | Ask the steward to verify AIWG status |
| Codex | Continue in the project; restart only if verification finds cached context | Ask for AIWG status and one next action |
| Cursor | Open the project in Cursor | Ask Cursor to verify AIWG is active |
| Copilot | Open the VS Code workspace | Ask Copilot Chat for AIWG status |
| Factory | Start Factory from the project root | Ask for the AIWG first action |
| OpenCode | Open OpenCode in the project root | Ask for one AIWG route |
| Warp | Start Warp in the project root | Ask the session to route through AIWG |
| Devin Desktop | Open the project in Devin Desktop | Ask Devin to verify AIWG status |
| Hermes | Open a Hermes chat attached to the project | Ask for the AIWG route |
| OpenClaw | Open OpenClaw with the workspace | Ask for one AIWG capability and verify deployment |

Use `aiwg-regenerate` from inside the session when provider context files need
to be rebuilt. Use `aiwg doctor` as the direct diagnostic escape hatch.

## Verification

For guided setup, inspect the `aiwg.setup.apply.v1` report: classification,
per-action status, and core versus optional failures. A successful deployment
action includes verification from the deployment owner. For direct `aiwg use`,
the first-run proof is `aiwg.use.result.v1`; inspect its resolved project,
provider, scope, phases, findings, final state, and restart requirement.

For an independent later audit, the local proof command remains:

```bash
aiwg status --probe --json
```

For troubleshooting, the broader health check remains:

```bash
aiwg doctor
```

Do not make either command an additional ordinary install step. Most provider
sessions can continue without restarting after `aiwg use`; request a restart or
reload only when its result or a later probe shows the current session cannot
read or discover the newly deployed files.

Common health-check outcomes:

| Symptom | What to do |
|---|---|
| `aiwg` not found | Add npm's global `bin` directory to PATH or use `npx aiwg` |
| No provider artifacts | Run `aiwg use all --provider <provider>` from the project root |
| Wrong project root | `cd` to the intended repository and rerun the setup |
| Stale provider session | Restart or reload the agentic platform |
| Generated context is stale | Ask the session to run `aiwg-regenerate` |
| Doctor reports repairable drift | Ask the steward to explain the failing check and propose the smallest fix |

## What Not To Teach As The Default

Do not make normal users memorize capability-search, asset-loading, agent-loop,
or framework-specific commands as the post-install path. Those implementation
surfaces remain available to agents and automation, but the expected onboarding
flow is platform-first and steward-first.

## Related Guides

- [Start Here](getting-started/start-here.md)
- [Provider Handoff](getting-started/provider-handoff.md)
- [Verify AIWG Is Working](getting-started/verify-aiwg-is-working.md)
- [macOS Install Guide](getting-started/macos-install.md)
- [Non-Interactive Installation](/install/non-interactive)
