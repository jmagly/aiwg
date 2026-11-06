---
namespace: aiwg
name: flow-cross-team-sync
platforms: [all]
description: Orchestrate cross-team synchronization with dependency mapping, sync cadence, blocker escalation, integration planning, and cross-team demos
commandHint:
  argumentHint: '[team-a] [team-b] [sync-frequency] [--guidance "text"] [--interactive]'
  allowedTools: 'Task, Read, Write, Glob, TodoWrite'
  model: sonnet
  category: sdlc-orchestration
  orchestration: true
  modelRole: coding
  modelTier: standard
---

> **Declarative Flow (#1539):** This flow's orchestration is now also expressed as a
> declarative YAML Flow at `flows/flow-cross-team-sync.playbook.yaml` (source of truth for the step
> sequence + gates). This SKILL.md remains the discoverable trigger surface and prose
> reference. See epic #1534.

# Cross-Team Synchronization Flow

**You are the Core Orchestrator** for cross-team coordination and integration alignment.

## Your Role

**You orchestrate multi-agent workflows. You do NOT execute bash scripts.**

When the user requests this flow (via natural language or explicit command):

1. **Interpret the request** and confirm understanding
2. **Read this template** as your orchestration guide
3. **Extract agent assignments** and workflow steps
4. **Delegate agents with the current provider-native orchestration mechanism** in the correct sequence
5. **Synthesize results** and finalize artifacts
6. **Report completion** with summary

## Cross-Team Sync Overview

**Purpose**: Orchestrate synchronization, dependency management, and integration planning across multiple teams working on interconnected systems.

**Key Activities**:
- Dependency mapping (team-to-team dependencies)
- Sync cadence establishment (daily, weekly)
- Blocker escalation
- Integration planning
- Cross-team demos and validation

**Expected Duration**: Initial setup 2-3 hours, ongoing syncs 1 hour weekly, orchestration 20-30 minutes

## Natural Language Triggers

Users may say:
- "Sync with {team}"
- "Coordinate teams"
- "Cross-team sync"
- "Team alignment meeting"
- "Set up team coordination"
- "Map team dependencies"
- "Establish team sync cadence"
- "Resolve cross-team blockers"

You recognize these as requests for this orchestration flow.

## Parameter Handling

### Team Parameters

**Primary inputs**:
- `team-a`: First team name (required)
- `team-b`: Second team name (required)
- `sync-frequency`: Optional frequency (weekly, bi-weekly, default: weekly)

### --guidance Parameter

**Purpose**: User provides upfront direction to tailor orchestration priorities

**Examples**:
```
--guidance "High API dependencies, need tight integration coordination"
--guidance "Teams in different time zones, prefer async communication"
--guidance "Critical launch deadline, daily sync needed for next 2 weeks"
--guidance "New teams, need extra focus on knowledge sharing and patterns"
```

**How to Apply**:
- Parse guidance for keywords: integration, timezone, deadline, knowledge
- Adjust sync frequency (daily for critical periods)
- Modify meeting structure (async-friendly for timezone issues)
- Add knowledge sharing emphasis (for new teams)

### --interactive Parameter

**Purpose**: You ask 6 strategic questions to understand team dynamics

**Questions to Ask** (if --interactive):

```
I'll ask 6 strategic questions to tailor cross-team synchronization:

Q1: What are the main integration points between teams?
    (e.g., APIs, shared databases, event streams, UI components)

Q2: How critical are the dependencies?
    (Helps determine sync frequency and escalation urgency)

Q3: What's the current blocker resolution time?
    (Helps set appropriate SLAs and escalation paths)

Q4: What are the teams' time zones and availability?
    (Influences meeting scheduling and async strategies)

Q5: What's your timeline pressure?
    (Daily sync for critical periods vs. weekly for normal pace)

Q6: What collaboration tools do teams use?
    (Slack, Teams, Jira, GitHub - affects communication setup)

Based on your answers, I'll adjust:
- Sync frequency (daily, weekly, bi-weekly)
- Meeting structure (sync vs. async emphasis)
- Escalation paths (SLAs and ownership)
- Knowledge sharing approach
```

**Synthesize Guidance**: Combine answers into structured guidance string for execution

## Artifacts to Generate

**Primary Deliverables**:
- **Dependency Map**: Component ownership and integration points → `.aiwg/team/dependency-map-{team-a}-{team-b}.md`
- **Integration Contracts**: API specifications and change protocol → `.aiwg/team/integration-contracts/`
- **Sync Meeting Agenda**: Structured meeting template → `.aiwg/team/sync-agenda-{team-a}-{team-b}.md`
- **Blocker Tracker**: Active blockers with SLAs → `.aiwg/team/blocker-tracker.md`
- **Escalation Matrix**: Clear escalation paths → `.aiwg/team/escalation-matrix.md`
- **Cross-Team Sync Report**: Health metrics and recommendations → `.aiwg/reports/cross-team-sync-report.md`

**Supporting Artifacts**:
- Meeting notes archive
- Demo recordings/summaries
- Reusable patterns documentation

## Multi-Agent Orchestration Workflow

### Step 1: Dependency Mapping and Integration Points

**Purpose**: Identify components owned by each team and map dependencies

**Your Actions**:

1. **Gather Context**:
   ```
   Read existing artifacts if present:
   - .aiwg/architecture/software-architecture-doc.md
   - .aiwg/requirements/use-case-*.md
   - Any existing team documentation
   ```

2. **Launch Dependency Analysis Agents** (parallel):
   ```
   # Agent 1: System Analyst - Component Analysis
   Task(
       subagent_type="system-analyst",
       description="Map component ownership and dependencies",
       prompt="""
       Analyze architecture and identify:

       For Team A ({team-a}):
       - Components owned
       - Services maintained
       - Data stores managed
       - External dependencies

       For Team B ({team-b}):
       - Components owned
       - Services maintained
       - Data stores managed
       - External dependencies

       Map dependencies:
       - Team A → Team B dependencies
       - Team B → Team A dependencies
       - Shared resources
       - External system touchpoints

       Classify each dependency:
       - Type: API, Database, Event Stream, File System
       - Criticality: BLOCKING, NON-BLOCKING
       - Status: ACTIVE, PLANNED, DEPRECATED

       Create dependency matrix showing all relationships.

       Output: .aiwg/working/team/dependency-analysis-draft.md
       """
   )

   # Agent 2: Integration Engineer - Technical Integration
   Task(
       subagent_type="integration-engineer",
       description="Define integration points and contracts",
       prompt="""
       Based on component analysis, define integration points:

       For each integration point:
       1. Integration ID and name
       2. Type (REST API, GraphQL, Event Stream, Database)
       3. Owner team
       4. Consumer team(s)
       5. Criticality (BLOCKING vs NON-BLOCKING)
       6. Current status (STABLE, IN_DEVELOPMENT, PLANNED)

       Define integration contracts:
       - API endpoints and methods
       - Data schemas
       - Error handling
       - Rate limits and SLAs
       - Authentication/authorization

       Document change protocol:
       - Breaking vs non-breaking changes
       - Notice period required
       - Version support policy
       - Migration requirements

       Output: .aiwg/working/team/integration-points-draft.md
       """
   )
   ```

3. **Synthesize Dependency Map**:
   ```
   Task(
       subagent_type="documentation-synthesizer",
       description="Create unified dependency map",
       prompt="""
       Read drafts:
       - .aiwg/working/team/dependency-analysis-draft.md
       - .aiwg/working/team/integration-points-draft.md

       Create comprehensive Dependency Map including:

       1. Component Ownership
          - Team A components with descriptions
          - Team B components with descriptions

       2. Dependency Matrix
          - Team A → Team B dependencies table
          - Team B → Team A dependencies table
          - Criticality and status for each

       3. Integration Points Detail
          - Detailed specifications for each IP
          - SLAs and performance requirements
          - Change management protocol

       4. Critical Path Dependencies
          - Dependencies that block progress
          - Impact analysis if not resolved

       5. Dependency Risks
          - Risk assessment table
          - Mitigation strategies

       Use clear tables and structured format.

       Output: .aiwg/team/dependency-map-{team-a}-{team-b}.md
       """
   )
   ```

**Communicate Progress**:
```
✓ Initialized dependency mapping
⏳ Analyzing team components and dependencies...
✓ Dependency map complete: .aiwg/team/dependency-map-{team-a}-{team-b}.md
```

### Step 2: Establish Sync Cadence and Meeting Structure

**Purpose**: Define structured sync meetings with clear agenda and attendees

**Your Actions**:

1. **Launch Meeting Planning Agent**:
   ```
   Task(
       subagent_type="project-manager",
       description="Establish cross-team sync structure",
       prompt="""
       Create sync meeting structure for {team-a} and {team-b}

       Frequency: {sync-frequency} (weekly/bi-weekly/daily)

       Define:
       1. Meeting cadence and duration
       2. Mandatory attendees from each team
       3. Optional attendees
       4. Meeting roles (facilitator, note-taker)

       Create standing agenda with time boxes:
       1. Blockers and Escalations (15 min)
       2. Integration Status (15 min)
       3. Roadmap Alignment (15 min)
       4. Knowledge Sharing (10 min)
       5. Action Items Review (5 min)

       Define async communication:
       - Slack/Teams channels
       - Shared documentation location
       - Escalation channels

       Include guidelines for:
       - When to sync vs async
       - How to prepare for meetings
       - Meeting notes storage

       Output: .aiwg/team/sync-agenda-{team-a}-{team-b}.md
       """
   )
   ```

2. **Create Meeting Template**:
   ```
   Task(
       subagent_type="scrum-master",
       description="Create reusable meeting notes template",
       prompt="""
       Create meeting notes template for recurring syncs:

       Include sections for:
       - Date and attendees
       - Blockers discussed
       - Integration updates
       - Roadmap changes
       - Demo/knowledge shared
       - Action items with owners and dates
       - Parking lot items

       Make it easy to copy/paste for each meeting.

       Output: .aiwg/team/meeting-notes-template.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Establishing sync cadence...
✓ Sync structure defined: {sync-frequency} meetings
✓ Meeting agenda created: .aiwg/team/sync-agenda-{team-a}-{team-b}.md
```

### Step 3: Blocker Tracking and Escalation Setup

**Purpose**: Create blocker tracking system with clear SLAs and escalation paths

**Your Actions**:

1. **Launch Blocker Management Agents** (parallel):
   ```
   # Agent 1: Project Manager - Blocker System
   Task(
       subagent_type="project-manager",
       description="Create blocker tracking system",
       prompt="""
       Design blocker tracking system:

       1. Blocker Severity Levels
          - P0 (Critical): Work stopped, no workaround
          - P1 (High): Workaround exists but suboptimal
          - P2 (Medium): Minor impact, can work on other items
          - P3 (Low): Nice to have, no immediate impact

       2. SLAs by Severity
          - P0: Resolve within 2 business days
          - P1: Resolve within 1 week
          - P2: Resolve within 2 weeks
          - P3: Best effort

       3. Tracking Fields
          - ID, Severity, Blocked Team, Blocking Team
          - Description, Owner, Opened Date, Age
          - Due Date, Status, Resolution

       4. Status Values
          - NEW, IN_PROGRESS, ESCALATED, RESOLVED, CLOSED

       Create initial blocker tracker with example entries.

       Output: .aiwg/team/blocker-tracker.md
       """
   )

   # Agent 2: Agile Coach - Escalation Matrix
   Task(
       subagent_type="agile-coach",
       description="Define escalation paths",
       prompt="""
       Create escalation matrix:

       1. Escalation Triggers
          - Age-based (blocker open too long)
          - Severity-based (P0/P1 immediate escalation)
          - Impact-based (affecting multiple teams)

       2. Escalation Levels
          - Level 1: Tech Leads
          - Level 2: Engineering Managers
          - Level 3: Directors
          - Level 4: VPs/Executives

       3. Escalation Actions
          - Who to notify
          - Meeting to schedule
          - Communication required
          - Decision authority

       4. Response SLAs
          - How quickly escalation must be acknowledged
          - Resolution timeline after escalation

       Create clear escalation flowchart.

       Output: .aiwg/team/escalation-matrix.md
       """
   )
   ```

2. **Create Blocker Resolution Process**:
   ```
   Task(
       subagent_type="scrum-master",
       description="Document blocker resolution workflow",
       prompt="""
       Define end-to-end blocker resolution process:

       1. Identification
          - How blockers are identified
          - Who can raise blockers
          - Where to log them

       2. Assignment
          - How owners are assigned
          - Default ownership rules
          - Handoff process

       3. Resolution
          - Daily standup updates
          - Status tracking
          - Workaround documentation

       4. Closure
          - Verification steps
          - Retrospective for patterns
          - Process improvements

       Include example scenarios.

       Output: .aiwg/team/blocker-resolution-process.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Setting up blocker management...
✓ Blocker tracker created with SLAs
✓ Escalation matrix defined: .aiwg/team/escalation-matrix.md
```

### Step 4: Integration Planning and API Contracts

**Purpose**: Document API contracts and establish change management protocol

**Your Actions**:

1. **Launch API Contract Documentation** (for each integration point):
   ```
   # For each major integration point identified in Step 1
   Task(
       subagent_type="api-designer",
       description="Create API contract for {integration-point}",
       prompt="""
       Create detailed API contract:

       Integration Point: {integration-point}
       Owner: {owner-team}
       Consumer: {consumer-team}

       Document:
       1. API Specification
          - OpenAPI 3.0 format preferred
          - Endpoints, methods, parameters
          - Request/response schemas
          - Error responses

       2. Performance SLA
          - Response time targets (p50, p95, p99)
          - Throughput limits
          - Rate limiting rules

       3. Security
          - Authentication method
          - Authorization rules
          - Data encryption requirements

       4. Versioning Strategy
          - URL versioning (/v1/, /v2/)
          - Header versioning
          - Deprecation timeline

       5. Change Protocol
          - Breaking vs non-breaking changes
          - Notice period (2 sprints for breaking)
          - Migration support period

       Output: .aiwg/team/integration-contracts/api-{integration-point}.yaml
       """
   )
   ```

2. **Create Change Management Protocol**:
   ```
   Task(
       subagent_type="architecture-designer",
       description="Define API change management protocol",
       prompt="""
       Create comprehensive change management protocol:

       1. Change Categories
          - Additive (non-breaking): New endpoints, optional fields
          - Evolving (backward compatible): Deprecations with warnings
          - Breaking: Removing fields, changing types

       2. Process by Category
          - Additive: Deploy anytime with notice
          - Evolving: 1 sprint notice, 3 sprint deprecation
          - Breaking: 2 sprint notice, new version required

       3. Communication Requirements
          - Where to announce changes
          - Documentation updates required
          - Consumer notification process

       4. Version Support Policy
          - How many versions supported simultaneously
          - Sunset timeline for old versions
          - Migration assistance provided

       5. Testing Requirements
          - Contract testing in CI/CD
          - Consumer testing coordination
          - Rollback procedures

       Output: .aiwg/team/api-change-protocol.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Documenting integration contracts...
✓ API contracts created: {count} integration points
✓ Change management protocol established
```

### Step 5: Cross-Team Knowledge Sharing

**Purpose**: Facilitate demos, pattern sharing, and cross-pollination of ideas

**Your Actions**:

1. **Setup Knowledge Sharing Framework**:
   ```
   Task(
       subagent_type="technical-lead",
       description="Create knowledge sharing structure",
       prompt="""
       Design knowledge sharing framework:

       1. Demo Cadence
          - Monthly cross-team demos
          - 60 minutes duration
          - Recording for async viewing

       2. Demo Structure
          - Team A: 25 minutes
          - Team B: 25 minutes
          - Open discussion: 10 minutes

       3. Knowledge Topics
          - Integration patterns that worked
          - Performance optimizations
          - Debugging techniques
          - Testing strategies
          - Tooling improvements
          - Incident learnings

       4. Documentation
          - Shared patterns library
          - Reusable code snippets
          - Best practices guide

       5. Collaboration Opportunities
          - Pair programming sessions
          - Architecture reviews
          - Code reviews across teams

       Create demo agenda template and knowledge base structure.

       Output: .aiwg/team/knowledge-sharing-framework.md
       """
   )
   ```

2. **Create Initial Demo Schedule**:
   ```
   Task(
       subagent_type="program-manager",
       description="Schedule first cross-team demo",
       prompt="""
       Plan first cross-team demo:

       1. Proposed Date/Time
          - Within next 2 weeks
          - Consider team time zones

       2. Initial Topics
          - Team A: {suggested topics based on recent work}
          - Team B: {suggested topics based on recent work}

       3. Attendee List
          - Mandatory: Tech leads, architects
          - Optional: All team members
          - Guests: Other interested teams

       4. Preparation Checklist
          - Demo environment setup
          - Slides/materials preparation
          - Recording setup

       Create calendar invite template.

       Output: .aiwg/team/first-demo-plan.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Setting up knowledge sharing...
✓ Knowledge sharing framework created
✓ First demo scheduled: {date}
```

### Step 6: Generate Cross-Team Sync Status Report

**Purpose**: Compile comprehensive status report with health metrics

**Your Actions**:

1. **Launch Report Generation**:
   ```
   Task(
       subagent_type="project-manager",
       description="Generate cross-team sync status report",
       prompt="""
       Read all generated artifacts:
       - .aiwg/team/dependency-map-{team-a}-{team-b}.md
       - .aiwg/team/sync-agenda-{team-a}-{team-b}.md
       - .aiwg/team/blocker-tracker.md
       - .aiwg/team/escalation-matrix.md
       - .aiwg/team/integration-contracts/*.yaml
       - .aiwg/team/knowledge-sharing-framework.md

       Generate comprehensive status report:

       1. Executive Summary
          - Teams involved
          - Sync frequency established
          - Key dependencies identified
          - Current health status

       2. Dependency Analysis
          - Total dependencies: {count}
          - Critical (blocking): {count}
          - Documented with contracts: {percentage}%
          - Integration test coverage: {percentage}%

       3. Blocker Status
          - Active blockers: {count}
          - Average resolution time: {days}
          - Escalations this period: {count}

       4. Sync Meeting Health
          - Attendance rate: {percentage}%
          - Action items completion: {percentage}%
          - Meeting effectiveness score

       5. Integration Health
          - API contract coverage: {percentage}%
          - Breaking changes planned: {count}
          - Integration test pass rate: {percentage}%

       6. Knowledge Sharing
          - Demos conducted: {count}
          - Patterns documented: {count}
          - Cross-team code reviews: {count}

       7. Risks and Recommendations
          - Top risks identified
          - Recommended actions
          - Process improvements

       8. Next Steps
          - Immediate actions (this week)
          - Short-term (next sprint)
          - Long-term (next quarter)

       Output: .aiwg/reports/cross-team-sync-report.md
       """
   )
   ```

2. **Present Summary to User**:
   ```
   # You present this directly

   Read .aiwg/reports/cross-team-sync-report.md

   Present summary:
   ─────────────────────────────────────────────
   Cross-Team Synchronization Setup Complete
   ─────────────────────────────────────────────

   **Teams**: {team-a} ↔ {team-b}
   **Sync Frequency**: {weekly | bi-weekly | daily}
   **Status**: OPERATIONAL

   **Dependencies Mapped**:
   ✓ Total dependencies: {count}
   ✓ Critical/Blocking: {count}
   ✓ Integration points documented: {count}

   **Sync Structure Established**:
   ✓ Meeting cadence: {frequency}
   ✓ Agenda template created
   ✓ Mandatory attendees identified
   ✓ Async channels defined

   **Blocker Management**:
   ✓ Tracking system: ACTIVE
   ✓ Severity levels: P0-P3 defined
   ✓ SLAs established
   ✓ Escalation matrix: 4 levels

   **Integration Planning**:
   ✓ API contracts: {count} documented
   ✓ Change protocol: DEFINED
   ✓ Version strategy: ESTABLISHED

   **Knowledge Sharing**:
   ✓ Demo schedule: Monthly
   ✓ First demo: {date}
   ✓ Pattern library: INITIATED

   **Artifacts Generated**:
   - Dependency Map (.aiwg/team/dependency-map-{team-a}-{team-b}.md)
   - Sync Agenda (.aiwg/team/sync-agenda-{team-a}-{team-b}.md)
   - Blocker Tracker (.aiwg/team/blocker-tracker.md)
   - Escalation Matrix (.aiwg/team/escalation-matrix.md)
   - Integration Contracts (.aiwg/team/integration-contracts/)
   - Knowledge Framework (.aiwg/team/knowledge-sharing-framework.md)
   - Status Report (.aiwg/reports/cross-team-sync-report.md)

   **Immediate Actions**:
   1. Schedule first sync meeting
   2. Share dependency map with both teams
   3. Train teams on blocker tracking process
   4. Review and sign off on API contracts

   **Recommendations**:
   - Start with weekly sync, adjust based on needs
   - Focus first meetings on critical blockers
   - Document patterns from first demo
   - Review sync effectiveness after 4 weeks

   ─────────────────────────────────────────────
   ```

**Communicate Progress**:
```
⏳ Generating status report...
✓ Cross-team sync report complete: .aiwg/reports/cross-team-sync-report.md
```

## Quality Gates

Before marking workflow complete, verify:
- [ ] Dependency map comprehensive and accurate
- [ ] All integration points have documented contracts
- [ ] Sync meeting structure agreed by both teams
- [ ] Blocker tracking system operational
- [ ] Escalation paths clear and communicated
- [ ] Knowledge sharing framework established
- [ ] First meetings/demos scheduled

## User Communication

**At start**: Confirm understanding and list deliverables

```
Understood. I'll orchestrate cross-team synchronization between {team-a} and {team-b}.

This will establish:
- Dependency mapping and integration points
- Sync meeting cadence ({frequency})
- Blocker tracking with escalation
- API contracts and change protocol
- Knowledge sharing framework

Expected duration: 20-30 minutes.

Starting orchestration...
```

**During**: Update progress with clear indicators

```
✓ = Complete
⏳ = In progress
❌ = Error/blocked
⚠️ = Warning/attention needed
```

**At end**: Summary report with status and next steps (see Step 6.2 above)

## Error Handling

**Teams Not Found**:
```
❌ Team not found in project roster

Teams specified: {team-a}, {team-b}
Missing: {team-name}

Action: Verify team names or add to project roster
Command: /team-roster add {team-name}
```

**No Architecture Available**:
```
⚠️ No architecture documentation found

Cannot automatically map dependencies without:
- Software Architecture Document
- Component diagrams
- Service definitions

Recommendation: Conduct manual dependency mapping workshop
Alternative: Create architecture first with /flow-inception-to-elaboration
```

**Time Zone Conflict**:
```
⚠️ Significant time zone difference detected

Team A: {timezone-1}
Team B: {timezone-2}
Overlap: {hours} hours

Recommendations:
1. Emphasize async communication
2. Rotate meeting times
3. Record all sync meetings
4. Use written updates heavily
```

**High Blocker Volume**:
```
⚠️ High blocker volume detected

Active blockers: {count} (threshold: 10)
P0/P1 blockers: {count}

Recommendations:
1. Increase sync frequency to daily
2. Dedicated blocker resolution session
3. Executive escalation for resource allocation
4. Consider team reorganization
```

## Success Criteria

This orchestration succeeds when:
- [ ] Dependencies fully mapped with criticality
- [ ] Integration points documented with contracts
- [ ] Sync cadence established and agreed
- [ ] First sync meeting scheduled
- [ ] Blocker tracking operational
- [ ] Escalation paths defined and communicated
- [ ] Knowledge sharing framework in place
- [ ] Both teams trained on processes

## Metrics to Track

**During orchestration, track**:
- Dependency coverage: % of components analyzed
- Integration documentation: % with contracts
- Blocker age: Average days open
- Meeting attendance: % of required attendees
- Knowledge sharing: Patterns documented

**Ongoing metrics** (post-setup):
- Blocker resolution velocity
- Integration stability (breaking changes)
- Meeting effectiveness scores
- Cross-team collaboration index
- Knowledge reuse rate

## Common Failure Modes

### Dependency Drift
**Symptoms**: Teams unaware of each other's changes, integration breaks
**Remediation**:
1. Enforce change notification protocol
2. Increase sync frequency
3. Add pre-integration testing gate
4. Review and update dependency map quarterly

### Meeting Fatigue
**Symptoms**: Attendance drops, meetings feel unproductive
**Remediation**:
1. Reduce frequency if dependencies stable
2. Shorten meeting duration
3. Focus on blockers only, move other topics async
4. Rotate facilitator to share ownership

### Blocker Stagnation
**Symptoms**: Blockers remain unresolved for weeks
**Remediation**:
1. Escalate immediately per escalation matrix
2. Assign dedicated resources
3. Executive intervention if needed
4. Consider architectural changes to reduce dependencies

### API Contract Violations
**Symptoms**: Breaking changes deployed without notice
**Remediation**:
1. Implement contract testing in CI/CD
2. Enforce change management protocol
3. Post-mortem on violation
4. Improve contract governance

### One-Way Communication
**Symptoms**: One team dominates sync, other team passive
**Remediation**:
1. Rotate meeting facilitator between teams
2. Require equal time allocation
3. Use structured agenda strictly
4. Private check-in with passive team

## References

**Templates** (via $AIWG_ROOT):
- Dependency Map: `agentic/code/frameworks/sdlc-complete/templates/management/dependency-card.md`
- Integration Contract: `agentic/code/frameworks/sdlc-complete/templates/analysis-design/interface-contract-card.md`
- Blocker Card: blocker fields in this skill
- Escalation Matrix: `agentic/code/frameworks/sdlc-complete/templates/governance/escalation-matrix-template.md`
- Sync Agenda: sync agenda in this skill
- Demo Agenda: demo agenda in this skill

**Related Flows**:
- `flow-risk-management-cycle.md` (for dependency risks)
- `flow-architecture-evolution.md` (for integration architecture)
- `flow-change-control.md` (for API changes)

**Multi-Agent Patterns**:
- `docs/multi-agent-coordination-pattern.md`
- `docs/orchestrator-architecture.md`