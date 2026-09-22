---
description: Show research framework status, coverage metrics, and recent activity
category: research-management
argument-hint: [--verbose] [--export <format>]
allowed-tools: Read, Grep, Glob, Bash
model: claude-sonnet-5
---

# Research Status Command

## Task

Display comprehensive status of research framework: papers acquired, documentation coverage, quality scores, and recent activity.

When invoked with `/research-status [options]`:

1. **Scan** `.aiwg/research/` directory
2. **Calculate** coverage metrics
3. **Aggregate** quality scores
4. **List** recent activity
5. **Display** formatted status report

## Parameters

- **`--verbose`** (optional): Show detailed breakdown
- **`--export <format>`** (optional): Export status to file (`json`, `markdown`)

## Output Format

```markdown
# Research Framework Status

**Last Updated**: 2026-01-25T10:30:00Z
**Total Papers**: 45
**Documentation Coverage**: 87% (39/45)
**Average Quality Score**: 4.2/5.0 (FAIR)

## Coverage Breakdown

- **Discovered**: 100 papers
- **Acquired**: 45 papers (45%)
- **Documented**: 39 papers (87% of acquired)
- **Quality Assessed**: 30 papers (67% of acquired)
- **Archived**: 1 version (v20260125)

## Recent Activity

- 2026-01-25 10:30: Acquired 10 papers (OAuth2 security)
- 2026-01-25 09:15: Documented 5 papers
- 2026-01-24 16:45: Gap analysis completed

## Quality Scores

- FAIR Compliance: 85% (Findable: 95%, Accessible: 80%, Interoperable: 80%, Reusable: 85%)
- Methodological Rigor: 4.1/5.0
- Reproducibility: 3.8/5.0

## Top Research Topics

1. OAuth2 Security (15 papers)
2. LLM Evaluation (12 papers)
3. Reinforcement Learning (8 papers)
4. API Security (6 papers)
5. Distributed Systems (4 papers)

## Recommendations

- Document 6 remaining acquired papers
- Quality assess 15 papers
- Archive updated collection
```

## Related Agents

- All research agents (for status aggregation)

## Skill Definition

**Natural Language Patterns**:
- "Show research status"
- "What's the coverage?"
- "Research framework summary"
- "How many papers do we have?"

## References

- All research framework use cases

---

**Status**: DRAFT
**Created**: 2026-01-25
**UC Mapping**: Cross-cutting status command
