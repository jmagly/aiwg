---
audience: agent-operator
publication: agent-reference
stable_id: aiwg.agent-reference.provider.muse
---

# Muse Code Operational Reference

> **AIWG provider status:** Experimental (`muse`). No aliases are registered:
> `muse-spark`, `muse-code`, `spark`, and `meta` are all deliberately rejected
> as provider ids. Decision record:
> [`docs/architecture/adr-muse-provider-target.md`](../../architecture/adr-muse-provider-target.md).
>
> **First time using AIWG?** Begin with
> [Install, Connect, and Verify](https://docs.aiwg.io/pages/getting-started--install-connect-verify.html).
> This guide assumes AIWG is already installed.

Deploy AIWG into **Muse Code** (Meta's terminal/CI coding agent built on Muse
Spark). This provider is **not** Cursor IDE: Muse fleets must use `--provider
muse`; Cursor IDE fleets stay on `cursor`. Overloading `--provider cursor` for
Muse deploys into paths Muse does not load and prints foreign reload guidance.

## Architecture

| Artifact | Where it lands | Notes |
| -------- | -------------- | ----- |
| Context bridge | `<project>/AGENTS.md` + `WORKSPACE.md` + `.aiwg/AIWG.md` | Discover-first; loads only after the workspace is trusted |
| Agents / commands / rules | AIWG index | `aiwg discover` / `aiwg show` — no native file surface in this wave |
| Skills (kernel, project) | `<project>/.agents/skills/` | Canonical project deployment root |
| Skills (standard, project) | `<project>/.agents/.aiwg/skills/` | Only with `--copy-all`; indexed, not startup-listed |
| Skills (user) | `$XDG_CONFIG_HOME/muse/skills` (default `~/.config/muse/skills`) | Resolved at deploy time; absolute `XDG_CONFIG_HOME` honored |

AIWG never writes `.cursor/**` for this provider, never invents `~/.muse` or
siblings of `muse/skills` under the XDG config home, and never silently mirrors
into `~/.agents/skills` (Muse also reads that root — a second AIWG-owned copy
would list every kernel skill twice, the Codex #766 regression).

## Quick start (project)

Install Muse Code, then from the project root:

```bash
aiwg use all --provider muse
```

The deployment command refreshes AIWG's shared project context and prints a
verification result. Muse loads project `AGENTS.md` only after the workspace
is explicitly trusted: **trust the workspace when prompted, then start a new
Muse session** (or re-read skills) before using the deployment. Reloading an
IDE window does not apply to Muse Code. After that, work discover-first —
`aiwg discover "<intent>"`, then `aiwg show <type> <name>` — before
improvising.

Full first-run path: [`docs/integrations/muse-quickstart.md`](../../integrations/muse-quickstart.md).

## User-scope / global skills

```bash
aiwg use all --provider muse --scope user
```

User-scope skills land in the resolved XDG user root
(`$XDG_CONFIG_HOME/muse/skills`, default `~/.config/muse/skills`). Bad XDG
metadata fails closed with remediation instead of inventing a bogus tree.
`--global` is the no-project-deploy bootstrap (stage → user deploy →
lightweight project context); it is **not** identical to `--scope user`
(additive mirror).

## Verify

```bash
aiwg status --probe --json   # Muse restart copy — never Cursor wording
aiwg doctor --provider muse
```

`aiwg doctor --provider muse` checks the labeled Muse surfaces, the deployed
`.agents/skills/` listing, and the context/memory firewall scan over the
muse layout (`AGENTS.md` bridge + project skill root). Muse has no native
agent surface; the Agents line reports that agents are indexed and reached
via `aiwg discover` / `aiwg show`.

## Sessions

Session support is **export-first** until a native log root is evidenced on
disk: the adapter ingests only explicit `muse export` / `/export trajectory`
JSON documents supplied by the operator, gated on the document's
`export_schema_version` major. Auto-discovery never scrapes unauthorized
homes; no `~/.muse` root is assumed. See the ADR "Sessions: export-first"
section. Details: [Muse sessions](../../providers/muse-sessions.md).

## Hooks and MCP

Hooks execute outside Muse's sandbox, as plain shell processes on the
operator's machine, and project hooks run only after the folder is trusted.
Review `.muse/hooks.json` before trusting a workspace.

- `aiwg use --provider muse` installs one AIWG-managed `SessionStart` hook
  into `.muse/hooks.json`: a read-only `aiwg refresh --dry-run --quiet`
  context refresh. Operator hook groups are preserved, the managed group is
  tracked in `.muse/.aiwg-hooks.json`, and a hand-edited `hooks.json` is
  backed up before it is rewritten. Unmanaged hooks are never installed.
- Opt out with `aiwg use --provider muse --no-hooks`, or delete the matcher
  group whose command is `aiwg refresh --dry-run --quiet`.
- MCP is opt-in only: `aiwg use --provider muse --mcp` merges the AIWG MCP
  server into `mcp_servers` in `$XDG_CONFIG_HOME/muse/settings.json`
  (default `~/.config/muse/settings.json`), with a backup of the existing
  file. A default deploy never touches user settings.

## Workspace trust

Muse natively prefers `AGENTS.md` over `CLAUDE.md` at each directory level,
but project `AGENTS.md` loads only after the workspace is explicitly trusted
(first-run trust prompt). The deployed bridge states this up front: until the
workspace is trusted, the bridge does not load. Trust the workspace when
prompted, then start a new Muse session so the bridge is read. No `CLAUDE.md`
shim is deployed for this provider.
