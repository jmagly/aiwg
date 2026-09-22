# Source / Discovery Tracking Schema

**Purpose**: record *where each source was discovered* (which account / surface), so high-yield curators are identified and can be revisited deliberately.
**Optional by design**: the `discovery:` block is OPTIONAL. Its absence is normal and never an error (see §0).

Tooling: `aiwg corpus discovery-log` (record), `aiwg corpus curator-init` (scaffold PROF-S), `aiwg corpus curator-status` (yield + orphans). Read views: `by-source`, `by-curator` (rendered by `aiwg index build`).

---

## 0. Optionality & exemptions (read first)

Discovery metadata is best-effort signal, not a required field. Three cases where it is legitimately absent — none are gaps, none are flagged by audits:

| Case | State | Treatment |
|------|-------|-----------|
| **Legacy refs** (inducted before source-tracking adoption) | no `discovery:` block | Normal. Not backfilled. Audits ignore. |
| **Operator-direct** (you brought the paper/source directly) | `surface: direct`, `curator-id: null` (or block omitted) | First-class, curator-less. Never an orphan. |
| **Curator unknown** (found via search/feed with no clear account) | `surface: x-search`/`x-foryou`/…, `curator-id: null` | Surface recorded, curator left null. Fine. |

Only set a `curator-id` when a source genuinely came through a named, repeatable curator worth returning to. When in doubt, record the `surface` and leave `curator-id` null.

---

## 1. Per-paper: `discovery:` block (citation sidecar)

Added to `documentation/citations/REF-XXX-citations.md` frontmatter:

```yaml
discovery:
  date: 2026-05-25                 # when the source was first surfaced
  surface: x-account               # controlled vocab — see below
  via: "x.com/@askalphaxiv"        # human-readable origin (account/URL/feed)
  curator-id: PROF-S-askalphaxiv   # link to curator profile; null if no curator
  harvest-batch: 2026-05-25-morning # optional: groups a harvesting session
  harvested-by: claude-opus-5    # agent/human that performed the harvest
```

All fields except `date` and `surface` are optional.

### `surface` controlled vocabulary

| Value | Meaning |
|-------|---------|
| `x-account` | A specific X account's timeline (curator) |
| `x-search` | X search results (query-driven, often no curator) |
| `x-bookmarks` | Operator's own X bookmarks |
| `x-foryou` | X "For You" algorithmic feed |
| `x-following` | X "Following" feed |
| `rss` | RSS/Atom feed |
| `newsletter` | Email newsletter / digest |
| `web` | Direct web browsing / blog |
| `referral` | Cited by / linked from another corpus paper |
| `direct` | Operator supplied directly (no discovery surface) |

> Distinct from radar `sources-searched` (surfaces queried *during a freshness refresh*): `discovery` records the surface a paper was *originally found through*. They are orthogonal.

---

## 2. Curator: `PROF-S-` source profile

A `source` value in the entity-profile `type` enum, stored in `documentation/profiles/sources/PROF-S-{slug}.md` (see the `source-profile` template).

- **slug** = handle lowercased, leading punctuation stripped, `_`→`-` (`@_akhaliq` → `PROF-S-akhaliq`).
- **`corpus-refs`** = inducted REFs discovered via this curator (NOT candidates).
- **`signal-quality`** = curator signal density (A = paper-per-post, high relevance; … D = low), graded A–D.
- **`revisit-cadence`** = `daily | weekly | biweekly | monthly | on-demand`.

"Good accounts to return to" = PROF-S ranked by **return-to score** (inducted-ref count × avg surfaced-paper GRADE) — see `aiwg corpus curator-status`.

---

## 3. Bidirectionality + orphan rule

When a paper is inducted with `discovery.curator-id: PROF-S-x`:
1. Add the REF to `PROF-S-x` frontmatter `corpus-refs:` and its §2 "Sources Surfaced" table.
2. The sidecar's `discovery.curator-id` IS the backlink (no separate REF-doc edit).
3. Recompute the curator's yield stats.

A PROF-S referenced by a sidecar's `discovery.curator-id` but missing that REF in its `corpus-refs` is a **curator orphan** — flagged by `curator-status` (and `research-lint`). **The check fires only when `curator-id` is set**; a missing/`null`/`direct` discovery block is never an orphan (it is simply outside the discovery graph).

---

## 4. Candidate (pre-induction) curator records

Curator profiles may be seeded before their surfaced papers are inducted:
- `corpus-refs: []` (empty until induction)
- record observed candidate yield under §2 "Candidate Sources Surfaced (not yet inducted)".
- As candidates induct, move them into `corpus-refs` + the "Sources Surfaced" table.
