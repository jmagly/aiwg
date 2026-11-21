# Devin Desktop paths and verification

Use `devin` as the canonical AIWG provider id. The deprecated `windsurf`
selector uses the same adapter and deployment destinations. Devin CLI is a
separate product surface and is not a deployable AIWG provider.

AIWG retains these existing destinations. Devin Desktop 3.14 still imports them
(verified on titan 2026-11-20 against the documentation bundled with
`devin-desktop` 3.14.30825; see below):

| Surface | Retained destination | Evidence / status |
|---|---|---|
| Project startup | `AGENTS.md` | 3.14: recommended always-on project rules (`docs/extensibility/rules.mdx`) |
| Rules | `.windsurf/rules/` | 3.14: imported (`read-config-from.mdx`, Windsurf table); native equivalent `.devin/rules/*.md` |
| Workflows | `.windsurf/workflows/` | 3.14: **not** imported as skills by the Devin agent (`read-config-from.mdx` note); kept for legacy Windsurf installs |
| Kernel skills | `.windsurf/skills/` | 3.14: imported (`.windsurf/skills/` and `.codeium/skills/`) |
| Indexed skills | `.windsurf/.aiwg/skills/` | AIWG discovery storage, not a claim of native scanning |
| Agent mirrors | `.windsurf/agents/` | AIWG discovery storage; reached through startup/index guidance |
| Legacy rules | `.windsurfrules` | Deprecated compatibility stub |
| MCP config | `~/.codeium/windsurf/mcp_config.json` | 3.14: imported for the stable channel; native project file `.devin/mcp_config.json` |

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
channel and joins those segments with `mcp_config.json`. This supports retaining
the legacy MCP destination for 3.11; it does **not** verify 3.14 behavior.

Detection recognizes the current `devin-desktop` launcher and the legacy
Windsurf `windsurf` launcher and `WINDSURF_VERSION` marker. Directory existence
checks recognize `~/.devin`, `~/.config/Devin`, `~/.codeium`, and existing
`.windsurf/` deployments. Detection does not read their contents or change where
AIWG deploys. Presence of a config directory alone does not prove an executable
is available.

## Desktop 3.14 verification still required

On titan, inspect the same package metadata and extension path builders and
observe which fixture rules, workflows, skills, and startup files Desktop 3.14
loads. Record the package version, commands, and observed loaded markers here
before changing any project or user destination. In particular, neither
`.devin/rules/` precedence nor `~/.config/Devin` as an MCP config destination has
been verified by this worker. No destination was migrated based on a guess.

## Devin Desktop 3.14 verification, 2026-11-20 (titan)

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

Consequence: every retained `.windsurf/` destination except workflows still loads
in 3.14. Moving AIWG output to the native `.devin/` paths, and a replacement for
workflows, is a separate follow-up.
