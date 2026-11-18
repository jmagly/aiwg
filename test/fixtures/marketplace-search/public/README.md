# Public search response fixtures

These offline fixtures record synthetic examples of the MCP Registry servers,
GitHub repository-search and skills.sh search JSON shapes. They contain no real
accounts, credentials or network captures. Tests serve them through a fake fetch
or a built-CLI fetch preload; no test calls a public service.

`cache-valid.json` and `cache-invalid.json` exercise the discovery definitions in
the existing marketplace catalog schema. The invalid fixture has an observed
install count without its required observation date.
