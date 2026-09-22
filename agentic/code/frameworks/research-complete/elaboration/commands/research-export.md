---
description: Export research artifacts in multiple formats (BibTeX, Obsidian, Zotero, OAIS)
category: research-management
argument-hint: <format> [--destination <path>]
allowed-tools: Bash, Read, Write
model: claude-sonnet-5
---

# Research Export Command

## Task

Export research artifacts in formats compatible with external tools and repositories. Supports BibTeX, Obsidian vaults, Zotero libraries, and OAIS preservation packages.

When invoked with `/research-export <format> [options]`:

1. **Collect** artifacts for export
2. **Transform** to target format
3. **Package** with metadata
4. **Output** to specified destination

## Parameters

- **`<format>`** (required): Export format (`bibtex`, `obsidian`, `zotero`, `oais-sip`)
- **`--destination <path>`** (optional): Output path (default: `.aiwg/research/exports/`)

## Outputs

- **BibTeX**: `.aiwg/research/exports/bibliography.bib`
- **Obsidian**: `.aiwg/research/exports/obsidian-vault/`
- **Zotero**: `.aiwg/research/exports/zotero-library.json`
- **OAIS SIP**: `.aiwg/research/exports/oais-sip.tar.gz`

## Related Agents

- **Archival Agent** (@$AIWG_ROOT/agentic/code/frameworks/research-complete/elaboration/agents/archival-agent-spec.md)

## Skill Definition

**Natural Language Patterns**:
- "Export to BibTeX"
- "Create Obsidian vault"
- "Generate Zotero library"
- "Package for OAIS"

## References

- @$AIWG_ROOT/agentic/code/frameworks/research-complete/elaboration/use-cases/UC-RF-010-export-research-artifacts.md

---

**Status**: DRAFT
**Created**: 2026-01-25
**UC Mapping**: UC-RF-010
