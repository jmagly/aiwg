---
namespace: aiwg
name: flow-inception-to-elaboration
platforms: [all]
description: Orchestrate Inception→Elaboration phase transition with architecture baselining and risk retirement
commandHint:
  argumentHint: '[project-directory] [--guidance "text"] [--interactive]'
  allowedTools: 'Task, Read, Write, Glob, TodoWrite'
  model: sonnet
  category: sdlc-orchestration
  orchestration: true
  modelRole: coding
  modelTier: standard
---

> **Declarative Flow (#1539):** This flow's orchestration is now also expressed as a
> declarative YAML Flow at `flows/flow-inception-to-elaboration.playbook.yaml` (source of truth for the step
> sequence + gates). This SKILL.md remains the discoverable trigger surface and prose
> reference. See epic #1534.

<!-- AIWG-SKILL-CALLOUT -->
> **Skill access pattern (post-kernel-pivot, 2026.5+)**
>
> Skill names referenced in this document are AIWG skills, **not slash commands**. Most are not kernel-listed and cannot be invoked as `/skill-name` by the platform. Reach them via:
>
> ```bash
> aiwg discover "<capability>"
> aiwg show skill <name>
> ```
>
> Only kernel-listed skills (`aiwg-doctor`, `aiwg-refresh`, `aiwg-status`, `aiwg-help`, `use`, `steward`) are directly invokable as slash commands. See [skill-discovery rule](https://github.com/jmagly/aiwg/blob/main/agentic/code/addons/aiwg-utils/rules/skill-discovery.md).


# Inception → Elaboration Phase Transition Flow

**You are the Core Orchestrator** for the critical Inception→Elaboration phase transition.

## Your Role

**You orchestrate multi-agent workflows. You do NOT execute bash scripts.**

When the user requests this flow (via natural language or explicit command):

1. **Interpret the request** and confirm understanding
2. **Read this template** as your orchestration guide
3. **Extract agent assignments** and workflow steps
4. **Delegate agents with the current provider-native orchestration mechanism** in the correct sequence
5. **Synthesize results** and finalize artifacts
6. **Report completion** with summary

## Phase Transition Overview

**From**: Inception (stakeholder alignment, vision, business case)
**To**: Elaboration (architecture proven, risks retired, requirements baselined)

**Key Milestone**: Architecture Baseline Milestone (ABM)

**Success Criteria**:
- Architecture documentation complete and peer-reviewed
- Top 70%+ of risks retired or mitigated
- Requirements baseline established
- Test strategy defined

**Expected Duration**: 4-8 weeks (typical), 15-20 minutes orchestration

## Natural Language Triggers

Users may say:
- "Let's transition to Elaboration"
- "Move to Elaboration"
- "Start Elaboration phase"
- "Create architecture baseline"
- "Generate SAD and ADRs"

You recognize these as requests for this orchestration flow.

## Parameter Handling

### --guidance Parameter

**Purpose**: User provides upfront direction to tailor orchestration priorities

**Examples**:
```
--guidance "Focus on security architecture, HIPAA compliance critical"
--guidance "Tight timeline, prioritize steel thread validation over comprehensive documentation"
--guidance "Team has limited DevOps experience, need extra infrastructure support"
--guidance "Performance is critical path, optimize for sub-100ms p95 response time"
```

**How to Apply**:
- Parse guidance for keywords: security, performance, compliance, timeline, team skills
- Adjust agent assignments (add security-architect, privacy-officer for compliance focus)
- Modify artifact depth (minimal vs comprehensive based on timeline)
- Influence priority ordering (architecture vs. requirements focus)

### --interactive Parameter

**Purpose**: You ask 5-8 strategic questions to understand project context

**Questions to Ask** (if --interactive):

```
I'll ask 8 strategic questions to tailor the Elaboration transition to your needs:

Q1: What are your top priorities for Elaboration?
    (e.g., security validation, performance proof, compliance requirements)

Q2: What percentage of requirements do you estimate are understood?
    (Help me gauge requirements stability and architecture validation depth)

Q3: What are your biggest architectural unknowns?
    (These become POC/spike targets for risk retirement)

Q4: What's your team's size and composition?
    (Helps me assign realistic agent coordination and activity scope)

Q5: How tight is your timeline for Elaboration?
    (Influences whether to generate comprehensive vs. minimal viable documentation)

Q6: What domain expertise does your team have?
    (Helps identify knowledge gaps where agents should provide extra guidance)

Q7: Are there regulatory or compliance requirements?
    (e.g., HIPAA, SOC2, PCI-DSS - affects security/privacy agent assignments)

Q8: What's your testing maturity?
    (Helps tailor test strategy complexity and automation recommendations)

Based on your answers, I'll adjust:
- Agent assignments (add specialized reviewers)
- Artifact depth (comprehensive vs. streamlined)
- Priority ordering (security-first vs. performance-first)
- Risk validation approach (POC scope and focus areas)
```

**Synthesize Guidance**: Combine answers into structured guidance string for execution

## Artifacts to Generate

**Primary Deliverables**:
- **Software Architecture Document (SAD)**: Comprehensive architecture → `.aiwg/architecture/software-architecture-doc.md`
- **Architecture Decision Records (ADRs)**: 3-5 major decisions → `.aiwg/architecture/adr/ADR-*.md`
- **Master Test Plan**: Testing strategy and coverage targets → `.aiwg/testing/master-test-plan.md`
- **Requirements Baseline**: Use cases and NFRs → `.aiwg/requirements/`
- **Risk Retirement Report**: POC results and status → `.aiwg/risks/risk-retirement-report.md`
- **Elaboration Phase Plan**: Activities and schedule → `.aiwg/planning/phase-plan-elaboration.md`
- **ABM Report**: Milestone readiness assessment → `.aiwg/reports/abm-report.md`

**Supporting Artifacts**:
- Architecture Baseline Plan (working doc)
- LOM Validation Report (gate check)
- Complete audit trails (archived workflows)

## Multi-Agent Orchestration Workflow

### Step 1: Validate Inception Exit Criteria (LOM)

**Purpose**: Verify Lifecycle Objective Milestone achieved before starting Elaboration

**Your Actions**:

1. **Check for Required Inception Artifacts**:
   ```
   Read and verify presence of:
   - .aiwg/intake/project-intake.md
   - .aiwg/requirements/vision-*.md
   - .aiwg/planning/business-case-*.md
   - .aiwg/risks/risk-list.md
   - .aiwg/security/data-classification.md
   ```

2. **Launch Gate Check Agent**:
   ```
   Task(
       subagent_type="project-manager",
       description="Validate Inception gate (LOM) criteria",
       prompt="""
       Read gate criteria from: $AIWG_ROOT/agentic/code/frameworks/sdlc-complete/flows/gate-criteria-by-phase.md

       Validate LOM criteria:
       - Vision document APPROVED (stakeholder signoff ≥75%)
       - Business case APPROVED (funding secured)
       - Risk list BASELINED (5-10 risks, top 3 have mitigation plans)
       - Data classification COMPLETE
       - Architecture scan documented
       - Executive Sponsor approval obtained

       Generate LOM Validation Report:
       - Status: PASS | FAIL
       - Criteria checklist with results
       - Decision: GO to Elaboration | NO-GO
       - Gaps (if NO-GO): List missing artifacts

       Save to: .aiwg/reports/lom-validation-report.md
       """
   )
   ```

3. **Decision Point**:
   - If LOM PASS → Continue to Step 2
   - If LOM FAIL → Report gaps to user, recommend `flow-concept-to-inception` to complete Inception
   - Escalate to user for executive decision if criteria partially met

**Communicate Progress**:
```
✓ Initialized LOM validation
⏳ Validating Inception exit criteria...
✓ LOM Validation complete: [PASS | FAIL]
```

### Step 2: Plan Architecture Baseline Development

**Purpose**: Define architecture objectives and select steel thread use cases

**Your Actions**:

1. **Read Intake and Risk Context**:
   ```
   Read:
   - .aiwg/intake/project-intake.md (understand project scope)
   - .aiwg/risks/risk-list.md (identify architectural risks)
   - .aiwg/requirements/vision-*.md (understand quality attributes)
   ```

2. **Launch Architecture Planning Agents** (parallel):
   ```
   # Agent 1: Architecture Designer
   Task(
       subagent_type="architecture-designer",
       description="Define architecture objectives and drivers",
       prompt="""
       Read project intake and vision documents

       Define for Architecture Baseline Plan:
       - Architectural drivers (quality attributes: performance, security, scalability)
       - Architectural constraints (technology, budget, timeline)
       - Component boundaries (logical decomposition approach)
       - Technology stack candidates (languages, frameworks, databases)
       - Integration architecture approach (APIs, external systems)

       Draft architecture objectives section
       Save to: .aiwg/working/elaboration/planning/architecture-objectives-draft.md
       """
   )

   # Agent 2: Requirements Analyst
   Task(
       subagent_type="requirements-analyst",
       description="Identify architecturally significant use cases",
       prompt="""
       Read vision and risk list

       Select 2-3 Steel Thread Use Cases:
       - Must exercise key architectural patterns
       - Must address high-priority architectural risks
       - Must demonstrate end-to-end flow (UI → logic → data)
       - Must include external system integration (if applicable)

       For each use case document:
       - Why architecturally significant (technical complexity, risk coverage)
       - Risks addressed (map to risk IDs)
       - Acceptance criteria (how to validate architecture works)

       Draft steel thread use cases section
       Save to: .aiwg/working/elaboration/planning/steel-thread-use-cases-draft.md
       """
   )

   # Agent 3: System Analyst
   Task(
       subagent_type="system-analyst",
       description="Define risk validation approach",
       prompt="""
       Read risk list

       For top 3 architectural risks:
       - Define validation approach (spike, POC, performance test)
       - Specify acceptance criteria (what proves risk is retired)
       - Recommend scope (minimal, standard, comprehensive)
       - Estimate effort (days/weeks)

       Document risk validation strategy
       Save to: .aiwg/working/elaboration/planning/risk-validation-strategy-draft.md
       """
   )
   ```

3. **Synthesize Architecture Baseline Plan**:
   ```
   Task(
       subagent_type="documentation-synthesizer",
       description="Create unified Architecture Baseline Plan",
       prompt="""
       Read all planning drafts:
       - .aiwg/working/elaboration/planning/architecture-objectives-draft.md
       - .aiwg/working/elaboration/planning/steel-thread-use-cases-draft.md
       - .aiwg/working/elaboration/planning/risk-validation-strategy-draft.md

       Synthesize into cohesive Architecture Baseline Plan:
       1. Architecture Objectives
       2. Steel Thread Use Cases
       3. Risk Validation Strategy
       4. Team Assignments (placeholder for user to fill)
       5. Schedule (4-8 weeks broken into phases)

       Use template: $AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/planning/phase-plan-template.md

       Output: .aiwg/planning/architecture-baseline-plan.md
       """
   )
   ```

**Communicate Progress**:
```
✓ LOM validation complete
⏳ Planning architecture baseline development...
  ✓ Architecture objectives defined
  ✓ Steel thread use cases identified (2-3)
  ✓ Risk validation strategy created
✓ Architecture Baseline Plan complete: .aiwg/planning/architecture-baseline-plan.md
```

### Step 3: Develop Architecture Baseline (SAD) - Multi-Agent Pattern

**Purpose**: Create comprehensive Software Architecture Document using multi-agent collaboration

**Template**: `$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/analysis-design/software-architecture-doc-template.md`

**Output**: `.aiwg/architecture/software-architecture-doc.md` (BASELINED)

**Agent Assignments** (from template metadata):
- **Primary Author**: Architecture Designer
- **Reviewers** (parallel): Security Architect, Test Architect, Requirements Analyst, Technical Writer
- **Synthesizer**: Architecture Documenter
- **Archivist**: Documentation Archivist

**Your Orchestration Steps**:

#### 3.1: Initialize Workspace

```
# You do this directly (no agent needed)
mkdir -p .aiwg/working/architecture/sad/{drafts,reviews,synthesis}

# Create metadata tracking
Write to .aiwg/working/architecture/sad/metadata.json:
{
  "document-id": "software-architecture-doc",
  "template-source": "$AIWG_ROOT/.../software-architecture-doc-template.md",
  "primary-author": "architecture-designer",
  "reviewers": ["security-architect", "test-architect", "requirements-analyst", "technical-writer"],
  "synthesizer": "architecture-documenter",
  "status": "DRAFT",
  "current-version": "0.1",
  "output-path": ".aiwg/architecture/software-architecture-doc.md"
}
```

#### 3.2: Primary Draft Creation

```
Task(
    subagent_type="architecture-designer",
    description="Create Software Architecture Document draft",
    prompt="""
    Read template: $AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/analysis-design/software-architecture-doc-template.md
    Read inputs:
    - .aiwg/planning/architecture-baseline-plan.md (objectives, drivers)
    - .aiwg/requirements/vision-*.md (quality attributes)
    - .aiwg/intake/project-intake.md (context, scope)
    - .aiwg/risks/risk-list.md (architectural risks to address)

    Create comprehensive SAD draft covering:

    1. Architectural Drivers
       - Quality attributes (performance, scalability, security, availability)
       - Constraints (technology, budget, timeline, regulatory)
       - Assumptions (technical, organizational)

    2. Component Decomposition
       - Logical view (modules, layers, responsibilities)
       - Physical view (deployment units, processes, threads)
       - Component relationships (dependencies, interfaces)

    3. Deployment Architecture
       - Environments (dev, test, staging, prod)
       - Infrastructure (cloud, on-prem, hybrid)
       - Networking (VPCs, subnets, load balancers)
       - Scaling strategy (horizontal, vertical, auto-scaling)

    4. Technology Stack
       - Languages (with rationale)
       - Frameworks (with alternatives considered)
       - Databases (RDBMS, NoSQL, caching)
       - Tools and services (CI/CD, monitoring, logging)

    5. Integration Architecture
       - External systems (APIs, protocols, data formats)
       - Authentication mechanisms (OAuth, JWT, API keys)
       - Data exchange patterns (sync, async, event-driven)

    6. Security Architecture
       - Authentication (user identity, SSO)
       - Authorization (RBAC, ABAC, policies)
       - Encryption (at-rest, in-transit, key management)
       - Audit logging (what, when, who, compliance)

    7. Data Architecture
       - Data models (entities, relationships)
       - Storage strategy (transactional, analytical, archival)
       - Migration strategy (schema evolution, data migration)

    8. Key Decisions (ADR References)
       - List 3-5 major architectural decisions
       - Link to detailed ADR documents (to be created in Step 4)

    Follow template structure exactly.
    Technical depth appropriate for Elaboration (detailed but not implementation-level).

    Save draft to: .aiwg/working/architecture/sad/drafts/v0.1-primary-draft.md
    """
)
```

**Wait for completion**, then update user:
```
✓ Architecture Designer created SAD v0.1 draft (estimated 3,000-5,000 words)
```

#### 3.3: Parallel Multi-Agent Review

**Launch all reviewers simultaneously** (single message with 4 Task calls):

```
# Security Architect Review
Task(
    subagent_type="security-architect",
    description="Review SAD: Security architecture validation",
    prompt="""
    Read draft: .aiwg/working/architecture/sad/drafts/v0.1-primary-draft.md

    Review focus: Security Architecture completeness

    Validate:
    - Authentication mechanisms (OAuth, JWT, SSO) - are they appropriate?
    - Authorization strategy (RBAC, ABAC) - is it complete?
    - Encryption (at-rest, in-transit) - are standards specified (e.g., TLS 1.3, AES-256)?
    - Security controls (input validation, CSRF, XSS protection)
    - Audit logging (what events, retention, compliance)
    - Key management (where secrets stored, rotation policy)
    - Threat model considerations (STRIDE, attack surface)

    Add inline comments: <!-- SEC-ARCH: your feedback -->

    Create review summary:
    - Strengths (what's well-documented)
    - Gaps (missing security details)
    - Recommendations (specific improvements)
    - Status: APPROVED | CONDITIONAL | NEEDS_WORK

    If CONDITIONAL or NEEDS_WORK, specify what must be addressed.

    Save review to: .aiwg/working/architecture/sad/reviews/security-architect-review.md
    """
)

# Test Architect Review
Task(
    subagent_type="test-architect",
    description="Review SAD: Testability and test strategy",
    prompt="""
    Read draft: .aiwg/working/architecture/sad/drafts/v0.1-primary-draft.md

    Review focus: Architecture testability

    Validate:
    - Component boundaries enable unit testing
    - Integration points are mockable/stubbable
    - Deployment architecture supports test environments
    - Performance testing infrastructure (load testing, benchmarking)
    - Test data strategy (synthetic, anonymized, production-like)
    - Observability (logging, metrics, tracing for debugging)

    Add inline comments: <!-- TEST-ARCH: your feedback -->

    Create review summary:
    - Testability strengths
    - Testability gaps
    - Test infrastructure recommendations
    - Status: APPROVED | CONDITIONAL | NEEDS_WORK

    Save review to: .aiwg/working/architecture/sad/reviews/test-architect-review.md
    """
)

# Requirements Analyst Review
Task(
    subagent_type="requirements-analyst",
    description="Review SAD: Requirements traceability",
    prompt="""
    Read draft: .aiwg/working/architecture/sad/drafts/v0.1-primary-draft.md
    Read requirements: .aiwg/requirements/vision-*.md

    Review focus: Requirements-to-architecture traceability

    Validate:
    - Architectural components map to functional requirements
    - Quality attributes (NFRs) addressed in architecture
    - Steel thread use cases covered by component design
    - Missing functionality (requirements without component assignment)

    Add inline comments: <!-- REQ-ANALYST: your feedback -->

    Create review summary:
    - Traceability strengths (well-mapped components)
    - Traceability gaps (requirements without architecture coverage)
    - Recommendations (component additions or clarifications)
    - Status: APPROVED | CONDITIONAL | NEEDS_WORK

    Save review to: .aiwg/working/architecture/sad/reviews/requirements-analyst-review.md
    """
)

# Technical Writer Review
Task(
    subagent_type="technical-writer",
    description="Review SAD: Clarity and consistency",
    prompt="""
    Read draft: .aiwg/working/architecture/sad/drafts/v0.1-primary-draft.md

    Review focus: Documentation quality

    Validate:
    - Clarity (understandable by developers, stakeholders)
    - Consistency (terminology, formatting, style)
    - Grammar and spelling
    - Diagram references (are they clear, do they exist)
    - Section completeness (no TODOs or placeholders)

    Add inline comments: <!-- TECH-WRITER: your feedback -->

    Create review summary:
    - Clarity strengths
    - Clarity issues (jargon, ambiguity, missing context)
    - Formatting/style improvements
    - Status: APPROVED | CONDITIONAL | NEEDS_WORK

    Save review to: .aiwg/working/architecture/sad/reviews/technical-writer-review.md
    """
)
```

**Wait for all 4 reviews to complete**, then update user:
```
⏳ Launching parallel review (4 agents)...
  ✓ Security Architect: [APPROVED | CONDITIONAL | NEEDS_WORK] (2-3 min)
  ✓ Test Architect: [APPROVED | CONDITIONAL | NEEDS_WORK] (2-3 min)
  ✓ Requirements Analyst: [APPROVED | CONDITIONAL | NEEDS_WORK] (2-3 min)
  ✓ Technical Writer: [APPROVED | CONDITIONAL | NEEDS_WORK] (2-3 min)
```

#### 3.4: Synthesis and Finalization

```
Task(
    subagent_type="architecture-documenter",
    description="Synthesize SAD review feedback",
    prompt="""
    Read primary draft: .aiwg/working/architecture/sad/drafts/v0.1-primary-draft.md
    Read all reviews:
    - .aiwg/working/architecture/sad/reviews/security-architect-review.md
    - .aiwg/working/architecture/sad/reviews/test-architect-review.md
    - .aiwg/working/architecture/sad/reviews/requirements-analyst-review.md
    - .aiwg/working/architecture/sad/reviews/technical-writer-review.md

    Synthesize final Software Architecture Document:

    1. Read all inline comments (<!-- ROLE: feedback -->)
    2. Merge complementary feedback (add missing sections)
    3. Resolve conflicts (e.g., security vs. performance trade-offs):
       - Document trade-off rationale
       - Escalate to user if unresolvable
    4. Address CONDITIONAL feedback (must-fix items)
    5. Incorporate APPROVED feedback (nice-to-have improvements)
    6. Ensure technical accuracy and architectural consistency

    Create synthesis report documenting:
    - All feedback integrated (checklist)
    - Conflicts resolved (with rationale)
    - Outstanding concerns escalated (if any)
    - Review status summary (4/4 APPROVED, etc.)

    Output final SAD v1.0:
    - .aiwg/architecture/software-architecture-doc.md (BASELINED)

    Output synthesis report:
    - .aiwg/working/architecture/sad/synthesis/synthesis-report.md
    """
)
```

**Wait for synthesis**, then update user:
```
⏳ Synthesizing SAD feedback...
✓ SAD BASELINED: .aiwg/architecture/software-architecture-doc.md
  - Review status: [X/4 APPROVED, Y/4 CONDITIONAL resolved]
  - Final version: 1.0
  - Word count: ~3,500-5,500 words
```

#### 3.5: Archive Workflow

```
# You do this directly (or via Documentation Archivist agent)

# Archive complete workflow
mv .aiwg/working/architecture/sad \
   .aiwg/archive/$(date +%Y-%m)/sad-$(date +%Y-%m-%d)/

# Generate audit trail
Create .aiwg/archive/$(date +%Y-%m)/sad-$(date +%Y-%m-%d)/audit-trail.md:

# Audit Trail: Software Architecture Document

**Document ID:** software-architecture-doc
**Final Version:** 1.0
**Baselined:** {current-timestamp}
**Output:** .aiwg/architecture/software-architecture-doc.md

## Timeline
- v0.1: Architecture Designer initial draft (timestamp)
- v0.2: Security Architect review complete (APPROVED with recommendations)
- v0.3: Test Architect review complete (CONDITIONAL - test mocking strategy needed)
- v0.3: Requirements Analyst review complete (APPROVED)
- v0.3: Technical Writer review complete (APPROVED - minor fixes applied)
- v1.0: Architecture Documenter final synthesis (BASELINED)

## Reviews
- Security Architect: APPROVED (added TLS 1.3 requirement)
- Test Architect: CONDITIONAL → RESOLVED (added service mocking documentation)
- Requirements Analyst: APPROVED (validated component mapping)
- Technical Writer: APPROVED (standardized terminology, fixed diagrams)

## Synthesis
- Conflicts resolved: 1 (TLS version for test environment: 1.3 prod, 1.2 test/dev)
- Final status: BASELINED
```

**Update user**:
```
✓ Archived workflow: .aiwg/archive/{date}/sad-{date}/
```

### Step 4: Create Architecture Decision Records (ADRs)

**Purpose**: Document 3-5 major architectural decisions identified in SAD

**Template**: `$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/analysis-design/architecture-decision-record-template.md`

**Your Actions**:

1. **Extract Decisions from SAD**:
   ```
   Read .aiwg/architecture/software-architecture-doc.md
   Identify section "Key Decisions" (3-5 major decisions)
   ```

2. **For Each Decision, Launch ADR Creation** (can be parallel):
   ```
   Task(
       subagent_type="architecture-designer",
       description="Create ADR-{number}: {decision-title}",
       prompt="""
       Read SAD: .aiwg/architecture/software-architecture-doc.md
       Read ADR template: $AIWG_ROOT/.../architecture-decision-record-template.md

       Create ADR for decision: {decision-title}

       Structure:
       1. Status: Proposed | Accepted | Superseded
       2. Context: What is the issue we're facing?
       3. Decision: What is the change we're making?
       4. Consequences: What are the impacts (positive, negative, risks)?
       5. Alternatives Considered: What other options were evaluated? Why rejected?

       Example decisions to document:
       - Database Selection (PostgreSQL vs MySQL vs MongoDB)
       - API Architecture (REST vs GraphQL vs gRPC)
       - Authentication Strategy (OAuth vs JWT vs session-based)
       - Deployment Model (monolith vs microservices)
       - Cloud Provider Selection (AWS vs Azure vs GCP)

       Technical depth: Elaborate on trade-offs, not just "we chose X"

       Save to: .aiwg/architecture/adr/ADR-{number:03d}-{slug}.md
       (e.g., ADR-001-database-selection.md)
       """
   )
   ```

3. **Quick Review Cycle** (parallel reviewers):
   ```
   # Launch 2-3 reviewers for each ADR:
   # - Security Architect (if security-relevant decision)
   # - Test Architect (for testability impacts)
   # - Technical Writer (for clarity)

   # Lighter review than SAD (5-10 min per reviewer)
   # Focus on: decision rationale complete, alternatives documented, consequences realistic
   ```

**Communicate Progress**:
```
⏳ Creating ADRs (3-5 decisions)...
  ✓ ADR-001: Database Selection (PostgreSQL) - APPROVED
  ✓ ADR-002: API Architecture (REST + GraphQL) - APPROVED
  ✓ ADR-003: Authentication (OAuth 2.0 + JWT) - APPROVED
  ✓ ADR-004: Deployment Model (Kubernetes) - CONDITIONAL → RESOLVED
✓ ADRs baselined: .aiwg/architecture/adr/ (3-5 files)
```

### Step 5: Retire Architectural Risks

**Purpose**: Validate high-risk assumptions via POCs, update risk list

**Your Actions**:

1. **Read Risk List and Identify High-Priority Risks**:
   ```
   Read .aiwg/risks/risk-list.md
   Filter for:
   - Priority: P0 (Show Stopper) or P1 (High)
   - Category: Architectural or Technical
   - Status: Open or Identified (not yet retired)
   ```

2. **For Each High-Risk Assumption, Launch Risk Validation**:
   ```
   # Option A: Build POC (if technical feasibility needs proof)
   Task(
       subagent_type="software-implementer",
       description="Build POC for Risk #{risk-id}",
       prompt="""
       Risk to validate: {risk-description}

       Use /build-poc command to create proof of concept:
       /build-poc "{risk-description}" --scope {minimal|standard|comprehensive}

       Acceptance criteria: {what proves risk is retired}

       Output POC results to: .aiwg/risks/poc-{risk-id}-results.md

       Document:
       - POC approach (what was tested)
       - Results (metrics, observations)
       - Decision: GO (risk retired) | NO-GO (risk remains) | PIVOT (change approach)
       """
   )

   # Option B: Conduct Spike (if research/investigation needed)
   Task(
       subagent_type="architecture-designer",
       description="Conduct spike for Risk #{risk-id}",
       prompt="""
       Risk to investigate: {risk-description}

       Conduct time-boxed investigation (1-3 days):
       - Research alternatives (frameworks, patterns, technologies)
       - Prototype minimal implementation
       - Benchmark performance (if performance risk)
       - Document findings

       Spike card template: $AIWG_ROOT/.../spike-card-template.md

       Output: .aiwg/risks/spike-{risk-id}-results.md
       """
   )

   # Option C: Analysis Only (if risk can be retired by design)
   Task(
       subagent_type="security-architect",
       description="Validate Risk #{risk-id} through architecture",
       prompt="""
       Risk: {risk-description}

       Validate that architecture addresses this risk:
       - Read SAD: .aiwg/architecture/software-architecture-doc.md
       - Verify risk mitigation documented (security controls, design patterns)
       - Confirm mitigation is sufficient

       Document validation:
       - How architecture addresses risk
       - Residual risk (if any)
       - Decision: RETIRED | MITIGATED | ACCEPTED

       Output: .aiwg/risks/risk-{risk-id}-validation.md
       """
   )
   ```

3. **Update Risk List**:
   ```
   Task(
       subagent_type="project-manager",
       description="Update risk list with validation results",
       prompt="""
       Read all risk validation results:
       - .aiwg/risks/poc-*-results.md
       - .aiwg/risks/spike-*-results.md
       - .aiwg/risks/risk-*-validation.md

       Update .aiwg/risks/risk-list.md:
       - Change status: Open → RETIRED | MITIGATED | ACCEPTED
       - Add validation evidence (POC results, spike findings)
       - Document residual risk (if any)
       - Add newly discovered risks (if any)

       Calculate risk retirement metrics:
       - Total risks: {count}
       - Retired: {count} ({percentage}%)
       - Mitigated: {count} ({percentage}%)
       - Accepted: {count} ({percentage}%)

       ABM Target: ≥70% retired or mitigated
       Critical Target: 100% of P0 and P1 architectural risks retired/mitigated
       """
   )
   ```

**Communicate Progress**:
```
⏳ Retiring architectural risks...
  ✓ Risk #1 (Database scale): POC complete → RETIRED (validated 1M records, <100ms)
  ✓ Risk #2 (OAuth integration): Spike complete → RETIRED (tested Auth0 integration)
  ✓ Risk #3 (Performance SLA): Architecture analysis → MITIGATED (caching strategy)
  ✓ Risk #4 (API versioning): Design validated → RETIRED (versioning strategy documented)
✓ Risk retirement: 75% (target: ≥70%) - ABM CRITERIA MET
```

### Step 6: Baseline Requirements and Test Strategy

**Purpose**: Document use cases, NFRs, and Master Test Plan

**Your Actions**:

1. **Create Use Case Specifications** (parallel):
   ```
   Task(
       subagent_type="requirements-analyst",
       description="Create use case specifications (10+ use cases)",
       prompt="""
       Read architecture baseline plan: .aiwg/planning/architecture-baseline-plan.md
       Read steel thread use cases (already identified)

       Create 10+ use case specifications:
       - Top 3: Steel thread use cases (architecturally significant, already validated)
       - Remaining 7+: Functional requirements for Construction

       Template: $AIWG_ROOT/.../use-case-spec-template.md

       For each use case:
       1. Use Case ID and Name
       2. Actors (who interacts)
       3. Preconditions (system state before)
       4. Main Flow (happy path steps)
       5. Alternative Flows (error cases, edge cases)
       6. Postconditions (system state after)
       7. Acceptance Criteria (how to test)
       8. Component Mapping (which SAD components implement this)

       Ensure traceability: Use Case → SAD Components

       Output: .aiwg/requirements/use-case-{id}-{name}.md (10+ files)
       """
   )
   ```

2. **Create Supplemental Specification (NFRs)**:
   ```
   Task(
       subagent_type="requirements-analyst",
       description="Document non-functional requirements",
       prompt="""
       Read SAD quality attributes
       Read architecture baseline plan

       Create Supplemental Specification covering:

       1. Performance
          - Response time: p50, p95, p99 (e.g., p95 < 500ms)
          - Throughput: requests/second (e.g., 1000 req/s)

       2. Scalability
          - Concurrent users (e.g., 10,000 simultaneous)
          - Data volume (e.g., 1M records, 10GB database)

       3. Availability
          - Uptime target (e.g., 99.9% = 43 min downtime/month)
          - SLA definition (service level agreement)

       4. Security (reference SAD security architecture)
          - Authentication: OAuth 2.0, JWT
          - Authorization: RBAC
          - Audit: All user actions logged

       5. Usability
          - Accessibility: WCAG 2.1 Level AA
          - Internationalization: English, Spanish, French

       6. Maintainability
          - Coding standards: (reference or define)
          - Documentation: Inline comments, API docs
          - Technical debt: Policy for addressing

       Template: $AIWG_ROOT/.../supplemental-specification-template.md

       Output: .aiwg/requirements/supplemental-specification.md
       """
   )
   ```

3. **Create Master Test Plan**:
   ```
   Task(
       subagent_type="test-architect",
       description="Develop Master Test Plan",
       prompt="""
       Read SAD testability sections
       Read supplemental specification (NFRs)
       Read use case specifications

       Create Master Test Plan covering:

       1. Test Strategy
          - Test types: Unit, Integration, System, Acceptance, Performance, Security
          - Test levels: Component, Service, End-to-End

       2. Coverage Targets
          - Unit tests: ≥80% code coverage
          - Integration tests: ≥70% API coverage
          - End-to-End: ≥50% user journey coverage

       3. Test Environments
          - Development: Local, Docker Compose
          - Test: Shared environment, CI/CD integrated
          - Staging: Production-like, final validation
          - Production: Smoke tests only

       4. Test Data Strategy
          - Synthetic data: Generated for unit/integration
          - Anonymized data: Production data sanitized for staging
          - Production-like: Realistic volume and variety

       5. Test Automation
          - Unit: Jest (JS), Pytest (Python)
          - Integration: Postman, REST Assured
          - E2E: Playwright, Selenium
          - CI Integration: GitHub Actions, Jenkins

       6. Defect Management
          - Triage: P0 (blocker), P1 (critical), P2 (major), P3 (minor), P4 (trivial)
          - Tracking: Jira, GitHub Issues
          - Resolution SLAs: P0 = 4 hours, P1 = 24 hours, P2 = 3 days

       Template: $AIWG_ROOT/.../master-test-plan-template.md

       Output: .aiwg/testing/master-test-plan.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Baselining requirements and test strategy...
  ✓ Use case specifications created (10+ use cases)
  ✓ Supplemental specification (NFRs) complete
  ✓ Master Test Plan approved
✓ Requirements baseline: .aiwg/requirements/ (10+ files + supplemental spec)
✓ Test strategy: .aiwg/testing/master-test-plan.md
```

### Step 7: Conduct Architecture Baseline Milestone (ABM) Review

**Purpose**: Formal gate review to decide GO/NO-GO to Construction

**Your Actions**:

1. **Validate ABM Criteria**:
   ```
   Task(
       subagent_type="project-manager",
       description="Validate ABM gate criteria",
       prompt="""
       Read gate criteria: $AIWG_ROOT/.../flows/gate-criteria-by-phase.md (Elaboration section)

       Validate all ABM criteria:

       1. Architecture Documentation
          - [ ] SAD complete and BASELINED
          - [ ] SAD peer-reviewed (4+ reviewers)
          - [ ] ADRs documented (3-5 decisions)

       2. Risk Retirement
          - [ ] ≥70% of risks retired or mitigated
          - [ ] 100% of P0/P1 architectural risks retired/mitigated
          - [ ] POC/Spike results documented

       3. Requirements Baseline
          - [ ] ≥10 use cases documented
          - [ ] Supplemental specification (NFRs) complete
          - [ ] Traceability established (use cases → SAD components)

       4. Test Strategy
          - [ ] Master Test Plan approved
          - [ ] Test environments operational (dev, test)

       Report status: PASS | CONDITIONAL PASS | FAIL

       Output: .aiwg/reports/abm-criteria-validation.md
       """
   )
   ```

2. **Generate ABM Report**:
   ```
   Task(
       subagent_type="project-manager",
       description="Generate Architecture Baseline Milestone Report",
       prompt="""
       Read all Elaboration artifacts:
       - .aiwg/architecture/software-architecture-doc.md
       - .aiwg/architecture/adr/*.md
       - .aiwg/risks/risk-list.md
       - .aiwg/requirements/*.md
       - .aiwg/testing/master-test-plan.md
       - .aiwg/reports/abm-criteria-validation.md

       Generate comprehensive ABM Report:

       1. Overall Status
          - ABM Status: PASS | CONDITIONAL PASS | FAIL
          - Decision: GO | CONDITIONAL GO | NO-GO | PIVOT

       2. Criteria Validation (detailed breakdown)
          - Architecture Documentation: PASS | FAIL
          - Risk Retirement: PASS | FAIL (with metrics)
          - Requirements Baseline: PASS | FAIL
          - Test Strategy: PASS | FAIL

       3. Signoff Checklist
          - [ ] Executive Sponsor
          - [ ] Software Architect
          - [ ] Security Architect
          - [ ] Test Architect
          - [ ] Product Owner
          - [ ] Peer Reviewer (external architect)

       4. Decision Rationale
          - Why GO/NO-GO/CONDITIONAL GO
          - Evidence supporting decision

       5. Conditions (if CONDITIONAL GO)
          - What must be completed before full GO
          - Re-validation date

       6. Next Steps
          - Action items
          - Schedule (Construction kickoff date)

       Template: Use ABM Report structure from orchestration template

       Output: .aiwg/reports/abm-report.md
       """
   )
   ```

3. **Present ABM Summary to User**:
   ```
   # You present this directly (not via agent)

   Read .aiwg/reports/abm-report.md

   Present summary:
   ─────────────────────────────────────────────
   Architecture Baseline Milestone Review
   ─────────────────────────────────────────────

   **Overall Status**: {PASS | CONDITIONAL PASS | FAIL}
   **Decision**: {GO | CONDITIONAL GO | NO-GO | PIVOT}

   **Criteria Status**:
   ✓ Architecture Documentation: PASS
     - SAD baselined (v1.0, 4 reviewers APPROVED)
     - ADRs documented (4 major decisions)

   ✓ Risk Retirement: PASS
     - 75% retired or mitigated (target: ≥70%)
     - 100% of P0/P1 risks addressed

   ✓ Requirements Baseline: PASS
     - 12 use cases documented
     - Supplemental spec complete
     - Traceability: 100%

   ✓ Test Strategy: PASS
     - Master Test Plan approved
     - Test environments operational

   **Artifacts Generated**:
   - Software Architecture Document (.aiwg/architecture/software-architecture-doc.md)
   - ADR-001: Database Selection (.aiwg/architecture/adr/ADR-001-database-selection.md)
   - ADR-002: API Architecture (.aiwg/architecture/adr/ADR-002-api-architecture.md)
   - ADR-003: Authentication (.aiwg/architecture/adr/ADR-003-authentication.md)
   - ADR-004: Deployment Model (.aiwg/architecture/adr/ADR-004-deployment-model.md)
   - Master Test Plan (.aiwg/testing/master-test-plan.md)
   - Use Case Specifications (.aiwg/requirements/use-case-*.md, 12 files)
   - Supplemental Specification (.aiwg/requirements/supplemental-specification.md)
   - ABM Report (.aiwg/reports/abm-report.md)

   **Next Steps**:
   - Review all generated artifacts
   - Schedule ABM review meeting with stakeholders
   - Obtain formal signoffs (6 required signatures)
   - If GO: Run /flow-elaboration-to-construction to begin Construction
   - If CONDITIONAL GO: Complete conditions, then re-validate
   - If NO-GO: Address gaps, extend Elaboration, re-review in 2-4 weeks

   ─────────────────────────────────────────────
   ```

**Communicate Progress**:
```
⏳ Conducting ABM gate validation...
✓ ABM criteria validated: PASS (4/4 criteria met)
✓ ABM Report generated: .aiwg/reports/abm-report.md
```

## Quality Gates

Before marking workflow complete, verify:
- [ ] All required artifacts generated and BASELINED
- [ ] All reviewers provided sign-off (APPROVED or CONDITIONAL resolved)
- [ ] Final artifacts saved to .aiwg/{category}/
- [ ] Working drafts archived to .aiwg/archive/
- [ ] Synthesis reports document all changes
- [ ] ABM criteria validated: PASS or CONDITIONAL PASS

## User Communication

**At start**: Confirm understanding and list artifacts to generate

```
Understood. I'll orchestrate the Inception → Elaboration transition.

This will generate:
- Software Architecture Document (SAD)
- Architecture Decision Records (3-5 ADRs)
- Master Test Plan
- Requirements Baseline (10+ use cases + NFRs)
- Risk Retirement Report
- Elaboration Phase Plan
- ABM Report

I'll coordinate multiple agents for comprehensive review.
Expected duration: 15-20 minutes.

Starting orchestration...
```

**During**: Update progress with clear indicators

```
✓ = Complete
⏳ = In progress
❌ = Error/blocked
⚠️ = Warning/attention needed
```

**At end**: Summary report with artifact locations and status (see Step 7.3 above)

## Error Handling

**If LOM Not Met**:
```
❌ Inception phase incomplete - cannot proceed to Elaboration

Gaps identified:
- {list missing artifacts or incomplete criteria}

Recommendation: Complete Inception first
- Run: /flow-concept-to-inception
- Or: Complete missing artifacts manually

Contact Executive Sponsor for project status decision.
```

**If POC/Spike Failed**:
```
❌ Critical POC failed - technical feasibility not proven

Risk: {risk-description}
POC Result: {NO-GO reason}

Actions:
1. Identify technical blockers
2. Consider architecture pivot or technology change
3. Conduct additional investigation spike

Impact: ABM blocked until technical feasibility proven or risk accepted by sponsor.

Escalating to user for decision...
```

**If Risk Retirement Insufficient**:
```
⚠️ Risk retirement {percentage}% (target: ≥70%)

Outstanding risks:
- {risk-1}: {status}
- {risk-2}: {status}

Recommendation: Conduct additional spikes/POCs to retire critical risks

Impact: ABM may result in CONDITIONAL GO or NO-GO if risk retirement remains insufficient.
```

**If Review Conflicts Unresolvable**:
```
⚠️ Review conflict requires user decision

Conflict: {description}
- Security Architect: {position}
- Performance Architect: {opposing position}

Trade-off analysis:
- Option A: {pros/cons}
- Option B: {pros/cons}

Escalating to user for architectural decision...
```

## Success Criteria

This orchestration succeeds when:
- [ ] Lifecycle Objective Milestone validated (LOM complete)
- [ ] Architecture Baseline Plan created
- [ ] Software Architecture Document BASELINED (multi-agent reviewed)
- [ ] ADRs documented (3-5 major decisions)
- [ ] Risks retired ≥70% (P0/P1 100% retired/mitigated)
- [ ] POCs/Spikes completed for high-risk assumptions
- [ ] Requirements baseline ESTABLISHED (10+ use cases + NFRs)
- [ ] Master Test Plan APPROVED
- [ ] ABM review conducted with GO/CONDITIONAL GO decision
- [ ] Complete audit trails archived

## Metrics to Track

**During orchestration, track**:
- Architecture stability: % of architectural changes (target: <10% after ABM)
- POC/Spike completion: % of planned validations completed (target: 100%)
- Risk retirement velocity: % of risks resolved per week
- Review consensus: % of reviews APPROVED vs CONDITIONAL vs NEEDS_WORK
- Cycle time: Elaboration phase duration (target: 4-8 weeks, orchestration: 15-20 min)

## References

**Templates** (via $AIWG_ROOT):
- Software Architecture Doc: `templates/analysis-design/software-architecture-doc-template.md`
- ADR: `templates/analysis-design/architecture-decision-record-template.md`
- Use Case: `templates/requirements/use-case-spec-template.md`
- Supplemental Spec: `templates/requirements/supplemental-specification-template.md`
- Master Test Plan: `templates/test/master-test-plan-template.md`
- Risk List: `templates/management/risk-list-template.md`

**Gate Criteria**:
- `flows/gate-criteria-by-phase.md` (Elaboration section)

**Multi-Agent Pattern**:
- `docs/multi-agent-documentation-pattern.md`

**Orchestrator Architecture**:
- `docs/orchestrator-architecture.md`

**Natural Language Translations**:
- `docs/simple-language-translations.md`
