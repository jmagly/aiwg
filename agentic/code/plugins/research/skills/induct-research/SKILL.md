---
namespace: aiwg
platforms: [all]
name: induct-research
description: Induct research sources (issue, file, directory, or URI) into a research corpus — reads, annotates, and files structured induction tasks. Like address-issues but for research.
commandHint:
  argumentHint: "<target> [--repo <dest>] [--dry-run] [--priority high|medium|low] [--tag <topic>] [--recursive]"
  allowedTools: Read, Write, Glob, Grep, Bash, Agent, WebFetch, WebSearch, mcp__gitea__issue_write, mcp__gitea__issue_read, mcp__gitea__list_issues, mcp__hound__authenticate
  model: sonnet
  category: research
  modelRole: coding
  modelTier: standard
---

# Induct Research

Before dispatch, apply the shared [context engineering contract](../../../../../../docs/context-engineering-contract.md) and [verification contract](../../../../../../docs/verification-contracts.md). Missing source, fixity, sidecar, GRADE, or lint evidence makes the result incomplete or blocked, never complete.

Process one or more research sources — an issue, a file, a directory of papers, or a URI — and file structured induction tasks into a research repository so nothing gets lost. The analogue of `address-issues` for research corpora.

## Kernel Delegation

> As of ADR-021, `induct-research` delegates core ingest mechanics to the semantic memory kernel.

**Delegation pattern**:
1. `induct-research` retains its public name and interactive research-induction UX
2. Internal ingest mechanics delegate to `memory-ingest --consumer research-complete`
3. Research-specific layers remain in this wrapper:
   - GRADE quality assessment (via `ingestRequires: ["grade-quality"]`)
   - Citation validation (via `ingestRequires: ["provenance"]`)
   - Research-specific page templates
4. Cross-references written as `@-mentions` per consumer schema

**What changed**: The ingest pipeline (source reading, page creation, index update, log append) is now handled by `memory-ingest`. This skill adds the research-specific quality and citation layers on top.

**Backward compatibility**: No UX changes. Existing invocations work identically.

@agentic/code/addons/semantic-memory/skills/memory-ingest/SKILL.md

## Triggers

- "induct this paper" → single file induction
- "induct the research queue" → batch directory induction
- "add these references to the research repo" → URI or file-path induction
- "process the research from issue-planner" → induct `.aiwg/research/queue/`
- "induct research into gitea" → named MCP service target
- `/induct-research <target>` → direct invocation

## Parameters

### `<target>` (required)
What to induct. Three formats accepted:

| Format | Example | Behavior |
|--------|---------|----------|
| **File path** | `.aiwg/research/queue/` | Read all `.md` files in the directory |
| **Single file** | `.aiwg/research/queue/ref-dapper.md` | Induct one source |
| **URI** | `https://arxiv.org/abs/2307.09288` | Fetch and induct the paper at that URL |
| **Directory glob** | `papers/**/*.pdf` | Induct all matched files recursively |
| **Issue reference** | `gitea:roctinam/research#42` | Read the issue body as a research stub |

### `--repo <dest>` (optional)
Where to file induction tasks. Accepts the same three formats as `--induct-research` in issue-planner:

| Format | Example | Behavior |
|--------|---------|----------|
| File path | `--repo .aiwg/research/inducted/` | Write task `.md` files locally |
| URI | `--repo https://git.integrolabs.net/roctinam/research` | File issues to that Gitea/GitHub/Jira instance |
| Named MCP | `--repo gitea` | Use `mcp__gitea__issue_write` directly |
| Named MCP | `--repo codehound` | Register in Hound search index |

Falls back to `AIWG_RESEARCH_REPO` env var if `--repo` is omitted.

### `--dry-run` (optional)
List what would be inducted and where, without writing or filing anything.

### `--priority high|medium|low` (optional)
Override the suggested priority for all inducted items. Default: assessed per source.

### `--tag <topic>` (optional)
Apply a topic tag to all inducted items. Repeatable: `--tag llm --tag evaluation`.

### `--recursive` (optional)
When target is a directory, recurse into subdirectories. Default: top-level only.

---

## Execution Flow

### Phase 1: Source Discovery

1. **Parse `<target>`** — determine input type (file, directory, URI, issue ref)
2. **Collect sources**:
   - **File/directory**: glob for `.md`, `.pdf`, `.txt`, `.yaml` files
   - **URI**: fetch the resource; detect type (paper, doc page, repo, issue)
   - **Issue reference**: fetch issue body and all comments via MCP or CLI
3. **Deduplicate** — skip sources already present in the destination repo (if queryable)
4. **Report discovery**:

```
Found 9 sources to induct:
  3 Markdown stubs (.aiwg/research/queue/)
  4 PDF papers (papers/2024/)
  2 URI references
  Skipping 1 (already inducted: REF-042)
```

---

### Phase 2: Source Acquisition (acquire before analyze)

**CRITICAL**: Never write analysis docs from metadata or abstracts alone. The pipeline is:
**acquire full content → read full content → write analysis doc.**

This was learned from a session where 88 of 120 papers were inducted as shallow stubs
written from arXiv abstract pages — not the actual papers. See #817.

For each source, ensure full content is available before analysis:

**For PDFs / full papers**:
1. **Acquire the PDF** — call `/research-acquire <url> --extract-text` to download the PDF
   to `sources/pdfs/full/` and extract full text to `sources/text/`
2. **Verify acquisition** — confirm the PDF exists at the expected path and is non-empty
3. **If the first path fails**, do NOT conclude the source is unavailable. Run the
   unavailability gate below. Only after it completes may you record a deficit status,
   and never write a full analysis doc from the abstract alone.

**For URIs (web sources)**:
1. **Fetch the full page** (WebFetch) — save to `sources/web/<slug>.html`
2. **Classify**: paper, blog post, official docs, repo README, specification, news
3. **If paper**: call `/research-acquire` to get the actual PDF — do not analyze from
   the landing page HTML
4. **If non-paper web source**: the fetched HTML/text is the full content — proceed to analysis

**For Markdown stubs** (from issue-planner queue files):
- Read the stub content and relevance summary
- If the stub references a paper URL: acquire the PDF first (same as above)
- If the stub is a research brief with no external source: proceed as-is

**For issue references**:
- Read full issue body and comments
- Extract referenced URLs, files, or topics
- If URLs point to papers: acquire PDFs before analysis
- If no external sources: treat as a research brief stub

#### Unavailability gate (before recording any acquisition deficit)

Applies to every source type above, not just PDFs. One failing request is not evidence of
unavailability. Before recording
`pending-acquisition` or `acquisition-deficit`, complete both steps and record what each
returned. Both are cheap; step B is cheaper than any network call.

**A. Enumerate the host's access paths.** Try them in order rather than inventing one:

| Host | Try, in order |
|------|---------------|
| Hugging Face | `resolve/main/<file>`, `raw/main/<file>`, `api/datasets/<id>`, `api/.../tree/main?recursive=true`, `api/.../croissant`, `datasets-server/splits`, `hf-mirror.com` |
| arXiv | `/abs/<id>`, `/pdf/<id>`, `/e-print/<id>` |
| Publisher DOI | publisher URL, Unpaywall, Europe PMC, Semantic Scholar `openAccessPdf`, arXiv full-text search, author/lab pages, institutional repository |
| Conference | ACL Anthology, PMLR, OpenReview, proceedings site |

Two traps worth naming, because both have produced false "gated" verdicts:

- On Hugging Face, `raw/main/README.md` can return **401** while `resolve/main/README.md`
  returns **200 with the complete card** — same repo, same revision, same anonymous client.
  The API's `description` field is also truncated (~600 chars) where the card behind
  `resolve/main` is not.
- `export.arxiv.org/api/query` returns **503** from some networks while `arxiv.org/abs`
  serves fine with a browser UA. An API failure is not source unavailability.

**B. Check the corpus before declaring unavailable.** Ask both, and record the answers:

1. Does the corpus already hold a source that **introduces, specifies or evaluates** this
   artifact? Benchmarks, datasets, models and tools are usually defined in a paper, and
   that paper is often already inducted and text-extracted on local disk.
2. Is there an **open-access companion** — preprint, technical report, or a same-group
   paper on the same subject — covering the claim the citing document needed?

Both are `grep`/index queries against `sources/text/` and the corpus index.

**Record the outcome as a named obstacle, not a bare flag.** `pending-acquisition` alone
conflates four states that need different actions:

| State | Means | Action |
|-------|-------|--------|
| `not-attempted` | ordinary backlog | do the work |
| `credential-required` | one credential away (e.g. needs `HF_TOKEN`) | credential decision |
| `structurally-unobtainable` | closed access, N services checked | subscription decision, or accept |
| `artifact-absent` | the named artifact was never published | close as not-planned |

Write the state and the specific obstacle — `structurally-unobtainable: closed access;
Unpaywall reports zero OA locations; Semantic Scholar reports the publisher elided the
abstract; no arXiv preprint` — not `acquisition-failed: true`. A bare boolean cannot be
triaged, and the paths-tried record is what makes the verdict credible to a reader.

For tracker hand-off, mirror the state as a label (`blocked:credential-required`,
`blocked:structurally-unobtainable`, `artifact-absent`) so the distinction survives into
triage instead of collapsing into one undifferentiated queue.

### Phase 2.5: Per-Source Analysis (on full content)

Only after full content is acquired, run analysis:

**For PDFs / full papers** (with full text available):
- Read the **full extracted text**, not just the abstract
- Extract title, authors, year, abstract, methodology, key findings, limitations
- Identify key claims with specific evidence (quotes, figures, tables)
- Assess relevance to existing corpus (check `.aiwg/research/` for related REF-XXX files)
- Assign GRADE quality level (A–D) based on source type and peer-review status
- Target: analysis docs should be 150-300 lines with substantive content from the paper

**For web sources** (with full content saved):
- Read the full saved page content
- Extract key points, methodology if applicable, credibility indicators
- Assess relevance and quality

**Quality gate**: If the resulting analysis doc is under 80 lines, flag it as a potential
stub. Either the source content wasn't fully read or the analysis was superficial.
Consider re-running with explicit instructions to read the full text.

#### Cheap-verification gate (stated uncertainty is not a terminal state)

Honest limitation sections are good, but they are the **residue after cheap checks**, not a
substitute for them. An induction that completes while carrying "no OpenReview query was
run" has not declared a limitation — it has skipped a one-request check and described the
skip. That reads as diligence and is a provenance gap.

**Rule.** Before writing any statement of the form *"X was not checked / not retrieved /
not queried / is unverified / rests on Y rather than an independent record"*, either:

1. **Resolve it**, if resolving costs roughly one request against a known endpoint; or
2. **Record why it is not cheap** — endpoint unknown, rate-limited after N attempts with
   backoff, requires a credential, behind an anti-bot wall, paywalled — naming the
   specific obstacle.

"I did not check" is not an acceptable terminal state on its own. "I could not check,
because `pubpeer.com` returns HTTP 403 to this client" is.

**The four cheap checks to run by default.** Named explicitly because agents do not reach
for them unprompted:

- **Venue confirmation.** If `source_type` is `peer_reviewed_*` on the strength of an arXiv
  comment or a LaTeX template, confirm against an independent record — OpenReview, ACL
  Anthology, PMLR, DBLP — before asserting it. **A conference template is not evidence of
  acceptance.** If confirmation fails, demote to `preprint` rather than asserting the venue.
- **Published version.** Once a peer-reviewed venue is confirmed, fetch the camera-ready and
  archive it alongside the preprint. Record the diff — page count, extracted-text size,
  occurrence counts for the doc's own headline claims — so a reader knows whether the
  analysis needs re-reading. "Materially identical, no analysis changed" is a *finding*;
  assuming it is not.
- **Asserted URLs.** Probe every code, project and dataset URL the document asserts. An
  originating issue carrying a wrong GitHub URL is a normal occurrence, and nothing else in
  this flow would catch it.
- **Retraction and citation census.** Run both by default. OpenAlex (`is_retracted`,
  unauthenticated) and Semantic Scholar (`citationCount`, `influentialCitationCount`) are one
  call each. Record the source and the date, and **record a null result as a null result**
  — `is_retracted: false, OpenAlex, 2026-09-12` — never as the absence of a check. A census
  also does real work: a high influential-citation count independently corroborates a GRADE
  assignment and can reframe in-corpus sidecars that reference the work.

  **Use OpenAlex for `is_retracted` only — never for counts.** It indexes the preprint and
  published records separately and does not merge them; an 18x undercount has been observed
  (178 vs 3,205 for the same paper). It is the obvious fallback when Semantic Scholar
  throttles, and substituting it records wrong counts with no error and no signal. Never
  swap in a count source without calibrating it against a known-high-count paper first.
  Semantic Scholar throttles hard enough that misses are expected — record a miss as a miss
  rather than substituting an uncalibrated source. Per-service operating characteristics,
  failure modes, and API-key handling:
  [`bibliographic-services.md`](../../docs/bibliographic-services.md).

**Register the residue as a check, not as prose.** Any uncertainty that survives the gate
must be recorded as a declared check with an outcome, so it lands as `incomplete` or
`blocked` per [`verification-contracts.md`](../../../../../../docs/verification-contracts.md)
instead of as narrative an automated reader cannot see.

The `research/uncertainty-registered` lint rule checks this on induction output: it flags a
clause stating an unperformed action against a verification target with no obstacle named
nearby. It is a prose heuristic, so it runs at `warn` — on a 2,544-reference corpus it
flagged 34 clauses, of which roughly 31 were genuine, including every gap a hand audit had
found independently. Run it with the rest of the research ruleset:

```bash
aiwg lint <corpus-root> --ruleset research
```

**Worked example.** The same uncertainty, stated three ways:

| Statement | Verdict |
|-----------|---------|
| "ICLR 2024 attribution rests on the arXiv comment and the `iclr2024_conference` template. No OpenReview or proceedings query was run." | **Not acceptable alone.** One query against a known endpoint was available and skipped. |
| "OpenReview queried 2026-09-12; acceptance confirmed as ICLR 2024 poster (plus an ATTRIB workshop listing)." | **Acceptable** — resolved. |
| "PubPeer not checked — `pubpeer.com` returns HTTP 403 to this client." | **Acceptable** — named obstacle, correctly not cheap. |

Scope note: this gate is about *cheap* checks. It does not ask for exhaustive verification,
and "expensive, and here is the specific reason" remains a valid outcome.

#### Bibliography ground truth (what the paper actually cites)

Citation edges and reference counts come from the **compiled** bibliography. For arXiv
e-print sources the shipped `.bib` is the author's *library*, not the paper's reference
list: it routinely contains entries that were never cited. Treating it as the membership
set fabricates edges and inflates counts.

**1. Authoritative sources, in order of preference:**

1. `.bbl` — `\bibitem` for natbib/plain, `\entry{}` for biblatex. What the paper printed.
2. `\begin{thebibliography}` inline in the `.tex`, when no `.bbl` ships.
3. The reference list in the extracted PDF text.
4. The shipped `.bib` — **only** to enrich metadata for entries already confirmed present
   by 1–3. Never as the membership set.

A 15-entry gap between a shipped `.bib` (81) and its compiled `.bbl` (66) is ordinary, not
a sign of a broken artifact.

**2. Counts come from counting entries in the compiled bibliography.** Count `\bibitem` /
`\entry` occurrences. Never use `.bib` size, and never sum artifacts — summing `.bib` and
`.bbl` without dedup has produced counts inflated by 2–3x (209 claimed vs 100 actual; 38 vs
12). **Record the counting method alongside the number**, and note printed-vs-unique where
they differ (92 printed, 90 unique).

**3. Confirm every asserted edge against the printed entry** — not by title similarity
against a corpus index. Record *how* each edge was confirmed: arXiv ID, exact title, or
printed-entry read.

Two failure modes title matching cannot catch:

- **Author-year collisions.** "Zou et al. 2023" may be GCG *or* Representation Engineering —
  same first author, same year, different work. Author-year and fuzzy-title resolution both
  land on the wrong node. Only reading the printed entry disambiguates.
- **Brace-escaped titles.** `{AI}`, `{Prompt}-{Driven}` defeat naive matching; normalise
  before comparing.

**4. Record rejections.** When a candidate edge is dropped because it is `.bib`-only, say so
in the sidecar. This stops a later extraction pass silently reintroducing it.

**Tooling.** `tools/research/bibliography-resolver.mjs` applies this hierarchy mechanically
against an e-print source directory — it picks the authoritative artifact, counts entries
with the method recorded, normalises brace-escaped titles, resolves against a corpus
`REF<TAB>title<TAB>arxivId` index, and lists `.bib`-only rejections:

```bash
node tools/research/bibliography-resolver.mjs <source-dir> --index <corpus-index.tsv> [--json]
```

Per entry it reports `title`, `year`, `arxiv`, `ref`, and `confirmedBy` — one of
`arxiv-id`, `exact-title`, or `unresolved`. An unresolved entry carries `ref: null`,
never an empty string. When a printed title matches more than one corpus REF (the
corpus inducts some works twice), it resolves to the lowest REF and lists the twins in
`ambiguous` so the `Confirmed by` choice is auditable rather than silent. It reads
acl_natbib `\href {url} {Title}`, biblatex `\field{title}`, plain natbib, ACM
`\showarticletitle`, and brace-delimited `.bib` fields; venue strings such as
"ArXiv preprint" are never returned as titles.

It refuses to answer from a `.bib` alone. When only `.tex` + `.bib` ship it uses the cited
keys, which is what BibTeX itself would print — the hierarchy's four levels have no answer
for that case, and it is common: one real paper shipped 80,568 `.bib` entries and cited six
works. Prefer the tool over re-deriving the rules per batch, and record its `countMethod`
verbatim.

**5. Direction is a check, not an assumption.** Publication dates bound edge direction: a
work cannot cite something published after it. Assert this explicitly — sidecars have
shipped with outgoing edges to works published up to three years *later*, incoming edges
from works that predate the paper, and edges to papers the work does not cite at all.

---

### Phase 3: Induction Task Filing

For each analyzed source, file one induction task using the standard template.

**Induction task body:**

```markdown
## Reference Induction

**Source**: <URL, file path, or issue reference>
**Type**: <paper | blog | docs | repo | spec | stub | issue>
**GRADE**: <A | B | C | D | unassessed>
**Priority**: <high | medium | low>
**Tags**: <topic1>, <topic2>

## Summary
<2–3 sentences: what this source covers and why it's relevant>

## Key Claims / Findings
- <Specific claim or finding>
- <Specific claim or finding>
- <Specific claim or finding>

## Relevance to Corpus
<How this relates to existing research — cross-references to REF-XXX if applicable>

## Induction Checklist
- [ ] Read full source
- [ ] Extract key insights as Zettelkasten notes
- [ ] Cross-reference with existing corpus
- [ ] Assign REF-XXX identifier
- [ ] Tag with topic taxonomy
- [ ] Assess with /research-quality
- [ ] Archive with /research-archive (if paper/PDF)
- [ ] Add to citation graph with /research-cite

### Cheap-verification gate
- [ ] Venue confirmed against an independent record (not a LaTeX template), or demoted to `preprint`
- [ ] Published version fetched and archived if peer-reviewed; diff vs preprint recorded
- [ ] Every asserted code/project/dataset URL probed
- [ ] Retraction check run (source + date recorded, null result recorded as null)
- [ ] Citation census run (source + date recorded)
- [ ] Every surviving uncertainty registered as a declared check, not written as prose only

### Bibliography
- [ ] Edges taken from the compiled bibliography (`.bbl` / inline / PDF list), not the shipped `.bib`
- [ ] Reference count states its counting method
- [ ] Each edge's confirmation method recorded; `.bib`-only rejections recorded
- [ ] Edge direction checked against publication dates

## Origin
- Surfaced by: <issue-planner | manual | other>
- Surfaced for: <objective or context>
- Induction date: <YYYY-MM-DD>
```

**Filing based on `--repo` target:**

- **File path**: write `induct-<slug>.md` to destination directory
- **Gitea URI/MCP**: `mcp__gitea__issue_write` with label `research-induction`
- **GitHub URI**: `gh issue create --label research-induction`
- **Jira URI**: REST `POST /rest/api/2/issue` with issue type Task
- **Codehound MCP**: register URI in search index, create stub document

---

### Phase 3.5: Cross-Reference Fan-Out

After creating each new literature note, update the broader corpus with bidirectional cross-references. This is what makes a corpus **compound** rather than just accumulate.

Citation edges written here are subject to the **bibliography ground truth** rules in
Phase 2.5: membership comes from the compiled bibliography, each edge records its
confirmation method, `.bib`-only rejections are recorded, and direction is checked against
publication dates. Cross-referencing is where a fabricated edge becomes bidirectional and
therefore twice as expensive to unwind.

For each newly inducted source:

1. **Search existing findings** for topically related REF-XXX notes:
   - Match by shared tags
   - Match by overlapping key claims or methodologies
   - Match by citation overlap (both cite the same sources)

2. **Add "Related Sources" cross-references**:
   - In the **new note**: add a `## Related Sources` section listing existing REF-XXX notes and how they relate (confirms, contradicts, extends, prerequisite)
   - In **existing notes**: append the new REF-XXX to their `## Related Sources` section with relationship type
   - Before writing a citation edge in either direction, check the two publication dates.
     A work cannot cite something published after it; if the dates say otherwise, the edge
     is mis-directed or points at the wrong node.

3. **Flag contradictions or confirmations**:
   - If the new source contradicts an existing finding, add a `contradiction` marker to both notes
   - If it confirms an existing finding, add a `confirms` marker

4. **Update synthesis documents** in `.aiwg/research/synthesis/`:
   - If a relevant synthesis document exists, append a note that new evidence is available

**Example cross-reference entry:**

```markdown
## Related Sources

- **REF-034** — Confirms: both identify prompt injection as the primary attack vector for LLM agents
- **REF-042** — Extends: this source adds quantitative benchmarks missing from REF-042's qualitative analysis
- **REF-067** — Contradicts: claims agent sandboxing overhead is <5%, while REF-067 measured 15-20%
```

**Batch optimization**: When inducting multiple sources in a batch, defer cross-referencing until all new notes are created, then run a single fan-out pass across all new + existing notes. This avoids redundant searches.

**Skip conditions**: Skip cross-referencing when:
- `--dry-run` is set
- Source is filed as a stub (not yet fully documented)
- Fewer than 3 existing REF-XXX notes in the corpus (too early for meaningful cross-refs)

---

### Phase 4: Summary Report

```
## Induction Summary

| # | Source | Type | Priority | Filed At |
|---|--------|------|----------|----------|
| 1 | RFC 9110 HTTP Semantics | spec | high | gitea#301 |
| 2 | "Dapper" Google Tracing Paper | paper | high | gitea#302 |
| 3 | opentelemetry.io/docs | docs | medium | gitea#303 |
| 4 | github.com/jaegertracing/jaeger | repo | medium | gitea#304 |
| 5 | arxiv.org/abs/2012.15161 | paper | low | gitea#305 |
...

Inducted: 9
Skipped: 1 (already present)
Destination: gitea:roctinam/research

Next steps:
- /research-acquire <URL> for any paper that needs PDF download
- /research-document to annotate inducted sources
- /research-quality to score GRADE for each inducted item
```

---

## Target Resolution Logic

```
resolve_target(target):
  if target starts with "http://" or "https://":
    host = extract_host(target)
    if host matches known_gitea_instances: use mcp__gitea__issue_write
    if host == "github.com": use gh CLI
    if host matches jira pattern: use Jira REST API
    else: fetch as web resource, induct as URI reference

  elif target matches "gitea:<owner>/<repo>#<n>":
    fetch issue via mcp__gitea__issue_read

  elif target is a named MCP service ("gitea", "codehound", "github"):
    use that service's write/register tool directly

  elif target is a file path:
    if path is directory: glob for .md/.pdf/.txt files
    if path is a file: induct single source
```

---

## Batch Mode — Directory of Papers

When target is a directory, process all supported files:

```
/induct-research papers/2024/ --repo gitea --tag llm --recursive
```

```
⏳ Scanning papers/2024/ (recursive)...
  Found 23 PDF files
  Found 7 Markdown stubs
  Found 2 YAML records
  Deduplicating against gitea:roctinam/research...
    Skipping 4 (already inducted)

⏳ Analyzing 28 sources (parallel agents)...
  ✓ Batch A (7 sources): complete
  ✓ Batch B (7 sources): complete
  ✓ Batch C (7 sources): complete
  ✓ Batch D (7 sources): complete

⏳ Filing 28 induction tasks to gitea:roctinam/research...
✓ Inducted: 28 | Skipped: 4 | Total: 32
```

---

## Integration with issue-planner

`issue-planner --induct-research <target>` calls this skill's Phase 3 (filing) logic directly after Phase 2 research synthesis. The references are the URLs and sources discovered during the parallel research pass.

`/induct-research` can also be invoked standalone to process:
- Pre-existing queues: `/induct-research .aiwg/research/queue/`
- Ad-hoc papers: `/induct-research https://arxiv.org/abs/2307.09288`
- Full directories: `/induct-research ~/Downloads/papers/ --repo gitea`

---

## Composition

```
induct-research <target>
    │
    ├── Phase 1: Source discovery
    │   ├── File/directory: glob + read
    │   ├── URI: WebFetch + classify
    │   └── Issue ref: mcp__gitea__issue_read or gh CLI
    ├── Phase 2: Source acquisition (acquire before analyze)
    │   ├── PDF/paper → /research-acquire --extract-text
    │   ├── URI → WebFetch full page → /research-acquire if paper
    │   ├── Stub with URL → acquire referenced source
    │   └── Unavailability gate before any deficit status
    │       ├── A: enumerate the host's access paths, record each result
    │       ├── B: corpus-first — introducing source? OA companion?
    │       └── Record a named obstacle + state, never a bare flag
    ├── Phase 2.5: Per-source analysis (on full content only)
    │   ├── PDF agent → read full text, extract claims + GRADE
    │   ├── Web agent → read full saved page, assess credibility
    │   ├── Stub agent → parse relevance summary
    │   ├── Quality gate: flag docs under 80 lines as potential stubs
    │   ├── Cheap-verification gate: venue, published version, URLs, census
    │   │   └── Residue registered as a declared check, not prose
    │   └── Bibliography ground truth: compiled .bbl over shipped .bib
    ├── Phase 3: Induction task filing
    │   ├── File path → write .md task files
    │   ├── Gitea URI/MCP → mcp__gitea__issue_write
    │   ├── GitHub URI → gh issue create
    │   └── Codehound MCP → register in search index
    ├── Phase 3.5: Cross-reference fan-out
    │   ├── Search existing findings by tags + claims
    │   ├── Add bidirectional Related Sources sections
    │   ├── Flag contradictions / confirmations
    │   └── Update synthesis documents
    └── Phase 4: Summary report
```

## References

- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/skills/issue-planner/SKILL.md — Calls induct-research during Phase 2b
- @$AIWG_ROOT/agentic/code/frameworks/research-complete/skills/research-acquire/SKILL.md — Full PDF acquisition (called for paper URIs)
- @$AIWG_ROOT/agentic/code/frameworks/research-complete/skills/research-document/SKILL.md — Annotate inducted sources
- @$AIWG_ROOT/agentic/code/frameworks/research-complete/skills/research-quality/SKILL.md — GRADE scoring for inducted items
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/skills/address-issues/SKILL.md — Analogous pattern for code issues
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/subagent-scoping.md — Parallel batch analysis constraints
- @$AIWG_ROOT/docs/verification-contracts.md — Declared checks; prose uncertainty must be registered as one (#2523)
- @$AIWG_ROOT/agentic/code/frameworks/research-complete/templates/citation-sidecar.md — `Confirmed by`, `Rejected Candidates`, `bibliography` and `acquisition-obstacle` fields (#2524, #2525)
- @$AIWG_ROOT/agentic/code/frameworks/research-complete/skills/sidecar-lint/SKILL.md — Structural lint for the sidecars this skill writes
- @$AIWG_ROOT/tools/research/bibliography-resolver.mjs — Applies the bibliography hierarchy mechanically (#2525)
- @$AIWG_ROOT/agentic/code/frameworks/research-complete/docs/bibliographic-services.md — Per-service operating characteristics, the OpenAlex count trap, throttling budget (#2539)
- @$AIWG_ROOT/agentic/code/frameworks/research-complete/lint/uncertainty-registered.yaml — Flags uncertainty stated without an obstacle (#2523)

## Storage Routing (#934, #968)

This skill's persistence flows through `resolveStorage('research')`. On the default `fs` backend the research corpus lives at `.aiwg/research/`. **Heavy artifacts (papers, archived sources) can move to a secondary drive** by setting `roots.research` in `.aiwg/storage.config` (one of the headline #934 use cases).

```bash
aiwg research-store path                            # resolved root
aiwg research-store list --prefix sources/
aiwg research-store get sources/paper-123.md
```
