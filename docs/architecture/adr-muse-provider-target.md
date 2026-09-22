# ADR: First-class Muse Code (`muse`) provider target

**Status:** Proposed (PR0 for #224; accepted on merge)  
**Date:** 2026-09-22  
**Parent:** [#223](https://github.com/jmagly/aiwg/issues/223)  
**This issue:** [#224](https://github.com/jmagly/aiwg/issues/224)  
**Children:** #225–#231 (registries, writer, context bridge, sessions, hooks/MCP, status/doctor/docs, Ralph adapter,
stable promotion)  
**Related:** #222 (sessions export-first), #232–#238 (session catalog, schemas, allowlists, smoke harness)

## Context

**Muse Code** is Meta's terminal/CI coding agent built on Muse Spark. It is a high-leverage AIWG peer: native `AGENTS.md`
context, an Agents-skills layout (`.agents/skills`), user skills under `$XDG_CONFIG_HOME/muse/skills`, project hooks at
`.muse/hooks.json`, MCP configuration in operator settings, subagents/workflows, headless `muse exec`, and first-class
session export (`muse export` / trajectory JSON).

Operators currently have no first-class AIWG provider for Muse Code. Overloading `--provider cursor` (or any other IDE
provider) as the adapter would deploy into paths Muse does not load and surface foreign reload guidance — the same
anti-pattern resolved for Grok Bot in [`adr-grokbot-provider-target.md`](./adr-grokbot-provider-target.md). AIWG needs a
first-class provider identity with locked artifact destinations before any native writer lands, so child implementers can
resolve paths without inventing homes.

Closest reuse: **Hermes** (discover-first + `AGENTS.md` + home skills) and **OpenHuman** (personal multi-agent).
Claude/Codex skill-import compatibility is a bonus (`muse skills import --from claude|codex`).

## Decision

### Identity

| Field | Value |
|---|---|
| Canonical ID | `muse` |
| Display name | Muse Code |
| Aliases | **none** (no `muse-spark`, no bare `spark`, no `meta`) |
| Initial status | `experimental` |

`muse` does not collide with any music-product surface; no qualified alternative is needed. `muse-spark` is deliberately
**not** a provider id: Muse Spark names the underlying model family, not the operator-facing coding-agent surface this
provider deploys into. Bare `spark` and `meta` are likewise rejected as ambiguous (model family / vendor, respectively).
`AIWG_PROVIDER=muse` always means Muse Code, the terminal/CI coding agent.

### Scope semantics

1. **Project (default):** maintain canonical project context plus a discover-first `AGENTS.md` bridge (see Context below).
   Do **not** invent a project `.muse/skills/` tree or write foreign provider paths.
2. **`--scope user`:** additive project + user mirror. User skill writes target the resolved XDG user root (see Skill roots).
3. **`--global`:** existing AIWG no-project-deploy bootstrap (stage → user deploy → lightweight project context).
   **Not** identical to `--scope user`.

### Skill roots

| Scope | Root |
|---|---|
| Project | `<repo>/.agents/skills` |
| User | `$XDG_CONFIG_HOME/muse/skills` (default XDG resolution: `~/.config/muse/skills` when `XDG_CONFIG_HOME` is unset) |

The user root resolves at deploy time: honor a set, absolute `XDG_CONFIG_HOME`; otherwise fall back to `~/.config`.
A `~/.agents/skills` mirror is permitted only as an explicitly documented, operator-opt-in policy — never as a silent
default and never as a second source of truth alongside the XDG root. Until the mirror policy is documented (PR2/#226),
deployers must not write outside the two roots above.

### Fail-closed path policy

Muse Code's user skill root above is the only sanctioned user home for this provider. Until further product evidence:

- Do **not** default to `~/.muse`, `~/.config/muse` siblings outside `muse/skills`, or any other provider's paths.
- Overrides must be absolute (leading `~/` is expanded; bare `~` and relative paths are rejected).
- The Agent Skills deployer must resolve the Muse XDG root rather than invent homes (#234).

### Context: discover-first `AGENTS.md`

Muse Code natively prefers `AGENTS.md` over `CLAUDE.md` at each directory level. The provider therefore ships a
discover-first `AGENTS.md` bridge as its primary context surface — no `CLAUDE.md` shim, no foreign-provider context file.
Bridge text instructs agents to run `aiwg discover "<intent>"` then `aiwg show <type> <name>` before improvising, and
stores artifact **references/summaries** in context — never full bodies. Full bridge content and regeneration land in
PR3/#227; this ADR locks only the surface choice (`AGENTS.md`, discover-first).

### Sessions: export-first

Session catalog support is **export-first** until a native log root is evidenced on disk (#222):

- The adapter ingests only explicit `muse export` / `/export trajectory` JSON documents supplied by the operator.
- Auto-discovery must not scrape unauthorized homes; no `~/.muse` (or similar) root is assumed without product evidence.
- A future evidence-gated `--muse-root` discover path (analogous to `--codex-root`) remains the route to native discovery.

Session adapter implementation itself is out of scope here (Phase 4 / #222, catalog track #232).

### Hooks and MCP ownership

- AIWG may emit **managed project hooks** (`.muse/hooks.json` entries) and **optional MCP settings snippets**, using the
  same managed markers / sidecars as peer providers so only recorded AIWG entries are ever removed.
- AIWG must **never overwrite operator `settings.json` blindly**: user settings merges are additive, preserve unknown
  keys, and back up or diff before writing. Unmanaged hooks are never silently installed — hooks execute outside Muse's
  sandbox, so every managed hook ships with a stated reason and a removal path.
- Full writer profiles land in PR5/#228; this ADR locks only the ownership boundary.

### Headless Ralph

A headless Ralph/loop adapter over `muse exec` is **optional and post-experimental** (PR7/#230). It does not block the
experimental cut (#225–#229) or stable promotion (#231), and no `muse exec` contract may be assumed until evidenced
against the installed CLI surface.

### Explicit exclusions

Out of provider scope, now and for all child issues unless a new ADR re-opens them:

- Muse Glimmer, Muse Image, Muse Voice, and any raw Meta model-API surface — this provider is the Muse Code coding
  agent only.
- Inventing undocumented session filesystem roots (covered by Sessions above).
- Silent install of unmanaged hooks (covered by Ownership above).

## Consequences

- Dual registries (provider definitions + deploy agents) plus the capability matrix gain a `muse` row at `experimental`
  without inventing filesystem facts (#225).
- Doctor, setup choices, install-connect-verify, model catalog / provider-policy schema, and wizard/discovery allowlists
  gain Muse Code entries against the locked roots (#229, #233–#236, #238).
- Operators stop overloading `--provider cursor` for Muse fleets; Cursor IDE fleets stay on `cursor`.
- Child implementers (#226–#230) resolve every destination path from this ADR's tables; deviations require an ADR amendment.

## Out of scope

Code deploy of any kind; session adapter implementation (Phase 4 / #222, catalog track #232); registry/matrix flips (#225).

## References

- Peers: Hermes (discover-first + `AGENTS.md` + home skills), OpenHuman (personal multi-agent), Agent Skills portability
  contract ([`adr-agent-skills-portability-contract.md`](./adr-agent-skills-portability-contract.md)).
- Anti-pattern: Cursor path overload (foreign `.cursor/` deploy + reload copy).
- Product docs: [Muse Code](https://dev.meta.ai/docs/muse-code/),
  [configuration](https://dev.meta.ai/docs/muse-code/configuration),
  [extending](https://dev.meta.ai/docs/muse-code/extending/),
  [audit agent sessions](https://dev.meta.ai/docs/cookbook/audit-agent-sessions).
- Plan artifact: `muse-aiwg-integration-plan.md` (operator policy planning copy, linked from #223).
