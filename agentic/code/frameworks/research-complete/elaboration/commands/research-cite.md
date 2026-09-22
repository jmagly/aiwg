---
description: Format citations, back claims with evidence, and build citation networks
category: research-management
argument-hint: <claim-text> [--style <format>] [--back-claim]
allowed-tools: Read, Write, Grep, Glob
model: claude-sonnet-5
---

# Research Citation Command

## Task

Format citations in multiple styles (APA, IEEE, ACM), back claims with research evidence, and visualize citation networks.

When invoked with `/research-cite [options]`:

1. **Format** citations in specified style
2. **Link** claims to supporting research
3. **Generate** bibliography entries
4. **Build** citation network graphs

## Parameters

- **`<claim-text>`** (required): Claim to back with citations
- **`--style <format>`** (optional): Citation style (`apa`, `ieee`, `acm`, `bibtex`)
- **`--back-claim`** (optional): Find papers supporting the claim

## Outputs

- **Bibliography**: `.aiwg/research/bibliography.bib`
- **Citation network**: `.aiwg/research/analysis/citation-network.dot`
- **Backed claims**: `.aiwg/research/claims/backed-claims.md`

## Related Agents

- **Citation Agent** (@$AIWG_ROOT/agentic/code/frameworks/research-complete/elaboration/agents/citation-agent-spec.md)

## Skill Definition

**Natural Language Patterns**:
- "Cite this claim: {text}"
- "Format citations in APA style"
- "Build citation network"
- "Find papers supporting {claim}"

## References

- @$AIWG_ROOT/agentic/code/frameworks/research-complete/elaboration/use-cases/UC-RF-004-integrate-citations.md

---

**Status**: DRAFT
**Created**: 2026-01-25
**UC Mapping**: UC-RF-004
