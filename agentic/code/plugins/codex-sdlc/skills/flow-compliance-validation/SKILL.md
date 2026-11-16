---
namespace: aiwg
name: flow-compliance-validation
platforms: [all]
description: Orchestrate compliance validation workflow with requirements mapping, audit evidence collection, gap analysis, remediation tracking, and attestation
commandHint:
  argumentHint: <compliance-framework> [project-directory] [--guidance "text"] [--interactive]
  allowedTools: Task, Read, Write, Glob, TodoWrite
  model: sonnet
  category: sdlc-orchestration
  orchestration: true
  modelRole: coding
  modelTier: standard
---

> **Declarative Flow (#1539):** This flow's orchestration is now also expressed as a
> declarative YAML Flow at `flows/flow-compliance-validation.playbook.yaml` (source of truth for the step
> sequence + gates). This SKILL.md remains the discoverable trigger surface and prose
> reference. See epic #1534.

# Compliance Validation Flow

**You are the Core Orchestrator** for comprehensive compliance validation and attestation.

## Your Role

**You orchestrate multi-agent workflows. You do NOT execute bash scripts.**

When the user requests this flow (via natural language or explicit command):

1. **Interpret the request** and confirm understanding
2. **Read this template** as your orchestration guide
3. **Extract agent assignments** and workflow steps
4. **Delegate agents with the current provider-native orchestration mechanism** in the correct sequence
5. **Synthesize results** and finalize artifacts
6. **Report completion** with summary

## Compliance Validation Overview

**Purpose**: Validate project compliance with regulatory frameworks (GDPR, HIPAA, SOC2, PCI-DSS, ISO 27001, etc.)

**Key Deliverables**:
- Compliance Requirements Matrix
- Control Mapping Documentation
- Gap Analysis Report
- Remediation Plans
- Audit Evidence Package
- Compliance Attestation

**Success Criteria**:
- All applicable requirements identified and mapped
- Audit evidence collected for all controls
- Critical and high gaps remediated or risk accepted
- Control effectiveness validated
- Compliance attestation signed by Executive Sponsor

**Expected Duration**: 2-4 weeks (typical), 20-30 minutes orchestration

## Natural Language Triggers

Users may say:
- "Check compliance"
- "Validate GDPR compliance"
- "Run compliance audit"
- "Verify regulatory compliance"
- "Check SOC2 readiness"
- "Assess HIPAA compliance"
- "Prepare for ISO 27001 audit"

You recognize these as requests for this orchestration flow.

## Parameter Handling

### Compliance Framework Parameter

**Required**: User must specify which framework to validate

**Supported Frameworks**:
- **sox**: Sarbanes-Oxley Act (financial controls)
- **hipaa**: Health Insurance Portability and Accountability Act (healthcare data)
- **gdpr**: General Data Protection Regulation (EU data privacy)
- **pci-dss**: Payment Card Industry Data Security Standard (payment data)
- **iso27001**: ISO 27001 (information security management)
- **soc2**: SOC 2 Type I/II (service organization controls)
- **fedramp**: Federal Risk and Authorization Management Program (US government cloud)
- **ccpa**: California Consumer Privacy Act (California data privacy)
- **nist**: NIST Cybersecurity Framework (US government security)

### --guidance Parameter

**Purpose**: User provides upfront direction to tailor compliance focus

**Examples**:
```
--guidance "Focus on data privacy controls, GDPR Article 25 critical"
--guidance "Tight audit deadline, prioritize critical gaps only"
--guidance "First-time audit, need comprehensive evidence collection"
--guidance "Already have partial evidence from last year's audit"
```

**How to Apply**:
- Parse guidance for keywords: privacy, security, audit, deadline, evidence
- Adjust agent assignments (add privacy-officer for GDPR, security-architect for SOC2)
- Modify validation depth (comprehensive vs. streamlined based on timeline)
- Influence priority ordering (critical gaps first vs. complete coverage)

### --interactive Parameter

**Purpose**: You ask 6 strategic questions to understand compliance context

**Questions to Ask** (if --interactive):

```
I'll ask 6 strategic questions to tailor the compliance validation to your needs:

Q1: What are your top priorities for this compliance activity?
    (e.g., passing external audit, internal readiness, specific control areas)

Q2: What are your biggest compliance constraints?
    (e.g., time to audit, resource availability, technical limitations)

Q3: What compliance risks concern you most?
    (e.g., data breaches, audit failure, regulatory penalties)

Q4: What's your team's experience level with this framework?
    (Helps me gauge guidance depth and evidence collection support)

Q5: What's your target timeline for attestation?
    (Influences remediation prioritization and evidence collection pace)

Q6: Are there specific areas where you expect gaps?
    (e.g., encryption, access control, audit logging)

Based on your answers, I'll adjust:
- Agent assignments (add specialized reviewers)
- Validation depth (comprehensive vs. targeted)
- Priority ordering (critical controls first)
- Remediation approach (quick fixes vs. systematic improvements)
```

**Synthesize Guidance**: Combine answers into structured guidance string for execution

## Artifacts to Generate

**Primary Deliverables**:
- **Compliance Requirements Matrix**: Framework requirements mapped to controls → `.aiwg/compliance/requirements-matrix-{framework}.md`
- **Control Mapping**: Controls mapped to evidence → `.aiwg/compliance/control-mapping-{framework}.md`
- **Gap Analysis Report**: Identified compliance gaps → `.aiwg/compliance/gap-analysis-{framework}.md`
- **Remediation Plans**: Plans to address gaps → `.aiwg/compliance/remediation-plans-{framework}.md`
- **Evidence Collection Checklist**: Evidence inventory → `.aiwg/compliance/evidence-checklist-{framework}.md`
- **Control Testing Results**: Effectiveness validation → `.aiwg/compliance/control-testing-{framework}.md`
- **Compliance Report**: Executive summary → `.aiwg/reports/compliance-report-{framework}.md`
- **Attestation Statement**: Formal compliance attestation → `.aiwg/compliance/attestation-{framework}.md`

**Supporting Artifacts**:
- Control owner assignments
- Evidence repository index
- Risk acceptance documentation
- Audit readiness checklist

## Multi-Agent Orchestration Workflow

### Step 1: Map Compliance Requirements

**Purpose**: Identify applicable requirements and map to project controls

**Your Actions**:

1. **Initialize Compliance Assessment**:
   ```
   Create workspace:
   - .aiwg/compliance/
   - .aiwg/compliance/evidence/
   - .aiwg/compliance/working/
   ```

2. **Launch Requirements Mapping Agents** (parallel based on framework):

   **For GDPR**:
   ```
   Task(
       subagent_type="privacy-officer",
       description="Map GDPR requirements to controls",
       prompt="""
       Framework: GDPR (General Data Protection Regulation)

       Map GDPR requirements:
       1. Lawful Basis (Articles 6-9)
          - Consent management
          - Legitimate interest assessment
          - Contract necessity

       2. Data Subject Rights (Articles 12-23)
          - Right to access (Article 15)
          - Right to rectification (Article 16)
          - Right to erasure (Article 17)
          - Right to portability (Article 20)

       3. Privacy by Design (Article 25)
          - Data minimization
          - Purpose limitation
          - Storage limitation

       4. Data Protection (Articles 32-34)
          - Technical measures (encryption, pseudonymization)
          - Organizational measures (policies, training)
          - Breach notification (72-hour requirement)

       5. International Transfers (Articles 44-49)
          - Adequacy decisions
          - Standard contractual clauses
          - Binding corporate rules

       For each requirement:
       - Identify if applicable to project
       - Map to technical/administrative controls
       - Specify evidence requirements
       - Assign control owner (role)

       Output: .aiwg/compliance/requirements-matrix-gdpr.md
       """
   )
   ```

   **For HIPAA**:
   ```
   Task(
       subagent_type="security-architect",
       description="Map HIPAA requirements to controls",
       prompt="""
       Framework: HIPAA (Health Insurance Portability and Accountability Act)

       Map HIPAA requirements:
       1. Administrative Safeguards (§164.308)
          - Security Officer designation
          - Workforce training
          - Access management
          - Incident response procedures
          - Business Associate Agreements

       2. Physical Safeguards (§164.310)
          - Facility access controls
          - Workstation use policies
          - Device and media controls

       3. Technical Safeguards (§164.312)
          - Access control (unique user ID, encryption)
          - Audit controls (logging, monitoring)
          - Integrity controls (data validation)
          - Transmission security (encryption in transit)

       4. Breach Notification (§164.400-414)
          - Risk assessment process
          - Notification procedures
          - Documentation requirements

       For each requirement:
       - Identify PHI handling in project
       - Map to specific controls
       - Define evidence requirements
       - Assign control owner

       Output: .aiwg/compliance/requirements-matrix-hipaa.md
       """
   )
   ```

   **For SOC2**:
   ```
   Task(
       subagent_type="security-architect",
       description="Map SOC2 Trust Services Criteria",
       prompt="""
       Framework: SOC2 (Service Organization Control 2)

       Map SOC2 Trust Services Criteria:

       1. Security (Common Criteria)
          - CC1: Control Environment
          - CC2: Communication and Information
          - CC3: Risk Assessment
          - CC4: Monitoring Activities
          - CC5: Control Activities
          - CC6: Logical and Physical Access
          - CC7: System Operations
          - CC8: Change Management
          - CC9: Risk Mitigation

       2. Availability (if applicable)
          - A1: Availability commitments and SLAs

       3. Processing Integrity (if applicable)
          - PI1: Processing accuracy and completeness

       4. Confidentiality (if applicable)
          - C1: Protection of confidential information

       5. Privacy (if applicable)
          - P1-P8: Privacy criteria

       For each criterion:
       - Map to project controls
       - Identify control activities
       - Specify testing procedures
       - Define evidence requirements

       Output: .aiwg/compliance/requirements-matrix-soc2.md
       """
   )
   ```

   **For PCI-DSS**:
   ```
   Task(
       subagent_type="security-architect",
       description="Map PCI-DSS requirements",
       prompt="""
       Framework: PCI-DSS (Payment Card Industry Data Security Standard)

       Map PCI-DSS 4.0 Requirements:

       1. Build and Maintain Secure Networks (Req 1-2)
          - Network segmentation
          - Firewall configurations
          - Default passwords changed

       2. Protect Cardholder Data (Req 3-4)
          - Data retention and disposal
          - Encryption at rest
          - Encryption in transit

       3. Vulnerability Management (Req 5-6)
          - Anti-malware programs
          - Secure development practices
          - Security patches

       4. Access Control (Req 7-9)
          - Need-to-know access
          - Unique user IDs
          - Physical access controls

       5. Monitor and Test (Req 10-11)
          - Audit logging
          - Security testing (scans, penetration tests)
          - Network monitoring

       6. Information Security Policy (Req 12)
          - Security policies
          - Risk assessments
          - Incident response

       For each requirement:
       - Identify cardholder data in scope
       - Map to compensating controls (if applicable)
       - Define quarterly/annual validation
       - Specify ASV scan requirements

       Output: .aiwg/compliance/requirements-matrix-pci-dss.md
       """
   )
   ```

   **For ISO 27001**:
   ```
   Task(
       subagent_type="security-architect",
       description="Map ISO 27001 controls",
       prompt="""
       Framework: ISO 27001:2022

       Map ISO 27001 Annex A Controls (93 controls in 4 categories):

       1. Organizational Controls (37 controls)
          - Information security policies
          - Roles and responsibilities
          - Segregation of duties
          - Management commitment

       2. People Controls (8 controls)
          - Screening and vetting
          - Terms of employment
          - Security awareness training
          - Disciplinary process

       3. Physical Controls (14 controls)
          - Physical security perimeter
          - Physical entry controls
          - Protection against threats
          - Secure disposal

       4. Technological Controls (34 controls)
          - Access control
          - Cryptography
          - Systems security
          - Application security
          - Secure configuration

       For each applicable control:
       - Document implementation status
       - Map to existing controls
       - Identify control effectiveness measures
       - Define audit evidence

       Create Statement of Applicability (SoA)

       Output: .aiwg/compliance/requirements-matrix-iso27001.md
       """
   )
   ```

3. **Synthesize Requirements Matrix**:
   ```
   Task(
       subagent_type="compliance-auditor",
       description="Create unified compliance requirements matrix",
       prompt="""
       Read framework-specific requirements matrix

       Create comprehensive matrix including:
       - Requirement ID and description
       - Applicable: Yes/No/Partial
       - Control type (Preventive/Detective/Corrective)
       - Implementation status (Implemented/Partial/Missing)
       - Control owner assignment
       - Evidence requirements
       - Testing approach

       Prioritize by:
       - Regulatory importance (mandatory vs. recommended)
       - Risk impact (critical/high/medium/low)
       - Implementation complexity

       Output: .aiwg/compliance/unified-requirements-matrix-{framework}.md
       """
   )
   ```

**Communicate Progress**:
```
✓ Initialized compliance validation for {framework}
⏳ Mapping {framework} requirements to controls...
  ✓ Requirements identified: {count}
  ✓ Controls mapped: {count}
  ✓ Control owners assigned
✓ Requirements matrix complete: .aiwg/compliance/requirements-matrix-{framework}.md
```

### Step 2: Collect Audit Evidence

**Purpose**: Gather evidence demonstrating control implementation

**Your Actions**:

1. **Generate Evidence Collection Checklist**:
   ```
   Task(
       subagent_type="compliance-auditor",
       description="Create evidence collection checklist",
       prompt="""
       Read requirements matrix: .aiwg/compliance/requirements-matrix-{framework}.md

       For each control, specify evidence needed:

       1. Documentation Evidence
          - Policies and procedures
          - Architecture documentation
          - Configuration standards
          - Training materials

       2. Configuration Evidence
          - System configurations (screenshots/exports)
          - Security settings
          - Access control lists
          - Firewall rules

       3. Operational Evidence
          - Audit logs (samples)
          - Incident reports
          - Change tickets
          - Monitoring dashboards

       4. Testing Evidence
          - Vulnerability scan reports
          - Penetration test results
          - Code review reports
          - Security assessments

       Create checklist with:
       - Control ID
       - Evidence type needed
       - Evidence location (if known)
       - Collection method
       - Owner responsible
       - Collection deadline
       - Status (Collected/Pending/N/A)

       Output: .aiwg/compliance/evidence-checklist-{framework}.md
       """
   )
   ```

2. **Launch Evidence Collection Agents** (parallel by control domain):
   ```
   # Technical Controls Evidence
   Task(
       subagent_type="security-architect",
       description="Collect technical control evidence",
       prompt="""
       Read evidence checklist (technical controls section)

       Collect or document location of:
       1. Encryption configurations
          - TLS certificates and versions
          - Database encryption settings
          - Key management procedures

       2. Access control configurations
          - IAM policies
          - RBAC configurations
          - MFA settings

       3. Security monitoring
          - Log aggregation setup
          - SIEM rules and alerts
          - Incident response runbooks

       4. Network security
          - Firewall rules
          - Network segmentation diagrams
          - VPN configurations

       For each piece of evidence:
       - Verify it's current (not outdated)
       - Redact sensitive information
       - Document retrieval process
       - Save to .aiwg/compliance/evidence/technical/

       Update checklist with collection status
       """
   )

   # Administrative Controls Evidence
   Task(
       subagent_type="privacy-officer",
       description="Collect administrative control evidence",
       prompt="""
       Read evidence checklist (administrative controls section)

       Collect or document:
       1. Policies and procedures
          - Information security policy
          - Data handling procedures
          - Incident response plan
          - Business continuity plan

       2. Training and awareness
          - Training materials
          - Completion records
          - Security awareness communications

       3. Third-party management
          - Vendor assessments
          - Contract reviews
          - SLAs and agreements

       4. Risk management
          - Risk assessments
          - Risk register
          - Risk treatment plans

       Save to .aiwg/compliance/evidence/administrative/
       Update checklist status
       """
   )

   # Operational Controls Evidence
   Task(
       subagent_type="devops-engineer",
       description="Collect operational control evidence",
       prompt="""
       Read evidence checklist (operational controls section)

       Collect evidence of:
       1. Change management
          - Change tickets (samples)
          - Approval workflows
          - Deployment logs
          - Rollback procedures

       2. Monitoring and logging
          - Log samples (30-90 days)
          - Alert configurations
          - Monitoring dashboards
          - Availability metrics

       3. Backup and recovery
          - Backup schedules
          - Recovery test results
          - RTO/RPO documentation

       4. Vulnerability management
          - Scan reports (recent)
          - Patch management records
          - Vulnerability remediation tickets

       Save to .aiwg/compliance/evidence/operational/
       Update checklist status
       """
   )
   ```

3. **Validate Evidence Quality**:
   ```
   Task(
       subagent_type="compliance-auditor",
       description="Validate evidence completeness and quality",
       prompt="""
       Review all collected evidence

       For each piece of evidence, validate:
       1. Completeness (no missing sections)
       2. Currency (within required timeframe)
       3. Authenticity (legitimate source)
       4. Relevance (addresses control requirement)
       5. Sufficiency (enough to prove control)

       Create evidence quality report:
       - Total evidence items: {count}
       - Complete: {count} ({percentage}%)
       - Incomplete: {count} (list items)
       - Outdated: {count} (list items)
       - Missing: {count} (list items)

       Flag critical gaps for immediate collection

       Output: .aiwg/compliance/evidence-quality-report-{framework}.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Collecting audit evidence...
  ✓ Evidence checklist created: {count} items
  ✓ Technical evidence: {percentage}% collected
  ✓ Administrative evidence: {percentage}% collected
  ✓ Operational evidence: {percentage}% collected
✓ Evidence collection complete: {percentage}% overall
⚠️ Missing evidence flagged: {count} items
```

### Step 3: Conduct Gap Analysis

**Purpose**: Compare current state to compliance requirements

**Your Actions**:

1. **Launch Gap Analysis Agents** (parallel by severity):
   ```
   Task(
       subagent_type="compliance-auditor",
       description="Identify compliance gaps",
       prompt="""
       Read:
       - Requirements matrix: .aiwg/compliance/requirements-matrix-{framework}.md
       - Evidence quality report: .aiwg/compliance/evidence-quality-report-{framework}.md

       For each requirement, assess:
       1. Control Implementation
          - Fully Implemented (control exists and operates)
          - Partially Implemented (control exists but incomplete)
          - Not Implemented (control missing)

       2. Evidence Status
          - Sufficient (proves control effectiveness)
          - Insufficient (partial evidence)
          - Missing (no evidence)

       3. Gap Severity
          - Critical: Blocks compliance, high risk
          - High: Audit finding likely, medium risk
          - Medium: Minor finding possible, low risk
          - Low: Improvement opportunity

       Categorize gaps:
       - Missing controls (not implemented)
       - Ineffective controls (implemented but not working)
       - Insufficient evidence (control works but can't prove)

       Output: .aiwg/compliance/gap-analysis-{framework}.md
       """
   )

   Task(
       subagent_type="security-architect",
       description="Assess technical gap impact",
       prompt="""
       Read gap analysis

       For each technical gap:
       1. Assess security impact
          - Data exposure risk
          - System compromise risk
          - Compliance violation risk

       2. Estimate remediation effort
          - Quick fix (hours/days)
          - Standard fix (weeks)
          - Major project (months)

       3. Recommend remediation approach
          - Technical solution
          - Compensating controls
          - Risk acceptance criteria

       Prioritize by risk × effort matrix

       Output: .aiwg/compliance/technical-gap-assessment-{framework}.md
       """
   )
   ```

2. **Create Gap Remediation Matrix**:
   ```
   Task(
       subagent_type="project-manager",
       description="Create remediation priority matrix",
       prompt="""
       Read:
       - Gap analysis
       - Technical gap assessment

       Create remediation matrix:

       | Gap ID | Requirement | Severity | Risk | Effort | Priority | Owner | Timeline |
       |--------|------------|----------|------|--------|----------|-------|----------|

       Prioritization formula:
       - Critical gaps: MUST fix before attestation
       - High gaps: SHOULD fix or have risk acceptance
       - Medium gaps: Target for next cycle
       - Low gaps: Continuous improvement

       For each gap, specify:
       - Remediation approach
       - Success criteria
       - Validation method
       - Dependencies

       Output: .aiwg/compliance/remediation-matrix-{framework}.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Analyzing compliance gaps...
✓ Gap analysis complete:
  - Critical gaps: {count}
  - High gaps: {count}
  - Medium gaps: {count}
  - Low gaps: {count}
✓ Remediation matrix created
⚠️ {count} critical gaps require immediate attention
```

### Step 4: Implement Remediation Plans

**Purpose**: Address critical and high-priority gaps

**Your Actions**:

1. **Create Detailed Remediation Plans** (parallel by gap severity):
   ```
   # Critical Gaps
   Task(
       subagent_type="security-architect",
       description="Create critical gap remediation plans",
       prompt="""
       Read remediation matrix (critical gaps)

       For each critical gap, create detailed plan:

       1. Gap Description
          - Current state
          - Required state
          - Compliance impact

       2. Remediation Steps
          - Specific technical actions
          - Configuration changes
          - Process updates
          - Documentation needs

       3. Success Criteria
          - How to verify remediation
          - Evidence to collect
          - Testing approach

       4. Timeline
          - Start date
          - Milestones
          - Completion date
          - Validation date

       5. Risk if Not Remediated
          - Compliance impact
          - Business impact
          - Recommended risk acceptance (if applicable)

       Output: .aiwg/compliance/remediation-plans/critical-{gap-id}.md
       """
   )

   # High Priority Gaps
   Task(
       subagent_type="compliance-specialist",
       description="Create high-priority gap remediation plans",
       prompt="""
       Similar structure for high-priority gaps
       Focus on quick wins and high-impact improvements

       Output: .aiwg/compliance/remediation-plans/high-{gap-id}.md
       """
   )
   ```

2. **Execute Quick Remediation** (where possible):
   ```
   Task(
       subagent_type="devops-engineer",
       description="Implement quick-fix remediations",
       prompt="""
       Read remediation plans (quick fixes only)

       For gaps that can be fixed immediately:
       1. Update configurations
       2. Enable logging/monitoring
       3. Document procedures
       4. Update access controls

       For each fix:
       - Document change made
       - Collect evidence of fix
       - Validate effectiveness
       - Update gap status

       Output: .aiwg/compliance/remediation-completed-{framework}.md
       """
   )
   ```

3. **Document Risk Acceptance** (for gaps not remediated):
   ```
   Task(
       subagent_type="legal-liaison",
       description="Document risk acceptance for unremediated gaps",
       prompt="""
       For gaps that cannot be remediated before attestation:

       Create risk acceptance documentation:
       1. Gap description and severity
       2. Why it cannot be remediated now
       3. Compensating controls (if any)
       4. Residual risk assessment
       5. Risk owner (must be executive level)
       6. Acceptance period (temporary vs. permanent)
       7. Re-evaluation date

       Output: .aiwg/compliance/risk-acceptance-{framework}.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Implementing remediation plans...
  ✓ Critical gap remediation: {count}/{total} complete
  ✓ High gap remediation: {count}/{total} complete
  ✓ Quick fixes applied: {count}
  ⚠️ Risk acceptance needed: {count} gaps
✓ Remediation phase complete
```

### Step 5: Validate Control Effectiveness

**Purpose**: Test that controls are operating effectively

**Your Actions**:

1. **Design Control Tests**:
   ```
   Task(
       subagent_type="test-architect",
       description="Design control effectiveness tests",
       prompt="""
       Read:
       - Requirements matrix
       - Remediation completed list

       For each control, design test:
       1. Test objective (what to validate)
       2. Test approach (how to test)
       3. Sample size (if sampling)
       4. Success criteria (pass/fail)
       5. Evidence to collect

       Test types:
       - Inquiry (interview control owners)
       - Observation (watch control in action)
       - Inspection (review evidence)
       - Re-performance (repeat control action)

       Output: .aiwg/compliance/control-test-plan-{framework}.md
       """
   )
   ```

2. **Execute Control Tests** (parallel by control domain):
   ```
   Task(
       subagent_type="security-tester",
       description="Test technical controls",
       prompt="""
       Execute technical control tests:

       1. Access Control Testing
          - Attempt unauthorized access
          - Verify least privilege
          - Test segregation of duties

       2. Encryption Testing
          - Verify encryption in transit (TLS scan)
          - Verify encryption at rest
          - Test key management

       3. Logging and Monitoring
          - Verify log generation
          - Test alert triggers
          - Validate log retention

       4. Security Configuration
          - Run configuration scans
          - Test hardening standards
          - Validate patch levels

       Document results:
       - Control ID
       - Test performed
       - Result (Pass/Fail)
       - Evidence collected
       - Deficiencies noted

       Output: .aiwg/compliance/control-test-results-technical-{framework}.md
       """
   )

   Task(
       subagent_type="compliance-auditor",
       description="Test administrative controls",
       prompt="""
       Test administrative controls through:

       1. Policy review (current and approved)
       2. Training record inspection
       3. Process observation
       4. Staff interviews
       5. Documentation review

       Output: .aiwg/compliance/control-test-results-administrative-{framework}.md
       """
   )
   ```

3. **Consolidate Test Results**:
   ```
   Task(
       subagent_type="compliance-auditor",
       description="Consolidate control testing results",
       prompt="""
       Read all test results

       Create summary:
       - Total controls tested: {count}
       - Controls effective: {count} ({percentage}%)
       - Controls with deficiencies: {count}
       - Controls failed: {count}

       For deficiencies:
       - Categorize by severity
       - Determine if attestation blocker
       - Recommend remediation or acceptance

       Output: .aiwg/compliance/control-effectiveness-summary-{framework}.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Testing control effectiveness...
  ✓ Test plan created: {count} controls to test
  ✓ Technical controls tested: {percentage}% effective
  ✓ Administrative controls tested: {percentage}% effective
✓ Control testing complete: {percentage}% overall effectiveness
⚠️ {count} controls with deficiencies identified
```

### Step 6: Generate Compliance Report and Attestation

**Purpose**: Create executive report and formal attestation

**Your Actions**:

1. **Generate Executive Compliance Report**:
   ```
   Task(
       subagent_type="compliance-auditor",
       description="Generate comprehensive compliance report",
       prompt="""
       Read all compliance artifacts:
       - Requirements matrix
       - Gap analysis
       - Remediation status
       - Control test results
       - Risk acceptances

       Generate executive report with:

       # Compliance Validation Report - {Framework}

       ## Executive Summary
       - Overall compliance status
       - Critical findings
       - Attestation readiness

       ## Compliance Status
       - Total requirements: {count}
       - Requirements met: {percentage}%
       - Critical gaps: {count}
       - Risk acceptances: {count}

       ## Gap Analysis Summary
       [Table of gaps by severity]

       ## Remediation Status
       [Progress on gap closure]

       ## Control Effectiveness
       [Testing results summary]

       ## Risk Acceptance Summary
       [Accepted risks with owners]

       ## Recommendations
       - Immediate actions needed
       - Long-term improvements
       - Process enhancements

       ## Attestation Readiness
       - Ready to attest: YES/NO/CONDITIONAL
       - Conditions (if any)

       Output: .aiwg/reports/compliance-report-{framework}.md
       """
   )
   ```

2. **Prepare Attestation Statement**:
   ```
   Task(
       subagent_type="legal-liaison",
       description="Prepare formal attestation statement",
       prompt="""
       Based on compliance status, prepare attestation:

       # {Framework} Compliance Attestation

       **Organization**: [Project/Company Name]
       **Framework**: {framework}
       **Assessment Period**: [Start Date] to [End Date]
       **Attestation Date**: {current date}

       ## Attestation Statement

       I, [Executive Name], in my capacity as [Title], hereby attest that:

       1. A comprehensive compliance assessment has been conducted
       2. Controls have been implemented to address {framework} requirements
       3. Control effectiveness has been validated through testing
       4. Identified gaps have been remediated or formally risk accepted
       5. The organization is [COMPLIANT/SUBSTANTIALLY COMPLIANT/NOT COMPLIANT]
          with {framework} requirements

       ## Scope
       [Define what is included/excluded]

       ## Exceptions and Limitations
       [List any gaps with risk acceptance]

       ## Compensating Controls
       [Describe compensating controls for gaps]

       ## Management Commitment
       We commit to maintaining compliance through:
       - Continuous monitoring
       - Periodic assessments
       - Timely remediation

       **Signature**: _________________________
       **Name**: [Executive Sponsor]
       **Title**: [Title]
       **Date**: [Date]

       Output: .aiwg/compliance/attestation-{framework}.md
       """
   )
   ```

3. **Package Audit Evidence**:
   ```
   Task(
       subagent_type="documentation-archivist",
       description="Create audit evidence package",
       prompt="""
       Create organized evidence package for auditor:

       Create index:
       .aiwg/compliance/evidence/INDEX.md

       Structure:
       1. Executive Summary
          - Compliance report
          - Attestation statement

       2. Requirements Mapping
          - Requirements matrix
          - Control mapping

       3. Gap Analysis
          - Gap analysis report
          - Remediation plans
          - Risk acceptances

       4. Evidence by Control
          - Organize by requirement ID
          - Include test results
          - Link to source documents

       5. Appendices
          - Policies and procedures
          - Technical configurations
          - Test reports

       Create ZIP archive:
       .aiwg/compliance/audit-package-{framework}-{date}.zip

       Output: Evidence package ready for auditor review
       """
   )
   ```

**Communicate Progress**:
```
✓ Generating compliance documentation...
  ✓ Executive report complete
  ✓ Attestation statement prepared
  ✓ Audit evidence package created
✓ Compliance validation complete for {framework}
```

## Framework-Specific Considerations

### GDPR Specific
- Focus on privacy rights implementation
- Document lawful basis for processing
- Validate DSAR (data subject access request) process
- Ensure DPO (Data Protection Officer) involvement
- Verify cross-border transfer mechanisms

### HIPAA Specific
- Emphasize PHI safeguards
- Validate Business Associate Agreements
- Test breach notification procedures
- Verify workforce training completion
- Document risk assessments

### SOC2 Specific
- Align with Trust Services Criteria
- Focus on continuous monitoring
- Document control activities
- Validate change management
- Emphasize availability metrics

### PCI-DSS Specific
- Define cardholder data environment (CDE)
- Validate network segmentation
- Quarterly vulnerability scans by ASV
- Annual penetration testing
- Compensating controls documentation

### ISO 27001 Specific
- Create Statement of Applicability
- Document ISMS scope
- Validate risk assessment methodology
- Internal audit before certification
- Management review evidence

## Quality Gates

Before marking workflow complete, verify:
- [ ] All applicable requirements identified
- [ ] Evidence collected for all controls
- [ ] Gap analysis complete with severity assessment
- [ ] Critical gaps remediated or risk accepted
- [ ] Control effectiveness validated
- [ ] Executive report generated
- [ ] Attestation statement prepared
- [ ] Audit package assembled

## User Communication

**At start**: Confirm framework and scope

```
Understood. I'll orchestrate compliance validation for {framework}.

This will include:
- Requirements mapping to controls
- Evidence collection and validation
- Gap analysis and remediation
- Control effectiveness testing
- Compliance report and attestation

Expected duration: 20-30 minutes.

Starting compliance validation...
```

**During**: Update progress with clear indicators

```
✓ = Complete
⏳ = In progress
❌ = Failed/blocked
⚠️ = Attention needed
```

**At end**: Compliance summary report

```
═══════════════════════════════════════════════
{Framework} Compliance Validation Complete
═══════════════════════════════════════════════

**Compliance Status**: {COMPLIANT | SUBSTANTIALLY COMPLIANT | NON-COMPLIANT}
**Attestation Ready**: {YES | NO | CONDITIONAL}

**Requirements Coverage**:
✓ Total Requirements: {count}
✓ Requirements Met: {count} ({percentage}%)
⚠️ Requirements with Gaps: {count}

**Gap Summary**:
- Critical: {count} [{resolved}/{total}]
- High: {count} [{resolved}/{total}]
- Medium: {count}
- Low: {count}

**Control Effectiveness**: {percentage}% effective
**Evidence Collection**: {percentage}% complete

**Key Artifacts**:
- Compliance Report: .aiwg/reports/compliance-report-{framework}.md
- Gap Analysis: .aiwg/compliance/gap-analysis-{framework}.md
- Attestation: .aiwg/compliance/attestation-{framework}.md
- Audit Package: .aiwg/compliance/audit-package-{framework}.zip

**Next Steps**:
1. Review executive report with leadership
2. Obtain attestation signature
3. Address remaining gaps (if any)
4. Schedule audit (internal or external)
5. Implement continuous monitoring

**Recommendations**:
{List top 3-5 recommendations}

═══════════════════════════════════════════════
```

## Error Handling

**Framework Not Recognized**:
```
❌ Compliance framework '{input}' not recognized

Supported frameworks:
- sox: Sarbanes-Oxley Act
- hipaa: Health Insurance Portability and Accountability Act
- gdpr: General Data Protection Regulation
- pci-dss: Payment Card Industry Data Security Standard
- iso27001: ISO 27001 Information Security
- soc2: Service Organization Control 2
- fedramp: Federal Risk and Authorization Management Program
- ccpa: California Consumer Privacy Act
- nist: NIST Cybersecurity Framework

Please specify a valid framework.
```

**Critical Gaps Not Remediated**:
```
⚠️ Critical compliance gaps remain

{count} critical gaps must be addressed before attestation:
1. {gap description}
2. {gap description}

Options:
- Remediate gaps (recommended)
- Document compensating controls
- Obtain executive risk acceptance
- Defer attestation

Cannot proceed with attestation while critical gaps remain unremediated.
```

**Insufficient Evidence**:
```
❌ Insufficient evidence for compliance validation

Evidence gaps:
- {count} controls missing evidence
- {count} controls with outdated evidence

Actions needed:
1. Collect missing evidence
2. Update outdated documentation
3. Re-run validation

Compliance cannot be attested without sufficient evidence.
```

## Success Criteria

This orchestration succeeds when:
- [ ] Framework requirements mapped to controls
- [ ] Control owners identified and assigned
- [ ] Evidence collected (≥90% complete)
- [ ] Gap analysis completed
- [ ] Critical/high gaps remediated or risk accepted
- [ ] Control effectiveness validated
- [ ] Compliance report generated
- [ ] Attestation statement prepared
- [ ] Audit package ready for review

## Metrics to Track

**During orchestration, track**:
- Requirements coverage: % of requirements with implemented controls
- Evidence completeness: % of controls with sufficient evidence
- Gap closure rate: % of gaps remediated
- Control effectiveness: % of controls testing as effective
- Time to remediation: Average days to close gaps
- Risk acceptance rate: % of gaps requiring risk acceptance

## References

**Templates** (via $AIWG_ROOT):
- Requirements Matrix: requirements matrix fields in this skill
- Control Mapping: control mapping fields in this skill
- Gap Analysis: gap analysis fields in this skill
- Evidence Checklist: evidence collection fields in this skill
- Attestation: attestation fields in this skill
- Control Testing: control testing fields in this skill

**Framework Guidance**:
- GDPR: `add-ons/gdpr-compliance/`
- HIPAA: External reference (HHS.gov)
- SOC2: AICPA Trust Services Criteria
- PCI-DSS: PCI Security Standards Council
- ISO 27001: ISO/IEC 27001:2022 standard

**Related Flows**:
- Security Review: `flow-security-review-cycle.md`
- Risk Management: `flow-risk-management-cycle.md`
- Gate Checks: `flow-gate-check.md`