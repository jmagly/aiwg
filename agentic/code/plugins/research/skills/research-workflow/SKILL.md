---
namespace: aiwg
name: research-workflow
platforms: [all]
description: Execute multi-stage research workflows
triggers:
  - "help with research papers"
  - "help me build a cited research corpus"
  - "start a research workflow or citation plan"
  - "research workflow"
commandHint:
  argumentHint: "[workflow-name] [--input parameters] [--stage n]"
  category: research-workflows
---

# Research Workflow Command

Every acquisition, induction, and synthesis dispatch uses the shared [context engineering contract](https://github.com/jmagly/aiwg/blob/main/docs/context-engineering-contract.md) and [verification contract](https://github.com/jmagly/aiwg/blob/main/docs/verification-contracts.md). Synthesis completion requires citation resolution, GRADE-calibrated claims, and evidence/inference/recommendation separation.

Execute complete multi-stage research workflows from discovery through archival.

## Instructions

When invoked, orchestrate multi-agent research workflows:

1. **Load Workflow Definition**
   - Identify workflow by name or load custom workflow YAML
   - Parse stages, agents, dependencies
   - Validate workflow structure

2. **Execute Stages Sequentially**
   - Each stage invokes specific agents
   - Pass outputs from one stage to next
   - Handle stage failures and retries
   - Track progress and status

3. **Monitor Execution**
   - Display progress indicators
   - Log all agent invocations
   - Capture intermediate outputs
   - Track resource usage (tokens, time)

4. **Handle Gates**
   - Pause for human approval at designated gates
   - Present artifacts for review
   - Collect feedback and decisions
   - Resume or abort based on input

5. **Generate Report**
   - Summarize workflow execution
   - Report outcomes for each stage
   - Calculate quality metrics
   - Archive workflow state

## Built-in Workflows

| Workflow | Stages | Description |
|----------|--------|-------------|
| `discovery-to-corpus` | 5 | Full pipeline from search to documented findings |
| `paper-acquisition` | 3 | Download, extract metadata, create finding document |
| `quality-assessment` | 4 | GRADE assessment with citation validation |
| `corpus-maintenance` | 6 | Periodic corpus health checks and updates |
| `synthesis-report` | 4 | Generate synthesis report from topic cluster |
| `citation-audit` | 3 | Validate all citations across corpus |

## Arguments

- `[workflow-name]` - Workflow to execute (required)
- `--input [yaml-file]` - Input parameters for workflow
- `--stage [n]` - Start from specific stage (default: 1)
- `--pause-at [stage]` - Pause after specific stage
- `--interactive` - Prompt for confirmation at each stage
- `--dry-run` - Preview workflow without execution
- `--resume [workflow-id]` - Resume previously interrupted workflow

## Workflow Definitions

### discovery-to-corpus

Complete pipeline from literature search to documented findings:

**Stages:**

1. **Discovery** (agent: discovery-agent)
   - Search academic databases for query
   - Rank and filter results
   - Present top candidates

2. **Acquisition** (agent: research-acquisition-agent)
   - Download selected papers
   - Extract metadata
   - Generate frontmatter
   - Create finding documents

3. **Documentation** (agent: documentation-agent)
   - Parse PDFs
   - Extract key findings
   - Assess AIWG relevance
   - Generate literature notes

4. **Quality Assessment** (agent: quality-agent)
   - Apply GRADE framework
   - Calculate quality level
   - Generate assessment reports
   - Update frontmatter

5. **Archival** (agent: archival-agent)
   - Create BagIt packages
   - Update fixity manifest
   - Register in archival index

**Human Gates:**
- After Discovery: Select papers to acquire
- After Quality Assessment: Approve quality levels

### paper-acquisition

Streamlined acquisition workflow:

**Stages:**

1. **Download** (agent: research-acquisition-agent)
   - Fetch PDF from source
   - Verify file integrity

2. **Metadata Extraction** (agent: research-acquisition-agent)
   - Parse PDF metadata
   - Enrich via CrossRef/Semantic Scholar
   - Assign REF-XXX identifier

3. **Document Creation** (agent: documentation-agent)
   - Generate finding document from template
   - Populate frontmatter
   - Add placeholder sections

### quality-assessment

Comprehensive quality assessment workflow:

**Stages:**

1. **GRADE Assessment** (agent: quality-agent)
   - Determine baseline quality
   - Apply downgrade/upgrade factors
   - Calculate final GRADE level

2. **Hedging Analysis** (agent: quality-agent)
   - Generate appropriate hedging language
   - Document forbidden phrases
   - Create citation templates

3. **Citation Validation** (agent: citation-agent)
   - Scan corpus for citations of this source
   - Check hedging compliance
   - Generate remediation suggestions

4. **Report Generation** (agent: quality-agent)
   - Create assessment report
   - Update frontmatter
   - Save assessment YAML

## Examples

```bash
# Execute full discovery-to-corpus workflow
/research-workflow discovery-to-corpus --input discovery-params.yaml

# Acquire specific paper
/research-workflow paper-acquisition --input '{"doi": "10.48550/arXiv.2308.08155"}'

# Run quality assessment
/research-workflow quality-assessment --input '{"ref_id": "REF-022"}'

# Interactive mode with pauses
/research-workflow discovery-to-corpus --interactive

# Dry run to preview
/research-workflow corpus-maintenance --dry-run

# Resume interrupted workflow
/research-workflow resume wf-20260203-123456
```

## Expected Output

```
Executing Workflow: discovery-to-corpus
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Input Parameters:
  Query: "agentic workflows for software development"
  Max results: 10
  Year from: 2020

Workflow Progress: [████░░░░░░] Stage 1/5
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Stage 1: Discovery (agent: discovery-agent)
─────────────────────────────────────────────────────────────────────
  Status: Running...
  ✓ Queried arXiv (42 results)
  ✓ Queried ACM DL (18 results)
  ✓ Queried IEEE Xplore (25 results)
  ✓ Queried Semantic Scholar (67 results)
  ✓ Deduplicated and ranked
  ✓ Top 10 results selected

  Duration: 15s
  Status: COMPLETE

Output:
  10 papers identified
  Saved to: .aiwg/research/search-cache/results-20260203-143000.yaml

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
HUMAN GATE: Paper Selection
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Top 10 Results:

 1. [✓] AutoGen: Enabling Next-Gen LLM Applications (Wu et al., 2023)
    Relevance: 0.95, Citations: 234, DOI: 10.48550/arXiv.2308.08155

 2. [✓] The Landscape of Emerging AI Agent Architectures (Wang et al., 2024)
    Relevance: 0.89, Citations: 89, DOI: 10.48550/arXiv.2404.11584

 3. [ ] MetaGPT: Meta Programming for Multi-Agent Systems (Hong et al., 2023)
    Relevance: 0.87, Citations: 156, DOI: 10.48550/arXiv.2308.00352
    Note: Already in corpus as REF-013

 4. [✓] Agent Laboratory: Using LLM Agents as Research Assistants (Schmidgall et al., 2024)
    Relevance: 0.85, Citations: 45, arXiv:2404.11587

... (6 more)

Select papers to acquire [1,2,4 or 'all']: 1,2,4

Selected: 3 papers
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Workflow Progress: [████████░░] Stage 2/5
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Stage 2: Acquisition (agent: research-acquisition-agent)
─────────────────────────────────────────────────────────────────────
  Status: Running...

  Paper 1/3: AutoGen (10.48550/arXiv.2308.08155)
    ✓ Downloaded PDF (2.4 MB)
    ✓ Metadata extracted
    ✓ Assigned REF-022
    ✓ Finding document created

  Paper 2/3: Emerging AI Agent Architectures (10.48550/arXiv.2404.11584)
    ✓ Downloaded PDF (3.1 MB)
    ✓ Metadata extracted
    ✓ Assigned REF-075
    ✓ Finding document created

  Paper 3/3: Agent Laboratory (arXiv:2404.11587)
    ✓ Downloaded PDF (1.8 MB)
    ✓ Metadata extracted
    ✓ Assigned REF-076
    ✓ Finding document created

  Duration: 42s
  Status: COMPLETE

Output:
  3 papers acquired
  REF-022, REF-075, REF-076
  Total size: 7.3 MB

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Workflow Progress: [████████████░░] Stage 3/5
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Stage 3: Documentation (agent: documentation-agent)
─────────────────────────────────────────────────────────────────────
  Status: Running...

  REF-022: AutoGen
    ✓ PDF parsed (27 pages)
    ✓ 4 key findings extracted
    ✓ AIWG relevance assessed (HIGH)
    ✓ Literature notes created
    ✓ Finding document populated (1,847 words)

  REF-075: Emerging AI Agent Architectures
    ✓ PDF parsed (18 pages)
    ✓ 5 key findings extracted
    ✓ AIWG relevance assessed (HIGH)
    ✓ Literature notes created
    ✓ Finding document populated (2,103 words)

  REF-076: Agent Laboratory
    ✓ PDF parsed (12 pages)
    ✓ 3 key findings extracted
    ✓ AIWG relevance assessed (MEDIUM)
    ✓ Literature notes created
    ✓ Finding document populated (1,524 words)

  Duration: 3m 15s
  Status: COMPLETE

Output:
  3 finding documents completed
  3 literature notes created
  Total: 5,474 words of documentation

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Workflow Progress: [█████████████░] Stage 4/5
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Stage 4: Quality Assessment (agent: quality-agent)
─────────────────────────────────────────────────────────────────────
  Status: Running...

  REF-022: AutoGen
    ✓ Baseline: MODERATE (conference paper)
    ✓ Downgrade: -1 (imprecision)
    ✓ Final GRADE: LOW
    ✓ Assessment saved

  REF-075: Emerging AI Agent Architectures
    ✓ Baseline: VERY LOW (preprint, not peer-reviewed)
    ✓ No upgrades/downgrades
    ✓ Final GRADE: VERY LOW
    ✓ Assessment saved

  REF-076: Agent Laboratory
    ✓ Baseline: MODERATE (preprint, high-quality)
    ✓ Upgrade: +1 (large effect)
    ✓ Final GRADE: MODERATE
    ✓ Assessment saved

  Duration: 45s
  Status: COMPLETE

Output:
  3 quality assessments completed
  GRADE levels: LOW, VERY LOW, MODERATE

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
HUMAN GATE: Quality Approval
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Quality assessments complete. Review GRADE levels:

  REF-022: LOW (conference paper with limited evaluation)
  REF-075: VERY LOW (preprint, not peer-reviewed)
  REF-076: MODERATE (high-quality preprint with strong findings)

Approve quality levels? [Y/n]: Y

Approved. Proceeding to archival.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Workflow Progress: [██████████████] Stage 5/5
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Stage 5: Archival (agent: archival-agent)
─────────────────────────────────────────────────────────────────────
  Status: Running...

  REF-022: AutoGen
    ✓ BagIt package created (2.5 MB)
    ✓ Checksums verified
    ✓ Registered in archival index

  REF-075: Emerging AI Agent Architectures
    ✓ BagIt package created (3.2 MB)
    ✓ Checksums verified
    ✓ Registered in archival index

  REF-076: Agent Laboratory
    ✓ BagIt package created (1.9 MB)
    ✓ Checksums verified
    ✓ Registered in archival index

  Duration: 28s
  Status: COMPLETE

Output:
  3 archival packages created
  Total archived size: 7.6 MB

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Workflow Complete!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Summary:
  Workflow: discovery-to-corpus
  Duration: 5m 25s
  Papers processed: 3
  Success rate: 100%

Artifacts Created:
  - 3 PDFs (.aiwg/research/sources/)
  - 3 finding documents (.aiwg/research/findings/)
  - 3 literature notes (.aiwg/research/literature-notes/)
  - 3 quality assessments (.aiwg/research/quality-assessments/)
  - 3 archival packages (.aiwg/research/archives/)

Resource Usage:
  Tokens consumed: 45,230
  API calls: 27
  Storage used: 7.6 MB

Next Steps:
  - Review findings: /research-document REF-022 REF-075 REF-076
  - Generate citations: /research-cite REF-022
  - Check corpus health: /research-status

Workflow log: .aiwg/research/workflows/wf-20260203-143000.log
```

## Workflow State

All workflows track state for resumption:

```yaml
# .aiwg/research/workflows/wf-20260203-143000-state.yaml
workflow_id: wf-20260203-143000
workflow_name: discovery-to-corpus
status: complete
started_at: "2026-02-03T14:30:00Z"
completed_at: "2026-02-03T14:35:25Z"

stages:
  - name: discovery
    status: complete
    started_at: "2026-02-03T14:30:00Z"
    completed_at: "2026-02-03T14:30:15Z"
    output:
      papers: 10
      selected: [1, 2, 4]

  - name: acquisition
    status: complete
    started_at: "2026-02-03T14:30:20Z"
    completed_at: "2026-02-03T14:31:02Z"
    output:
      acquired: [REF-022, REF-075, REF-076]

  ... (stages 3-5)

metrics:
  duration_seconds: 325
  tokens_consumed: 45230
  api_calls: 27
  success_rate: 1.0
```

## Custom Workflows

Define custom workflows in YAML:

```yaml
# custom-workflow.yaml
name: focused-acquisition
description: Acquire and document specific papers
stages:
  - name: acquisition
    agent: research-acquisition-agent
    inputs:
      - doi_list

  - name: documentation
    agent: documentation-agent
    inputs:
      - from: acquisition.acquired

  - name: quality
    agent: quality-agent
    inputs:
      - from: acquisition.acquired

gates:
  - stage: quality
    type: approval
    message: "Review quality assessments"
```

Execute:
```bash
/research-workflow custom-workflow.yaml --input '{"doi_list": ["10.1234/example"]}'
```

## References

- @$AIWG_ROOT/agentic/code/frameworks/research-complete/agents/workflow-agent.md - Workflow Agent
- @$AIWG_ROOT/agentic/code/frameworks/research-complete/workflows/ - Workflow definitions
- @$AIWG_ROOT/src/research/services/workflow-service.ts - Workflow orchestration
- @.aiwg/research/workflows/ - Workflow state and logs
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/hitl-gates.md - Human gate patterns
