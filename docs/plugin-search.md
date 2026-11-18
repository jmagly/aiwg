# Search marketplace plugins

The `plugin-search` skill and `marketplace search --plugins` search local Claude
Code manifests, its plugin directory, and cached public MCP Registry, GitHub and
skills.sh observations. Search stays offline and read-only unless `--refresh` is
explicitly supplied. Nothing is installed.

## Command reference

```bash
aiwg discover "search marketplaces for plugins"
aiwg marketplace search "social media" --plugins --refresh --json
aiwg marketplace search "social media" --plugins
aiwg marketplace search "accessibility" --plugins --provider claude --max-age-days 7 --json
```

The default scope is `--provider all`. `claude` restricts results to local Claude
manifests and caches; `codex` explicitly defers its local manifest search (#783).
A provider restriction also excludes public refresh requests. Without `--plugins`,
existing skill registry and signed catalog search retains its behavior, including
remote registry queries.

## Explicit refresh and coverage

`--refresh` queries these public, unauthenticated JSON endpoints:

| Source | Endpoint | Signals |
|---|---|---|
| MCP Registry | `https://registry.modelcontextprotocol.io/v0.1/servers?search=…&limit=100` | Version, publication and update dates |
| GitHub | `https://api.github.com/search/repositories?q=…&per_page=100&sort=stars&order=desc` | Stars, SPDX license when known, last push |
| skills.sh | `https://skills.sh/api/search?q=…&limit=100` | Installs |

Each response is limited to 5 MiB and a 10-second request deadline. Search reads
one bounded page per source; provider pagination/incomplete-result indicators
are disclosed. It does not claim an exhaustive internet inventory. No credentials
are read or sent, so public rate limits can cause refresh failures.

Refresh writes validated, dated observations atomically beneath the existing
`~/.aiwg/marketplace-cache/<source>/search/` root (`AIWG_CACHE_DIR` overrides it).
Each cache is keyed by the exact query: repeat the same query for offline reuse.
A successful empty response counts as covered. A failed refresh keeps the previous
snapshot and its original date; coverage says whether cached data was used or the
source was skipped. Malformed responses never replace healthy snapshots.

Both table and JSON output include `coverage`, listing searched sources, local,
cache or refresh mode, observation dates and skipped-source reasons. Cursor,
ClawHub, Hermes, PulseMCP, Glama and Docker MCP search adapters are explicitly
skipped. Claude public directory/count refresh is also skipped: there is no
established endpoint contract in this implementation. Its provider-owned caches
are not overwritten. Refresh those through Claude; the AIWG refresh command
updates the public adapters only. Stale warnings name the AIWG refresh command
and explain the Claude limitation when applicable.

## Ranking and honesty

Results match name, description, keywords and category, then sort by matched term
count, review tier (`anthropic`, `partner`, `none`/unknown), installs and cache
date, descending. Ties use ID. Stars and versions are separate observations;
they are never substituted for installs or review tiers. Signals carry source
paths/URLs and as-of dates. Missing values and dates remain `unknown` in text and
`null` in JSON; zero remains zero. License unknown does not imply free use.

A cache older than 30 days warns by default. `--max-age-days` changes this limit.
Undated, future-dated, malformed or missing caches produce warnings without
inventing freshness or blocking healthy sources. Public signal dates record
when the endpoint was observed; publication/update/push dates are separate
values. Responses are unsigned discovery data, never signed catalog verification.

When an install count is at least 100,000 and exceeds 1,000 times the stars of a
matching GitHub repository, output flags an implausible signal. Repository
identity must match; names alone do not establish a match. This heuristic does
not prove abuse: the metrics and observation dates can differ.

Claude inputs remain under `${CLAUDE_CONFIG_DIR:-~/.claude}/plugins/`:
`known_marketplaces.json`, configured `.claude-plugin/marketplace.json` files,
`install-counts-cache.json` and `plugin-directory-cache-v2.json`. Directory-only
listings keep stable IDs and unknown marketplace membership. File modification
time is never used as an observation date.

After selecting a Claude `name@marketplace`, run `aiwg show skill install-plugin`.
Public results are discovery only; consult their source for installation guidance.
