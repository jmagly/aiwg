# Devin Desktop paths and verification

Use `devin` as the canonical AIWG provider id. The `devin` selector deploys to
Devin's native `.devin/` layout. The deprecated `windsurf` selector uses the
same adapter and writes the same native `.devin/` layout. Devin CLI is a separate
product surface and is not a deployable AIWG provider.

## Current destinations

`--provider devin` writes:

| Surface | Destination | Evidence / status |
|---|---|---|
| Project startup | `AGENTS.md` | 3.14: recommended always-on project rules (`docs/extensibility/rules.mdx`) |
| Rules | `.devin/rules/` | 3.14 native (`rules.mdx`, `trigger` frontmatter); PROBE verified loaded on titan |
| Commands | `.devin/skills/<name>/SKILL.md` | Delivered as skills — Devin has no command-file surface; `.windsurf/workflows/` is not imported |
| Kernel skills | `.devin/skills/` | 3.14 native; PROBE verified loaded on titan |
| Indexed skills | `.devin/.aiwg/skills/` | AIWG discovery storage, not a claim of native scanning |
| Cross-agent skills | `.agents/skills/` | 3.14: scanned natively (PROBE verified on titan) |
| Agent mirrors | `.devin/agents/` | Devin subagent profiles (`name`/`description`/`model`/`allowed-tools` frontmatter) |
| Legacy rules | `.windsurfrules` | Deprecated compatibility stub pointing at `.devin/rules/` |
| MCP config | `.devin/mcp_config.json` (project), `~/.config/devin/mcp_config.json` (user) | Native 3.x destinations |

Devin Desktop uses skills natively: `providerNeedsCommands('devin')` is false.
AIWG does not generate command shims from skills for Devin because its bundled
documentation says workflows are not imported. Command content is delivered as
skills at the native path above.

Namespaced skills keep the flat `.devin/skills/<namespace>-<name>/SKILL.md`
layout. The 3.14 probes verified immediate skill directories, but did not test
recursive discovery beneath `.devin/skills/`. The existing one-level deployment
policy is therefore retained conservatively; a native one-level discovery limit
is not established by those findings.

`--provider windsurf` is a deprecated alias of `devin`: it prints a deprecation
warning and deploys the same rules, skills, agents and project MCP configuration.
There is no separate legacy output layout.

Re-deploying or refreshing a managed `.windsurf/` installation writes `.devin/`
and retires legacy managed agents, skills, workflows, rules, RULES-BOUND.md and
manifests. Ownership comes from receipts, managed markers and skill markers.
Original managed bytes and permissions are retained in
`.devin/.aiwg/legacy-windsurf/originals.json.gz` for recovery (gzip-compressed
JSON mapping legacy relative paths to base64 `bytes` and numeric `mode`, or a
`link` target for a receipt-owned symlink),
including edited copies and artifacts with no current replacement.
Unmanaged operator files and symlinks stay under `.windsurf/` with a notice.
Migration participates in deployment staging and copy-mode preservation does not
restore the retired artifacts. Existing project declarations cannot select the
old layout. MCP merges preserve existing server entries and unrelated keys.

## Devin 3.14 loaded-surface evidence (PROBE tokens, titan)

Probe rule and skill files were placed under candidate directories and observed
inside a live Devin 3.14 (`devin-desktop` 3.14.30833-1795195328) session:

- `.devin/rules/zz-probe.md` — loaded as an always-on rule.
- `.windsurf/rules/zz-probe.md` — also loaded (legacy import surface is live).
- `.devin/skills/<name>/SKILL.md` — loaded as a skill.
- `.windsurf/skills/<name>/SKILL.md` — loaded as a skill (legacy import).
- `.agents/skills/<name>/SKILL.md` — loaded as a skill (shared cross-agent surface).

## Read-only package inspection, 2026-11-19

The worker host has `devin-desktop` **3.11.238-1793395379**, rather than the
operator's **3.14.30825-1795029285** on titan. The following checks used only
installed application files, without opening user settings or credentials:

```sh
dpkg-query -W devin-desktop
readlink -f /usr/bin/devin-desktop
readlink -f /usr/bin/windsurf
```

Results: both launchers resolve to
`/usr/share/devin-desktop/bin/devin-desktop`. Packaged
`resources/app/product.json` identifies `nameShort: Devin`,
`applicationName: devin-desktop`, and `dataFolderName: .devin`.
`resources/app/extensions/windsurf/dist/extension.js` computes
`codeiumDirPathSegments` as `[".codeium", ..., "windsurf"]` for the stable
channel and joins those segments with `mcp_config.json`. This describes the
historical 3.11 import path; current deployments use native Devin MCP paths for
both selectors. It does **not** verify 3.14 behavior.

Detection recognizes the current `devin-desktop` launcher and the legacy
Windsurf `windsurf` launcher and `WINDSURF_VERSION` marker. Directory existence
checks recognize `~/.devin`, `~/.config/Devin`, `~/.codeium`, and existing
`.windsurf/` deployments. Detection does not read their contents or change where
AIWG deploys. Presence of a config directory alone does not prove an executable
is available.

## Devin Desktop 3.14 documentation verification, 2026-11-20 (titan)

Read from the documentation bundled with `devin-desktop` 3.14.30825-1795029285
under `resources/app/extensions/windsurf/devin/share/devin/docs/`:

- `reference/configuration/read-config-from.mdx`: Devin imports Windsurf
  configuration: rules from `.windsurf/rules/*.md` and `.windsurf/global_rules.md`,
  skills from `.windsurf/skills/` and `.codeium/skills/`, global skills from
  `~/.codeium/<channel>/skills/`, MCP servers from `~/.codeium/<channel>/mcp_config.json`
  (stable channel: `~/.codeium/windsurf/`). Windsurf workflows
  (`.windsurf/workflows/`, `~/.codeium/<channel>/global_workflows/`) are **not**
  imported as skills. Standard project rules import `AGENTS.md`, `AGENTS.local.md`,
  `AGENT.md` and `.windsurfrules`.
- `extensibility/rules.mdx`: native Devin rules are `.devin/rules/*.md` (same
  `trigger` frontmatter as `.windsurf/rules/*.md`) and `.devin/global_rules.md`;
  user-wide rules live in `~/.config/devin/AGENTS.md`; `.windsurfrules` is listed
  as legacy Windsurf workspace rules.
- Project MCP servers natively live in `.devin/mcp_config.json`
  (`.devin/mcp_config.local.json` for personal overrides).
