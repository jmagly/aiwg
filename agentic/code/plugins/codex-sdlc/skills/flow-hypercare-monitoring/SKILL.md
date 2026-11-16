---
namespace: aiwg
name: flow-hypercare-monitoring
platforms: [all]
description: Orchestrate hypercare monitoring period with 24/7 support, SLO tracking, and rapid issue response
commandHint:
  argumentHint: '[hypercare-duration-days] [project-directory] [--guidance "text"] [--interactive]'
  allowedTools: 'Task, Read, Write, Glob, TodoWrite'
  model: sonnet
  category: sdlc-orchestration
  orchestration: true
  modelRole: coding
  modelTier: standard
---

> **Declarative Flow (#1539):** This flow's orchestration is now also expressed as a
> declarative YAML Flow at `flows/flow-hypercare-monitoring.playbook.yaml` (source of truth for the step
> sequence + gates). This SKILL.md remains the discoverable trigger surface and prose
> reference. See epic #1534.

# Hypercare Monitoring Flow

**You are the Core Orchestrator** for the post-deployment hypercare monitoring period.

## Your Role

**You orchestrate multi-agent workflows. You do NOT execute bash scripts.**

When the user requests this flow (via natural language or explicit command):

1. **Interpret the request** and confirm understanding
2. **Read this template** as your orchestration guide
3. **Extract agent assignments** and workflow steps
4. **Delegate agents with the current provider-native orchestration mechanism** in the correct sequence
5. **Synthesize results** and finalize artifacts
6. **Report completion** with summary

## Hypercare Overview

**Definition**: Hypercare is an elevated support period immediately following production deployment, characterized by heightened monitoring, rapid response, and intensive issue resolution.

**Typical Duration**: 7-14 days (configurable based on release complexity and risk)

**Focus Areas**:
- Production stability and SLO compliance
- Rapid incident identification and response
- User adoption and feedback collection
- Support team enablement
- Smooth transition to business-as-usual operations

**Exit Criteria**:
- Zero P0 (Critical) incidents in last 48 hours
- Zero P1 (High) incidents in last 24 hours
- All SLOs met for 72 consecutive hours
- User adoption metrics trending positive
- Support team ready for standard operations
- Hypercare report complete and approved

**Expected Duration**: 7-14 days (typical), 20-30 minutes orchestration

## Natural Language Triggers

Users may say:
- "Start hypercare"
- "Begin hypercare period"
- "Post-launch monitoring"
- "24/7 support period"
- "Activate hypercare monitoring"
- "Launch post-deployment support"

You recognize these as requests for this orchestration flow.

## Parameter Handling

### Hypercare Duration Parameter

**Purpose**: Specify hypercare period length

**Examples**:
```
/flow-hypercare-monitoring 7 .
/flow-hypercare-monitoring 14 .
```

**Default**: 7 days (low-risk deployments), 14 days (high-risk deployments)

### --guidance Parameter

**Purpose**: User provides upfront direction to tailor hypercare priorities

**Examples**:
```
--guidance "Focus on security monitoring, financial transaction integrity critical"
--guidance "Performance is key, sub-200ms p95 response time SLO"
--guidance "First production launch, team needs extra support and documentation"
--guidance "High-traffic deployment, anticipate 100K daily active users"
```

**How to Apply**:
- Parse guidance for keywords: security, performance, compliance, scale, team experience
- Adjust agent assignments (add security-gatekeeper, performance-engineer for specific focuses)
- Modify monitoring depth (lightweight vs comprehensive based on complexity)
- Influence priority ordering (stability vs. adoption focus)

### --interactive Parameter

**Purpose**: You ask 5-8 strategic questions to understand project context

**Questions to Ask** (if --interactive):

```
I'll ask 8 strategic questions to tailor hypercare to your needs:

Q1: What are your top priorities for hypercare?
    (e.g., stability validation, user adoption, performance monitoring)

Q2: What's the deployment risk level?
    (Helps determine monitoring intensity and duration)

Q3: What are your critical SLOs?
    (Availability, response time, error rate targets)

Q4: What's your expected user volume?
    (Helps set alert thresholds and capacity monitoring)

Q5: What's your support team's experience level?
    (Influences runbook detail and escalation paths)

Q6: What are your biggest concerns about this deployment?
    (These become focus areas for monitoring and validation)

Q7: Are there regulatory or compliance requirements?
    (e.g., HIPAA, SOC2, PCI-DSS - affects audit logging and security monitoring)

Q8: What's your incident response capability?
    (24/7 on-call? Business hours? Helps plan escalation and response)

Based on your answers, I'll adjust:
- Monitoring intensity (alert thresholds, dashboard focus)
- Agent assignments (add specialized monitoring agents)
- Exit criteria strictness (standard vs. elevated)
- Support team guidance level (detailed runbooks vs. minimal)
```

**Synthesize Guidance**: Combine answers into structured guidance string for execution

## Artifacts to Generate

**Primary Deliverables**:
- **Hypercare Team Roster**: Roles, on-call rotation, contacts → `.aiwg/deployment/hypercare-team-roster.md`
- **Production Health Dashboard**: Real-time monitoring config → `.aiwg/deployment/production-dashboard-config.md`
- **Alert Escalation Matrix**: Severity definitions and response SLAs → `.aiwg/deployment/alert-escalation-matrix.md`
- **Daily Hypercare Standups**: Status reports (daily) → `.aiwg/deployment/hypercare-standup-{YYYY-MM-DD}.md`
- **Incident Response Logs**: All P0/P1 incidents → `.aiwg/deployment/incidents/incident-{ID}.md`
- **Risk Retirement Report**: Validation evidence → `.aiwg/risks/hypercare-risk-validation.md`
- **Hypercare Exit Report**: Final status and transition plan → `.aiwg/reports/hypercare-exit-report.md`

**Supporting Artifacts**:
- SLO tracking logs (hourly updates)
- User adoption metrics (daily updates)
- Support ticket analysis (daily summary)
- Post-incident reviews (PIRs) for all P0/P1
- Corrective action tracker

## Multi-Agent Orchestration Workflow

### Step 1: Establish Hypercare Team and Schedule

**Purpose**: Create dedicated support structure with clear ownership and 24/7 coverage

**Your Actions**:

1. **Read Deployment Context**:
   ```
   Read:
   - .aiwg/deployment/operational-readiness-review.md (team assignments, contacts)
   - .aiwg/deployment/slo-sli-definition.md (SLO targets, monitoring approach)
   - .aiwg/deployment/incident-response-runbook.md (escalation paths)
   ```

2. **Launch Hypercare Planning Agents** (parallel):
   ```
   # Agent 1: Operations Manager
   Task(
       subagent_type="operations-manager",
       description="Create hypercare team roster and on-call rotation",
       prompt="""
       Read ORR team assignments and contacts

       Create Hypercare Team Roster:

       ## Core Team
       - Hypercare Lead: {name} (overall coordination, daily standups)
       - On-Call Engineers: {rotation-schedule} (24/7 coverage)
       - Reliability Engineer: {name} (SLO monitoring, performance analysis)
       - Support Lead: {name} (user-facing issues, ticket triage)
       - DevOps Engineer: {name} (rapid deployment, rollback authority)

       ## Extended Team
       - Product Owner: {name} (prioritization, user impact)
       - Security Gatekeeper: {name} (security incidents)
       - Component Owners: {list by component}

       Create 24/7 On-Call Rotation ({duration} days):
       - Primary on-call schedule (8-hour shifts or daily rotation)
       - Backup on-call contacts
       - Escalation path (P0/P1/P2/P3 response procedures)

       Schedule Daily Standups:
       - Time: {suggest optimal time}
       - Duration: 30 minutes
       - Attendees: Core team (mandatory), Extended team (optional)

       Save to: .aiwg/deployment/hypercare-team-roster.md
       """
   )

   # Agent 2: Reliability Engineer
   Task(
       subagent_type="reliability-engineer",
       description="Configure production monitoring and alerting",
       prompt="""
       Read SLO/SLI definitions

       Configure Production Health Dashboard:

       ## Key Metrics (Auto-Refresh: 30s)

       **Availability**
       - Current Uptime: {percentage}% (Target: ≥99.9%)
       - Service Health: {GREEN | YELLOW | RED}
       - Failed Health Checks: {count}

       **Performance (Last 5 min)**
       - Response Time (p50/p95/p99): {value}ms
       - Throughput: {requests-per-second} req/s
       - Target: p95 < {SLA}ms

       **Errors (Last 5 min)**
       - Error Rate: {percentage}% (Target: <0.1%)
       - 4xx/5xx Errors: {count}
       - Database Errors: {count}

       **Business Metrics**
       - Active Users (Current): {count}
       - Successful Transactions: {count}
       - Transaction Success Rate: {percentage}%

       **Infrastructure**
       - CPU/Memory Utilization: {percentage}%
       - Disk I/O, Network Traffic

       Define alert thresholds for P0/P1/P2/P3 severity levels

       Save to: .aiwg/deployment/production-dashboard-config.md
       """
   )

   # Agent 3: Support Lead
   Task(
       subagent_type="support-lead",
       description="Define alert escalation and incident response",
       prompt="""
       Read incident response runbook

       Create Alert Escalation Matrix:

       ## P0 (Critical) - Page Immediately
       - Availability <99%
       - Error rate >1%
       - All instances down
       - Security breach detected

       Action: Page on-call engineer + Hypercare Lead
       Response SLA: Immediate acknowledgment, 15 min time-to-engage

       ## P1 (High) - Alert Within 5 Minutes
       - Availability <99.5%
       - Error rate >0.5%
       - Response time p95 >2x SLA

       Action: Alert on-call engineer via Slack + SMS
       Response SLA: 30 min acknowledgment, 1 hour time-to-mitigation

       ## P2 (Medium) - Alert Within 30 Minutes
       - Availability <99.9%
       - Error rate >0.1%
       - Resource utilization >80%

       Action: Alert on-call engineer via Slack
       Response SLA: 4 hours

       ## P3 (Low) - Log and Review
       - Minor performance degradation
       - Non-critical errors

       Action: Create ticket for review
       Response SLA: 1 business day

       Document incident response workflow (5 phases):
       1. Detection (Target: <5 min)
       2. Triage (Target: <15 min)
       3. Investigation (P0=30min, P1=1h)
       4. Mitigation (P0=1h, P1=4h)
       5. Resolution (P0=2h, P1=8h)
       6. Post-Incident Review (Within 48h)

       Save to: .aiwg/deployment/alert-escalation-matrix.md
       """
   )
   ```

3. **Synthesize Hypercare Setup Plan**:
   ```
   # You do this directly (no agent needed)

   Read all hypercare planning artifacts

   Validate completeness:
   - Team roster: All roles assigned?
   - On-call rotation: 24/7 coverage confirmed?
   - Monitoring: All SLOs tracked?
   - Escalation: Response SLAs defined?

   Create dedicated communication channel: #hypercare-{project-name}-{YYYY-MM}
   ```

**Communicate Progress**:
```
✓ Initialized hypercare setup
⏳ Establishing hypercare team and monitoring...
  ✓ Hypercare team roster created (Core + Extended teams)
  ✓ 24/7 on-call rotation scheduled ({duration} days)
  ✓ Production dashboard configured (5 metric categories)
  ✓ Alert escalation matrix defined (P0/P1/P2/P3)
✓ Hypercare infrastructure ready: .aiwg/deployment/
```

### Step 2: Monitor Production Stability and SLOs (Daily)

**Purpose**: Continuously validate production system meets SLO targets and stability expectations

**Your Actions**:

1. **Launch SLO Monitoring Agents** (automated, repeat daily):
   ```
   # Agent 1: Reliability Engineer (Daily SLO Report)
   Task(
       subagent_type="reliability-engineer",
       description="Generate daily SLO compliance report",
       prompt="""
       Read production metrics from monitoring dashboard
       Read SLO definitions: .aiwg/deployment/slo-sli-definition.md

       Generate Daily SLO Report:

       ## SLO Tracking (Updated Hourly)

       ### Availability SLO
       - Target: ≥99.9% uptime
       - Current (24h): {percentage}%
       - Current (7d): {percentage}%
       - Error Budget Remaining: {percentage}%
       - Status: {ON TARGET | AT RISK | EXCEEDED}

       ### Performance SLO
       - Target: p95 response time <{value}ms
       - Current p95 (24h): {value}ms
       - Current p95 (7d): {value}ms
       - Status: {ON TARGET | AT RISK | EXCEEDED}

       ### Error Rate SLO
       - Target: <0.1% error rate
       - Current (24h): {percentage}%
       - Current (7d): {percentage}%
       - Status: {ON TARGET | AT RISK | EXCEEDED}

       ### Throughput SLO
       - Target: Handle {value} req/s
       - Current Peak: {value} req/s
       - Current Average: {value} req/s
       - Status: {ON TARGET | AT RISK | EXCEEDED}

       Calculate Error Budget Burn Rate:
       - Monthly error budget: {value} minutes downtime allowed
       - Hypercare period budget: {value} minutes
       - Current burn rate: {value} minutes consumed
       - Budget remaining: {percentage}%
       - Assessment: {HEALTHY | MONITOR | CRITICAL}

       If CRITICAL: Recommend incident freeze, focus on stability
       If MONITOR: Recommend increased monitoring, defer risky changes

       Save to: .aiwg/deployment/slo-report-{YYYY-MM-DD}.md
       """
   )

   # Agent 2: Support Lead (Daily Support Analysis)
   Task(
       subagent_type="support-lead",
       description="Analyze user adoption and support tickets",
       prompt="""
       Read support ticket system
       Read user analytics

       Generate User Adoption Dashboard:

       ### Active Users
       - DAU (Daily Active Users): {count} (Target: >{target})
       - WAU/MAU: {count}
       - User Growth Rate: {+/-percentage}%

       ### Feature Adoption (New Features)
       For each new feature:
       - Total Users: {count}
       - Users Engaged: {count} ({percentage}%)
       - Adoption Rate: {percentage}% (Target: >{target}%)
       - Trend: {INCREASING | STABLE | DECREASING}

       ### Support Ticket Analysis
       - Total Tickets (24h): {count}
       - By Category: Bug Reports, How-To, Performance, etc.
       - Critical Issues: {count} (blockers)
       - Average Response Time: {value}h (Target: <{SLA}h)

       ### User Feedback Summary
       - Sentiment: {POSITIVE | NEUTRAL | NEGATIVE} ({percentage}%)
       - Top Issues: {list top 3}
       - Top Praises: {list top 3}

       Flag Critical User Blockers (if any)

       Save to: .aiwg/deployment/user-adoption-{YYYY-MM-DD}.md
       """
   )
   ```

2. **Incident Tracking** (on-demand per incident):
   ```
   # When incident detected:
   Task(
       subagent_type="devops-engineer",
       description="Document and respond to incident {incident-ID}",
       prompt="""
       Incident detected: {incident-description}
       Severity: {P0 | P1 | P2 | P3}

       Follow Incident Response Workflow:

       1. Detection (<5 min):
          - Alert acknowledged
          - Initial severity assessment
          - Create incident channel: #incident-{YYYY-MM-DD}-{ID}

       2. Triage (<15 min):
          - Gather evidence (logs, metrics, user reports)
          - Identify affected systems/users
          - Estimate business impact
          - Engage Component Owners
          - Update severity if needed

       3. Investigation (P0=30min, P1=1h):
          - Review logs/metrics for root cause
          - Check recent deployments/changes
          - Reproduce in non-prod if possible
          - Identify probable root cause

       4. Mitigation (P0=1h, P1=4h):
          - Execute mitigation (rollback/hotfix/config change)
          - Validate effectiveness
          - Monitor for regression

       5. Resolution (P0=2h, P1=8h):
          - Confirm fully resolved
          - Validate SLOs back to normal
          - Close incident

       Document incident timeline and actions

       Save to: .aiwg/deployment/incidents/incident-{ID}.md

       If P0/P1: Schedule post-incident review within 48h
       """
   )
   ```

**Communicate Progress** (daily update):
```
✓ Hypercare Day {N} of {duration}
⏳ Monitoring production stability...
  ✓ SLO compliance: {percentage}% of SLOs met (target: 100%)
  ✓ Incidents (24h): {count} total (P0: {count}, P1: {count}, P2: {count})
  ✓ User adoption: {percentage}% ({trend})
  ✓ Support tickets: {count} (Trend: {↑/→/↓})
✓ Daily reports: .aiwg/deployment/slo-report-{date}.md, user-adoption-{date}.md
```

### Step 3: Conduct Daily Hypercare Standups

**Purpose**: Maintain team alignment, surface issues early, coordinate rapid response

**Your Actions**:

1. **Generate Daily Standup Report** (automated):
   ```
   Task(
       subagent_type="operations-manager",
       description="Generate daily hypercare standup report",
       prompt="""
       Read daily reports:
       - .aiwg/deployment/slo-report-{YYYY-MM-DD}.md
       - .aiwg/deployment/user-adoption-{YYYY-MM-DD}.md
       - .aiwg/deployment/incidents/* (all open/recent incidents)

       Create Daily Standup Agenda:

       ## Hypercare Daily Standup - Day {N} of {duration}

       **Date**: {YYYY-MM-DD}
       **Facilitator**: {Hypercare Lead}

       ### 1. Production Health Review (5 min)
       **Presented by**: Reliability Engineer

       - Availability: {percentage}% (Target: ≥99.9%) - {STATUS}
       - Performance: p95 {value}ms (Target: <{SLA}ms) - {STATUS}
       - Error Rate: {percentage}% (Target: <0.1%) - {STATUS}
       - Error Budget: {percentage}% remaining - {STATUS}

       Overall Health: {GREEN | YELLOW | RED}

       ### 2. Incident Summary (Last 24h) (10 min)
       **Presented by**: On-Call Engineer

       Total Incidents: {count}
       - P0 (Critical): {count} - {list titles if any}
       - P1 (High): {count} - {list titles if any}
       - P2 (Medium): {count}
       - P3 (Low): {count}

       Key Incidents:
       For each P0/P1:
       - Incident-ID: {title}
       - Status: {Open/Resolved/Closed}
       - Impact: {user-count} users, {duration} minutes
       - Root Cause: {brief description}
       - Action Items: {list}

       Patterns/Trends: {emerging issues or recurring problems}

       ### 3. User Feedback Review (5 min)
       **Presented by**: Support Lead

       - Support Tickets (24h): {count} (Trend: {↑/→/↓})
       - Critical User Issues: {count}
       - Top Complaints: {list top 3}
       - Top Praises: {list top 3}
       - Sentiment: {POSITIVE | NEUTRAL | NEGATIVE}

       Blockers for Users: {list critical issues}

       ### 4. SLO/SLI Status (5 min)
       **Presented by**: Reliability Engineer

       | SLO | Target | Current (24h) | Status |
       |-----|--------|---------------|--------|
       | Availability | ≥99.9% | {percentage}% | {✓/⚠/✗} |
       | Response Time | p95<{value}ms | {value}ms | {✓/⚠/✗} |
       | Error Rate | <0.1% | {percentage}% | {✓/⚠/✗} |
       | Throughput | >{value} req/s | {value} req/s | {✓/⚠/✗} |

       ### 5. Action Items and Blockers (5 min)

       Open Action Items:
       | Action | Owner | Due Date | Status |
       |--------|-------|----------|--------|
       {list open actions}

       New Blockers:
       {list blockers requiring escalation}

       Tomorrow's On-Call: {name} (taking over at {HH:MM})

       ---

       Overall Status: {GREEN | YELLOW | RED}

       Key Decisions Made:
       {list decisions from standup}

       New Action Items:
       {list new actions assigned}

       Save to: .aiwg/deployment/hypercare-standup-{YYYY-MM-DD}.md
       """
   )
   ```

2. **Weekly Summary** (if hypercare > 7 days):
   ```
   # On Day 7, 14, etc.:
   Task(
       subagent_type="operations-manager",
       description="Generate weekly hypercare summary",
       prompt="""
       Read all daily standups for week: .aiwg/deployment/hypercare-standup-*.md

       Create Weekly Summary:

       ## Hypercare Week {N} Summary

       **Week**: {date-range}
       **Overall Status**: {GREEN | YELLOW | RED}

       ### Production Stability
       - Availability: {percentage}% (Target: ≥99.9%)
       - Total Incidents: {count} (P0: {count}, P1: {count})
       - MTTR: {value} min
       - SLO Compliance: {percentage}%

       ### User Adoption
       - Active Users: {count} ({+/-percentage}% vs. previous week)
       - Feature Adoption: {percentage}%
       - User Sentiment: {POSITIVE | NEUTRAL | NEGATIVE}

       ### Support Health
       - Support Tickets: {count} ({+/-percentage}% vs. previous week)
       - Critical Issues: {count}
       - Response Time: {value}h (Target: <{SLA}h)

       ### Accomplishments
       {list accomplishments}

       ### Challenges
       {list challenges}

       ### Next Week Focus
       {list focus areas}

       Save to: .aiwg/reports/hypercare-week-{N}-summary.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Conducting daily standup...
✓ Daily standup report generated: .aiwg/deployment/hypercare-standup-{date}.md
  - Overall Health: {GREEN | YELLOW | RED}
  - Key Decisions: {count}
  - New Action Items: {count}
  - Escalations: {count}
```

### Step 4: Post-Incident Reviews (For P0/P1 Incidents)

**Purpose**: Document root cause and corrective actions for all critical incidents

**Your Actions**:

1. **For Each P0/P1 Incident** (within 48h of resolution):
   ```
   Task(
       subagent_type="reliability-engineer",
       description="Conduct post-incident review for {incident-ID}",
       prompt="""
       Read incident log: .aiwg/deployment/incidents/incident-{ID}.md

       Create Post-Incident Review (PIR):

       ## Post-Incident Review: {Incident-ID}

       **Date**: {YYYY-MM-DD}
       **Severity**: {P0/P1/P2/P3}
       **Duration**: {detection-to-resolution}
       **Impact**: {user-count} users, {downtime-minutes} minutes downtime

       ### Incident Summary
       {1-2 sentence description of what happened}

       ### Timeline
       | Time | Event | Actor |
       |------|-------|-------|
       {incident timeline from detection to resolution}

       ### Root Cause
       {Detailed technical root cause analysis}

       ### Contributing Factors
       1. {Factor 1 - e.g., insufficient testing}
       2. {Factor 2 - e.g., monitoring gap}
       3. {Factor 3 - e.g., unclear runbook}

       ### Corrective Actions
       | Action | Owner | Due Date | Status |
       |--------|-------|----------|--------|
       {list corrective actions to prevent recurrence}

       ### Lessons Learned
       - What went well: {list}
       - What could improve: {list}
       - Process changes needed: {list}

       Save to: .aiwg/deployment/incidents/pir-{ID}.md

       Update incident log with PIR link
       Track corrective actions in action tracker
       """
   )
   ```

**Communicate Progress**:
```
⏳ Conducting post-incident reviews...
✓ PIR complete: Incident-{ID} ({title})
  - Root cause: {summary}
  - Corrective actions: {count} assigned
  - Status: Tracking to completion
```

### Step 5: Validate Exit Criteria and Generate Hypercare Report

**Purpose**: Ensure production is stable and support team is ready before ending hypercare

**Your Actions**:

1. **Validate Exit Criteria** (on final day or when user requests):
   ```
   Task(
       subagent_type="operations-manager",
       description="Validate hypercare exit criteria",
       prompt="""
       Read all hypercare artifacts

       Validate Hypercare Exit Criteria:

       ## Hypercare Exit Criteria Validation

       **Hypercare Period**: Day {N} of {duration}
       **Validation Date**: {YYYY-MM-DD}

       ### Production Stability
       - [ ] Zero P0 (Critical) incidents in last 48 hours
       - [ ] Zero P1 (High) incidents in last 24 hours
       - [ ] All SLOs met for 72 consecutive hours
         - [ ] Availability ≥99.9%
         - [ ] Response time p95 <{SLA}ms
         - [ ] Error rate <0.1%
         - [ ] Throughput >{target} req/s
       - [ ] Error budget healthy: >{percentage}% remaining
       - [ ] No open P0/P1 incidents

       ### User Adoption
       - [ ] User adoption trending positive ({percentage}% growth)
       - [ ] Feature adoption >{target}% for critical features
       - [ ] User sentiment majority positive (≥70%)
       - [ ] Support ticket volume stable or decreasing
       - [ ] No critical user blockers unresolved

       ### Support Readiness
       - [ ] Support team trained and confident
       - [ ] Runbooks validated (all common issues documented)
       - [ ] Escalation paths tested and effective
       - [ ] Knowledge base updated with hypercare learnings
       - [ ] On-call rotation transitioned to standard support

       ### Documentation Complete
       - [ ] Hypercare report completed
       - [ ] Post-incident reviews completed (all P0/P1)
       - [ ] Corrective actions tracked (assigned, due dates set)
       - [ ] Lessons learned documented
       - [ ] Runbooks updated

       Overall Exit Criteria Status: {PASS | CONDITIONAL | FAIL}
       Decision: {END HYPERCARE | EXTEND HYPERCARE | ESCALATE}

       Save to: .aiwg/reports/hypercare-exit-criteria.md
       """
   )
   ```

2. **Generate Hypercare Exit Report** (comprehensive final report):
   ```
   Task(
       subagent_type="operations-manager",
       description="Generate comprehensive hypercare exit report",
       prompt="""
       Read all hypercare artifacts:
       - .aiwg/deployment/hypercare-team-roster.md
       - .aiwg/deployment/slo-report-*.md (all days)
       - .aiwg/deployment/user-adoption-*.md (all days)
       - .aiwg/deployment/hypercare-standup-*.md (all days)
       - .aiwg/deployment/incidents/*.md (all incidents)
       - .aiwg/reports/hypercare-exit-criteria.md

       Generate Hypercare Exit Report:

       # Hypercare Report: {Project-Name}

       **Hypercare Period**: {start-date} to {end-date} ({duration} days)
       **Report Date**: {YYYY-MM-DD}
       **Report Author**: {Hypercare Lead}

       ## Executive Summary

       {2-3 sentence summary of hypercare outcomes}

       Overall Status: {SUCCESS | SUCCESS WITH CONDITIONS | CHALLENGES}

       Key Metrics:
       - Availability: {percentage}%
       - Total Incidents: {count} (P0: {count}, P1: {count})
       - User Adoption: {percentage}%
       - Support Tickets: {count}

       ## Production Stability Summary

       ### SLO Performance
       | SLO | Target | Achieved | Status |
       |-----|--------|----------|--------|
       {SLO compliance table}

       SLO Compliance Rate: {percentage}%

       ### Incident Summary
       Total Incidents: {count}
       - P0 (Critical): {count}
       - P1 (High): {count}
       - P2 (Medium): {count}
       - P3 (Low): {count}

       Key Metrics:
       - MTTD (Mean Time to Detect): {value} min
       - MTTA (Mean Time to Acknowledge): {value} min
       - MTTR (Mean Time to Resolve): {value} min

       Major Incidents:
       For each P0/P1:
       - Incident-ID: {title}
         - Date, Duration, Impact, Root Cause, Resolution
         - Corrective Actions: {count} assigned

       ### Performance Trends
       - Response Time: {IMPROVED | STABLE | DEGRADED} ({+/-percentage}% vs. pre-deployment)
       - Error Rate: {IMPROVED | STABLE | DEGRADED}
       - Resource Utilization: {HEALTHY | CONCERNING}

       ## User Adoption Summary

       ### Adoption Metrics
       - Active Users: {count} ({+/-percentage}% vs. pre-deployment)
       - Feature Adoption: {percentage}% (Target: >{target}%)
       - User Retention (Day 14): {percentage}%

       ### User Feedback
       - Total Feedback Items: {count}
       - Sentiment: {percentage}% positive
       - Net Promoter Score: {value}

       Top Praises: {list top 3}
       Top Complaints: {list top 3 with resolution status}

       ## Support Summary

       ### Ticket Volume
       - Total Support Tickets: {count}
       - Daily Average: {count} tickets/day
       - Trend: {DECREASING | STABLE | INCREASING}

       ### Support Performance
       - Average Response Time: {value}h (Target: <{SLA}h) - {✓/⚠/✗}
       - First Contact Resolution: {percentage}%

       ### Support Team Readiness
       - Team Confidence Level: {HIGH | MEDIUM | LOW}
       - Runbook Completeness: {percentage}%

       ## Lessons Learned

       ### What Went Well
       {list successes}

       ### What Could Improve
       {list improvements}

       ### Process Recommendations
       {list recommendations for future deployments}

       ## Corrective Actions

       Total Actions Identified: {count}

       | Action | Category | Owner | Due Date | Status |
       |--------|----------|-------|----------|--------|
       {corrective actions table}

       ## Handover to Standard Support

       ### Transition Plan
       - [ ] Standard on-call rotation activated (starting {date})
       - [ ] Support runbooks transferred
       - [ ] Knowledge base published
       - [ ] Support team training complete
       - [ ] Escalation paths updated for BAU

       ### Post-Hypercare Monitoring
       - Duration: {duration} days continued close monitoring
       - Responsible: {Support Lead}
       - Review Cadence: Weekly check-ins for {duration} weeks

       ## Conclusion

       {2-3 sentence summary and readiness for standard support}

       Recommendation: {END HYPERCARE | EXTEND HYPERCARE}

       Signoff:
       - Hypercare Lead: {name} - {date}
       - Reliability Engineer: {name} - {date}
       - Support Lead: {name} - {date}
       - Product Owner: {name} - {date}
       - Project Manager: {name} - {date}

       Save to: .aiwg/reports/hypercare-exit-report.md
       """
   )
   ```

3. **Present Exit Summary to User**:
   ```
   # You present this directly (not via agent)

   Read .aiwg/reports/hypercare-exit-report.md

   Present summary:
   ─────────────────────────────────────────────
   Hypercare Monitoring Period Complete
   ─────────────────────────────────────────────

   **Hypercare Period**: {start-date} to {end-date} ({duration} days)
   **Overall Status**: {SUCCESS | SUCCESS WITH CONDITIONS | CHALLENGES}

   **Key Metrics**:
   ✓ Availability: {percentage}% (Target: ≥99.9%)
   ✓ Total Incidents: {count} (P0: {count}, P1: {count})
   ✓ User Adoption: {percentage}% of target
   ✓ Support Readiness: Team confident and ready

   **Exit Criteria Status**:
   ✓ Production Stability: {PASS | CONDITIONAL | FAIL}
   ✓ User Adoption: {PASS | CONDITIONAL | FAIL}
   ✓ Support Readiness: {PASS | CONDITIONAL | FAIL}
   ✓ Documentation: {PASS | CONDITIONAL | FAIL}

   **Decision**: {END HYPERCARE | EXTEND HYPERCARE | ESCALATE}

   **Artifacts Generated**:
   - Hypercare Team Roster (.aiwg/deployment/hypercare-team-roster.md)
   - Production Dashboard Config (.aiwg/deployment/production-dashboard-config.md)
   - Alert Escalation Matrix (.aiwg/deployment/alert-escalation-matrix.md)
   - Daily Standup Reports (.aiwg/deployment/hypercare-standup-*.md, {count} files)
   - SLO Reports (.aiwg/deployment/slo-report-*.md, {count} files)
   - User Adoption Reports (.aiwg/deployment/user-adoption-*.md, {count} files)
   - Incident Logs (.aiwg/deployment/incidents/*.md, {count} files)
   - Post-Incident Reviews (.aiwg/deployment/incidents/pir-*.md, {count} files)
   - Hypercare Exit Report (.aiwg/reports/hypercare-exit-report.md)

   **Next Steps**:
   - Review hypercare exit report with stakeholders
   - Obtain formal signoffs (5 required signatures)
   - If END HYPERCARE: Transition to standard support (run handoff workflow)
   - If EXTEND HYPERCARE: Address gaps, continue monitoring
   - If ESCALATE: Executive decision required

   **Transition to Standard Support**:
   - Standard on-call rotation activated: {date}
   - Continued monitoring period: {duration} days
   - Weekly check-ins scheduled

   ─────────────────────────────────────────────
   ```

**Communicate Progress**:
```
⏳ Validating hypercare exit criteria...
✓ Exit criteria validated: {PASS | CONDITIONAL | FAIL}
✓ Hypercare Exit Report generated: .aiwg/reports/hypercare-exit-report.md
✓ Transition plan documented
```

## Quality Gates

Before marking workflow complete, verify:
- [ ] Hypercare team established with 24/7 coverage
- [ ] Production monitoring operational (dashboards, alerts)
- [ ] Daily standups conducted and documented
- [ ] All P0/P1 incidents have post-incident reviews
- [ ] SLO compliance tracked daily
- [ ] User adoption monitored and reported
- [ ] Exit criteria validated
- [ ] Hypercare exit report complete and approved
- [ ] Transition to standard support planned

## User Communication

**At start**: Confirm understanding and list activities

```
Understood. I'll orchestrate the hypercare monitoring period.

Hypercare Duration: {duration} days
Hypercare Period: {start-date} to {estimated-end-date}

This will establish:
- Hypercare team roster and 24/7 on-call rotation
- Production health monitoring dashboards
- Alert escalation and incident response procedures
- Daily standup coordination
- SLO tracking and user adoption monitoring
- Post-incident review process
- Hypercare exit criteria validation

I'll coordinate multiple agents for comprehensive monitoring and support.
Expected setup: 20-30 minutes.

Starting orchestration...
```

**During**: Update progress with clear indicators

```
✓ = Complete
⏳ = In progress
❌ = Error/blocked
⚠️ = Warning/attention needed
```

**Daily**: Provide daily status summary

```
Hypercare Day {N} of {duration}: {GREEN | YELLOW | RED}

Production Health:
✓ Availability: {percentage}% (Target: ≥99.9%)
✓ Performance: p95 {value}ms (Target: <{SLA}ms)
{⚠️ | ✓} Error Rate: {percentage}% (Target: <0.1%)

Incidents (24h):
- P0: {count}
- P1: {count}
- P2: {count}

User Adoption: {percentage}% ({trend})

Daily reports: .aiwg/deployment/hypercare-standup-{date}.md
```

**At end**: Summary report (see Step 5.3 above)

## Error Handling

**If P0 Incident During Hypercare**:
```
❌ Critical incident detected - immediate response initiated

Incident: {incident-ID} - {title}
Severity: P0 (Complete outage / Data loss / Security breach)
Impact: {user-count} users affected

Actions:
1. On-call engineer + Hypercare Lead paged
2. Incident war room created: #incident-{date}-{ID}
3. Executive Sponsor notified
4. Status page updated

Response Timeline:
- Detection: {timestamp}
- Acknowledgment: {timestamp} (Target: Immediate)
- Time-to-engage: {minutes} min (Target: <15 min)

Current Status: {INVESTIGATING | MITIGATING | RESOLVED}

Impact on Exit Criteria: P0 incident resets 48h "zero critical incidents" requirement

Monitoring incident response...
```

**If SLO Breach**:
```
⚠️ SLO breach detected - immediate investigation required

SLO Breached: {SLO-name}
- Target: {target-value}
- Current: {actual-value}
- Duration: {duration} (continuous breach)

Impact:
- Error budget consumed: {percentage}%
- User impact: {description}

Actions:
1. Reliability Engineer investigating root cause
2. Metrics and logs under review
3. Mitigation plan in progress

If breach persists >24h: Recommend extending hypercare period
If error budget critically low: Recommend incident freeze

Monitoring for improvement...
```

**If User Adoption Low**:
```
⚠️ User adoption below target

Current Adoption: {percentage}% (Target: >{target}%)
Gap: {percentage} points

Analysis:
- Top User Issues: {list issues}
- Support Ticket Themes: {list themes}
- Potential Blockers: {list blockers}

Actions:
1. Product Owner engaged for adoption analysis
2. Support team reviewing common user issues
3. Documentation and training gaps identified

Decision Point:
- If blockers identified: Prioritize fixes, may extend hypercare
- If education needed: Launch awareness campaign
- If feature not valuable: Escalate to stakeholders

Impact on Exit Criteria: User adoption trend must improve before exit approval
```

**If Support Team Overwhelmed**:
```
⚠️ Support team capacity exceeded

Support Volume: {count} tickets/day (Capacity: {capacity})
Team Status: {STRESSED | OVERWHELMED}

Root Cause Analysis:
- Top Issue Categories: {list categories with counts}
- Product Bugs vs User Education: {ratio}

Immediate Relief Actions:
1. Additional support staff brought in (temp)
2. Engineering team handling overflow tickets
3. Workarounds created for top issues
4. FAQ and self-service guides published

Mitigation:
- Deploy hotfixes for high-frequency bugs
- Update documentation for common questions
- Additional training sessions scheduled

Impact on Exit Criteria: Support team must be confident and staffed before exit
```

**If Exit Criteria Not Met**:
```
⚠️ Hypercare exit criteria not met - extension recommended

Exit Criteria Status: {FAIL | CONDITIONAL}

Gaps Identified:
{list unmet criteria with details}

Recommendation: {EXTEND HYPERCARE | CONDITIONAL EXIT | ESCALATE}

Extension Plan:
- Additional Duration: {days} days
- Focus Areas: {list areas needing improvement}
- Re-validation Date: {date}

Escalating to user for decision...
```

## Success Criteria

This orchestration succeeds when:
- [ ] Hypercare team established with 24/7 coverage
- [ ] Production monitoring operational (dashboards, alerts, SLO tracking)
- [ ] Daily standups conducted for entire hypercare period
- [ ] All incidents documented and P0/P1 incidents have PIRs
- [ ] SLO compliance ≥95% (all SLOs met for 72+ consecutive hours)
- [ ] Zero P0/P1 incidents in final 48/24 hours
- [ ] User adoption trending positive (≥target%)
- [ ] Support team ready and confident
- [ ] Exit criteria validated: PASS or CONDITIONAL PASS
- [ ] Hypercare exit report complete and approved
- [ ] Transition to standard support planned and executed

## Metrics to Track

**During orchestration, track**:
- SLO compliance rate: % of SLOs met (target: 100% for 72h before exit)
- Incident frequency: # of P0/P1/P2/P3 incidents (target: P0/P1 = 0 in final 48/24h)
- Mean time to detect (MTTD): Minutes from incident to detection (target: <5 min)
- Mean time to resolve (MTTR): Minutes from detection to resolution (target: P0 <120 min, P1 <480 min)
- Error budget burn rate: % of monthly budget consumed (target: <50% during hypercare)
- User adoption rate: % of target users actively engaged (target: ≥70%)
- Support ticket volume: # of tickets/day (target: decreasing trend)
- Support response time: Hours to first response (target: <SLA)

## References

**Templates** (via $AIWG_ROOT):
- Operational Readiness Review: `agentic/code/frameworks/sdlc-complete/templates/reliability/operational-readiness-review-template.md`
- SLO/SLI Definition: `agentic/code/frameworks/sdlc-complete/templates/reliability/slo-sli-template.md`
- Incident Response Runbook: `agentic/code/frameworks/sdlc-complete/templates/deployment/support-runbook-template.md`
- Support Plan: `agentic/code/frameworks/sdlc-complete/templates/deployment/support-runbook-template.md`

**Related Flows**:
- Gate Check: `commands/flow-gate-check.md`
- Handoff Checklist: `commands/flow-handoff-checklist.md`
- Deployment Workflow: `commands/flow-deployment-workflow.md`

**SDLC Phase Context**:
- Phase: Transition (Deployment → Operations)
- Milestone: Hypercare Complete (transition to BAU support)
