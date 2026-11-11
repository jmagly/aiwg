---
namespace: aiwg
name: plugin-search
platforms: [all]
description: Search marketplaces for plugins using configured local manifests and directory caches; rank matching plugins by observed installs, review tier and cache dates without installing or fetching anything
---

# Search Marketplace Plugins

Ask: "Search all marketplaces for UI/UX design and development plugins" or
"Find the most popular accessibility agent suite in my cached marketplaces."

## Triggers

- "search marketplaces for plugins"
- "search all marketplaces"
- "find marketplace plugins"
- "highest rated UI/UX agent suite"
- "compare plugin install counts"

## Behavior

1. Extract capability terms from the request, such as `UI UX design development`.
2. Run the existing marketplace command in its read-only provider plugin mode:

   ```bash
   aiwg marketplace search "UI UX design development" --plugins --json
   ```

   Default scope reads every configured Claude marketplace plus the local directory
   cache. It explicitly reports Codex manifest search as deferred. Use `--provider
   claude` to restrict the scope; other provider formats are not yet supported.
3. Report the searched marketplaces, matching descriptions and keywords, and the
   install count, review tier and as-of date for each signal. Preserve `null` as
   unknown; an explicit review tier `none` differs from an absent tier.
4. Explain ordering: number of matched query terms, review tier (`anthropic`, then
   `partner`, then `none`/unknown), install count, then cache date, descending.
   Popularity and review observations do not establish capability or a rating.
   Compare the stated capabilities against the user's need; never invent stars,
   ratings or claims that a suite is objectively the best.
5. Surface warnings, including stale, malformed, missing or undated cache data.
   Default maximum age is 30 days; `--max-age-days 7` changes it for this search.
6. Give the selected `name@marketplace` and link to the
   [install-plugin skill](../install-plugin/SKILL.md) with
   `aiwg show skill install-plugin`. Third-party results require their provider's
   installation workflow; this search does not extend the AIWG installer or
   authorize installation. Never run an installer as part of search.

## CLI reference

```bash
aiwg marketplace search "accessibility design" --plugins
aiwg marketplace search "interface" --plugins --provider claude --max-age-days 7 --json
```

The table and JSON include signal dates. JSON also lists configured marketplaces,
source files, matched terms and warnings. Warnings go to stderr as well.

Only these local Claude files are read below `${CLAUDE_CONFIG_DIR:-~/.claude}/plugins/`:
`known_marketplaces.json`, each configured checkout's
`.claude-plugin/marketplace.json`, `plugin-directory-cache-v2.json`, and
`install-counts-cache.json`. Missing cache dates stay unknown; filesystem modification
times are not substituted for observation dates. Nothing is downloaded or refreshed.

Without `--plugins`, the existing skill registry and signed catalog search behavior
is unchanged and may query remote registries. Always use `--plugins` for this skill.
