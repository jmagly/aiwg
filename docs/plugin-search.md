# Search marketplace plugins

> "Search marketplaces for plugins that provide UI/UX design and development agents."

> "Compare cached accessibility plugins by installs and review tier."

> "Find interface design tools and show how old their popularity data is."

The `plugin-search` skill searches configured Claude Code marketplaces and its
local plugin directory cache. Directory listings without a confirmed marketplace
retain their stable directory ID and an unknown marketplace. It reads existing
files only; it never downloads, refreshes caches, installs plugins or writes
configuration.

## Command reference

```bash
aiwg discover "search marketplaces for plugins"
aiwg marketplace search "UI UX design development" --plugins
aiwg marketplace search "accessibility" --plugins --provider claude --max-age-days 7 --json
```

The default provider scope is `all`: Claude manifests and caches are searched;
Codex `marketplace.json` search is explicitly deferred until its local manifest
and configuration contract is established (#783). Other provider formats are not
yet supported. `--provider claude` restricts the scope to Claude.

Results match name, description, keywords and category, then sort by number of
matched terms, review tier (`anthropic`, `partner`, `none`/unknown), install count,
and cache date, descending. Ties use the plugin ID. These are observations of
popularity and review, not ratings or measurements of capability. An explicit
review tier `none` is shown separately from an unknown tier.

Each result shows install count, review tier and their as-of dates, plus the
listing cache date. Missing values and dates show `unknown` in the table and
`null` in JSON; zero installs remain zero. JSON includes configured marketplace
names, manifest paths, source paths, matched terms and warnings. A cache older
than 30 days warns by default; `--max-age-days` sets a non-negative maximum age
for this invocation. Undated, future-dated, malformed or unavailable configured
manifests are reported without inventing freshness or blocking healthy sources.

Claude inputs live under `${CLAUDE_CONFIG_DIR:-~/.claude}/plugins/`:
`known_marketplaces.json`, each configured checkout's
`.claude-plugin/marketplace.json`, `install-counts-cache.json`, and
`plugin-directory-cache-v2.json`. Only local checkouts are read, including configured
marketplaces outside the default checkout folder. File modification time is not
used as an observation date. Local caches may omit plugins or signals.

After choosing a `name@marketplace`, run `aiwg show skill install-plugin` for
installation guidance. Third-party plugins use their provider's installation
workflow; they are not deployed through `aiwg use` by this feature. Without
`--plugins`, the existing skill registry and signed catalog search retains its
behavior, including remote registry queries.
