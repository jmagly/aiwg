---
description: Execute complete research workflow from discovery to export
category: research-management
argument-hint: <query> [--output-format <type>]
allowed-tools: Bash, Read, Write, Grep, Glob
model: claude-sonnet-5
---

# Research Workflow Command

## Task

Orchestrate complete end-to-end research workflow: discover → acquire → document → cite → quality check → archive → export.

When invoked with `/research-workflow <query> [options]`:

1. **Discover** papers via semantic search
2. **Acquire** PDFs for selected papers
3. **Document** with structured notes
4. **Integrate** citations and claims
5. **Assess** quality (FAIR compliance)
6. **Archive** versioned collection
7. **Export** to desired formats

## Parameters

- **`<query>`** (required): Research topic or question
- **`--output-format <type>`** (optional): Final export format (`bibtex`, `obsidian`, `zotero`)
- **`--limit <count>`** (optional): Number of papers to process (default: 20)

## Workflow Steps

### Step 1: Discovery
```bash
aiwg research discover "$QUERY" --limit $LIMIT
```

### Step 2: Acquisition
```bash
aiwg research acquire --all
```

### Step 3: Documentation
```bash
aiwg research document --all
```

### Step 4: Citation Integration
```bash
aiwg research cite --style bibtex --build-network
```

### Step 5: Quality Assessment
```bash
aiwg research quality --all --checklist fair
```

### Step 6: Archival
```bash
aiwg research archive --version v$(date +%Y%m%d)
```

### Step 7: Export
```bash
aiwg research export "$OUTPUT_FORMAT"
```

## Related Agents

- **Workflow Agent** (@$AIWG_ROOT/agentic/code/frameworks/research-complete/elaboration/agents/workflow-agent-spec.md)

## Skill Definition

**Natural Language Patterns**:
- "Complete research workflow for {query}"
- "Full research pipeline on {topic}"
- "End-to-end research on {subject}"

## References

- @$AIWG_ROOT/agentic/code/frameworks/research-complete/elaboration/use-cases/UC-RF-008-execute-research-workflow.md

---

**Status**: DRAFT
**Created**: 2026-01-25
**UC Mapping**: UC-RF-008
