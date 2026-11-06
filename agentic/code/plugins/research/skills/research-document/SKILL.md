---
namespace: aiwg
name: research-document
platforms: [all]
description: Generate summaries and literature notes from research papers
commandHint:
  argumentHint: "[REF-XXX] [--depth brief|standard|comprehensive]"
  category: research-documentation
---

# Research Document Command

Generate structured summaries and literature notes from acquired research papers.

## Instructions

When invoked, create comprehensive documentation:

1. **Load Paper**
   - Verify REF-XXX exists in `.aiwg/research/sources/`
   - Load PDF and existing finding document
   - Load metadata from frontmatter

2. **Extract Content**
   - Parse PDF sections (abstract, introduction, methodology, results, conclusion)
   - Identify key findings, claims, and evidence
   - Extract figures, tables, and important quotes
   - Note limitations and future work

3. **Analyze Relevance**
   - Assess applicability to AIWG framework
   - Identify which components/agents could use these findings
   - Determine implementation priority
   - Map findings to existing use cases or requirements

4. **Generate Documentation**
   - Fill finding document template sections:
     - Executive Summary
     - Key Findings (with metrics)
     - Methodology
     - AIWG Relevance
     - Implementation Notes
     - References
   - Use domain-appropriate voice
   - Include specific metrics and quotes

5. **Create Synthesis Notes**
   - Generate literature note in `.aiwg/research/literature-notes/REF-XXX-notes.md`
   - Connect to related research (cross-references)
   - Identify gaps or contradictions with existing corpus
   - Suggest follow-up research questions

6. **Update Index**
   - Add to topic-based indices
   - Update cross-reference map
   - Flag for synthesis report inclusion

## Arguments

- `[ref-id]` - REF-XXX identifier (required)
- `--depth [brief|standard|comprehensive]` - Documentation depth (default: standard)
- `--focus [section]` - Focus on specific section (methodology, results, implications)
- `--update-only` - Update existing documentation rather than regenerate
- `--include-citations` - Extract all citations from paper for potential acquisition

## Depth Levels

| Level | Content |
|-------|---------|
| `brief` | Executive summary + key findings only (~500 words) |
| `standard` | Full finding document with all sections (~1500 words) |
| `comprehensive` | Full document + literature notes + citation extraction (~3000 words) |

## Examples

```bash
# Standard documentation
/research-document REF-022

# Brief summary for quick review
/research-document REF-022 --depth brief

# Comprehensive with citation extraction
/research-document REF-022 --depth comprehensive --include-citations

# Update existing documentation
/research-document REF-022 --update-only

# Focus on methodology only
/research-document REF-022 --focus methodology
```

## Expected Output

```
Documenting: REF-022 - AutoGen: Enabling Next-Gen LLM Applications
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Step 1: Loading paper
  ✓ PDF loaded (27 pages)
  ✓ Metadata parsed
  ✓ Existing finding document found

Step 2: Extracting content
  ✓ Abstract extracted
  ✓ Sections parsed: Introduction, Framework, Evaluation, Discussion
  ✓ 4 key findings identified
  ✓ 12 figures/tables extracted
  ✓ 3 direct quotes captured

Step 3: Analyzing AIWG relevance
  ✓ High relevance to agent orchestration
  ✓ Applicable to: Conversable Agent Interface, Auto-Reply Chains
  ✓ Implementation priority: HIGH
  ✓ Maps to: UC-174, UC-183

Step 4: Generating documentation
  ✓ Finding document updated: .aiwg/research/findings/REF-022-autogen.md
  ✓ Sections populated:
    - Executive Summary (150 words)
    - Key Findings (4 findings, metrics included)
    - Methodology (multi-agent conversational framework)
    - AIWG Relevance (applicable components listed)
    - Implementation Notes (integration patterns)
    - Limitations (scalability concerns noted)
    - References (45 citations)

Step 5: Creating synthesis notes
  ✓ Literature note: .aiwg/research/literature-notes/REF-022-notes.md
  ✓ Connected to: REF-001, REF-013, REF-057
  ✓ Synthesis themes: agent collaboration, HITL patterns
  ✓ Follow-up questions: 3 identified

Step 6: Updating indices
  ✓ Added to topic indices: agentic-workflows, multi-agent-systems
  ✓ Cross-reference map updated
  ✓ Flagged for next synthesis report

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Documentation complete!

Finding: .aiwg/research/findings/REF-022-autogen.md (1,847 words)
Literature Note: .aiwg/research/literature-notes/REF-022-notes.md (623 words)

Next Steps:
1. /research-quality REF-022 - Assess evidence quality
2. /research-cite REF-022 - Generate citations
3. Review AIWG integration opportunities in UC-174, UC-183
```

## Quality Checks

Documentation includes automatic quality checks:

- [ ] All key findings have metrics or specific claims
- [ ] AIWG relevance section is concrete (not generic)
- [ ] Implementation priority justified
- [ ] No invented citations or page references
- [ ] Quotes are exact with page numbers
- [ ] Limitations section populated
- [ ] Cross-references to related research included

## Voice and Tone

Documentation follows AIWG voice guidelines:

- **Technical Authority** for methodology sections
- **Analytical Precision** for findings
- **Pragmatic** for implementation notes
- **Balanced** when noting limitations

Avoids:
- Marketing language ("revolutionary", "game-changing")
- Overconfident claims beyond evidence
- Generic summaries without specifics

## References

- @$AIWG_ROOT/agentic/code/frameworks/research-complete/agents/documentation-agent.md - Documentation Agent
- @$AIWG_ROOT/src/research/services/documentation-service.ts - Documentation implementation
- @$AIWG_ROOT/agentic/code/frameworks/research-complete/templates/reference-canonical.md - Finding template
- @$AIWG_ROOT/agentic/code/addons/voice-framework/voices/technical-authority.md - Voice profile
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/citation-policy.md - Citation requirements
