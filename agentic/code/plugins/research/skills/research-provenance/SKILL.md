---
namespace: aiwg
name: research-provenance
platforms: [all]
description: Query provenance chains and artifact relationships
commandHint:
  argumentHint: "[REF-XXX or artifact-path] [--query what-derives|what-cites|history]"
  category: research-provenance
---

# Research Provenance Command

This workflow remains active. Its records can be projected to the Dataset
Intelligence ledger, but arbitrary entity/activity attributes require a
governed extension. See the [dataset migration
guide](https://github.com/jmagly/aiwg/blob/main/agentic/code/addons/dataset-intelligence/docs/migration-guide.md).

Query W3C PROV-compliant provenance chains to trace artifact derivations and relationships.

## Instructions

When invoked, perform provenance queries:

1. **Load Provenance Records**
   - If REF-XXX, load all provenance records for that paper
   - If artifact path, load records for that specific artifact
   - Build provenance graph from PROV relationships

2. **Execute Query**
   - Query types:
     - `what-derives` - What artifacts derive from this source?
     - `what-cites` - What documents cite this source?
     - `history` - Full derivation history of this artifact
     - `lineage` - Complete lineage from source to current state
     - `impact` - Impact analysis (what would be affected by changes?)

3. **Traverse Graph**
   - Follow `wasDerivedFrom` relationships
   - Follow `wasGeneratedBy` activities
   - Follow `wasAssociatedWith` agents
   - Collect all related entities, activities, and agents

4. **Format Results**
   - Visualize as tree, graph, or table
   - Show derivation chains
   - Highlight gaps or inconsistencies
   - Calculate impact metrics

5. **Report**
   - Display provenance chain
   - Show relationship types
   - Include timestamps and agents
   - Flag any provenance issues

## Arguments

- `[ref-id or path]` - Source identifier or artifact path (required)
- `--query [what-derives|what-cites|history|lineage|impact]` - Query type (default: what-derives)
- `--depth [n]` - Maximum graph traversal depth (default: 5)
- `--output [tree|graph|table|json]` - Output format (default: tree)
- `--validate` - Validate provenance chain integrity
- `--export-dot` - Export as GraphViz DOT format

## Examples

```bash
# Find what derives from a paper
/research-provenance REF-022 --query what-derives

# Find citation usage
/research-provenance REF-022 --query what-cites

# Get full history of an artifact
/research-provenance .aiwg/architecture/agent-orchestration-sad.md --query history

# Analyze impact of changes
/research-provenance REF-022 --query impact --depth 10

# Validate provenance chain
/research-provenance REF-022 --validate

# Export as graph
/research-provenance REF-022 --query lineage --export-dot
```

## Expected Output

### What Derives Query

```
/research-provenance REF-022 --query what-derives

Provenance Query: REF-022 - What Derives From This Source?
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Source: REF-022 (AutoGen: Enabling Next-Gen LLM Applications...)

Derivation Tree:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

REF-022.pdf (source paper)
│
├─→ REF-022-autogen.md (finding document)
│   │   Relationship: wasDerivedFrom
│   │   Activity: documentation
│   │   Agent: documentation-agent
│   │   Date: 2026-02-03T12:15:00Z
│   │
│   ├─→ REF-022-notes.md (literature notes)
│   │   Relationship: wasDerivedFrom
│   │   Activity: synthesis
│   │   Agent: documentation-agent
│   │   Date: 2026-02-03T12:20:00Z
│   │
│   └─→ UC-174-conversable-agent.md (use case)
│       Relationship: wasInformedBy
│       Activity: requirements_analysis
│       Agent: requirements-analyst
│       Date: 2026-02-03T13:00:00Z
│
├─→ REF-022-assessment.yaml (quality assessment)
│   Relationship: wasDerivedFrom
│   Activity: quality_assessment
│   Agent: quality-agent
│   Date: 2026-02-03T12:30:00Z
│
└─→ .claude/rules/conversable-agent-interface.md (implementation rule)
    Relationship: wasInformedBy
    Activity: rule_creation
    Agent: architect
    Date: 2026-02-03T14:00:00Z

Summary:
  Total derived artifacts: 5
  Derivation depth: 2 levels
  Agents involved: 4 (documentation-agent, quality-agent, requirements-analyst, architect)
  Time span: 2026-02-03 12:15 - 14:00 (1h 45m)
```

### What Cites Query

```
/research-provenance REF-022 --query what-cites

Provenance Query: REF-022 - Citation Usage
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Source: REF-022 (AutoGen: Enabling Next-Gen LLM Applications...)

Citation Map:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Documents citing REF-022:

1. .aiwg/architecture/agent-orchestration-sad.md
   Lines: 78, 142, 267
   Context: Multi-agent conversation patterns
   Quality compliance: ✓ APPROPRIATE (MODERATE hedging for LOW evidence)

2. .aiwg/requirements/use-cases/UC-174-conversable-agent.md
   Lines: 23, 45
   Context: Conversable agent interface design
   Quality compliance: ✓ APPROPRIATE

3. .claude/rules/conversable-agent-interface.md
   Lines: 12, 89
   Context: Research foundation for agent protocol
   Quality compliance: ✓ APPROPRIATE

4. .claude/rules/auto-reply-chains.md
   Lines: 15, 34, 67
   Context: Auto-reply pattern implementation
   Quality compliance: ✓ APPROPRIATE

5. docs/agent-framework.md
   Lines: 78
   Context: Agent capabilities overview
   Quality compliance: ✗ VIOLATION - "Research demonstrates" too strong for LOW evidence
   Suggestion: Change to "Limited evidence suggests"

6. .aiwg/architecture/adr-012-agent-protocol.md
   Lines: 45
   Context: Protocol design rationale
   Quality compliance: ✗ VIOLATION - "Studies prove" too strong
   Suggestion: Change to "Preliminary findings indicate"

Summary:
  Total citations: 12 (across 6 documents)
  Compliant citations: 10 (83%)
  Policy violations: 2 (17%)
  Remediation needed: docs/agent-framework.md, .aiwg/architecture/adr-012-agent-protocol.md
```

### History Query

```
/research-provenance .aiwg/architecture/agent-orchestration-sad.md --query history

Provenance Query: agent-orchestration-sad.md - Derivation History
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Artifact: .aiwg/architecture/agent-orchestration-sad.md

Derivation History (chronological):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

2026-01-15T10:00:00Z - CREATION
  Activity: initial_architecture_design
  Agent: architect
  Based on:
    - .aiwg/requirements/use-cases/UC-001-orchestrator.md
    - .aiwg/intake/solution-profile.md

2026-01-20T14:30:00Z - REFINEMENT
  Activity: architecture_refinement
  Agent: architect
  Informed by:
    - REF-001-production-agentic.md (best practices)
    - Technical review feedback

2026-02-03T13:45:00Z - ENHANCEMENT
  Activity: research_integration
  Agent: architect
  Integrated findings from:
    - REF-022-autogen.md (conversable agent interface)
    - REF-057-agent-laboratory.md (HITL patterns)
  Changes:
    - Added conversable agent interface section
    - Enhanced HITL gate definitions
    - Updated agent communication patterns

Current State:
  Version: 3.0
  Last modified: 2026-02-03T13:45:00Z
  Size: 47 KB
  Sections: 12
  Referenced by: 8 artifacts
  Checksum: def456...

Provenance Chain:
  .aiwg/requirements/UC-001-orchestrator.md
    → .aiwg/architecture/agent-orchestration-sad.md (v1.0)
       ← REF-001-production-agentic.md
    → .aiwg/architecture/agent-orchestration-sad.md (v2.0)
       ← REF-022-autogen.md
       ← REF-057-agent-laboratory.md
    → .aiwg/architecture/agent-orchestration-sad.md (v3.0, current)
```

### Impact Analysis

```
/research-provenance REF-022 --query impact

Provenance Query: REF-022 - Impact Analysis
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Source: REF-022 (AutoGen: Enabling Next-Gen LLM Applications...)

Impact Analysis: What would be affected by changes to REF-022?
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Direct Dependencies (5):
  - REF-022-autogen.md (finding document) - CRITICAL
  - REF-022-assessment.yaml (quality assessment) - HIGH
  - REF-022-notes.md (literature notes) - MEDIUM
  - UC-174-conversable-agent.md (use case) - HIGH
  - .claude/rules/conversable-agent-interface.md - HIGH

Indirect Dependencies (12):
  - .aiwg/architecture/agent-orchestration-sad.md
  - src/agents/conversable-agent-interface.ts
  - test/unit/agents/conversable-agent.test.ts
  - .claude/rules/auto-reply-chains.md
  - docs/agent-framework.md
  ... (7 more)

Citation Dependencies (12 citations across 6 documents):
  - 10 citations in architecture/requirements
  - 2 citations in documentation

Implementation Dependencies (3):
  - src/agents/conversable-agent-interface.ts (implements patterns)
  - src/orchestration/conversation-manager.ts (uses patterns)
  - test/integration/multi-agent-conversation.test.ts (validates patterns)

Impact Metrics:
  Total affected artifacts: 17
  Critical dependencies: 1
  High priority dependencies: 4
  Medium priority dependencies: 3
  Citation count: 12

Risk Assessment:
  If REF-022 quality assessment changes from LOW to VERY LOW:
    - 2 citations would become violations (overclaiming)
    - 1 use case would need revision
    - 1 implementation rule would need hedging update

  If REF-022 findings are contradicted by new research:
    - 5 artifacts would require immediate review
    - 12 citations would need revalidation
    - 3 implementation patterns would need reassessment
```

## Validation

When --validate is used:

```
/research-provenance REF-022 --validate

Validating Provenance Chain: REF-022
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Validation Checks:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

✓ All provenance records exist
✓ All referenced artifacts exist
✓ All agents are registered
✓ All activities have timestamps
✓ All derivation chains are complete
✓ No circular dependencies detected
✓ All checksums match fixity manifest
✗ 2 citation policy violations found

Issues:
  [WARNING] Citation policy violation in docs/agent-framework.md:78
    - Hedging too strong for GRADE level
    - Recommendation: Update to "Limited evidence suggests"

  [WARNING] Citation policy violation in .aiwg/architecture/adr-012-agent-protocol.md:45
    - Hedging too strong for GRADE level
    - Recommendation: Update to "Preliminary findings indicate"

Overall Status: PASS with warnings
  Critical issues: 0
  Warnings: 2
  Info: 0

Remediation:
  Run: /research-quality REF-022 --check-citations --fix
```

## GraphViz Export

Export provenance graph for visualization:

```bash
/research-provenance REF-022 --query lineage --export-dot

Output:
  Provenance graph exported to: .aiwg/research/provenance/graphs/REF-022-lineage.dot

  To visualize:
    dot -Tpng REF-022-lineage.dot -o REF-022-lineage.png
    dot -Tsvg REF-022-lineage.dot -o REF-022-lineage.svg
```

## References

- @$AIWG_ROOT/agentic/code/frameworks/research-complete/agents/provenance-agent.md - Provenance Agent
- @$AIWG_ROOT/src/research/services/provenance-service.ts - Provenance query implementation
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/schemas/provenance/prov-record.yaml - PROV schema
- @.aiwg/research/provenance/README.md - Provenance tracking
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/provenance-tracking.md - Provenance requirements
- https://www.w3.org/TR/prov-dm/ - W3C PROV-DM specification
