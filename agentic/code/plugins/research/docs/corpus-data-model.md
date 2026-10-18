# Research Corpus Data Model

Authoritative reference for the research-corpus artifacts the `research-complete`
framework reads and writes. Confirmed against the shared research corpus
warehouse (the reference implementation) and consumed by the shared parser at
`src/artifacts/corpus-views/ref-parser.ts` (#1497).

> **Corpus root.** Artifacts live under `<corpusRoot>/documentation/`. The
> corpus root defaults to the project root and is overridable via
> `research.corpusRoot` in `.aiwg/aiwg.config` or the `AIWG_CORPUS_ROOT`
> environment variable.

## Directory layout

```
<corpusRoot>/
├── documentation/
│   ├── references/   REF-NNN-<slug>.md          analysis docs (one per source)
│   ├── citations/    REF-NNN-citations.md        citation sidecars (edges + funders + discovery)
│   ├── radar/        REF-NNN-radar.md            freshness sidecars
│   ├── profiles/
│   │   ├── people/   PROF-P-<slug>.md            authors/researchers
│   │   ├── orgs/      PROF-O-<slug>.md            organizations
│   │   ├── groups/    PROF-G-<slug>.md            research groups / teams
│   │   ├── funders/   PROF-F-<slug>.md            funding bodies
│   │   └── sources/   PROF-S-<slug>.md            discovery curators
│   ├── areas/        AREA-<slug>.md               research-area taxonomy
│   ├── concepts/     REF-NNN-skos.{ttl,jsonld}    SKOS concept schemes
│   ├── provenance/   records/REF-NNN-prov.{ttl,jsonld}  PROV-O induction bundles
│   └── synthesis/    SYN-NNN-<slug>.md            cross-paper synthesis essays
└── indices/          generated markdown views (by `aiwg index build`, #1490)
```

**Filename rule:** references carry a slug (`REF-001-attention.md`); **citation and
radar sidecars do NOT** (`REF-001-citations.md`, `REF-001-radar.md`). The parser
resolves sidecars by `REF-NNN` id, not by slug.

## ID conventions

- `REF-NNN` — research papers / sources (citation-network nodes).
- `PROF-{P|O|G|F|S}-<slug>` — entity profiles (person / org / group / funder / source-curator).
- `AREA-<slug>`, `SYN-NNN` — taxonomy areas, synthesis essays.
- Reference docs use `ref_id` (**underscore**) in frontmatter; every sidecar/profile uses hyphenated keys (`ref`, `prof-id`, …).

## Artifact schemas

### Reference / analysis doc — `references/REF-NNN-<slug>.md`
Frontmatter: `ref_id`, `title`, `year`, `pdf_hash` (+ optional `frontmatter-backfilled[-by]`). Body carries `## GRADE Quality` (A/B/C/LOW), `## Referenced By`, `## Entity Profiles` (Role→Entity→Profile table), `## Document Classification`. Two templates by source type: full academic (`REFERENCE-TEMPLATE.md`) and condensed web/blog (`REFERENCE-TEMPLATE-blog.md`) — see the extensible source-type model (#1509).

### Citation sidecar — `citations/REF-NNN-citations.md`
Frontmatter:
- `ref`, `title`, `type: citations`
- `authors[]` — strings (`"Last, First"`) or objects (`{name, orcid, prof-id}`)
- `affiliation-primary`, `affiliation-status` (optional)
- `funders[]` — `{id (→ PROF-F slug or raw name), grant-id}` (string entries allowed)
- `discovery` (optional, SOURCE-TRACKING) — `{date, surface, via, curator-id (→ PROF-S), harvest-batch, harvested-by}`. `surface` vocab: `x-account|x-search|x-bookmarks|x-foryou|x-following|rss|newsletter|web|referral|direct`.

Body: `## Outgoing` / `## Incoming` edge tables; last column = `Inducted REF` (`REF-NNN` or `—`).

### Radar sidecar — `radar/REF-NNN-radar.md`
Frontmatter: `ref`, `title`, `type: radar`, `refresh-cadence` (**enum word**: `monthly|quarterly|biannual|annual|on-demand`, *not* a duration), `last-refreshed` (ISO date), `last-refreshed-by`, `cluster`, `grade-original`, `grade-current` (A–D), `grade-trajectory` (`rising|stable|declining|superseded|retracted`, freeform drift in practice), `sources-searched[]`.

Cadence→days: `monthly`=30, `quarterly`=90, `biannual`=180, `annual`=365, `on-demand`=never.

### Entity profiles — `profiles/{people,orgs,groups,funders}/PROF-{P,O,G,F}-<slug>.md`
Shared frontmatter: `prof-id`, `name`, `type`, `affiliation`, `aliases[]`, `corpus-refs[]`, `refresh-cadence`, `last-refreshed`, `grade-influence` (A–D), `grade-trajectory`, `sources-searched[]`. Orgs add `research-areas[]`; groups add `parent-org`.

> **`corpus-refs` has two shapes in the wild** — list-of-strings (`['REF-1']`) and list-of-dicts (`[{ref, role}]`). The parser (`loadProfiles`) normalizes both to REF-id strings.

### Curator profile — `profiles/sources/PROF-S-<slug>.md`
Distinct schema: `prof-id`, `name`, `type: source`, `platform`, `handle`, `url`, `corpus-refs[]`, `surfaces[]`, `focus-areas[]`, `signal-quality` (A–D), `revisit-cadence` (`daily|weekly|biweekly|monthly|on-demand`), `last-harvested`, `candidate-yield`. Slug = handle lowercased, leading punctuation stripped, `_`→`-`.

## Bidirectional invariants

- Citation `authors[].prof-id` ↔ PROF-P `corpus-refs`.
- Citation `discovery.curator-id` ↔ PROF-S `corpus-refs` (orphan-checked: a set `curator-id` requires a matching PROF-S corpus-ref).
- Citation `funders[].id` ↔ PROF-F `corpus-refs`.
- Reference `## Entity Profiles` table ↔ each profile's `corpus-refs`.

## Date / value formats

- Dates: ISO `YYYY-MM-DD` (js-yaml parses bare dates as Date objects — the parser coerces to ISO strings).
- Cadences: enum words, never durations.
- GRADE: `A|B|C|D` (and `HIGH|MODERATE|LOW|VERY LOW` word forms in REF-doc bodies).

## See also

- `src/artifacts/corpus-views/ref-parser.ts` — the shared parser (this model in code).
- `aiwg index build` — renders the markdown index views from this model (#1490).
- Source-type extensibility: #1509. Subsystem tooling: radar #1498, discovery #1499, funder #1500.
