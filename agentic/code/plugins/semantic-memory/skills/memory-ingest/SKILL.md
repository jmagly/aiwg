---
name: memory-ingest
description: Ingest a source into any consumer's semantic memory by reading the topology contract
namespace: aiwg
category: kernel
platforms: [all]
triggers:
  - "help my AI remember what we decided"
  - "help me preserve project decisions between sessions"
  - "choose memory KB or project artifact flow"
  - "memory ingest"
---

# memory-ingest

This remains the canonical semantic synthesis workflow. Dataset Intelligence
can register its source and evidence, but raw dataset ingestion does not replace
summary, entity, contradiction, topology, or cross-reference behavior. See the
[dataset migration guide](https://github.com/jmagly/aiwg/blob/main/agentic/code/addons/dataset-intelligence/docs/migration-guide.md).

Ingest an external source into a consumer framework's semantic memory. Reads the consumer's `memory.topology` contract to know where pages live, then extracts, summarizes, integrates, and cross-references — all topology-agnostic.

## Session catalog sources

For normalized session events or catalog candidates, first use
`aiwg show skill session-harvest`. Session knowledge uses the catalog's exact
candidate-version review and `sessions promote` gateway, retaining the
source-event → candidate → destination receipt. Do not flatten session output
into an external-source file to bypass that review path. General semantic
synthesis may consume an authorized promoted page while retaining its lineage;
ordinary external documents continue through the workflow below.
## When to Use

When new knowledge (a document, paper, URL, config file, or directory of files) needs to enter a consumer's semantic memory. This is the primary write path for external information.

## Parameters

### source (required)
Path to the source material. Supports: markdown (`.md`), PDF (`.pdf`), HTML (`.html`), YAML (`.yaml`/`.yml`), JSON (`.json`), a directory of files, or a URL.

### --consumer (optional)
Consumer ID to ingest into. Resolved via ADR-021 D4 precedence:
1. **Explicit** — `--consumer research-complete`
2. **Wrapper** — set by a calling skill or orchestrator
3. **Auto-detect** — cwd detection or active framework in `.aiwg/frameworks/registry.json`

### --dry-run (optional)
Preview what would be created/modified without writing any files. Outputs the planned page list, cross-references, and contradiction flags.

### --non-interactive (optional)
Skip the discussion step and proceed directly to extraction and page writing. Use for batch ingestion or CI pipelines.

## Operation

### 1. Resolve consumer

Determine which consumer's memory to target using ADR-021 D4 precedence. Fail with a clear error if no consumer can be resolved.

### 2. Load schema

Read `memory.topology` from the consumer's `manifest.json`. Extract:
- `rootDir` — base path for all memory pages
- `derivedPages.summary` — where summary pages are written
- `pageTemplate` — structure the summary must conform to
- `crossRefStyle` — how cross-references are formatted (e.g., wiki-links, markdown links)
- `indexPath` — location of the consumer's memory index
- `log` — path to `.log.jsonl`
- `ingestRequires` — optional list of required post-ingest actions (e.g., `"provenance"`)

### 3. Read source

Parse the source material based on type:
- **Markdown/HTML** — extract text, headings, and structure
- **PDF** — extract text content (use page ranges for large documents)
- **YAML/JSON** — parse structured data, identify key entities
- **Directory** — recursively read all supported files, treating each as a sub-source
- **URL** — fetch content, then parse based on content type

### 4. Discuss (interactive default)

**Default behavior** (no `--non-interactive` flag):
1. Present a concise summary of the source to the user
2. Highlight key takeaways, entities, and concepts found
3. Ask the user what to emphasize, de-prioritize, or reframe
4. Incorporate user guidance into the extraction strategy

This discussion-first pattern ensures the memory reflects human judgment, not just mechanical extraction.

### 5. Extract and summarize

Use LLM to produce a structured summary conforming to the consumer's `pageTemplate`. The summary captures:
- Key claims and findings
- Named entities (people, systems, concepts)
- Relationships between entities
- Source metadata (title, author, date, URI)

### 6. Integrate

- **Write summary page** to `derivedPages.summary` path
- **Update entity/concept pages** — for each entity or concept mentioned, update or create the relevant page under the consumer's entity directory, adding the new information with source attribution
- **Insert cross-references** — link the summary page to entity pages and vice versa, using the consumer's `crossRefStyle`

### 7. Contradiction detection

Compare new claims against existing pages. When a contradiction is found:
- **Flag inline** on the affected existing page using a callout:
  ```markdown
  > [!contradiction]
  > Source "paper.pdf" (2026-04-14) claims X, but this page states Y.
  > Ingested via memory-ingest — awaiting human resolution.
  ```
- **Log the contradiction** in `.log.jsonl` with `"contradictions"` count and details
- **Do not auto-resolve** — surface contradictions for human judgment

### 8. Update index

Regenerate the entry for the new summary page in the consumer's index at `indexPath`. Include title, source reference, date, and cross-ref targets.

### 9. Append log

Call `memory-log-append` with:
```
--consumer <resolved> --op ingest --data '{"source":"<path>","pages_touched":[...],"contradictions":<n>,"cross_refs_added":<n>}'
```

### 10. Optional provenance

If `ingestRequires` includes `"provenance"`, create a W3C PROV record documenting:
- `prov:Entity` — the new summary page
- `prov:Activity` — the ingest operation
- `prov:wasDerivedFrom` — the source material
- `prov:wasGeneratedBy` — this skill invocation
- `prov:wasAttributedTo` — the actor (model + user)

### 11. Report

Output a summary:
- Pages created or updated (with paths)
- Contradictions flagged (count and locations)
- Cross-references added (count)
- Provenance record path (if created)

## Error Handling

- **Consumer not found** — fail with actionable message listing available consumers
- **Source unreadable** — fail with format-specific guidance (e.g., "PDF extraction requires the Read tool with page ranges")
- **Schema missing fields** — warn and use sensible defaults; log the gap for `memory-lint` to catch
- **Log write failure** — non-blocking; report primary operation result regardless

## Examples

```
# Interactive ingest of a research paper
memory-ingest docs/papers/distributed-consensus.pdf --consumer research-complete

# Batch ingest a directory of meeting notes
memory-ingest .aiwg/working/meeting-notes/ --consumer sdlc-complete --non-interactive

# Dry run to preview what would change
memory-ingest https://example.com/api-spec.html --consumer sdlc-complete --dry-run

# Explicit consumer override
memory-ingest design-doc.md --consumer media-marketing-kit --non-interactive
```

## Related Skills

- `memory-log-append` — log write primitive (called in step 9)
- `memory-lint` — validates memory page structure and cross-ref integrity
- `memory-query-capture` — captures query patterns for memory optimization
- `provenance-create` — W3C PROV record creation (called in step 10 when required)

## Storage Routing (#934, #966)

This skill's persistence flows through `resolveStorage('memory')`. On the default `fs` backend the memory subsystem lives at `.aiwg/memory/` and behavior is byte-identical to direct file writes. To redirect memory artifacts into Obsidian, Logseq, Fortemi, or another backend without changing this skill, configure `.aiwg/storage.config` (#934).

When this skill needs to read or write memory artifacts from a Bash step:

```bash
aiwg memory path                        # resolved root (fs only)
aiwg memory list --prefix research-complete/
aiwg memory get research-complete/index.md
echo "# index" | aiwg memory put research-complete/index.md
echo '{"op":"ingest","summary":"foo"}' | aiwg memory append-log research-complete/.log.jsonl
```

The `aiwg memory append-log` subcommand uses atomic `O_APPEND` (#976) on the fs backend — concurrent appenders don't race.
