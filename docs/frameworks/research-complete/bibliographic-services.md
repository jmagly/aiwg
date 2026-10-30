# Bibliographic services: what each is good for, and where each will mislead you

Operating characteristics of the services the census, retraction, and acquisition
steps depend on. Measured across a 12-paper batch, 2026-09-12. Re-measure and
update the date when these change — the failure modes below are behavioural, not
documented guarantees.

The point of this table is not the happy path. It is that **one of these services
returns plausible, well-formed, badly wrong data with no error**, and an agent
discovering the ecosystem from scratch has no way to know which.

## Service table

| Service | Use for | Do **not** use for | Auth | Observed failure |
|---|---|---|---|---|
| Semantic Scholar | citation counts, influential counts, venue corroboration | — | key strongly recommended | HTTP 429 even at 25 s spacing |
| OpenAlex | `is_retracted` | **citation counts** — splits preprint/published records; 18× undercount observed | none | none; returns wrong data silently |
| OpenReview | venue/acceptance confirmation | — | none | — |
| ACL Anthology / PMLR | published version, page ranges | — | none | PMLR asset lives at `raw.githubusercontent.com/mlresearch/...`; the intuitive proceedings path 404s |
| Crossref / Unpaywall / Europe PMC | OA routing, bibliographic metadata | — | none (Unpaywall wants `mailto`) | — |
| PubPeer | post-publication concerns | — | — | HTTP 403 to non-browser clients |
| DBLP | venue fallback | — | — | anti-bot challenge; returns HTML, not JSON |

## The OpenAlex count trap

OpenAlex indexes the arXiv preprint record separately from the published record and
does not merge them. For REF-2532 (ROME) it returns `cited_by_count: 178` where
Semantic Scholar returns **3,205** — an 18× undercount. Title-search does not fix
it; the best-cited match was still the arXiv record.

This is a trap rather than a limitation because of *when* an agent reaches for it.
OpenAlex is the obvious fallback when Semantic Scholar throttles: unauthenticated,
generous limits, returns a plausible-looking integer. Substituting it silently
records counts an order of magnitude wrong, with no error and no signal. The
corpus then carries a number that looks like evidence and is not.

**Calibration rule.** Never substitute a citation-count source without checking it
against a known-high-count paper first. A source that returns 178 for a
3,000-citation paper is not a fallback, it is data corruption. One calibration
query catches it.

**Provenance rule.** Record the source and the date with every count. A count
without a provenance line cannot be compared against a later refresh and cannot be
audited when two sources disagree. Record a null result as a null result —
`is_retracted: false, OpenAlex, 2026-09-12` — never as the absence of a check.

## Throttling budget

Semantic Scholar is the best source for counts and the most aggressive throttler.
Measured: 4 of 12 succeeded on a first pass at ~4 s spacing; a retry pass at **25 s
spacing still lost 4 of 8**. The 429 body points at the API-key form.

Budget roughly five minutes of wall-clock for a 12-paper census, and **record
misses as misses** rather than substituting a source that has not been calibrated.

## Permanent access limitations

PubPeer returns 403 to this client, so the corpus has never carried a PubPeer
signal; radars record "PubPeer not checked" as a permanent access limitation, which
is honest. DBLP returns an Anubis challenge page rather than JSON, which fails like
a parse error rather than a block — worth naming, since DBLP is the natural venue
fallback when Semantic Scholar throttles.

## API keys

A Semantic Scholar key removes the throttling problem and is strongly recommended
for any batch. Key handling follows
[`token-security`](https://github.com/jmagly/aiwg/blob/main/agentic/code/frameworks/sdlc-complete/rules/token-security.md) without
exception: a mode-600 file, loaded at the point of use, never passed as a command
argument, never echoed, never committed.

```bash
# Correct: loaded inline at point of use, scoped to the call
curl -s -H "x-api-key: $(cat ~/.config/semanticscholar/token)" \
  "https://api.semanticscholar.org/graph/v1/paper/..."
```
