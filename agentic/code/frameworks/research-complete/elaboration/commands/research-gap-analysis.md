---
description: Analyze research coverage, identify gaps, and suggest future research directions
category: research-management
argument-hint: [--topic <area>] [--depth <level>]
allowed-tools: Read, Write, Grep
model: claude-sonnet-5
---

# Research Gap Analysis Command

## Task

Perform comprehensive gap analysis of research collection. Identifies under-researched topics, contradictory findings, and missing research integrations.

When invoked with `/research-gap-analysis [options]`:

1. **Cluster** papers by topic
2. **Identify** sparse coverage areas
3. **Detect** contradictory findings
4. **Suggest** missing research angles

## Parameters

- **`--topic <area>`** (optional): Focus gap analysis on specific topic
- **`--depth <level>`** (optional): Analysis depth (`quick`, `standard`, `comprehensive`)

## Outputs

- **Gap report**: `.aiwg/research/analysis/gap-analysis.md`
- **Research agenda**: `.aiwg/research/analysis/future-research-agenda.md`

## Related Agents

- **Discovery Agent** (@$AIWG_ROOT/agentic/code/frameworks/research-complete/elaboration/agents/discovery-agent-spec.md)

## Skill Definition

**Natural Language Patterns**:
- "Analyze research gaps"
- "What's missing in the literature?"
- "Find under-researched topics"
- "Identify contradictions"

## References

- @$AIWG_ROOT/agentic/code/frameworks/research-complete/elaboration/use-cases/UC-RF-009-perform-gap-analysis.md

---

**Status**: DRAFT
**Created**: 2026-01-25
**UC Mapping**: UC-RF-009
