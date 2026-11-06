---
namespace: aiwg
name: flow-concept-to-inception
platforms: [all]
description: Orchestrate Concept→Inception phase transition with intake validation and vision alignment
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
> declarative YAML Flow at `flows/flow-concept-to-inception.playbook.yaml` (source of truth for the step
> sequence + gates). This SKILL.md remains the discoverable trigger surface and prose
> reference. See epic #1534.

# Concept → Inception Phase Transition Flow

**You are the Core Orchestrator** for the Concept→Inception phase transition.

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

**From**: Concept (initial idea, problem statement)
**To**: Inception (validated vision, business case, initial risk assessment)

**Key Milestone**: Lifecycle Objective Milestone (LOM)

**Success Criteria**:
- Vision document approved by stakeholders
- Business case approved with funding secured
- Risk list baselined with mitigation plans
- Initial architecture and security assessment complete

**Expected Duration**: 2-4 weeks (typical), 10-15 minutes orchestration

## Natural Language Triggers

Users may say:
- "Start new project"
- "Begin Inception"
- "Start Inception phase"
- "Kick off the project"
- "Complete intake and start Inception"
- "Initialize project from concept"
- "Move from idea to Inception"

You recognize these as requests for this orchestration flow.

## Parameter Handling

### --guidance Parameter

**Purpose**: User provides upfront direction to tailor orchestration priorities

**Examples**:
```
--guidance "Healthcare domain, HIPAA compliance critical"
--guidance "Startup context, need MVP fast, budget constrained"
--guidance "Enterprise project, heavy compliance and governance"
--guidance "Technical debt reduction, focus on architecture quality"
```

**How to Apply**:
- Parse guidance for keywords: security, compliance, timeline, budget, domain
- Adjust agent assignments (add security-architect for compliance focus)
- Modify artifact depth (minimal for MVP, comprehensive for enterprise)
- Influence priority ordering (compliance-first vs. speed-first)

### --interactive Parameter

**Purpose**: You ask 6 strategic questions to understand project context

**Questions to Ask** (if --interactive):

```
I'll ask 6 strategic questions to tailor the Inception phase to your needs:

Q1: What are your top priorities for this project?
    (e.g., time-to-market, security, compliance, innovation)

Q2: What are your biggest constraints?
    (e.g., budget, timeline, team size, technology)

Q3: What risks concern you most?
    (e.g., technical feasibility, market fit, regulatory, security)

Q4: What's your team's experience level with this type of project?
    (Helps determine depth of documentation and guidance needed)

Q5: What's your target timeline for Inception completion?
    (Influences artifact depth and review cycles)

Q6: Are there regulatory or compliance requirements?
    (e.g., HIPAA, GDPR, PCI-DSS, SOC2)

Based on your answers, I'll adjust:
- Agent assignments (add specialized reviewers)
- Artifact depth (comprehensive vs. streamlined)
- Priority ordering (compliance-first vs. speed-first)
- Risk focus areas (technical vs. business vs. regulatory)
```

**Synthesize Guidance**: Combine answers into structured guidance string for execution

## Artifacts to Generate

**Primary Deliverables**:
- **Vision Document**: Problem statement, personas, success metrics → `.aiwg/requirements/vision-document.md`
- **Business Case**: ROM cost estimate, ROI analysis, funding request → `.aiwg/management/business-case.md`
- **Risk List**: 5-10 risks with mitigation plans → `.aiwg/risks/risk-list.md`
- **Use Case Briefs**: 3-5 high-level use cases → `.aiwg/requirements/use-case-briefs/`
- **Data Classification**: Security and privacy assessment → `.aiwg/security/data-classification.md`
- **Architecture Sketch**: Initial component boundaries → `.aiwg/architecture/architecture-sketch.md`
- **ADRs**: 3+ critical decisions → `.aiwg/architecture/adr/`
- **Option Matrix**: Alternatives analyzed → `.aiwg/planning/option-matrix.md`
- **LOM Report**: Gate validation and go/no-go decision → `.aiwg/reports/lom-report.md`

**Supporting Artifacts**:
- Stakeholder interview notes
- Privacy impact assessment
- Scope boundaries document
- Complete audit trails (archived workflows)

## Multi-Agent Orchestration Workflow

### Step 1: Validate Intake and Initialize Vision - Multi-Agent Pattern

**Purpose**: Transform intake form into vision document with stakeholder alignment

**Your Actions**:

1. **Check for Intake Artifacts**:
   ```
   Read and verify presence of:
   - .aiwg/intake/project-intake.md (or intake/project-intake-template.md)

   If missing, recommend: /intake-wizard "project description"
   ```

2. **Launch Vision Development Agents** (parallel):
   ```
   # Agent 1: Vision Owner
   Task(
       subagent_type="vision-owner",
       description="Create vision document from intake",
       prompt="""
       Read intake form: .aiwg/intake/project-intake.md
       Read template: $AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/requirements/vision-informal-template.md

       Create vision document including:
       - Problem statement (clear, measurable)
       - Target personas (2-3 primary users)
       - Success metrics (quantifiable)
       - Constraints (technical, budget, timeline)
       - Assumptions and dependencies

       Focus on clarity and stakeholder communication.

       Save to: .aiwg/working/requirements/vision/drafts/v0.1-primary-draft.md
       """
   )

   # Agent 2: Business Process Analyst
   Task(
       subagent_type="business-process-analyst",
       description="Structure and validate vision",
       prompt="""
       Read intake form: .aiwg/intake/project-intake.md

       Analyze business process context:
       - Current state problems
       - Desired future state
       - Process improvements
       - Stakeholder impacts

       Document process context and stakeholder needs.

       Save to: .aiwg/working/requirements/vision/drafts/process-context.md
       """
   )
   ```

3. **Launch Parallel Reviewers**:
   ```
   # Product Strategist, Business Process Analyst, Technical Writer
   Task(
       subagent_type="product-strategist",
       description="Review vision for business value",
       prompt="""
       Read draft: .aiwg/working/requirements/vision/drafts/v0.1-primary-draft.md

       Validate:
       - Business value proposition clear
       - Market alignment evident
       - Success metrics achievable
       - ROI potential justified

       Add inline comments: <!-- PRODUCT-STRATEGIST: feedback -->

       Create review summary:
       - Status: APPROVED | CONDITIONAL | NEEDS_WORK

       Save to: .aiwg/working/requirements/vision/reviews/product-strategist-review.md
       """
   )

   # Similar for business-process-analyst and technical-writer
   ```

4. **Synthesize Vision Document**:
   ```
   Task(
       subagent_type="requirements-documenter",
       description="Synthesize vision document",
       prompt="""
       Read all vision drafts and reviews.

       Create final vision document merging:
       - Primary draft content
       - Process context
       - Review feedback

       Resolve conflicts, ensure clarity.

       Output: .aiwg/requirements/vision-document.md
       """
   )
   ```

**Communicate Progress**:
```
✓ Intake validated
⏳ Creating vision document...
  ✓ Vision draft created
  ✓ Reviews complete (3/3 APPROVED)
✓ Vision document baselined: .aiwg/requirements/vision-document.md
```

### Step 2: Business Value and Use Case Alignment

**Purpose**: Define use cases and validate business value proposition

**Your Actions**:

1. **Launch Use Case Development** (parallel agents):
   ```
   Task(
       subagent_type="requirements-analyst",
       description="Create use case briefs",
       prompt="""
       Read vision: .aiwg/requirements/vision-document.md
       Read template: $AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/requirements/use-case-brief-template.md

       Create 3-5 use case briefs:
       - UC-001: Primary user workflow
       - UC-002: Secondary workflow
       - UC-003: Admin/management function

       Each brief includes:
       - Actor and goal
       - Preconditions
       - Main flow (high-level)
       - Success criteria

       Save to: .aiwg/requirements/use-case-briefs/UC-*.md
       """
   )

   Task(
       subagent_type="product-strategist",
       description="Validate value proposition",
       prompt="""
       Read use cases as they're created.
       Validate each aligns with business value.
       Document value mapping.

       Save to: .aiwg/requirements/value-proposition-validation.md
       """
   )
   ```

2. **Conduct Stakeholder Interviews**:
   ```
   Task(
       subagent_type="business-process-analyst",
       description="Document stakeholder needs",
       prompt="""
       Read template: $AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/requirements/context-free-interview-template.md

       Create stakeholder interview summary:
       - Key stakeholder concerns
       - Success criteria from each perspective
       - Constraints and dependencies

       Save to: .aiwg/requirements/stakeholder-interviews.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Defining use cases and value proposition...
  ✓ 5 use case briefs created
  ✓ Value proposition validated
  ✓ Stakeholder interviews documented
✓ Business alignment complete
```

### Step 3: Risk Identification and Assessment

**Purpose**: Identify top risks with mitigation strategies

**Your Actions**:

1. **Launch Risk Assessment Agents** (parallel):
   ```
   # Project Manager leads risk identification
   Task(
       subagent_type="project-manager",
       description="Create initial risk list",
       prompt="""
       Read vision and use cases.
       Read template: $AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/management/risk-list-template.md

       Identify 5-10 risks:
       - Technical risks
       - Business risks
       - Resource risks
       - Schedule risks

       For each risk document:
       - Likelihood (High/Medium/Low)
       - Impact (Show Stopper/High/Medium/Low)
       - Mitigation strategy

       Focus on top 3 with detailed mitigation.

       Save draft to: .aiwg/working/risks/risk-list/drafts/v0.1-primary-draft.md
       """
   )

   # Architecture Designer identifies technical risks
   Task(
       subagent_type="architecture-designer",
       description="Identify architectural risks",
       prompt="""
       Read vision and use cases.

       Identify technical/architectural risks:
       - Scalability concerns
       - Integration challenges
       - Technology uncertainties
       - Performance risks

       Create risk cards using template: $AIWG_ROOT/.../risk-card.md

       Save to: .aiwg/working/risks/risk-list/drafts/technical-risks.md
       """
   )

   # Security Architect identifies security risks
   Task(
       subagent_type="security-architect",
       description="Identify security risks",
       prompt="""
       Read vision and data classification needs.

       Identify security risks:
       - Data breach potential
       - Compliance violations
       - Authentication/authorization weaknesses
       - Third-party vulnerabilities

       Save to: .aiwg/working/risks/risk-list/drafts/security-risks.md
       """
   )
   ```

2. **Synthesize Risk List**:
   ```
   Task(
       subagent_type="documentation-synthesizer",
       description="Create consolidated risk list",
       prompt="""
       Read all risk inputs:
       - Primary draft
       - Technical risks
       - Security risks

       Consolidate into single risk list:
       - Remove duplicates
       - Prioritize by severity
       - Ensure top 3 have mitigation plans
       - No Show Stopper without mitigation

       Output: .aiwg/risks/risk-list.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Identifying and assessing risks...
  ✓ Business risks identified (3)
  ✓ Technical risks identified (4)
  ✓ Security risks identified (3)
✓ Risk list baselined: 10 risks, top 3 with mitigation plans
```

### Step 4: Security and Privacy Assessment

**Purpose**: Classify data and assess privacy/compliance requirements

**Your Actions**:

1. **Launch Security Assessment Agents**:
   ```
   Task(
       subagent_type="security-architect",
       description="Create data classification",
       prompt="""
       Read vision and use cases.
       Read template: $AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/security/data-classification-template.md

       Classify all data types:
       - Public
       - Internal
       - Confidential
       - Restricted

       Document:
       - Data types and sensitivity
       - Security requirements per class
       - Encryption needs
       - Access control requirements

       Save to: .aiwg/security/data-classification.md
       """
   )

   Task(
       subagent_type="privacy-officer",
       description="Conduct privacy impact assessment",
       prompt="""
       Read data classification.
       Read template: agentic/code/frameworks/sdlc-complete/add-ons/compliance/gdpr/templates/privacy-impact-assessment-template.md

       Assess privacy requirements:
       - PII handling
       - GDPR compliance (if applicable)
       - CCPA compliance (if applicable)
       - Data retention policies
       - User consent requirements

       Save to: .aiwg/security/privacy-impact-assessment.md
       """
   )
   ```

2. **Validate Compliance**:
   ```
   Task(
       subagent_type="legal-liaison",
       description="Document compliance requirements",
       prompt="""
       Read privacy assessment and data classification.

       Document all compliance obligations:
       - Regulatory requirements
       - Industry standards
       - Legal constraints
       - Audit requirements

       Flag any Show Stopper compliance issues.

       Save to: .aiwg/security/compliance-requirements.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Conducting security and privacy assessment...
  ✓ Data classification complete
  ✓ Privacy impact assessed
  ✓ Compliance requirements documented
✓ Security assessment complete: No Show Stopper concerns
```

### Step 5: Architecture Sketch

**Purpose**: Create initial architecture vision

**Your Actions**:

```
Task(
    subagent_type="architecture-designer",
    description="Create architecture sketch",
    prompt="""
    Read vision, use cases, and risk list.
    Read template: $AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/analysis-design/software-architecture-doc-template.md

    Create initial architecture sketch:
    - Component boundaries (high-level)
    - Integration points
    - Technology stack proposal
    - Deployment model (cloud/on-prem/hybrid)
    - Key architectural decisions

    This is a sketch, not detailed design.
    Focus on major components and boundaries.

    Save to: .aiwg/architecture/architecture-sketch.md
    """
)

# Quick review by Security Architect
Task(
    subagent_type="security-architect",
    description="Review architecture sketch for security",
    prompt="""
    Read architecture sketch.

    Validate:
    - Security boundaries identified
    - Authentication/authorization approach
    - Data flow security
    - No obvious security anti-patterns

    Status: APPROVED | CONDITIONAL | NEEDS_WORK

    Save review to: .aiwg/working/architecture/security-review.md
    """
)
```

**Communicate Progress**:
```
⏳ Creating architecture sketch...
✓ Architecture sketch complete
✓ Security review: APPROVED
```

### Step 6: Architecture Decision Records

**Purpose**: Document critical early decisions

**Your Actions**:

```
# Create 3+ ADRs for critical decisions
Task(
    subagent_type="architecture-designer",
    description="Create critical ADRs",
    prompt="""
    Read architecture sketch and technology choices.
    Read template: agentic/code/frameworks/sdlc-complete/templates/governance/adr-template.md

    Create at least 3 ADRs for Inception:

    ADR-001: Database selection
    - Context: Data requirements
    - Decision: PostgreSQL/MongoDB/etc
    - Consequences: Trade-offs
    - Alternatives: What was considered

    ADR-002: API architecture
    - REST vs GraphQL vs gRPC

    ADR-003: Authentication mechanism
    - OAuth vs JWT vs session-based

    Save to: .aiwg/architecture/adr/ADR-*.md
    """
)
```

**Communicate Progress**:
```
⏳ Documenting architecture decisions...
✓ ADRs created: 3 critical decisions documented
```

### Step 7: Business Case and Funding

**Purpose**: Secure funding approval for project continuation

**Your Actions**:

1. **Create Business Case**:
   ```
   Task(
       subagent_type="product-strategist",
       description="Develop business case",
       prompt="""
       Read vision, use cases, and risk list.
       Read template: $AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/management/business-case-informal-template.md

       Create business case including:
       - Problem statement and business need
       - ROM cost estimate (±50% accuracy)
       - Expected benefits and ROI
       - Funding request for Elaboration
       - Success metrics

       Be realistic about costs and benefits.

       Save to: .aiwg/management/business-case.md
       """
   )

   Task(
       subagent_type="project-manager",
       description="Create option matrix",
       prompt="""
       Read template: $AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/intake/option-matrix-template.md

       Analyze at least 3 alternatives:
       - Build custom
       - Buy COTS
       - Hybrid approach
       - Do nothing

       Compare on: cost, time, risk, benefits

       Save to: .aiwg/planning/option-matrix.md
       """
   )
   ```

2. **Define Scope Boundaries**:
   ```
   Task(
       subagent_type="requirements-analyst",
       description="Document scope boundaries",
       prompt="""
       Read vision and use cases.

       Explicitly document:
       - In-scope features
       - Out-of-scope features
       - Future considerations
       - Dependencies

       Be very explicit about what's NOT included.

       Save to: .aiwg/planning/scope-boundaries.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Developing business case...
  ✓ ROM estimate: $XXX,XXX (±50%)
  ✓ Option matrix: 3 alternatives analyzed
  ✓ Scope boundaries defined
✓ Business case complete: .aiwg/management/business-case.md
```

### Step 8: Lifecycle Objective Milestone (LOM) Validation

**Purpose**: Validate all Inception exit criteria before proceeding

**Your Actions**:

1. **Validate LOM Criteria**:
   ```
   Task(
       subagent_type="project-manager",
       description="Validate LOM gate criteria",
       prompt="""
       Read gate criteria: $AIWG_ROOT/agentic/code/frameworks/sdlc-complete/flows/gate-criteria-by-phase.md

       Validate Inception exit criteria:

       Required Artifacts:
       - [ ] Vision document APPROVED
       - [ ] Business case APPROVED with funding
       - [ ] Risk list BASELINED (top 3 mitigated)
       - [ ] Data classification COMPLETE
       - [ ] Architecture sketch documented
       - [ ] 3+ ADRs created
       - [ ] Use case briefs (3-5)
       - [ ] Option matrix analyzed

       Quality Gates:
       - [ ] Stakeholder approval ≥75%
       - [ ] Executive Sponsor signoff
       - [ ] No Show Stopper risks without mitigation
       - [ ] Funding secured for Elaboration

       Generate LOM Report with:
       - Status: PASS | FAIL
       - Go/No-Go recommendation
       - Gaps (if any)

       Save to: .aiwg/reports/lom-report.md
       """
   )
   ```

2. **Decision Point**:
   - If LOM PASS → Report success
   - If LOM FAIL → Report gaps, recommend remediation
   - Escalate to user for executive decision

**Communicate Progress**:
```
⏳ Validating Lifecycle Objective Milestone...
✓ LOM Validation complete: PASS
✓ Recommendation: GO to Elaboration
```

### Step 9: Generate Phase Completion Report

**Your Actions**:

```
Task(
    subagent_type="project-manager",
    description="Generate Inception completion report",
    prompt="""
    Read all Inception artifacts and LOM report.

    Generate comprehensive phase report:

    # Concept → Inception Phase Report

    ## Milestone Achievement
    - Artifacts Status (list all with status)
    - Gate Criteria (pass/fail each)

    ## Risk Summary
    - Critical risks identified
    - Mitigation status

    ## Financial Summary
    - ROM estimate
    - Funding status

    ## Go/No-Go Decision
    - Recommendation: GO | NO-GO | CONDITIONAL
    - Rationale
    - Next steps

    ## Handoff to Elaboration
    - Assigned agents
    - Scheduled date
    - Baseline tag

    Save to: .aiwg/reports/inception-completion-report.md
    """
)
```

**Present Summary to User**:
```
─────────────────────────────────────────────
Concept → Inception Phase Complete
─────────────────────────────────────────────

**Overall Status**: COMPLETE
**Decision**: GO to Elaboration

**Artifacts Generated**:
✓ Vision Document (.aiwg/requirements/vision-document.md)
✓ Business Case (.aiwg/management/business-case.md)
✓ Risk List (.aiwg/risks/risk-list.md)
✓ Use Case Briefs (.aiwg/requirements/use-case-briefs/, 5 files)
✓ Data Classification (.aiwg/security/data-classification.md)
✓ Architecture Sketch (.aiwg/architecture/architecture-sketch.md)
✓ ADRs (.aiwg/architecture/adr/, 3 files)
✓ Option Matrix (.aiwg/planning/option-matrix.md)

**Key Decisions**:
- Database: PostgreSQL selected
- API: REST with versioning
- Authentication: OAuth 2.0

**Risk Status**:
- 10 risks identified
- Top 3 with mitigation plans
- No Show Stoppers

**Financial**:
- ROM Estimate: $450,000 (±50%)
- Elaboration Funding: APPROVED

**Next Steps**:
1. Review all generated artifacts
2. Schedule stakeholder review (within 3 days)
3. Begin Elaboration: /flow-inception-to-elaboration

─────────────────────────────────────────────
```

## Quality Gates

Before marking workflow complete, verify:
- [ ] All required artifacts generated
- [ ] All reviewers provided sign-off
- [ ] Final artifacts saved to .aiwg/{category}/
- [ ] Working drafts archived
- [ ] LOM criteria validated: PASS

## User Communication

**At start**: Confirm understanding and list artifacts to generate

```
Understood. I'll orchestrate the Concept → Inception transition.

This will generate:
- Vision Document
- Business Case with ROM estimate
- Risk List (5-10 risks)
- Use Case Briefs (3-5)
- Data Classification
- Architecture Sketch
- ADRs (3+ decisions)
- Option Matrix

I'll coordinate multiple agents for comprehensive coverage.
Expected duration: 10-15 minutes.

Starting orchestration...
```

**During**: Update progress with clear indicators

```
✓ = Complete
⏳ = In progress
❌ = Error/blocked
⚠️ = Warning/attention needed
```

**At end**: Summary report with artifact locations and status

## Error Handling

**If No Intake Form**:
```
❌ No intake form found

Recommendation: Start with intake wizard
Run: /intake-wizard "your project description"

Or create manually at: .aiwg/intake/project-intake.md
```

**If Stakeholder Alignment Failed**:
```
⚠️ Stakeholder approval only 60% (target: ≥75%)

Actions:
1. Review vision document for clarity
2. Schedule stakeholder workshop
3. Address specific concerns

Cannot proceed to Elaboration without alignment.
```

**If No Funding**:
```
❌ Business case approved but no funding allocated

Cannot proceed without funding.

Options:
1. Strengthen ROI analysis
2. Reduce scope for phased funding
3. Escalate to Executive Sponsor
```

## Success Criteria

This orchestration succeeds when:
- [ ] Vision document APPROVED by stakeholders (≥75%)
- [ ] Business case APPROVED with funding secured
- [ ] Risk list BASELINED with top 3 mitigated
- [ ] Use case briefs documented (3-5)
- [ ] Data classification and privacy assessed
- [ ] Architecture sketch reviewed
- [ ] ADRs documented (3+)
- [ ] LOM validation PASSED
- [ ] Go decision recorded

## Metrics to Track

**During orchestration, track**:
- Stakeholder alignment percentage
- Risk identification count
- Funding approval status
- Gate criteria pass rate
- Cycle time: Concept to Inception (target: 2-4 weeks, orchestration: 10-15 min)

## References

**Templates** (via $AIWG_ROOT):
- Vision: `templates/requirements/vision-informal-template.md`
- Business Case: `templates/management/business-case-informal-template.md`
- Risk List: `templates/management/risk-list-template.md`
- Use Case Brief: `templates/requirements/use-case-brief-template.md`
- Data Classification: `templates/security/data-classification-template.md`
- ADR: `agentic/code/frameworks/sdlc-complete/templates/governance/adr-template.md`
- Option Matrix: `templates/intake/option-matrix-template.md`

**Gate Criteria**:
- `flows/gate-criteria-by-phase.md` (Lifecycle Objective Milestone)

**Multi-Agent Pattern**:
- `docs/multi-agent-documentation-pattern.md`

**Orchestrator Architecture**:
- `docs/orchestrator-architecture.md`

**Natural Language Translations**:
- `docs/simple-language-translations.md`