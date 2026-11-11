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

## November 2026 update: file budget

After 2026.11.0 the package reached 8,001 files against the 8,000 file budget,
and the post-merge packaging lane failed. The extra file is the published
October 2026 blog post. Blog posts are part of the shipped discovery corpus: the
prebuilt relationship index digests `docs/`, so excluding them from the package
would make every installed index stale.

Raise the file budget from 8,000 to 8,800, about 10% headroom over the measured
count, the same margin the October decision chose. The packed and unpacked limits
stay unchanged.

Measured on `main` at 6eb4670df in the CI packaging lane after the full release
build:

| Metric | Measured | Budget |
| --- | ---: | ---: |
| Packed | 19,218.3 KiB | 23,000 KiB |
| Unpacked | 79.50 MiB | 80.08 MiB (82,000 KiB) |
| Files | 8,001 | 8,800 |

The unpacked size now has under 1% headroom. The next corpus growth will reach
that limit, which needs its own measured review rather than another file-count
raise.

## Amendment — 2026-11-06 (template and flow links in the prebuilt index, #3929/#3930)

#3929 made the index record the templates that skills, agents and flows use, and gave flows their dependencies, so templates surface with the components that need them. The operator directed (2026-11-06, #3930) that this template-to-asset mapping ship in the precomputed index package. The packaged Fortemi export grows accordingly.

Measured on main 0b6134941 against 23d22a0de (`npm pack --dry-run --json`):

| Metric | Before | After | Old limit | New limit |
|---|---|---|---|---|
| `prebuilt/fortemi-core/framework/aiwg-fortemi-index-v2.json` | 14,840,750 B | 15,396,290 B (+542 KiB) | 15,000,000 B | 16,000,000 B |
| Unpacked package | ≈ 81,750 KiB | 82,278 KiB | 82,000 KiB | 83,500 KiB |
| Packed package | — | 19,359 KiB | 23,000 KiB | unchanged |

All other source growth in the range is about 17 KiB of rule and template text. The new limits leave room for #3930, which adds templates to the framework-relations package. Any further growth still needs review.

## Amendment — 2026-11-11 (2026.11.6 Wave 1 features)

Main CI run 103559 (main c3e1020bf) failed the package lifecycle budget: unpacked 81.58 MiB against 81.54 MiB (83,500 KiB). The growth since the 2026-11-06 amendment is intentional shipped content: the 2026.11.5 fixes and the 2026.11.6 Wave 1 features, among them the `plugin-search` skill and guide (#4084), project-local flow registration (#4089), Grok Build agent deployment and capture fixtures (#4100, #4101), the Factory, Copilot and BYOK provider guidance (#4066, #4072, #4092), and the matching index entries.

Measured on main c3e1020bf (`node tools/cli/check-install-size.mjs --verbose`):

| Metric | Value | Old limit | New limit |
|---|---|---|---|
| Unpacked package | 81.58 MiB (≈83,540 KiB) | 83,500 KiB | 85,000 KiB |
| Packed package | 19,618 KiB | 23,000 KiB | unchanged |
| Files | 8,165 | 8,800 | unchanged |

The new limit leaves about 1.4 MiB of headroom, similar to the previous amendment. Any further growth still needs review.

