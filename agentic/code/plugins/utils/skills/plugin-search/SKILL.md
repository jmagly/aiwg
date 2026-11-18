---
namespace: aiwg
name: plugin-search
platforms: [all]
description: Search local marketplace manifests and cached MCP Registry, GitHub and skills.sh observations, with explicit public refresh and source coverage; never install tools
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

   Default scope reads every configured Claude marketplace, the local directory
   cache and public search snapshots for the exact query. Without `--refresh`,
   search stays offline and read-only. When the user explicitly requests a public
   refresh, append `--refresh` to query MCP Registry, GitHub and skills.sh and
   update their dated caches. Use `--provider claude` to restrict to local Claude
   data; restricted providers never trigger public requests. Codex local manifest
   search remains deferred (#783).
3. Report `coverage`: every searched source, cache/refresh mode, date and each
   skipped-source reason. "All" means the reported coverage, never all internet
   marketplaces. Report matching descriptions and keywords, and the
   install count, review tier and as-of date for each signal. Preserve `null` as
   unknown; an explicit review tier `none` differs from an absent tier. Include
   source paths/URLs and dates. Display GitHub stars, license and last push, MCP
   versions and dates separately; never substitute them for installs or review.
4. Explain ordering: number of matched query terms, review tier (`anthropic`, then
   `partner`, then `none`/unknown), install count, then cache date, descending.
   Popularity and review observations do not establish capability or a rating.
   Compare the stated capabilities against the user's need; never invent stars,
   ratings or claims that a suite is objectively the best.
5. Surface warnings, including stale, malformed, missing or undated cache data.
   Default maximum age is 30 days; `--max-age-days 7` changes it for this search.
   Name `aiwg marketplace search "<query>" --plugins --refresh` for public caches.
   Claude public directory/count refresh is unsupported; its caches must be
   refreshed through Claude. Surface partial-page, failed-refresh and implausible
   install/star warnings without treating them as proof of abuse.
6. Give the selected `name@marketplace` and link to the
   [install-plugin skill](../install-plugin/SKILL.md) with
   `aiwg show skill install-plugin`. Third-party results require their provider's
   installation workflow; this search does not extend the AIWG installer or
   authorize installation. Never run an installer as part of search.

## CLI reference

```bash
aiwg marketplace search "social media" --plugins --refresh --json
aiwg marketplace search "accessibility design" --plugins
aiwg marketplace search "interface" --plugins --provider claude --max-age-days 7 --json
```

The table and JSON include source coverage and signal dates. JSON also lists
configured marketplaces, source paths/URLs, matched terms and warnings. Warnings go to stderr as well.

Local Claude inputs are read below `${CLAUDE_CONFIG_DIR:-~/.claude}/plugins/`:
`known_marketplaces.json`, each configured checkout's
`.claude-plugin/marketplace.json`, `plugin-directory-cache-v2.json`, and
`install-counts-cache.json`. Missing cache dates stay unknown; filesystem modification
times are not substituted for observation dates. Claude-owned files are never
changed by this command. Public refresh uses unauthenticated bounded JSON requests
and writes query-specific snapshots beneath the existing marketplace-cache root.
A failed refresh preserves older snapshots and their original dates. PulseMCP,
Glama, Docker MCP, Cursor, ClawHub and Hermes search are explicitly skipped.
Public results are discovery data; consult their source for installation guidance.

Without `--plugins`, the existing skill registry and signed catalog search behavior
is unchanged and may query remote registries. Always use `--plugins` for this skill.
