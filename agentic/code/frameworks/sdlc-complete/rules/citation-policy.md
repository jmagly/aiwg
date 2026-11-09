---
precedence: critical
overridable: true
enforcement: critical
activation: "kernel"
enforcedBy:
  - aiwg:decision-engine/absolute-screening#false-support-upper
summary: "Retrieve and verify corpus sources before citing; never invent references, quotes or locations, and match claim strength to evidence quality."
triggers:
  - "verify citations before making claims"
  - "never invent citations or source locations"
  - "match claim language to evidence quality"
---

# Citation Policy Rules

**Enforcement Level**: CRITICAL
**Scope**: All agents, documentation, and generated content
**Issue**: #100

## Overview

These rules enforce rigorous citation standards across all AIWG operations, agents, and generated documentation. Violations constitute intellectual dishonesty and undermine framework credibility. Every factual claim requires a corpus-backed citation, an explicit evidence-gap acknowledgment, or removal.

## Mandatory Rules

Gate coverage is scoped to D29 held-out citation screening: the
`aiwg:decision-engine/absolute-screening#false-support-upper` gate caps the
Wilson upper bound on citation false-support. It does not verify every citation
or enforce the rest of this policy outside that study.

### Rule 1: Never Generate Citations Without Retrieval
**FORBIDDEN**: inventing a citation from memory ("According to Smith et al. (2024)..."). **REQUIRED**: cite only after retrieving the source from `.aiwg/research/` (`@.aiwg/research/sources/smith-2024.pdf (p. 15)`), OR acknowledge the gap ("Requires literature review for authoritative citation").

### Rule 2: Never Invent DOIs, URLs, or Page Numbers
**FORBIDDEN**: fabricated metadata (made-up DOI `10.1234/example`, invented URL, guessed page numbers). **REQUIRED**: use only exact metadata from the retrieved source (verified DOI/URL with verification date, real page range), OR state "Source location pending verification".

### Rule 3: Never Cite Sources Not in Research Corpus
**FORBIDDEN**: citing any source not present in `.aiwg/research/` (e.g. a remembered blog/book/`[1] martinfowler.com`). **REQUIRED**: cite only corpus sources (`[@.aiwg/research/sources/fowler-2024.pdf]`), OR make a qualified claim without citation noting that literature review is needed.

### Rule 4: Always Use Exact Quotes with References
**FORBIDDEN**: paraphrasing as if quoting, or unverified figures ("TDD improves quality by ~40%"). **REQUIRED**: exact quote + location (`"...40.7% reduction in defect density" (@.aiwg/research/sources/george-2003-tdd.pdf, p. 12)`), or explicitly-sourced paraphrase with page. For time-based media, use transcript timestamp anchors instead of page numbers (`"quote" (@.aiwg/research/findings/REF-123.md @ 00:12:34)`). Timestamp citations are valid ONLY when: the REF has a transcript sidecar in the corpus, the timestamp exists in that transcript, the quoted words match the transcript exactly, and the citation uses the corpus REF/finding path (not a bare platform URL).

### Rule 5: Always Verify Source Exists Before Citing
**FORBIDDEN**: citing a path before confirming it exists on disk. **REQUIRED**: verify the file exists (`[ -f <path> ]`) before citing it; if absent, acknowledge the gap instead.

### Rule 6: Always Use Quality-Appropriate Hedging
**FORBIDDEN**: overconfident claims from weak evidence ("Research proves...", "conclusively demonstrates..."). **REQUIRED**: match claim strength to GRADE evidence quality (see matrix below).

### Rule 7: Always Mark Uncertainty When Source Quality Is Low
**FORBIDDEN**: presenting LOW/VERY LOW evidence as authoritative ("industry best practices show microservices are superior"). **REQUIRED**: explicitly mark uncertainty and limitations, append the GRADE level (`... (@.aiwg/research/quality-notes.md - GRADE: LOW)`), or acknowledge the gap and flag for literature review.

## GRADE Evidence-Quality → Claim-Language Matrix

| GRADE | Claim Language | Context | Example |
|-------|----------------|---------|---------|
| **HIGH** | "demonstrates", "shows", "confirms", "establishes" | Systematic reviews, meta-analyses, well-designed RCTs | "Meta-analysis demonstrates 35% defect reduction" |
| **MODERATE** | "suggests", "indicates", "supports", "points to" | Cohort/case-control studies, lower-quality RCTs | "Research suggests correlation between TDD and quality" |
| **LOW** | "some evidence", "limited data", "preliminary findings" | Case series/reports, expert opinion with evidence | "Limited evidence indicates potential benefits" |
| **VERY LOW** | "anecdotal", "exploratory", "practitioner reports" | Expert opinion, anecdotes, untested claims | "Practitioner reports suggest possible improvements" |

Always append `GRADE: <level>` with a one-line evidence-type/limitations note to each citation.

### Time-Based Media GRADE

Apply the same hedging to videos/lectures/podcasts/interviews, grading source context and transcript integrity explicitly. All require a REF path + timestamp + exact transcript quote:

| Media source | Default GRADE |
|--------------|---------------|
| Peer-reviewed/official conference recording, verified venue + transcript | A- |
| Institutional lecture/course/seminar, identifiable speaker | B+ |
| Podcast/informal interview, identifiable expert(s) | B (hedge interview claims) |
| Platform upload, unclear speaker/provenance/transcript | C or lower (use only with limitations or corroboration) |

Do not promote a media source to paper-like authority because the speaker is credible. Record format limitations (moderation, informal remarks, transcription quality, whether spoken references are formal citations or informal mentions).

## Agent / Documentation Requirements

Agents that generate documentation MUST: (1) state an explicit citation protocol (verify file exists → extract exact quote with page/timestamp → assess GRADE → hedge → include full @-mention), (2) document the GRADE assessment, and (3) reference this rule. When writing claims, check the corpus first (`find .aiwg/research/sources -name "*keyword*"`); if found, cite with full @-mention path and GRADE; if not, hedge, file a gap in `@.aiwg/research/TODO.md`, or omit the claim. Use full @-mention paths, never bare author names. Per-artifact-type templates (technical docs / architectural decisions / requirements) follow the same CLAIM + `(@path, p./timestamp)` + `GRADE:` pattern.

## Validation Checklist

- [ ] All citations reference files in `.aiwg/research/sources/` (or corpus findings)
- [ ] All cited files verified to exist
- [ ] All quotes exact with page/section numbers, or timestamp anchors for media
- [ ] Media timestamps point to an existing transcript segment; quoted words match exactly
- [ ] GRADE level assessed and documented for each citation
- [ ] Claim language matches evidence quality (no overclaiming)
- [ ] Uncertainty explicitly marked for LOW/VERY LOW sources
- [ ] No invented DOIs, URLs, ISBNs, or page numbers
- [ ] @-mention paths provided for all internal references
- [ ] Research gaps documented in `@.aiwg/research/TODO.md`

## Remediation

On violation: immediately remove/hedge unsupported claims and delete fabricated citations (DOIs, URLs, page numbers); add disclaimers to uncertainly-sourced content; then search the corpus for support, rewrite claims to match available evidence quality, and document gaps in `@.aiwg/research/TODO.md`. Audit the codebase for similar violations.

## Exceptions

There are NO exceptions for factual claims requiring evidence. The ONLY acceptable uncited claims are:
1. **Obvious truths** — "TypeScript is a typed superset of JavaScript"
2. **Project-specific facts** — "This repository uses CalVer versioning"
3. **Explicit opinions** — "We prefer X over Y because..." (marked as opinion)

All other factual claims require: a corpus citation, an explicit evidence-gap acknowledgment, OR removal. When in doubt, hedge more conservatively.

## References

- @.aiwg/research/quality-assessment.md - GRADE methodology
- @.aiwg/research/sources/ - Research corpus
- @.aiwg/research/TODO.md - Research gaps and planned reviews
- @$AIWG_ROOT/agentic/code/addons/voice-framework/docs/authenticity-markers.md - Balancing authority with honesty

---

**Rule Status**: ACTIVE
**Last Updated**: 2026-01-25
**Issue**: #100
