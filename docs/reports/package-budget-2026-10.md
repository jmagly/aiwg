---
title: npm package budget review — October 2026
audience: maintainer
status: accepted
issue: 3075
---

# npm package budget review — October 2026

## Decision

Keep the current runtime dependency manifest and the inspectable offline corpus,
local documentation, compiled modules, runtime tools, and prebuilt Fortemi index.
The maintainer-only tool exclusions from #3077 already remove those tools from
installation. This change corrects the stale limits and enforces the resulting
budgets in the existing packaging CI job, after the complete release build.

Raise the direct dependency budget from 15 to 20. The current manifest declares
18 direct dependencies. The package now includes Fortemi discovery, MCP, JSON
schema validation, JavaScript/XML/TOML parsing, provider deployment, and CLI UI
support. Removing dependencies to recover the old count would require a separate
runtime dependency review and replacement work; it is not necessary to restore
a useful growth gate. Two dependency slots provide modest headroom while still
requiring review of subsequent growth. Optional and peer dependencies remain
outside this direct-dependency metric; it is not a count of the entire install.

Retain the packed limit of 23,000 KiB. Raise the unpacked limit from 70,000 to
82,000 KiB and the file limit from 5,500 to 8,000. The August baseline is stale:
the corpus, local documentation, compiled APIs, and contract schemas have grown.
Deleting capability-bearing files or hiding the corpus in an archive to satisfy
the old ceiling would undermine offline use and inspection. The new limits
provide approximately 10.5% unpacked and 8.3% file-count headroom over the
measured checkout, with the existing packed budget providing approximately 30%.
These limits also reserve room for release-built web assets.

## Measurements

Measured from `aiwg@2026.10.3` with `npm run build:cli`, followed by
`npm pack --dry-run --json` (including the real prepack lifecycle). This baseline
precedes this report's addition. The web build could not complete locally because
its React and Vite plugin dependencies are absent; installation was prohibited
for this task. Therefore these are CLI-built checkout measurements, not a claim
of a complete release measurement. CI builds the web assets before enforcing
these same limits and will reject growth beyond the reserved headroom.

| Metric | Measured | Budget |
| --- | ---: | ---: |
| Direct runtime dependencies | 18 | 20 |
| Packed bytes | 18,138,791 (17,713.7 KiB) | 23,552,000 (23,000 KiB) |
| Unpacked bytes | 75,983,435 (72.46 MiB) | 83,968,000 (82,000 KiB) |
| Files | 7,389 | 8,000 |

The dry-run inventory explains the file and size growth:

| Area | Files | Unpacked bytes |
| --- | ---: | ---: |
| `agentic/` | 4,531 | 30,920,974 |
| `dist/` | 1,265 | 12,489,585 |
| `docs/` | 1,061 | 11,514,612 |
| `tools/` | 312 | 4,561,077 |
| `prebuilt/` | 2 | 14,458,646 |
| `schemas/` | 176 | 1,669,474 |

## Enforcement

`npm run check:budgets` runs both checks as a blocking step in the existing
packaging lane. Each CLI exits 1 on a breach. Missing or invalid size metrics
also fail; an explicitly requested transitive check cannot silently skip a
measurement error. Usable `npm ls` output is still checked when npm exits nonzero
for optional or peer dependency warnings.

Regression tests exercise actual CLI exit statuses at and above each boundary,
measurement failures, and the packaging workflow wiring. Future intentional
increases should update the script defaults and record their measurements and
tradeoffs in the change description or commit message.
