---
description: Generate structured summaries, extract claims, and create markdown notes for acquired research papers
category: research-management
argument-hint: [--paper-id <id>] [--all] [--template <type>]
allowed-tools: Read, Write, Grep, Glob
model: claude-sonnet-5
---

# Research Documentation Command

## Task

Generate structured documentation for acquired research papers. Extracts key claims, methodologies, findings, and limitations. Creates markdown notes compatible with Obsidian, Zotero, and other research tools.

When invoked with `/research-document [options]`:

1. **Load** acquired papers (PDFs and metadata)
2. **Extract** text content from PDFs
3. **Summarize** paper structure (abstract, methodology, findings, conclusion)
4. **Identify** key claims and supporting evidence
5. **Generate** markdown notes with structured templates
6. **Link** related papers and citations

## Parameters

- **`--paper-id <id>`** (optional): Document specific paper
- **`--all`** (optional): Document all acquired papers
- **`--template <type>`** (optional): Note template (`research-note`, `literature-review`, `claim-extraction`)

## Outputs

- **Research notes**: `.aiwg/research/notes/{paper-id}.md`
- **Claim database**: `.aiwg/research/claims/claims.json`
- **Summary report**: `.aiwg/research/analysis/documentation-summary.md`

## Related Agents

- **Documentation Agent** (@$AIWG_ROOT/agentic/code/frameworks/research-complete/elaboration/agents/documentation-agent-spec.md)

## Skill Definition

**Natural Language Patterns**:
- "Summarize the papers"
- "Document the research"
- "Extract claims from papers"
- "Create research notes"

## References

- @$AIWG_ROOT/agentic/code/frameworks/research-complete/elaboration/use-cases/UC-RF-003-document-research-paper.md

---

**Status**: DRAFT
**Created**: 2026-01-25
**UC Mapping**: UC-RF-003
