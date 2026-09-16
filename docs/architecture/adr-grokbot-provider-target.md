# ADR: First-class Grok Bot (`grokbot`) provider target

**Status:** Accepted (experimental implementation)  
**Date:** 2026-09-15  
**Parent:** [#196](https://github.com/jmagly/aiwg/issues/196)  
**Children:** #203–#210  

## Context

Operators running **Grok Bot** (multi-agent desktop assistant) previously used
`--provider cursor` as a workaround. That deploys into `.cursor/` paths Grok Bot
does not auto-load and surfaces Cursor-specific reload guidance. AIWG needs a
first-class provider identity that is neither Cursor IDE nor xAI’s Grok Build /
API surface.

## Decision

### Identity

| Field | Value |
|---|---|
| Canonical ID | `grokbot` |
| Display name | Grok Bot |
| Aliases | **none** (no bare `grok`, no `xai`, no `grok-build`) |
| Initial status | `experimental` |

Bare `grok` is deliberately **not** an alias: it collides with the xAI model/API
family and would make `AIWG_PROVIDER=grok` ambiguous. A future xAI Grok Build
adapter, if ever added, must use a separately reviewed ID (likely `grok-build`).

### Scope semantics

1. **Project (default):** maintain canonical `WORKSPACE.md` + `.aiwg/AIWG.md`
   and a discover-first `AGENTS.md` bridge. Do **not** invent a project
   `.grokbot/` tree or write `.cursor/**`.
2. **`--scope user`:** additive project + user mirror (ADR-4). User skill
   writes are allowed **only** when `AIWG_GROKBOT_SKILLS_DIR` points at a
   verified absolute skill root.
3. **`--global`:** existing AIWG no-project-deploy bootstrap (stage → user
   deploy → lightweight project context). **Not** identical to `--scope user`.

### Fail-closed path policy

Grok Bot’s native skill/profile/memory filesystem paths are **not verified**
in this repository. Until product evidence documents them:

- Do **not** default to `~/.grokbot`, `~/.config/grokbot`, or any Cursor path.
- User-scope / global skill deployment **blocks** with remediation that asks
  the operator to set `AIWG_GROKBOT_SKILLS_DIR` to an absolute path.
- Overrides must be absolute (leading `~/` is expanded; bare `~` and relative
  paths are rejected).

### Ownership

- Never overwrite operator-authored skills, profile, shared/project memory,
  routines, connectors, or teammate definitions.
- AIWG-managed copies use the same managed markers / sidecars as peer
  providers; remove only recorded AIWG entries.

### Discover-first engagement

- Bridge text instructs agents to run `aiwg discover "<intent>"` then
  `aiwg show <type> <name>` before improvising.
- Store artifact **references/summaries** in Grok memory — never full bodies.
- Context `loadMode` is `prose-directive` with `support: degraded` until a
  native startup/include contract is confirmed. Do not claim auto-load of
  unverified paths.

### Native surfaces (Grok-owned in v1)

Routines (≈cron), CreateAgent teammates (≈agent_teams), connectors (≈mcp),
and registered-machine bridge remain **Grok-owned**. AIWG does not invent
writers for those surfaces in the experimental cut (#209 deferred). Matrix
flags may note native *capability* without claiming AIWG installers.

### Reload / status honesty

Until product reload behavior is verified, verification must **not** default
to a silent `live-refresh` claim. Prefer: start a new agent chat or re-read
skills. Never emit Cursor reload wording for `grokbot`.

### Stable promotion (#210 deferred)

Remain `experimental` until Linux PUW (plus macOS/Windows as applicable),
security review, and docs/matrix flip land under #210.

## Consequences

- Dual registries (`provider-definitions.ts` + `deploy-agents.mjs`) both list
  `grokbot`, or deploy/status diverge.
- Doctor, capability matrix, setup choices, and install-connect-verify gain a
  Grok Bot row without inventing filesystem facts.
- Operators migrate Grok fleets from `--provider cursor` to `--provider grokbot`;
  Cursor IDE fleets stay on `cursor`.

## References

- Peers: Hermes, OpenHuman, OpenClaw, Pi / deepseek-harness (skills-first).
- Anti-pattern: Cursor (`.cursor/`, MDC rules, Cursor reload copy).
- Plan verification: experimental cut covers #203–#208; #209/#210 deferred.
