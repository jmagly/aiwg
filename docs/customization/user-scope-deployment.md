# User-Scope Deployment

`aiwg use` deploys frameworks to your project tree by default
(`.claude/`, `.codex/`, `.factory/`, etc.). With `--scope user`, AIWG also
mirrors the deploy to the platform's user-scope directory under your
home folder, so the framework is available across every project on the
machine without re-running `aiwg use` per project.

This is most useful when:

- You're the sole user of a workstation and want a framework available
  globally
- A platform's discovery model favors user-scope (Claude Code reads
  `~/.claude/skills/` from every project automatically)
- You manage a small fleet of repos and don't want a `.claude/` deploy
  in each one

If you're working in a team repo where everyone needs the same
deployment regardless of personal setup, stick with the default
project-scope deploy and commit `.aiwg/` (or whichever provider dirs
your team uses).

## Quick Start

```bash
# Deploy SDLC to ~/.claude/{agents,commands,skills,rules}/ alongside
# the project deploy
aiwg use sdlc --provider claude --scope user

# --user is a shorthand for --scope user
aiwg use sdlc --provider claude --user

# List user-scope deployments (works from any cwd)
aiwg list --scope user

# Validate user-scope registry against actual disk state
aiwg doctor --scope user
aiwg doctor --user --verbose       # surface every missing path

# Revert the user-scope mirror (registry + recorded artifact files)
aiwg remove sdlc --scope user
aiwg remove sdlc --user --provider claude --dry-run
```

## Global Bootstrap Without Project Artifacts

Use `--global` when the provider supports native user-level discovery and you
do not want each project to carry its own deployed agents, commands, skills,
and rules:

```bash
cd /path/to/project
aiwg use sdlc --provider claude --global
```

AIWG stages the normal deployment temporarily, mirrors framework and kernel
skills into the provider's user-level paths, records them in
`~/.aiwg/installed.json`, and removes the stage. The current project receives
only the lightweight context graph and provider bootstrap files, such as
`WORKSPACE.md`, `AIWG.md`, `CLAUDE.md`, or `AGENTS.md`. It does not retain a
project `.claude/`, `.codex/`, or equivalent artifact deployment.

Run `aiwg regenerate --provider <name>` in another project to generate or
refresh those context-only hooks against the existing user-level installation.
Providers without a verified filesystem-based user loader still require their
documented project adapter; `--global` does not make an unsupported global
loader appear.

`--scope user` remains the additive compatibility mode described below: it
keeps the project deployment and mirrors it to user scope. `--global` is the
explicit no-project-artifact contract.

## Supported Providers

| Provider | User-scope path | Status |
|----------|-----------------|--------|
| Claude Code | `~/.claude/{agents,commands,skills,rules}/` | **Verified** ([docs](https://code.claude.com/docs/en/skills)) |
| OpenClaw | `~/.openclaw/{agents,commands,skills,rules,behaviors}/` | Always user-scope (no `--scope project`) |
| OpenHuman | `~/.openhuman/skills/` for kernel skills; `~/.openhuman/.aiwg/rules/` for rule bodies; optional native agents in `~/.openhuman/agents/`; project `AGENTS.md` bridge | **Verified** against OpenHuman induction ADR; home-dir payload plus project context bridge |
| Grok Bot | Absolute `AIWG_GROKBOT_SKILLS_DIR` only (never invents `~/grokbot-skills` / `~/.grokbot`) | **Fail-closed** until env set ([ADR](../architecture/adr-grokbot-provider-target.md)) |
| Hermes | `~/.hermes/skills/` | Always user-scope (skills only) |
| Codex | `~/.agents/skills/` (skills); `~/.codex/prompts/` (commands; deploy-for-visibility, not auto-scanned) | **Verified** ([`codex-rs/core-skills/src/loader.rs`](https://github.com/openai/codex)) |
| Cursor | `~/.cursor/{agents,skills,commands,rules}/` (harmless mirror; not auto-scanned) | **Non-applicable** — Cursor's "User Rules" feature is in-app settings, not filesystem-discovered; only project-scope `.cursor/rules/*.mdc` is confirmed. See [#1159](https://git.integrolabs.net/roctinam/aiwg/issues/1159) |
| OpenCode | `~/.config/opencode/{agents,commands}/`; skills at `~/.agents/skills/` (cross-provider canonical) | **Verified** ([opencode.ai/docs/skills](https://opencode.ai/docs/skills/), [opencode.ai/docs/rules](https://opencode.ai/docs/rules/)) — user-scope root is `~/.config/opencode/`, NOT `~/.opencode/` |
| Factory AI | `~/.factory/{droids,skills,commands}/` | **Verified** ([docs.factory.ai/cli/configuration/skills](https://docs.factory.ai/cli/configuration/skills)) for skills; droids/commands paths follow project-scope convention |
| Copilot | `~/.config/github-copilot/{agents,prompts,instructions}/` (harmless mirror; not auto-scanned) | **Non-applicable** — VS Code Copilot's user-scope customization is `settings.json` + Settings Sync, not filesystem discovery. See [#1160](https://git.integrolabs.net/roctinam/aiwg/issues/1160) |
| Warp | `~/.warp/{agents,commands,rules}/` (harmless mirror; not auto-scanned) | **Non-applicable** — Warp's user-scope mechanism is Warp Drive (cloud-synced), not filesystem discovery. WARP.md aggregation is the project-scope path. See [#1162](https://git.integrolabs.net/roctinam/aiwg/issues/1162) |
| Windsurf | `~/.windsurf/{agents,skills,workflows,rules}/` (harmless mirror; not auto-scanned) | **Non-applicable** — Windsurf's user-scope mechanism is Cascade Memories (in-app, agent-managed) + global rules in the settings UI, not filesystem discovery. See [#1163](https://git.integrolabs.net/roctinam/aiwg/issues/1163) |
| Muse Code | `$XDG_CONFIG_HOME/muse/skills` (default `~/.config/muse/skills`); never `~/.muse`, never `~/.agents/skills` | **Verified** ([Muse Code docs](https://dev.meta.ai/docs/muse-code/)) — resolves at deploy time, fail-closed on bad `XDG_CONFIG_HOME` ([ADR](../architecture/adr-muse-provider-target.md)) |

`aiwg use ... --scope user --provider <unknown>` errors fast rather
than silently falling back to project scope.

### Codex specifics

Codex's user-scope skills land at `~/.agents/skills/` — that's the
cross-provider canonical path the codex-rs loader actually scans. Codex
commands deploy at `~/.codex/prompts/` for operator visibility, but
codex-rs ships a static built-in command enum so this directory is **not
auto-scanned** by the runtime. The directory exists per AIWG's ADR-1
"always deploy" invariant: operators can see what AIWG would have
shipped, and AGENTS.md acts as the discovery bridge for the actual
commands. Same applies at project scope (`.codex/prompts/`).

## How It Works

A `--scope user` deploy is **additive**: it doesn't replace the project
deploy, it copies alongside it.

1. `aiwg use sdlc --provider claude --scope user` runs the normal
   project-scope deploy first (writing to `.claude/`)
2. Then it mirrors each artifact directory (agents, commands, skills,
   rules, behaviors) to the corresponding user-scope path
3. The mirror records exactly which entries it copied, per artifact
   type, so `aiwg remove` can later delete only this framework's
   contributions to the shared user-scope dirs
4. The deploy is recorded in a per-user registry at
   `~/.aiwg/installed.json` so `aiwg list` and `aiwg doctor` can find
   it from any cwd

## The Per-User Registry

`~/.aiwg/installed.json` holds one entry per framework deployed at
user scope:

```json
{
  "version": "1",
  "installed": {
    "sdlc": {
      "version": "2026.5.0",
      "source": "bundled",
      "installedAt": "2026-05-08T02:33:00.000Z",
      "deployedTo": {
        "claude": {
          "agents": 189,
          "commands": 0,
          "skills": 386,
          "rules": 14,
          "entries": {
            "agents": ["api-designer", "test-engineer", "..."],
            "skills": ["sdlc-accelerate", "intake-wizard", "..."]
          }
        }
      }
    }
  }
}
```

The `entries` snapshot is what enables precise `aiwg remove --scope
user`: the handler reads this list and deletes exactly those entries
from the user-scope dirs, leaving every other framework's artifacts
in place.

Older registry entries (written before the `entries` snapshot was
recorded) fall back to a conservative "registry-only revert" with a
manual cleanup hint. Re-running `aiwg use` upgrades the entry.

## Coexistence with Project Scope

Both scopes can be installed simultaneously. The project deploy in
`.claude/` shadows the user deploy in `~/.claude/` for any project
that contains the project artifacts (mirroring how Claude Code itself
resolves: project takes precedence over user). See
[`scope-precedence.md`](./scope-precedence.md) for the resolution
rules.

This means you can:

- Pin a specific framework version at user scope as your default
- Override per-project with a different version or with custom
  project-local bundles

## Removing a User-Scope Deploy

```bash
# Revert all providers' user-scope mirrors of sdlc
aiwg remove sdlc --scope user

# Revert just one provider
aiwg remove sdlc --user --provider claude

# Preview without touching disk
aiwg remove sdlc --user --provider claude --dry-run
```

The remove handler:

1. Looks up the framework's entry in `~/.aiwg/installed.json`
2. For each provider's deploy, walks the recorded `entries` list
3. Deletes each entry from its corresponding user-scope dir
4. Updates the registry

Other frameworks' artifacts in the same user-scope dirs are untouched.

## Validation with Doctor

```bash
aiwg doctor --scope user            # summary — exit 1 on drift
aiwg doctor --user --verbose        # list every missing path
```

`aiwg doctor --scope user` walks the per-user registry, calls `stat`
on each recorded entry path, and reports drift. Drift means a
recorded entry doesn't exist on disk anymore — usually because
something was deleted manually. Repair by re-running `aiwg use` or
clear the stale registry entry with `aiwg remove --scope user`.

## OpenClaw, OpenHuman, and Hermes

OpenClaw is exclusively user-scope by design — its native discovery
model only reads from `~/.openclaw/`. So:

- `aiwg use ... --provider openclaw` is implicitly user-scope (no
  flag needed)
- `aiwg use ... --provider openclaw --scope user` is a no-op
- `aiwg use ... --provider openclaw --scope project` errors with a
  clear message: there is no project-scope OpenClaw deploy to track

OpenHuman is also home-dir-oriented for skills. `aiwg use ... --provider
openhuman --scope user` records the OpenHuman home-rooted payload in the
user registry so `aiwg list --scope user`, `aiwg doctor --scope user`, and
`aiwg remove --scope user --provider openhuman` can reason about it from
any cwd. The default deploy does not copy markdown personas. It writes a
project-root `AGENTS.md` bridge for commands and indexed rules; optional curated
native harness agents are TOML files under `~/.openhuman/agents/`.

Hermes is similar (skills-only at user scope by design).

## Test Isolation

If you're writing tests that exercise user-scope behavior and don't
want them to clobber your real `~/.aiwg/installed.json`, set
`AIWG_USER_REGISTRY_PATH` to a tmpdir path. The registry helper
honors this env override and reads/writes there instead.

```bash
export AIWG_USER_REGISTRY_PATH=/tmp/aiwg-test-reg/installed.json
```

Production code never sets this — it exists for the test suite.

## Related

- [`scope-precedence.md`](./scope-precedence.md) — How project-scope
  and user-scope deploys resolve when both are installed
- [`README.md`](./README.md) — Customization paths overview
- [`from-fork-to-project-local.md`](./from-fork-to-project-local.md)
  — Project-local bundle workflow

## See Also

- AIWG #1156 — User-scope deployment for providers that support
  ~/-level discovery
- ADR-4 — Scope flag and path map
