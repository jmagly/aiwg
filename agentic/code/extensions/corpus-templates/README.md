# corpus-templates — research-complete extension

Multi-tier reference-doc templates for research-paper corpora that use the **REF-XXX naming + documentation/references/ + documentation/citations/ + documentation/radar/ quartet** convention (in contrast to the default `.aiwg/research/findings/` workspace topology of research-complete).

## What this extension provides

Four templates that encode a battle-tested corpus convention:

| Template | Sections | Use for |
|----------|---------:|---------|
| `TEMPLATE-reference-canonical.md` | 15 | Default. arXiv preprints, blog posts, technical reports, codebases, surveys. ~84% of corpus docs. |
| `TEMPLATE-reference-expanded.md` | 21 | Foundational / peer-reviewed papers warranting deep analysis. Adds 6 extra sections for benchmarks, ablations, comparisons, limitations. ~12% of corpus docs. |
| `TEMPLATE-citations.md` | (sidecar) | 6-column Outgoing + Incoming citation tables with bidirectional-consistency rules. |
| `TEMPLATES-README.md` | (guide) | Decision guide, section mapping (canonical ↔ expanded), promotion workflow, frontmatter reference. |

## Why these are an extension, not the framework default

research-complete's built-in `agentic/code/frameworks/research-complete/elaboration/templates/REF-XXX-template.md` is designed for:

- Workspace topology: `.aiwg/research/findings/REF-NNN.md`
- FAIR-compliance focus (sections: FAIR Principles Compliance, Provenance, File Integrity)
- Ephemeral workflow output (research artifact tied to an active research workflow)

This extension targets a different convention:

- Workspace topology: `documentation/references/REF-XXX-{author}-{year}-{slug}.md` (stable artifact path)
- Paired sidecar topology: `documentation/citations/REF-XXX-citations.md` + `documentation/radar/REF-XXX-radar.md`
- Source-archive topology: `pdfs/full/REF-XXX-{slug}.pdf` (Git LFS tracked)
- Multi-tier analysis depth (canonical 15-section vs expanded 21-section)
- BibTeX consolidation: per-doc entries + master `bibliographies/master.bib`
- Bibliographic-grade citation network (Outgoing + Incoming tables in sidecars, not free-form prose)

This convention treats the corpus as a stable, queryable research library — distinct from research-complete's workflow-oriented default.

## Origin

These templates were extracted from the shared research corpus (1,061 inducted REFs as of 2026-05-22) after a corpus audit identified the implicit conventions in use. The extraction is documented in:

- 2026-05-22 corpus snapshot (shared research corpus)
- Legacy frontmatter retro-backfill audit (context for why templates were captured)
- `documentation/references/TEMPLATES-README.md` (the decision guide, included here as the canonical reference)

## Installation

```bash
# Deploy the framework with this extension enabled
aiwg use research-complete --extension corpus-templates

# Or deploy templates only (no other research-complete components)
aiwg use research-complete --extension corpus-templates --templates-only
```

After install, templates appear at:

- `documentation/references/TEMPLATE-reference-canonical.md`
- `documentation/references/TEMPLATE-reference-expanded.md`
- `documentation/references/TEMPLATES-README.md`
- `documentation/citations/TEMPLATE-citations.md`

## Using the templates

When inducting a new REF, copy the appropriate template:

```bash
# For most papers (default)
cp documentation/references/TEMPLATE-reference-canonical.md \
   documentation/references/REF-NNNN-{author}-{year}-{slug}.md

# For peer-reviewed / foundational papers
cp documentation/references/TEMPLATE-reference-expanded.md \
   documentation/references/REF-NNNN-{author}-{year}-{slug}.md

# Plus the citation sidecar
cp documentation/citations/TEMPLATE-citations.md \
   documentation/citations/REF-NNNN-citations.md
```

Then fill in the YAML frontmatter (`ref_id`, `title`, `authors`, `year`, `source_type`, `venue`, `url`, `pdf_hash`) and replace each placeholder with paper-specific content.

The `TEMPLATES-README.md` documents which template to pick and how to promote canonical → expanded if a paper proves to need deeper analysis later.

## Companion templates

This extension covers two of the four artifact types in the corpus quartet. The other two have separate canonical templates:

- **Radar sidecar** — `documentation/radar/REF-XXX-radar.md`. Template at `agentic/code/frameworks/research-complete/elaboration/templates/` (uses the standard radar pattern).
- **Entity profile** — `documentation/profiles/{type}/{prof-id}.md`. Template at `documentation/profiles/TEMPLATE-profile.md` (project-local; not yet upstreamed).

Consider filing follow-up extensions for radar-bibliographic and entity-profile templates if those become reusable.

## Activation triggers

This extension is appropriate when:

- Starting a new research-paper corpus that will use REF-XXX naming + documentation/references/ topology
- Wanting tier-1 (15-section) vs tier-2 (21-section) analysis-depth choice
- Building a citation-graph-backed research library rather than a workflow-output store
- Migrating from another corpus convention to the research-papers convention

This extension is NOT appropriate when:

- Using the standard `.aiwg/research/findings/` workspace topology (use research-complete defaults instead)
- The corpus has fewer than ~50 papers (overhead exceeds benefit)
- The corpus is ephemeral / single-use (FAIR-default templates are simpler)

## Validation

After install, verify templates are present:

```bash
ls documentation/references/TEMPLATE-* documentation/citations/TEMPLATE-*
```

Expected: 4 files. Run `aiwg-doctor` to confirm extension is registered with the framework.

## License

MIT. See parent framework license file.

## References

- Parent framework: `agentic/code/frameworks/research-complete/`
- Origin corpus: the shared research corpus
- Decision guide (included here as canonical): `templates/TEMPLATES-README.md`
- Related templates outside this extension:
  - `agentic/code/frameworks/research-complete/elaboration/templates/REF-XXX-template.md` (FAIR-default variant)
  - `documentation/radar/TEMPLATE-radar.md` (radar sidecar pattern)
  - `documentation/profiles/TEMPLATE-profile.md` (entity profile pattern)
