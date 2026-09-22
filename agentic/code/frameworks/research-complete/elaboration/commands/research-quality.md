---
description: Assess research quality using FAIR principles and quality checklists
category: research-management
argument-hint: [--paper-id <id>] [--all] [--checklist <type>]
allowed-tools: Read, Write, Grep
model: claude-sonnet-5
---

# Research Quality Assessment Command

## Task

Evaluate research quality using FAIR principles (Findable, Accessible, Interoperable, Reusable) and domain-specific quality checklists.

When invoked with `/research-quality [options]`:

1. **Assess** FAIR compliance
2. **Evaluate** methodological rigor
3. **Check** reproducibility criteria
4. **Generate** quality scores and reports

## Parameters

- **`--paper-id <id>`** (optional): Assess specific paper
- **`--all`** (optional): Assess all papers
- **`--checklist <type>`** (optional): Quality checklist (`fair`, `consort`, `prisma`, `arrive`)

## Outputs

- **Quality report**: `.aiwg/research/quality/quality-assessment.md`
- **FAIR scores**: `.aiwg/research/quality/fair-scores.json`

## Related Agents

- **Quality Agent** (@$AIWG_ROOT/agentic/code/frameworks/research-complete/elaboration/agents/quality-agent-spec.md)

## Skill Definition

**Natural Language Patterns**:
- "Assess research quality"
- "Check FAIR compliance"
- "Evaluate paper quality"
- "Run quality checklist"

## References

- @$AIWG_ROOT/agentic/code/frameworks/research-complete/elaboration/use-cases/UC-RF-006-assess-source-quality.md

---

**Status**: DRAFT
**Created**: 2026-01-25
**UC Mapping**: UC-RF-006
