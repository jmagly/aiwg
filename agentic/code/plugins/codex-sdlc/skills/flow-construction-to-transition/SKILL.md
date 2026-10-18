---
namespace: aiwg
name: flow-construction-to-transition
platforms: [all]
description: Orchestrate Construction→Transition phase transition with IOC validation, production deployment, and operational handover
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
> declarative YAML Flow at `flows/flow-construction-to-transition.playbook.yaml` (source of truth for the step
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


# Construction → Transition Phase Transition Flow

**You are the Core Orchestrator** for the critical Construction→Transition phase transition.

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

**From**: Construction (feature-complete, tested, deployment-ready)
**To**: Transition (production deployed, users trained, support operational)

**Key Milestone**: Product Release Milestone (PRM)

**Success Criteria**:
- Production deployment successful and stable
- Users trained and actively using system
- Support and operations teams operational
- Hypercare period completed without critical issues
- Business value validated

**Expected Duration**: 2-4 weeks (typical), 20-30 minutes orchestration

## Natural Language Triggers

Users may say:
- "Transition to production"
- "Start Transition phase"
- "Prepare for deployment"
- "Move to Transition"
- "Ready to deploy"
- "Deploy to production"
- "Begin production rollout"
- "Start hypercare period"

You recognize these as requests for this orchestration flow.

## Parameter Handling

### --guidance Parameter

**Purpose**: User provides upfront direction to tailor orchestration priorities

**Examples**:
```
--guidance "High-risk deployment, need extensive validation and rollback plans"
--guidance "Limited support team, extra training and documentation needed"
--guidance "Performance critical, validate SLAs thoroughly before cutover"
--guidance "Phased rollout required, start with pilot users only"
```

**How to Apply**:
- Parse guidance for keywords: rollback, training, performance, phased, pilot
- Adjust agent assignments (add reliability-engineer for performance focus)
- Modify deployment strategy (phased vs. big-bang based on risk tolerance)
- Influence validation depth (comprehensive vs. streamlined based on risk)

### --interactive Parameter

**Purpose**: You ask 6-8 strategic questions to understand deployment context

**Questions to Ask** (if --interactive):

```
I'll ask 8 strategic questions to tailor the Transition to your needs:

Q1: What deployment strategy do you prefer?
    (e.g., big-bang, phased/canary, blue-green, feature toggles)

Q2: How critical is zero-downtime deployment?
    (Helps me plan cutover strategy and rollback procedures)

Q3: What's your support team's readiness level?
    (Determines training depth and handover timeline)

Q4: What are your rollback criteria?
    (Define when to pull back vs. fix forward)

Q5: How long should the hypercare period be?
    (7 days minimum, 14 days standard, 30 days for critical systems)

Q6: Are there specific compliance requirements for production?
    (e.g., SOC2 audit trails, HIPAA logging, PCI-DSS controls)

Q7: What's your user adoption strategy?
    (All at once, pilot group first, gradual onboarding)

Q8: What business metrics define success?
    (KPIs to validate during hypercare and PRM review)

Based on your answers, I'll adjust:
- Deployment strategy and validation depth
- Support training intensity
- Hypercare monitoring focus
- Success criteria thresholds
```

**Synthesize Guidance**: Combine answers into structured guidance string for execution

## Artifacts to Generate

**Primary Deliverables**:
- **Production Deployment Report**: Deployment execution and validation → `.aiwg/deployment/production-deployment-report.md`
- **User Training Report**: Training delivery and UAT results → `.aiwg/deployment/user-training-report.md`
- **Support Handover Report**: Support team readiness → `.aiwg/deployment/support-handover-report.md`
- **Operations Handover Report**: Ops team readiness → `.aiwg/deployment/operations-handover-report.md`
- **Hypercare Daily Reports**: Production monitoring → `.aiwg/reports/hypercare-day-*.md`
- **PRM Report**: Milestone readiness assessment → `.aiwg/reports/prm-report.md`

**Supporting Artifacts**:
- Infrastructure Readiness Report
- Operational Runbooks
- Support Knowledge Base
- Complete audit trails

## Multi-Agent Orchestration Workflow

### Step 1: Validate Construction Exit Criteria (OCM)

**Purpose**: Verify Operational Capability Milestone achieved before starting Transition

**Your Actions**:

1. **Check for Required Construction Artifacts**:
   ```
   Read and verify presence of:
   - .aiwg/deployment/deployment-plan.md
   - .aiwg/deployment/release-notes.md
   - .aiwg/deployment/support-runbook.md
   - .aiwg/testing/test-evaluation-summary.md
   - .aiwg/deployment/bill-of-materials.md
   ```

2. **Launch Gate Check Agent**:
   ```
   Task(
       subagent_type="project-manager",
       description="Validate Construction gate (OCM) criteria",
       prompt="""
       Read gate criteria from: $AIWG_ROOT/agentic/code/frameworks/sdlc-complete/flows/gate-criteria-by-phase.md

       Validate OCM criteria:
       - All planned features IMPLEMENTED (100% Must Have, ≥80% Should Have)
       - All acceptance tests PASSING (≥98% pass rate)
       - Test coverage targets MET (unit ≥80%, integration ≥70%, e2e ≥50%)
       - Zero P0 (Show Stopper) defects open
       - Zero P1 (High) defects open OR all have approved waivers
       - Performance tests PASSING (response time, throughput, concurrency)
       - Security tests PASSING (no High/Critical vulnerabilities)
       - CI/CD pipeline OPERATIONAL
       - Deployment plan COMPLETE and APPROVED
       - Operational Readiness Review (ORR) PASSED

       Generate OCM Validation Report:
       - Status: PASS | FAIL
       - Criteria checklist with results
       - Decision: GO to Transition | NO-GO
       - Gaps (if NO-GO): List missing artifacts

       Save to: .aiwg/reports/ocm-validation-report.md
       """
   )
   ```

3. **Decision Point**:
   - If OCM PASS → Continue to Step 2
   - If OCM FAIL → Report gaps to user, recommend `flow-elaboration-to-construction` to complete Construction
   - Escalate to user for executive decision if criteria partially met

**Communicate Progress**:
```
✓ Initialized OCM validation
⏳ Validating Construction exit criteria...
✓ OCM Validation complete: [PASS | FAIL]
```

### Step 2: Prepare Production Environment

**Purpose**: Ensure production infrastructure is provisioned, configured, and validated

**Your Actions**:

1. **Read Infrastructure Context**:
   ```
   Read:
   - .aiwg/deployment/infrastructure-definition.md
   - .aiwg/deployment/deployment-environment.md
   - .aiwg/architecture/software-architecture-doc.md (deployment view)
   ```

2. **Launch Infrastructure Validation Agents** (parallel):
   ```
   # Agent 1: DevOps Engineer
   Task(
       subagent_type="devops-engineer",
       description="Validate production infrastructure readiness",
       prompt="""
       Read infrastructure definition and deployment environment docs

       Validate production environment:
       - Infrastructure provisioned (compute, storage, network)
       - Capacity validated (expected load + 20% buffer)
       - High availability configured (redundancy, failover)
       - Scalability tested (autoscaling operational)
       - Network configuration (load balancers, CDN, DNS)

       Document infrastructure status:
       - Environment provisioning status
       - Capacity test results
       - HA/DR configuration
       - Outstanding issues

       Save to: .aiwg/working/transition/infrastructure-readiness.md
       """
   )

   # Agent 2: Security Architect
   Task(
       subagent_type="security-architect",
       description="Validate production security configuration",
       prompt="""
       Read security architecture and deployment docs

       Validate security hardening:
       - Firewall rules configured (least privilege)
       - SSL/TLS certificates valid (no expiry < 30 days)
       - Access controls configured (RBAC, audit logging)
       - Secrets management operational (vault, KMS)
       - Encryption enabled (at-rest, in-transit)
       - Security scan results (no High/Critical vulnerabilities)

       Document security status

       Save to: .aiwg/working/transition/security-validation.md
       """
   )

   # Agent 3: Reliability Engineer
   Task(
       subagent_type="reliability-engineer",
       description="Validate monitoring and observability",
       prompt="""
       Validate monitoring infrastructure:
       - Application metrics configured
       - Infrastructure metrics configured
       - Dashboards operational (list key dashboards)
       - Alerting configured and tested
       - Log aggregation working
       - SLIs/SLOs defined
       - Backup procedures automated
       - Disaster recovery validated

       Document observability status

       Save to: .aiwg/working/transition/observability-readiness.md
       """
   )
   ```

3. **Synthesize Infrastructure Readiness Report**:
   ```
   Task(
       subagent_type="deployment-manager",
       description="Create Production Environment Readiness Report",
       prompt="""
       Read all infrastructure validation reports:
       - .aiwg/working/transition/infrastructure-readiness.md
       - .aiwg/working/transition/security-validation.md
       - .aiwg/working/transition/observability-readiness.md

       Synthesize comprehensive readiness report covering:
       - Infrastructure provisioning status
       - Capacity and scalability validation
       - Security hardening status
       - Monitoring and observability
       - Backup and disaster recovery
       - Overall readiness: READY | NOT READY

       Output: .aiwg/deployment/production-environment-readiness-report.md
       """
   )
   ```

**Communicate Progress**:
```
✓ OCM validation complete
⏳ Validating production environment...
  ✓ Infrastructure provisioned and validated
  ✓ Security hardening complete
  ✓ Monitoring and observability operational
✓ Production environment: READY
```

### Step 3: Execute Production Deployment

**Purpose**: Deploy application to production using validated deployment plan

**Your Actions**:

1. **Select Deployment Strategy**:
   ```
   Task(
       subagent_type="deployment-manager",
       description="Select and plan deployment strategy",
       prompt="""
       Read deployment plan: .aiwg/deployment/deployment-plan.md
       Consider guidance: {user-guidance if provided}

       Select optimal strategy:
       - Big Bang: Simple but high risk (for low-traffic systems)
       - Phased/Canary: Gradual rollout (for risk mitigation)
       - Blue-Green: Parallel environments (for instant rollback)
       - Feature Toggle: Dark launch (for maximum control)

       Document selected strategy and rationale
       Define rollback criteria and procedures

       Output: .aiwg/working/transition/deployment-strategy.md
       """
   )
   ```

2. **Execute Deployment** (coordinate multiple agents):
   ```
   # Pre-deployment
   Task(
       subagent_type="deployment-manager",
       description="Execute pre-deployment checklist",
       prompt="""
       Validate pre-deployment:
       - Deployment window scheduled and communicated
       - Code freeze active
       - Deployment team assembled
       - Rollback plan validated
       - Stakeholders notified

       Document readiness: .aiwg/working/transition/pre-deployment-checklist.md
       """
   )

   # Deployment execution
   Task(
       subagent_type="devops-engineer",
       description="Execute production deployment",
       prompt="""
       Deploy to production following selected strategy:
       1. Execute deployment scripts/automation
       2. Run database migrations (if applicable)
       3. Update configuration (env vars, feature flags)
       4. Deploy application (code, containers, artifacts)
       5. Validate health checks

       Monitor deployment progress
       Document any issues encountered

       Output: .aiwg/working/transition/deployment-execution-log.md
       """
   )

   # Post-deployment validation
   Task(
       subagent_type="reliability-engineer",
       description="Validate post-deployment health",
       prompt="""
       Validate deployment success:
       - Smoke tests passing (critical paths)
       - Monitoring dashboards green
       - Error rates normal (<0.1%)
       - Performance metrics acceptable
       - User login tested
       - Key features tested

       Decision: SUCCESS | ISSUES DETECTED | ROLLBACK

       Output: .aiwg/working/transition/post-deployment-validation.md
       """
   )
   ```

3. **Generate Deployment Report**:
   ```
   Task(
       subagent_type="deployment-manager",
       description="Create Production Deployment Report",
       prompt="""
       Read all deployment artifacts:
       - Deployment strategy
       - Pre-deployment checklist
       - Deployment execution log
       - Post-deployment validation

       Generate comprehensive deployment report:
       - Deployment strategy and rationale
       - Execution timeline
       - Validation results
       - Issues and resolutions
       - Deployment outcome: SUCCESS | PARTIAL SUCCESS | FAILED | ROLLED BACK
       - Next steps

       Output: .aiwg/deployment/production-deployment-report.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Executing production deployment...
  ✓ Pre-deployment checklist complete
  ✓ Deployment executed successfully
  ✓ Post-deployment validation: PASSED
✓ Production deployment: SUCCESS
```

### Step 4: Conduct User Training and UAT

**Purpose**: Train users and validate acceptance in production

**Your Actions**:

1. **Prepare Training Materials**:
   ```
   Task(
       subagent_type="training-lead",
       description="Prepare and validate training materials",
       prompt="""
       Create/validate training materials:
       - User guides (role-based)
       - Quick reference cards
       - Video tutorials (if needed)
       - Online help documentation
       - FAQs

       Ensure materials cover all user roles
       Validate accuracy against deployed system

       Output: .aiwg/working/transition/training-materials-status.md
       """
   )
   ```

2. **Deliver Training**:
   ```
   Task(
       subagent_type="training-lead",
       description="Coordinate user training delivery",
       prompt="""
       Plan and track training delivery:
       - Schedule instructor-led sessions
       - Set up hands-on practice environments
       - Deploy self-paced e-learning
       - Schedule office hours for Q&A

       Track participation and completion
       Gather feedback scores

       Output: .aiwg/working/transition/training-delivery-status.md
       """
   )
   ```

3. **Execute UAT**:
   ```
   Task(
       subagent_type="requirements-analyst",
       description="Coordinate User Acceptance Testing",
       prompt="""
       Read Product Acceptance Plan template

       Coordinate UAT execution:
       - Identify key users per role
       - Define UAT scenarios (10+ critical workflows)
       - Track scenario execution
       - Capture user feedback
       - Document issues found

       Calculate UAT metrics:
       - Pass rate (target: ≥90%)
       - User satisfaction (target: ≥4/5)
       - Critical issues found

       Output: .aiwg/working/transition/uat-results.md
       """
   )
   ```

4. **Generate Training and Acceptance Report**:
   ```
   Task(
       subagent_type="product-owner",
       description="Create User Training and Acceptance Report",
       prompt="""
       Synthesize training and UAT results:
       - Training completion rates
       - Knowledge check results
       - UAT pass rates
       - User satisfaction scores
       - User adoption metrics
       - Acceptance decision: ACCEPTED | CONDITIONAL | REJECTED

       Output: .aiwg/deployment/user-training-report.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Conducting user training and acceptance...
  ✓ Training materials prepared
  ✓ Training delivered (85% completion)
  ✓ UAT completed (92% pass rate)
  ✓ User satisfaction: 4.2/5
✓ User acceptance: ACCEPTED
```

### Step 5: Execute Support and Operations Handover

**Purpose**: Formally hand over to support and operations teams

**Your Actions**:

1. **Support Team Training**:
   ```
   Task(
       subagent_type="support-lead",
       description="Train and validate support team readiness",
       prompt="""
       Train support team on:
       - System architecture overview
       - Common user issues and resolutions
       - Runbook procedures
       - Incident escalation paths
       - Support tools and ticketing

       Validate readiness:
       - Practice incidents resolved (≥3)
       - Runbook effectiveness tested
       - Knowledge base populated

       Output: .aiwg/working/transition/support-training-status.md
       """
   )
   ```

2. **Operations Team Training**:
   ```
   Task(
       subagent_type="operations-lead",
       description="Train and validate operations team readiness",
       prompt="""
       Train operations team on:
       - Deployment procedures
       - Monitoring and alerting
       - Incident response
       - Backup and restore
       - Scaling procedures

       Validate readiness:
       - Independent deployment successful
       - Alert response tested
       - Backup/restore validated

       Output: .aiwg/working/transition/operations-training-status.md
       """
   )
   ```

3. **Formal Handover**:
   ```
   Task(
       subagent_type="deployment-manager",
       description="Coordinate formal handover",
       prompt="""
       Coordinate handover meetings:
       - Support handover meeting conducted
       - Operations handover meeting conducted
       - Known issues reviewed
       - Escalation procedures confirmed

       Obtain signoffs:
       - Support Lead signoff
       - Operations Lead signoff

       Document handover status:
       - Support: ACCEPTED | CONDITIONAL | NOT ACCEPTED
       - Operations: ACCEPTED | CONDITIONAL | NOT ACCEPTED

       Output: .aiwg/deployment/support-handover-report.md
       Output: .aiwg/deployment/operations-handover-report.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Executing support and operations handover...
  ✓ Support team trained and ready
  ✓ Operations team trained and ready
  ✓ Support Lead signoff: OBTAINED
  ✓ Operations Lead signoff: OBTAINED
✓ Handover complete: ACCEPTED
```

### Step 6: Enter Hypercare Period

**Purpose**: Conduct 7-14 days of intensive monitoring and rapid response

**Your Actions**:

1. **Initialize Hypercare Monitoring**:
   ```
   Task(
       subagent_type="reliability-engineer",
       description="Set up hypercare monitoring",
       prompt="""
       Initialize hypercare period:
       - Duration: 7-14 days (based on system criticality)
       - Monitoring intensity: ELEVATED
       - Response SLAs: ACCELERATED
       - Daily standup schedule: SET

       Define success criteria:
       - Zero P0/P1 incidents
       - Error rate <0.1%
       - Performance within SLA
       - User adoption on track

       Output: .aiwg/working/transition/hypercare-plan.md
       """
   )
   ```

2. **Daily Hypercare Monitoring** (repeat daily):
   ```
   Task(
       subagent_type="reliability-engineer",
       description="Daily hypercare monitoring report",
       prompt="""
       Monitor and report daily:

       Production Stability:
       - Incidents (P0/P1/P2/P3 counts)
       - Error rates and trends
       - Uptime percentage
       - Performance metrics (p50, p95, p99)

       User Adoption:
       - Active users (DAU/WAU)
       - Feature usage statistics
       - User feedback themes

       Support Effectiveness:
       - Ticket volume and categories
       - Resolution times (MTTR)
       - Escalations to development

       Decision: CONTINUE | EXTEND | CONCLUDE

       Output: .aiwg/reports/hypercare-day-{day}.md
       """
   )
   ```

3. **Hypercare Review** (Day 7 and Day 14):
   ```
   Task(
       subagent_type="deployment-manager",
       description="Hypercare period review",
       prompt="""
       Review hypercare metrics:
       - Production stability validated
       - User adoption on track
       - Support effectiveness confirmed
       - No critical issues outstanding

       Decision:
       - CONCLUDE hypercare (ready for PRM)
       - EXTEND hypercare (specify duration and criteria)
       - ISSUES DETECTED (return to remediation)

       Output: .aiwg/reports/hypercare-review.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Hypercare period (Day 1-14)...
  Day 1: ✓ Stable (0 incidents, 99.99% uptime)
  Day 3: ✓ Stable (1 P3 incident resolved)
  Day 7: ✓ Mid-review: CONTINUE
  Day 14: ✓ Final review: READY FOR PRM
✓ Hypercare complete: Production stable
```

### Step 7: Validate Product Release Milestone (PRM)

**Purpose**: Formal PRM review to decide project completion

**Your Actions**:

1. **Validate PRM Criteria**:
   ```
   Task(
       subagent_type="project-manager",
       description="Validate PRM gate criteria",
       prompt="""
       Read gate criteria: $AIWG_ROOT/.../flows/gate-criteria-by-phase.md (Transition section)

       Validate all PRM criteria:

       1. Production Deployment
          - [ ] Deployment successful and stable
          - [ ] Hypercare completed (7-14 days)

       2. Production Stability
          - [ ] Uptime meets SLA
          - [ ] Zero P0/P1 incidents
          - [ ] Performance within targets

       3. User Adoption
          - [ ] Users trained (≥80%)
          - [ ] UAT passed
          - [ ] User satisfaction ≥4/5
          - [ ] Active user adoption on track

       4. Support Handover
          - [ ] Support team operational
          - [ ] Support Lead signoff obtained

       5. Operations Handover
          - [ ] Operations team operational
          - [ ] Operations Lead signoff obtained

       6. Business Value
          - [ ] Success metrics tracking
          - [ ] ROI forecast positive

       Report status: PASS | CONDITIONAL PASS | FAIL

       Output: .aiwg/reports/prm-criteria-validation.md
       """
   )
   ```

2. **Generate PRM Report**:
   ```
   Task(
       subagent_type="project-manager",
       description="Generate Product Release Milestone Report",
       prompt="""
       Read all Transition artifacts:
       - Production deployment report
       - User training and acceptance reports
       - Support/Operations handover reports
       - Hypercare reports
       - PRM criteria validation

       Generate comprehensive PRM Report:

       1. Overall Status
          - PRM Status: PASS | CONDITIONAL PASS | FAIL
          - Decision: PROJECT COMPLETE | EXTENDED HYPERCARE | ISSUES DETECTED

       2. Criteria Validation (detailed breakdown)

       3. Signoff Checklist
          - [ ] Executive Sponsor
          - [ ] Product Owner
          - [ ] Deployment Manager
          - [ ] Support Lead
          - [ ] Operations Lead
          - [ ] Reliability Engineer

       4. Business Value Validation
          - Success metrics vs. baseline
          - ROI forecast
          - Stakeholder satisfaction

       5. Lessons Learned
          - What went well
          - What could improve
          - Action items

       6. Next Steps
          - Project closure activities
          - Transition to BAU

       Output: .aiwg/reports/prm-report.md
       """
   )
   ```

3. **Present PRM Summary to User**:
   ```
   # You present this directly (not via agent)

   Read .aiwg/reports/prm-report.md

   Present summary:
   ─────────────────────────────────────────────
   Product Release Milestone Review
   ─────────────────────────────────────────────

   **Overall Status**: {PASS | CONDITIONAL PASS | FAIL}
   **Decision**: {PROJECT COMPLETE | EXTENDED HYPERCARE | ISSUES DETECTED}

   **Criteria Status**:
   ✓ Production Deployment: PASS
     - Successfully deployed, 14 days stable

   ✓ Production Stability: PASS
     - Uptime: 99.97% (target: ≥99.9%)
     - P0/P1 Incidents: 0

   ✓ User Adoption: PASS
     - Users trained: 92% (target: ≥80%)
     - UAT passed: 95% scenarios
     - User satisfaction: 4.3/5

   ✓ Support Handover: PASS
     - Support team operational
     - MTTR: 2.5 hours (target: <4 hours)

   ✓ Operations Handover: PASS
     - Operations team validated
     - Independent deployment successful

   ✓ Business Value: ON TRACK
     - Early metrics positive
     - ROI forecast: Meeting projections

   **Artifacts Generated**:
   - Production Deployment Report (.aiwg/deployment/production-deployment-report.md)
   - User Training Report (.aiwg/deployment/user-training-report.md)
   - Support Handover Report (.aiwg/deployment/support-handover-report.md)
   - Operations Handover Report (.aiwg/deployment/operations-handover-report.md)
   - Hypercare Reports (.aiwg/reports/hypercare-day-*.md)
   - PRM Report (.aiwg/reports/prm-report.md)

   **Next Steps**:
   - Formal project closure
   - Transition to Business As Usual (BAU)
   - Team celebration and recognition
   - Final retrospective scheduled

   ─────────────────────────────────────────────
   ```

**Communicate Progress**:
```
⏳ Conducting PRM validation...
✓ PRM criteria validated: PASS (6/6 criteria met)
✓ PRM Report generated: .aiwg/reports/prm-report.md
✓ PROJECT COMPLETE - Ready for closure
```

## Quality Gates

Before marking workflow complete, verify:
- [ ] All required artifacts generated and BASELINED
- [ ] Production deployment successful and stable
- [ ] User acceptance validated
- [ ] Support/Operations handover accepted
- [ ] Hypercare period completed successfully
- [ ] PRM criteria validated: PASS or CONDITIONAL PASS

## User Communication

**At start**: Confirm understanding and list artifacts to generate

```
Understood. I'll orchestrate the Construction → Transition phase.

This will generate:
- Production Deployment Report
- User Training and Acceptance Reports
- Support and Operations Handover Reports
- Hypercare Daily Reports (7-14 days)
- PRM Report

I'll coordinate deployment, training, handover, and monitoring.
Expected duration: 20-30 minutes orchestration (2-4 weeks actual).

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

**If OCM Not Met**:
```
❌ Construction phase incomplete - cannot proceed to Transition

Gaps identified:
- {list missing artifacts or incomplete criteria}

Recommendation: Complete Construction first
- Run: /flow-elaboration-to-construction
- Or: Complete missing artifacts manually

Contact Product Owner for project status decision.
```

**If Deployment Failed**:
```
❌ Production deployment failed

Failure point: {deployment stage}
Error: {error description}

Actions:
1. Execute rollback plan
2. Investigate root cause
3. Fix issues in Construction
4. Re-plan deployment

Impact: Cannot proceed to user training until deployment successful.

Escalating to user for decision...
```

**If Production Unstable**:
```
⚠️ Production instability detected

Issues:
- P0/P1 Incidents: {count}
- Error rate: {percentage}%
- Performance degradation: {metrics}

Recommendation:
- Fix forward (hotfix) if minor
- Rollback if critical
- Extend hypercare period

Impact: PRM blocked until stability demonstrated.
```

**If Support Not Ready**:
```
⚠️ Support team not ready for handover

Gaps:
- {list training gaps or readiness issues}

Recommendation: Additional training required
- Schedule supplemental training
- Update runbooks
- Defer handover by {days} days

Impact: Cannot achieve PRM without support acceptance.
```

## Success Criteria

This orchestration succeeds when:
- [ ] Operational Capability Milestone validated (OCM complete)
- [ ] Production environment provisioned and validated
- [ ] Production deployment SUCCESSFUL and STABLE
- [ ] User training COMPLETE and UAT PASSED
- [ ] Support handover ACCEPTED (Support Lead signoff)
- [ ] Operations handover ACCEPTED (Operations Lead signoff)
- [ ] Hypercare period COMPLETED (7-14 days, no critical issues)
- [ ] Product Release Milestone achieved (PRM review passed)

## Metrics to Track

**During orchestration, track**:
- Production stability: Uptime %, incidents, error rate %
- User adoption: Active users, adoption rate %, satisfaction score
- Support effectiveness: Ticket volume, MTTR, escalations
- Business value: Success metrics vs. baseline, ROI forecast
- Deployment success rate: % of deployments without rollback

## References

**Templates** (via $AIWG_ROOT):
- Deployment Plan: `templates/deployment/deployment-plan-template.md`
- Release Notes: `templates/deployment/release-notes-template.md`
- Support Runbook: `templates/deployment/support-runbook-template.md`
- Product Acceptance Plan: `templates/deployment/product-acceptance-plan-template.md`
- Infrastructure Definition: `templates/deployment/infrastructure-definition-template.md`

**Gate Criteria**:
- `flows/gate-criteria-by-phase.md` (Transition section)

**Multi-Agent Pattern**:
- `docs/multi-agent-documentation-pattern.md`

**Orchestrator Architecture**:
- `docs/orchestrator-architecture.md`

**Natural Language Translations**:
- `docs/simple-language-translations.md`