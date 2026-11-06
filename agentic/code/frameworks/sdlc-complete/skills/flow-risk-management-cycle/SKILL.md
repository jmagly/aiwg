---
namespace: aiwg
name: flow-risk-management-cycle
platforms: [all]
description: Orchestrate continuous risk identification, assessment, tracking, and retirement across SDLC phases
commandHint:
  argumentHint: '[project-directory] [--iteration N] [--guidance "text"] [--interactive]'
  allowedTools: 'Task, Read, Write, Glob, TodoWrite'
  model: sonnet
  category: sdlc-orchestration
  orchestration: true
  modelRole: coding
  modelTier: standard
---

> **Declarative Flow (#1539):** This flow's orchestration is now also expressed as a
> declarative YAML Flow at `flows/flow-risk-management-cycle.playbook.yaml` (source of truth for the step
> sequence + gates). This SKILL.md remains the discoverable trigger surface and prose
> reference. See epic #1534.

# Risk Management Cycle Orchestration Flow

**You are the Core Orchestrator** for continuous risk management throughout the SDLC.

## Your Role

**You orchestrate multi-agent workflows. You do NOT execute bash scripts.**

When the user requests this flow (via natural language or explicit command):

1. **Interpret the request** and confirm understanding
2. **Read this template** as your orchestration guide
3. **Extract agent assignments** and workflow steps
4. **Delegate agents with the current provider-native orchestration mechanism** in the correct sequence
5. **Synthesize results** and finalize artifacts
6. **Report completion** with summary

## Risk Management Overview

**Purpose**: Maintain continuous visibility into project risks, proactively retire technical and business risks before they become blockers, and ensure the team operates with acceptable risk tolerance throughout all SDLC phases.

**Key Activities**:
- Risk identification (business, technical, security)
- Risk assessment (probability × impact scoring)
- Risk mitigation planning (spikes, POCs)
- Risk tracking and monitoring
- Risk retirement validation

**Expected Duration**: 90-minute workshop + 2-5 days for spikes, 10-15 minutes orchestration

## Natural Language Triggers

Users may say:
- "Update risks"
- "Review risks"
- "Manage risks"
- "Risk assessment"
- "Identify new risks"
- "Conduct risk workshop"
- "Retire risks"

You recognize these as requests for this orchestration flow.

## Parameter Handling

### --guidance Parameter

**Purpose**: User provides upfront direction to tailor risk management priorities

**Examples**:
```
--guidance "Focus on security risks, compliance audit in 3 months"
--guidance "Performance risks are critical, need sub-100ms p95 validation"
--guidance "Tight timeline, prioritize Show Stopper risks only"
--guidance "Team lacks DevOps experience, infrastructure risks need extra attention"
```

**How to Apply**:
- Parse guidance for keywords: security, performance, compliance, timeline, team skills
- Adjust agent assignments (add security-architect, privacy-officer for compliance focus)
- Modify risk assessment depth (comprehensive vs. focused on specific categories)
- Influence spike/POC scope (minimal vs. comprehensive validation)

### --interactive Parameter

**Purpose**: You ask 6 strategic questions to understand risk context

**Questions to Ask** (if --interactive):

```
I'll ask 6 strategic questions to tailor risk management to your project's needs:

Q1: What are your top priorities for this risk cycle?
    (e.g., security validation, performance proof, compliance readiness)

Q2: What are your biggest constraints?
    (e.g., tight timeline, limited budget, small team)

Q3: What risks concern you most for this workflow?
    (e.g., technical unknowns, third-party dependencies, regulatory changes)

Q4: What's your team's experience level with this type of activity?
    (Helps me gauge risk assessment calibration and spike scope)

Q5: What's your target timeline?
    (Influences spike duration and mitigation planning depth)

Q6: Are there compliance or regulatory requirements?
    (e.g., HIPAA, SOC2, PCI-DSS - affects security/privacy risk focus)

Based on your answers, I'll adjust:
- Agent assignments (add specialized risk assessors)
- Risk category focus (security-first vs. performance-first)
- Spike/POC scope (minimal vs. comprehensive)
- Workshop agenda emphasis (technical vs. business vs. operational)
```

**Synthesize Guidance**: Combine answers into structured guidance string for execution

### --iteration Parameter

**Purpose**: Track risk cycles per iteration (bi-weekly or per sprint)

**Usage**: `--iteration 3` (Elaboration Iteration 3) or `--iteration Construction-5` (Construction Iteration 5)

## Risk Management Philosophy

**Proactive Risk Management**:
- Risks are identified early, tracked continuously, and retired systematically
- High-risk assumptions are validated via spikes/POCs before committing resources
- Show Stopper risks are escalated immediately and require executive decision
- Risk retirement is a primary objective of Elaboration phase (70%+ retired by ABM)

**Risk Categorization**:
- **Show Stopper (P0)**: Project cannot proceed without resolution (score 21-25)
- **High (P1)**: Major impact to schedule, scope, or quality (score 16-20)
- **Medium (P2)**: Moderate impact, workarounds available (score 11-15)
- **Low (P3)**: Minor impact, can be deferred (score 1-10)

## Artifacts to Generate

**Primary Deliverables**:
- **Risk Identification Workshop Notes**: New risks and status updates → `.aiwg/risks/risk-workshop-{date}.md`
- **Risk Assessment Report**: Prioritized risk list with scoring → `.aiwg/risks/risk-assessment-{date}.md`
- **Updated Risk List**: Current status of all risks → `.aiwg/risks/risk-list.md`
- **Spike Results**: POC findings for high-priority risks → `.aiwg/risks/spike-{risk-id}-results.md`
- **Risk Retirement Report**: Validation evidence and metrics → `.aiwg/risks/risk-retirement-report.md`
- **Risk Escalation Briefs**: Show Stopper risk decisions → `.aiwg/risks/risk-escalation-{risk-id}.md`
- **Risk Status Report**: Stakeholder summary → `.aiwg/risks/risk-status-report-{date}.md`

**Supporting Artifacts**:
- Risk validation documents (analysis-based retirements)
- POC code and benchmarks (working directory)
- Complete audit trails (archived workflows)

## Multi-Agent Orchestration Workflow

### Step 1: Conduct Risk Identification Workshop

**Purpose**: Facilitate regular risk identification session with project team

**Your Actions**:

1. **Check Workshop Frequency**:
   ```
   Read current project phase from .aiwg/intake/project-intake.md or .aiwg/planning/phase-plan-*.md

   Workshop frequency by phase:
   - Inception: Weekly (rapid discovery of unknowns)
   - Elaboration: Bi-weekly (validate architectural risks)
   - Construction: Bi-weekly per iteration (identify delivery risks)
   - Transition: Weekly (production readiness risks)
   ```

2. **Load Current Context**:
   ```
   Read:
   - .aiwg/risks/risk-list.md (current risk status)
   - .aiwg/intake/project-intake.md (project scope and constraints)
   - Recent changes (if accessible via git log or documentation)
   ```

3. **Launch Workshop Facilitation Agents** (parallel):
   ```
   # Agent 1: Project Manager (Workshop Facilitator)
   Task(
       subagent_type="project-manager",
       description="Facilitate risk identification workshop",
       prompt="""
       Read current risk list: .aiwg/risks/risk-list.md

       Facilitate 90-minute risk identification workshop:

       Agenda:
       1. Review Previous Risks (15 min)
          - Status update on existing risks
          - Validate risk retirements
          - Re-assess probabilities and impacts

       2. Identify New Risks (30 min)
          - Technical risks (architecture, performance, scalability)
          - Business risks (requirements changes, resource availability)
          - Security risks (vulnerabilities, compliance)
          - Operational risks (deployment, monitoring, support)
          - External risks (third-party dependencies, vendor delays)

       3. Prioritize Risks (20 min)
          - Score probability (1-5): 1=Rare, 5=Almost Certain
          - Score impact (1-5): 1=Negligible, 5=Catastrophic
          - Calculate risk score: Probability × Impact (1-25)
          - Categorize: Show Stopper (21-25), High (16-20), Medium (11-15), Low (1-10)

       4. Plan Mitigation Actions (20 min)
          - Show Stopper: Immediate action plan, executive escalation
          - High: Spike/POC to validate assumptions (1-3 days)
          - Medium: Monitoring plan, deferred action
          - Low: Accept and monitor

       5. Assign Ownership (5 min)
          - Each risk assigned to specific owner
          - Due dates for spikes and mitigation actions
          - Re-assessment date scheduled

       Risk Identification Prompts:
       - "What technical unknowns remain?"
       - "What assumptions are we making that could be wrong?"
       - "What external dependencies could fail?"
       - "What could prevent us from meeting our schedule?"
       - "What security vulnerabilities are most likely?"
       - "What operational challenges do we anticipate?"

       Document workshop results:
       - New risks identified (with ID, description, category)
       - Risk status updates (status changes with rationale)
       - Action items (owner, due date)

       Save to: .aiwg/risks/risk-workshop-{date}.md
       """
   )

   # Agent 2: Architecture Designer (Technical Risks)
   Task(
       subagent_type="architecture-designer",
       description="Identify architectural and technical risks",
       prompt="""
       Read project architecture: .aiwg/architecture/software-architecture-doc.md (if exists)
       Read project intake: .aiwg/intake/project-intake.md

       Identify technical and architectural risks:

       Technical Risk Categories:
       - Architecture choices unproven (new framework, database)
       - Performance requirements unclear (scalability unknowns)
       - Integration complexity underestimated (third-party APIs)
       - Technology learning curve steep (team skill gaps)
       - Data migration complexity (schema evolution, volume)

       For each risk:
       - Risk description (clear, specific)
       - Why it's a risk (impact if materializes)
       - Initial probability estimate (1-5)
       - Initial impact estimate (1-5)
       - Suggested mitigation (spike, POC, architecture change)

       Save technical risks to: .aiwg/working/risks/technical-risks-draft.md
       """
   )

   # Agent 3: Security Architect (Security Risks)
   Task(
       subagent_type="security-architect",
       description="Identify security and compliance risks",
       prompt="""
       Read project intake: .aiwg/intake/project-intake.md
       Read data classification: .aiwg/security/data-classification.md (if exists)

       Identify security and compliance risks:

       Security Risk Categories:
       - Compliance requirements unclear (GDPR, HIPAA, SOC2)
       - Vulnerability exposure (third-party dependencies, CVEs)
       - Authentication/authorization complex (multi-tenant, SSO)
       - Data breach potential (PII, financial data, encryption gaps)
       - Audit logging insufficient (compliance requirements)

       For each risk:
       - Risk description
       - Compliance impact (regulatory penalties, audit failures)
       - Initial probability estimate (1-5)
       - Initial impact estimate (1-5)
       - Suggested mitigation (security review, penetration test, compliance audit)

       Save security risks to: .aiwg/working/risks/security-risks-draft.md
       """
   )

   # Agent 4: Business Analyst (Business Risks)
   Task(
       subagent_type="business-analyst",
       description="Identify business and organizational risks",
       prompt="""
       Read project intake: .aiwg/intake/project-intake.md
       Read business case: .aiwg/planning/business-case-*.md (if exists)

       Identify business and organizational risks:

       Business Risk Categories:
       - Requirements changing frequently (scope creep)
       - Stakeholder availability limited (approval delays)
       - Funding uncertain (budget cuts possible)
       - Competitive pressure (market timing critical)
       - Team attrition (key personnel leaving)

       For each risk:
       - Risk description
       - Business impact (revenue, market share, reputation)
       - Initial probability estimate (1-5)
       - Initial impact estimate (1-5)
       - Suggested mitigation (stakeholder alignment, scope freeze, contingency plans)

       Save business risks to: .aiwg/working/risks/business-risks-draft.md
       """
   )
   ```

4. **Synthesize Workshop Results**:
   ```
   Task(
       subagent_type="risk-manager",
       description="Synthesize risk identification workshop results",
       prompt="""
       Read all risk identification inputs:
       - .aiwg/risks/risk-workshop-{date}.md (workshop notes)
       - .aiwg/working/risks/technical-risks-draft.md
       - .aiwg/working/risks/security-risks-draft.md
       - .aiwg/working/risks/business-risks-draft.md

       Synthesize comprehensive risk identification report:

       Structure:
       1. Workshop Summary
          - Date, attendees, iteration number
          - New risks identified (count by category)
          - Risk status updates (count by status change)

       2. New Risks Identified
          - For each risk: ID, description, category, probability, impact, score, priority, owner, mitigation

       3. Risk Status Updates
          - For each updated risk: ID, previous status, current status, rationale

       4. Action Items
          - Prioritized list with owner and due date

       Use template: $AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/management/risk-list-template.md

       Save to: .aiwg/risks/risk-workshop-{date}.md (final)
       """
   )
   ```

**Communicate Progress**:
```
✓ Initialized risk identification workshop
⏳ Facilitating risk workshop (90 minutes)...
  ✓ Project Manager: Workshop facilitation complete
  ✓ Architecture Designer: {count} technical risks identified
  ✓ Security Architect: {count} security risks identified
  ✓ Business Analyst: {count} business risks identified
✓ Risk Identification Workshop complete: .aiwg/risks/risk-workshop-{date}.md
  - New risks: {count}
  - Updated risks: {count}
  - Action items: {count}
```

### Step 2: Assess and Score Risks

**Purpose**: Apply consistent risk assessment methodology to prioritize risks

**Your Actions**:

1. **Launch Risk Assessment Agent**:
   ```
   Task(
       subagent_type="risk-manager",
       description="Assess and score identified risks",
       prompt="""
       Read workshop results: .aiwg/risks/risk-workshop-{date}.md
       Read current risk list: .aiwg/risks/risk-list.md

       Apply risk assessment matrix:

       Probability Scoring:
       | Probability | Definition | Score |
       |-------------|------------|-------|
       | Rare | <10% chance | 1 |
       | Unlikely | 10-30% chance | 2 |
       | Possible | 30-50% chance | 3 |
       | Likely | 50-70% chance | 4 |
       | Almost Certain | >70% chance | 5 |

       Impact Scoring:
       | Impact | Definition | Score |
       |--------|------------|-------|
       | Negligible | <1 day delay, no scope impact | 1 |
       | Minor | 1-3 days delay, minor scope reduction | 2 |
       | Moderate | 1-2 weeks delay, moderate scope impact | 3 |
       | Major | >2 weeks delay, major scope reduction | 4 |
       | Catastrophic | Project failure or cancellation | 5 |

       Risk Score Calculation:
       - Score = Probability × Impact (range: 1-25)
       - Show Stopper (P0): Score 21-25 (immediate action required)
       - High (P1): Score 16-20 (spike/POC within 1 week)
       - Medium (P2): Score 11-15 (monitor, plan mitigation)
       - Low (P3): Score 1-10 (accept, periodic review)

       For each risk:
       - Validate probability and impact scores (calibrate with team consensus)
       - Calculate risk score
       - Assign priority category
       - Document assessment rationale

       Generate Risk Assessment Report:
       1. Risk Summary by Priority (count of P0, P1, P2, P3)
       2. Top 5 Risks (by score)
       3. Risk Trends (new vs. retired, score trend)
       4. Escalations Required (Show Stopper risks)

       Save to: .aiwg/risks/risk-assessment-{date}.md
       """
   )
   ```

**Communicate Progress**:
```
✓ Workshop synthesis complete
⏳ Assessing and scoring risks...
✓ Risk Assessment complete: .aiwg/risks/risk-assessment-{date}.md
  - Show Stopper (P0): {count}
  - High (P1): {count}
  - Medium (P2): {count}
  - Low (P3): {count}
  - Top risk: {risk-id} (score: {score})
```

### Step 3: Update Risk List and Tracking

**Purpose**: Maintain comprehensive risk list with current status

**Your Actions**:

1. **Launch Risk List Update Agent**:
   ```
   Task(
       subagent_type="risk-manager",
       description="Update master risk list with assessment results",
       prompt="""
       Read current risk list: .aiwg/risks/risk-list.md
       Read risk assessment: .aiwg/risks/risk-assessment-{date}.md
       Read workshop results: .aiwg/risks/risk-workshop-{date}.md

       Update comprehensive risk list:

       Structure (use template):
       - Project metadata (name, last updated, risk owner)
       - Active Risks (by priority: P0 → P1 → P2 → P3)
       - Retired Risks (archive section)
       - Risk Metrics (retirement rate, average score, time to retirement)

       For each risk:
       - Risk ID (unique identifier)
       - Risk Title (concise)
       - Description (detailed)
       - Category (Technical | Business | Security | Operational | External)
       - Assessment (probability, impact, score, priority)
       - Status (IDENTIFIED | MITIGATED | RETIRED | ACCEPTED)
       - Owner (name or role)
       - Mitigation Plan (specific actions)
       - Contingency Plan (actions if risk materializes)
       - Target Date (for risk retirement)
       - Last Updated (timestamp)
       - Notes (status updates, spike results, decisions)

       Add traceability links:
       - Risk-ID → Spike-ID (if spike conducted)
       - Risk-ID → ADR-ID (if architectural decision)
       - Risk-ID → UC-ID (if requirement-related)

       Track risk aging:
       - Time since identification
       - Escalate stale risks (no progress in >2 weeks)

       Template: $AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/management/risk-list-template.md

       Save updated risk list to: .aiwg/risks/risk-list.md
       """
   )
   ```

**Communicate Progress**:
```
✓ Risk assessment complete
⏳ Updating master risk list...
✓ Risk List updated: .aiwg/risks/risk-list.md
  - Total active risks: {count}
  - Risks added this cycle: {count}
  - Risks retired this cycle: {count}
  - Risk retirement rate: {percentage}%
```

### Step 4: Execute Spikes and POCs for High-Priority Risks

**Purpose**: Conduct time-boxed experiments to validate high-risk assumptions

**Your Actions**:

1. **Identify High-Priority Risks Requiring Validation**:
   ```
   Read .aiwg/risks/risk-list.md
   Filter for:
   - Priority: P0 (Show Stopper) or P1 (High)
   - Status: IDENTIFIED (not yet mitigated or retired)
   - Mitigation: Spike or POC recommended
   ```

2. **For Each High-Risk, Launch Spike/POC Agent**:
   ```
   # Determine spike approach based on risk category

   # Option A: Technical/Performance Spike (architecture-designer + software-implementer)
   Task(
       subagent_type="architecture-designer",
       description="Conduct technical spike for Risk #{risk-id}",
       prompt="""
       Risk to validate: {risk-description}
       Risk ID: {risk-id}
       Timebox: 1-3 days (strict)

       Spike Planning:
       - Define hypothesis (what assumption are we testing?)
       - Define success criteria (what validates the hypothesis?)
       - Define approach (how will we test it?)

       Spike Execution:
       - Build minimal prototype (not production code)
       - Test hypothesis with real data/tools
       - Document findings (code, screenshots, metrics)
       - Formulate recommendation

       Spike Review:
       - Present findings
       - Go/No-Go decision on risk
       - Update risk status (RETIRED | MITIGATED | ESCALATE)
       - Create ADR if architecture change needed

       Spike Card Template: experiment fields in this skill

       Document:
       - Hypothesis and success criteria
       - Approach and findings
       - Result (SUCCESS | FAILURE | PARTIAL)
       - Recommendation (risk status, follow-up actions)
       - Traceability (Risk-ID, ADR-ID if applicable)

       Save spike results to: .aiwg/risks/spike-{risk-id}-results.md
       """
   )

   # Option B: Security Spike (security-architect)
   Task(
       subagent_type="security-architect",
       description="Conduct security validation for Risk #{risk-id}",
       prompt="""
       Risk to validate: {risk-description}
       Risk ID: {risk-id}

       Security Validation Approach:
       - Threat modeling (STRIDE analysis)
       - Vulnerability assessment (dependency scan, OWASP Top 10)
       - Compliance validation (GDPR, HIPAA, SOC2 requirements)
       - Penetration testing (if feasible in timebox)

       Document findings:
       - Vulnerabilities identified (severity, CVSS score)
       - Compliance gaps (regulation, requirement, current state)
       - Mitigation recommendations (controls, architecture changes)
       - Residual risk (after mitigation)

       Decision:
       - Risk status: RETIRED | MITIGATED | ACCEPTED | ESCALATE
       - Evidence: scan results, test reports, compliance checklist

       Save to: .aiwg/risks/spike-{risk-id}-results.md
       """
   )

   # Option C: POC for Feasibility (software-implementer)
   Task(
       subagent_type="software-implementer",
       description="Build POC for Risk #{risk-id}",
       prompt="""
       Risk to validate: {risk-description}
       Risk ID: {risk-id}
       Timebox: 1-3 days

       Use /build-poc command:
       /build-poc "{risk-description}" --scope {minimal|standard|comprehensive}

       POC Objectives:
       - Demonstrate technical feasibility
       - Validate performance requirements (if applicable)
       - Test integration with third-party systems (if applicable)
       - Prove architecture pattern works (if applicable)

       Acceptance criteria: {what proves risk is retired}

       Document POC results:
       - Approach (what was built, how was it tested)
       - Results (metrics, observations, screenshots)
       - Decision: GO (risk retired) | NO-GO (risk remains) | PIVOT (change approach)
       - Code artifacts (link to POC code, if saved)

       Save to: .aiwg/risks/poc-{risk-id}-results.md
       """
   )
   ```

3. **Synthesize Spike Execution Summary**:
   ```
   Task(
       subagent_type="risk-manager",
       description="Synthesize spike/POC results",
       prompt="""
       Read all spike/POC results:
       - .aiwg/risks/spike-*-results.md
       - .aiwg/risks/poc-*-results.md

       Generate Spike Execution Summary:

       1. Spikes Completed
          - For each: Spike-ID, Risk-ID, owner, duration, result, risk status, ADR created

       2. Risk Retirement Impact
          - Risks retired via spikes (list)
          - Risks requiring further action (list)

       3. Lessons Learned
          - What worked well (positive outcomes)
          - What could improve (process improvements)

       Calculate metrics:
       - Spikes completed: {count}
       - Risks retired: {count}
       - Average spike duration: {days}
       - Spike success rate: {percentage}%

       Save to: .aiwg/risks/spike-execution-summary-{date}.md
       """
   )
   ```

**Communicate Progress**:
```
✓ Risk list updated
⏳ Executing spikes/POCs for high-priority risks...
  ✓ Spike #{risk-id-1}: {title} - SUCCESS → RETIRED
  ✓ Spike #{risk-id-2}: {title} - PARTIAL → MITIGATED
  ✓ POC #{risk-id-3}: {title} - SUCCESS → RETIRED
  ⚠️ Spike #{risk-id-4}: {title} - FAILURE → ESCALATE
✓ Spike Execution complete: .aiwg/risks/spike-execution-summary-{date}.md
  - Spikes completed: {count}
  - Risks retired: {count}
  - Risks escalated: {count}
```

### Step 5: Validate Risk Retirement

**Purpose**: Ensure retired risks are genuinely resolved with evidence

**Your Actions**:

1. **Launch Risk Retirement Validation Agent**:
   ```
   Task(
       subagent_type="risk-manager",
       description="Validate risk retirements with evidence",
       prompt="""
       Read updated risk list: .aiwg/risks/risk-list.md
       Read spike results: .aiwg/risks/spike-*-results.md
       Read POC results: .aiwg/risks/poc-*-results.md

       Validate Risk Retirement Checklist:
       - [ ] Spike/POC completed with successful result
       - [ ] Evidence documented (code, tests, metrics)
       - [ ] ADR created if architectural change
       - [ ] Risk owner confirms retirement
       - [ ] No residual concerns from team

       Risk Retirement Evidence Types:

       1. Technical Validation
          - Spike code demonstrates feasibility
          - Performance tests meet requirements
          - Integration with third-party working
          - Prototype operational

       2. Architecture Validation
          - ADR documents decision
          - Peer review confirms approach
          - Security Architect approves security design
          - Test strategy covers risk area

       3. Business Validation
          - Stakeholder confirms requirement clarified
          - Product Owner accepts scope change
          - Funding secured for phase
          - Resource availability confirmed

       Premature Retirement Warning Signs:
       - No evidence artifact (spike card, ADR)
       - Spike marked SUCCESS but no prototype
       - Risk owner changed without transfer
       - Status changed without team review
       - Assumptions not validated

       Generate Risk Retirement Report:

       1. Newly Retired Risks
          - For each: Risk-ID, title, priority, retirement date, validation method, evidence, owner, confirmed by

       2. Risk Retirement Statistics
          - Phase progress (risks retired per phase)
          - Retirement rate by category

       3. ABM Risk Criteria (if Elaboration phase)
          - Show Stopper Risks: 100% retired/mitigated
          - High Risks: 100% retired/mitigated
          - All Risks: ≥70% retired/mitigated
          - Top 3 Inception Risks: 100% resolved
          - ABM Risk Gate Status: PASS | FAIL

       4. Active Risks Remaining
          - Show Stopper: {count}
          - High: {count}
          - Medium: {count}
          - Low: {count}

       Save to: .aiwg/risks/risk-retirement-report.md
       """
   )
   ```

**Communicate Progress**:
```
✓ Spike execution complete
⏳ Validating risk retirements...
✓ Risk Retirement Report: .aiwg/risks/risk-retirement-report.md
  - Risks retired this cycle: {count}
  - Total retirement rate: {percentage}%
  - ABM criteria: {PASS | FAIL | N/A}
  ⚠️ Premature retirements flagged: {count}
```

### Step 6: Escalate Show Stopper Risks

**Purpose**: For P0 risks that cannot be retired by the team, escalate to executive leadership

**Your Actions**:

1. **Identify Show Stopper Risks Requiring Escalation**:
   ```
   Read .aiwg/risks/risk-list.md
   Filter for:
   - Priority: Show Stopper (P0)
   - Status: IDENTIFIED or ESCALATE
   - Age: >1 iteration without resolution
   ```

2. **For Each Show Stopper Risk, Create Escalation Brief**:
   ```
   Task(
       subagent_type="project-manager",
       description="Create escalation brief for Risk #{risk-id}",
       prompt="""
       Risk to escalate: {risk-description}
       Risk ID: {risk-id}
       Priority: Show Stopper (P0)
       Risk Score: {score}

       Escalation Triggers:
       - Show Stopper risk identified (score ≥21)
       - High risk not mitigated within 1 iteration
       - Risk requires budget increase (>10% over baseline)
       - Risk requires scope reduction (major feature cut)
       - Risk requires timeline extension (>2 weeks)
       - Risk requires external vendor decision

       Prepare Escalation Brief:

       1. Risk Description (1-2 sentences, clear, non-technical for executive audience)

       2. Impact if Not Addressed
          - Schedule Impact: {delay in weeks}
          - Budget Impact: {cost increase}
          - Scope Impact: {features at risk}
          - Quality Impact: {technical debt, defects}

       3. Options for Resolution (3-5 options with pros/cons)
          - Option A: {approach, pros, cons, cost, timeline}
          - Option B: {approach, pros, cons, cost, timeline}
          - Option C: {approach, pros, cons, cost, timeline}

       4. Recommendation
          - Recommended Option: {option-number}
          - Rationale: {why this option is best}
          - Dependencies: {what must happen for this option to succeed}

       5. Decision Required By: {date}

       Template structure:
       - Executive summary (3-5 sentences)
       - Options table (comparison)
       - Recommendation (1 paragraph)
       - Decision section (to be filled by Executive Sponsor)

       Save to: .aiwg/risks/risk-escalation-{risk-id}.md
       """
   )
   ```

3. **Generate Escalation Log**:
   ```
   Task(
       subagent_type="project-manager",
       description="Maintain risk escalation log",
       prompt="""
       Read all escalation briefs: .aiwg/risks/risk-escalation-*.md

       Generate Risk Escalation Log:

       1. Active Escalations
          - For each: Risk-ID, title, escalation date, decision required by, status (PENDING | RESOLVED), decision maker

       2. Resolved Escalations
          - For each: Risk-ID, title, escalation date, resolution date, decision, outcome

       3. Escalation Metrics
          - Total escalations: {count}
          - Resolved escalations: {count}
          - Average resolution time: {days}
          - Escalations this phase: {count}

       Save to: .aiwg/risks/risk-escalation-log.md
       """
   )
   ```

**Communicate Progress**:
```
✓ Risk retirement validation complete
⏳ Escalating Show Stopper risks...
  ⚠️ Risk #{risk-id-1}: {title} - ESCALATED (decision required by {date})
  ⚠️ Risk #{risk-id-2}: {title} - ESCALATED (budget decision needed)
✓ Escalation Briefs created: .aiwg/risks/risk-escalation-*.md
  - Show Stopper risks escalated: {count}
  - Awaiting executive decision: {count}
```

### Step 7: Generate Risk Status Report for Stakeholders

**Purpose**: Create comprehensive risk report for stakeholders

**Your Actions**:

1. **Launch Risk Status Report Agent**:
   ```
   Task(
       subagent_type="project-manager",
       description="Generate stakeholder risk status report",
       prompt="""
       Read all risk artifacts:
       - .aiwg/risks/risk-list.md
       - .aiwg/risks/risk-assessment-{date}.md
       - .aiwg/risks/risk-retirement-report.md
       - .aiwg/risks/spike-execution-summary-{date}.md
       - .aiwg/risks/risk-escalation-log.md

       Generate Risk Status Report:

       Report Audience:
       - Executive Sponsor: High-level summary, escalations, decisions needed
       - Product Owner: Business risks, scope impact, priority changes
       - Project Manager: All risks, action items, owner assignments
       - Development Team: Technical risks, spikes, mitigation actions

       Structure:

       1. Executive Summary
          - Overall Risk Posture: LOW | MODERATE | HIGH | CRITICAL
          - Key Highlights (active risks, retired, new, escalations)
          - Top 3 Concerns (brief description of highest-priority risks)

       2. Risk Summary by Priority
          - Show Stopper (P0): {count} - list each with impact, mitigation, owner, status
          - High (P1): {count} - list each with impact, mitigation, owner, status
          - Medium (P2): {count} - summary only
          - Low (P3): {count} - summary only

       3. Risk Trends
          - Risk Velocity (new vs. retired, net change)
          - Risk Score Trend (average score, trend direction)
          - Risk Retirement Progress (percentage, target for phase)

       4. Action Items
          - Immediate Actions Required (next 1 week)
          - Spikes Planned (next 2 weeks)
          - Escalations Required (Show Stopper risks)

       5. Gate Readiness (if applicable)
          - Next Gate: {LOM | ABM | OCM | PRM}
          - Risk Criteria Status (checklist)
          - Gate Risk Status: ON TRACK | AT RISK | BLOCKED

       6. Appendix: Detailed Risk List (all details)

       Save to: .aiwg/risks/risk-status-report-{date}.md
       """
   )
   ```

**Communicate Progress**:
```
✓ Escalations processed
⏳ Generating risk status report...
✓ Risk Status Report complete: .aiwg/risks/risk-status-report-{date}.md
  - Overall risk posture: {LOW | MODERATE | HIGH | CRITICAL}
  - Top concern: {risk-id} ({priority})
  - Action items: {count}
```

## Quality Gates

Before marking workflow complete, verify:
- [ ] Risk identification workshop conducted with team participation
- [ ] All risks assessed with probability × impact scoring
- [ ] Risk list updated with current status and traceability
- [ ] Spikes/POCs executed for high-priority risks (1-3 days timebox each)
- [ ] Risk retirements validated with evidence artifacts
- [ ] Show Stopper risks escalated with decision briefs
- [ ] Risk status report generated for stakeholders
- [ ] Working drafts archived (workshop notes, spike results)

## User Communication

**At start**: Confirm understanding and list activities

```
Understood. I'll orchestrate the Risk Management Cycle.

This will conduct:
- Risk Identification Workshop (90 minutes)
- Risk Assessment and Scoring
- Risk List Update
- Spike/POC Execution for high-priority risks
- Risk Retirement Validation
- Show Stopper Risk Escalation
- Stakeholder Risk Status Report

I'll coordinate multiple agents for comprehensive risk coverage.
Expected duration: 10-15 minutes orchestration + 2-5 days for spikes.

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

```
─────────────────────────────────────────────
Risk Management Cycle Complete
─────────────────────────────────────────────

**Overall Risk Posture**: {LOW | MODERATE | HIGH | CRITICAL}

**Risk Summary**:
- Active Risks: {count} (P0: {count}, P1: {count}, P2: {count}, P3: {count})
- New Risks This Cycle: {count}
- Retired Risks This Cycle: {count}
- Escalations Required: {count}

**Top 3 Risks**:
1. {Risk-ID}: {description} - {priority} (score: {score})
2. {Risk-ID}: {description} - {priority} (score: {score})
3. {Risk-ID}: {description} - {priority} (score: {score})

**Artifacts Generated**:
- Risk Workshop Notes: .aiwg/risks/risk-workshop-{date}.md
- Risk Assessment Report: .aiwg/risks/risk-assessment-{date}.md
- Updated Risk List: .aiwg/risks/risk-list.md
- Spike Results: .aiwg/risks/spike-*-results.md ({count} spikes)
- Risk Retirement Report: .aiwg/risks/risk-retirement-report.md
- Escalation Briefs: .aiwg/risks/risk-escalation-*.md ({count} escalations)
- Risk Status Report: .aiwg/risks/risk-status-report-{date}.md

**Next Steps**:
- Review all generated artifacts
- Schedule executive decision meetings for escalated risks
- Assign spike/POC owners for high-priority risks
- Next risk cycle: {date} (bi-weekly)
- If Elaboration ABM: Risk retirement target ≥70% ({current-percentage}%)

─────────────────────────────────────────────
```

## Error Handling

**If No Risks Identified**:
```
⚠️ Risk identification workshop produced no new risks

This may indicate:
- Insufficient analysis or team participation
- Risk saturation (all risks already identified)
- Workshop facilitation issues

Recommendation:
- Re-run workshop with broader team participation
- Review risk identification prompts for comprehensiveness
- Consider external risk assessment (third-party review)

Action: Continue with existing risk tracking and monitoring.
```

**If Risk Scoring Inconsistent**:
```
⚠️ Risk scores vary widely across team members

Examples:
- Risk #{risk-id}: Probability estimates range 1-5
- Risk #{risk-id}: Impact estimates range 2-5

Recommendation:
- Calibrate scoring criteria using risk matrix examples
- Project Manager facilitates consensus scoring
- Use planning poker technique for score alignment
- Document scoring rationale for future consistency

Action: Escalating to Project Manager for score calibration.
```

**If Spike Overrunning Timebox**:
```
❌ Spike {Spike-ID} exceeding {timebox} days

Risk: {risk-description}
Planned duration: {timebox} days
Actual duration: {actual} days (ongoing)

Impact:
- Spike time overruns indicate risk underestimated
- Resource allocation affected
- Risk retirement delayed

Action:
- Stop spike immediately
- Document findings to date
- Re-assess risk score (likely higher than initially estimated)
- Consider alternative mitigation approach or escalation

Escalating to user for decision...
```

**If Risk Retirement Without Evidence**:
```
❌ Risk {Risk-ID} marked RETIRED without evidence artifact

Risk: {risk-description}
Status: RETIRED
Evidence: MISSING (no spike card, ADR, or validation document)

Impact:
- Cannot validate risk retirement for gate criteria
- Risk may re-emerge later in project
- Audit trail incomplete

Action:
- Request evidence artifact from risk owner
- If no evidence, revert status to IDENTIFIED or MITIGATED
- Schedule spike/POC to properly validate risk retirement

Cannot proceed with gate validation until evidence provided.
```

**If Show Stopper Risk Not Escalated**:
```
❌ Risk {Risk-ID} is Show Stopper (P0) but not escalated

Risk: {risk-description}
Priority: Show Stopper (P0)
Score: {score} (≥21)
Status: IDENTIFIED
Age: {days} days

Impact:
- Project cannot proceed without resolution
- Critical path blocked
- Executive decision required

Action:
- Prepare escalation brief immediately
- Contact Executive Sponsor within 24 hours
- Provide 3-5 resolution options with pros/cons
- Schedule emergency escalation meeting

Escalating to user for immediate action...
```

**If Risk Retirement Insufficient for Gate**:
```
⚠️ Risk retirement {percentage}% (target: ≥70% for ABM)

Outstanding risks:
- Show Stopper: {count} (must be 0)
- High: {count} (must be 0)
- Medium: {count}
- Low: {count}

Gap analysis:
- Need to retire {count} more risks to meet ABM criteria
- Estimated time: {weeks} weeks of additional spikes/POCs

Recommendation:
- Conduct additional spikes/POCs to retire critical risks
- Focus on P0 and P1 risks first (gate blockers)
- Consider risk acceptance for low-impact Medium risks (with sponsor approval)

Impact:
- ABM may result in CONDITIONAL GO or NO-GO if risk retirement remains insufficient
- Construction phase delayed until risk criteria met

Action: Review risk list with Executive Sponsor for prioritization decision.
```

## Success Criteria

This orchestration succeeds when:
- [ ] Risk identification workshop conducted with team participation
- [ ] All risks assessed with probability × impact scoring
- [ ] Risk list template updated with current status and traceability
- [ ] Spikes/POCs executed for high-priority risks (within timebox)
- [ ] Risk retirements validated with evidence artifacts
- [ ] Show Stopper risks escalated to executive leadership with decision briefs
- [ ] Risk status report generated for stakeholders
- [ ] Complete audit trails archived (workshop notes, spike results, escalation briefs)
- [ ] Risk retirement metrics tracked (rate, velocity, time to retirement)

## Metrics to Track

**During orchestration, track**:
- Risk retirement rate: {percentage}% per phase
- Risk velocity: New risks vs retired risks per iteration
- Average risk score: Trend over time (target: decreasing)
- Time to retirement: Days from identification to retirement
- Spike success rate: {percentage}% of spikes retire risks
- Escalation rate: {count} escalations per phase

**Target Metrics by Phase**:
- **Inception**: 5-10 risks identified, 0% retired (baseline)
- **Elaboration**: 10-20 risks identified, 70%+ retired by ABM
- **Construction**: 5-10 new risks per iteration, 90%+ retired by OCM
- **Transition**: 3-5 operational risks, 95%+ retired by PRM

## References

**Templates** (via $AIWG_ROOT):
- Risk List: `templates/management/risk-list-template.md`
- Spike Card: experiment fields in this skill
- Architecture Decision Record: `agentic/code/frameworks/sdlc-complete/templates/governance/adr-template.md`

**Gate Criteria**:
- `flows/gate-criteria-by-phase.md` (risk criteria per phase)

**Multi-Agent Pattern**:
- `docs/multi-agent-documentation-pattern.md`

**Orchestrator Architecture**:
- `docs/orchestrator-architecture.md`
