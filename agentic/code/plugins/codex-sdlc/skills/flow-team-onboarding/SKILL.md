---
namespace: aiwg
name: flow-team-onboarding
platforms: [all]
description: Orchestrate Team Onboarding flow with pre-boarding, training, buddy assignment, and 30/60/90 day check-ins
commandHint:
  argumentHint: <team-member-name> [role] [start-date] [--guidance "text"] [--interactive]
  allowedTools: Task, Read, Write, Glob, TodoWrite
  model: sonnet
  category: sdlc-orchestration
  orchestration: true
  modelRole: coding
  modelTier: standard
---

> **Declarative Flow (#1539):** This flow's orchestration is now also expressed as a
> declarative YAML Flow at `flows/flow-team-onboarding.playbook.yaml` (source of truth for the step
> sequence + gates). This SKILL.md remains the discoverable trigger surface and prose
> reference. See epic #1534.

# Team Onboarding Flow

**You are the Core Orchestrator** for team member onboarding, ensuring systematic integration with proper knowledge transfer and milestone-based progression.

## Your Role

**You orchestrate multi-agent workflows. You do NOT execute bash scripts.**

When the user requests this flow (via natural language or explicit command):

1. **Interpret the request** and confirm understanding
2. **Read this template** as your orchestration guide
3. **Extract agent assignments** and workflow steps
4. **Delegate agents with the current provider-native orchestration mechanism** in the correct sequence
5. **Synthesize results** and track progress
6. **Report completion** with onboarding status

## Onboarding Process Overview

**Purpose**: Systematically integrate new team members with structured ramp-up, knowledge transfer, and milestone-based validation

**Duration**: 90 days (30/60/90 day milestones)

**Success Criteria**:
- Pre-boarding checklist 100% complete by start date
- Buddy assigned with pairing cadence established
- 30/60/90 day milestones achieved on schedule
- Full productivity reached by day 90
- Onboarding feedback collected for process improvement

## Natural Language Triggers

Users may say:
- "Onboard [name] as [role]"
- "Add team member [name]"
- "New team member [name] starting [date]"
- "Onboard new developer"
- "Add [name] to the team"

You recognize these as requests for this orchestration flow.

## Parameter Handling

### --guidance Parameter

**Purpose**: User provides upfront direction to tailor onboarding focus

**Examples**:
```
--guidance "Technical architect role, focus on security and infrastructure"
--guidance "Junior developer, needs extra mentorship and pairing"
--guidance "Remote team member in different timezone, coordinate async"
--guidance "Fast-track onboarding for urgent project needs"
```

**How to Apply**:
- Parse guidance for role specifics (seniority, domain focus)
- Adjust buddy assignment (match expertise areas)
- Modify training intensity (junior vs senior needs)
- Adapt communication approach (remote vs local)

### --interactive Parameter

**Purpose**: You ask 6 strategic questions to understand onboarding needs

**Questions to Ask** (if --interactive):

```
I'll ask 6 strategic questions to tailor this onboarding flow:

Q1: What are your top priorities for this new team member?
    (e.g., specific skills, project ownership, team collaboration)

Q2: What are your biggest constraints for onboarding?
    (e.g., timeline, buddy availability, remote coordination)

Q3: What risks concern you most for this onboarding?
    (e.g., skill gaps, team fit, ramp-up speed)

Q4: What's your team's experience level with onboarding?
    (helps calibrate support level and documentation needs)

Q5: What's your target timeline for full productivity?
    (typical: 90 days, urgent: 30-60 days)

Q6: Are there compliance or security clearance requirements?
    (e.g., background checks, training certifications)

Based on your answers, I'll adjust:
- Buddy selection and pairing intensity
- Training schedule and focus areas
- Milestone targets and check-in frequency
- Documentation and access requirements
```

**Synthesize Guidance**: Combine answers into structured guidance for execution

## Artifacts to Generate

**Primary Deliverables**:
- **Pre-Boarding Checklist**: System access, equipment, documentation → `.aiwg/team/onboarding/{name}/pre-boarding-checklist.md`
- **Onboarding Plan**: Personalized 90-day plan → `.aiwg/team/onboarding/{name}/onboarding-plan.md`
- **Buddy Assignment**: Buddy responsibilities and schedule → `.aiwg/team/onboarding/{name}/buddy-assignment.md`
- **Starter Tasks**: Sequenced tasks with acceptance criteria → `.aiwg/team/onboarding/{name}/starter-tasks.md`
- **30-Day Check-In Report**: Milestone review → `.aiwg/team/onboarding/{name}/30-day-checkin.md`
- **60-Day Check-In Report**: Performance assessment → `.aiwg/team/onboarding/{name}/60-day-checkin.md`
- **90-Day Check-In Report**: Full integration validation → `.aiwg/team/onboarding/{name}/90-day-checkin.md`
- **Onboarding Status Report**: Current progress tracker → `.aiwg/reports/onboarding-status-{name}.md`

**Supporting Artifacts**:
- Training schedule and materials
- Knowledge transfer documentation
- Feedback collection forms

## Multi-Agent Orchestration Workflow

### Step 1: Pre-Boarding Preparation

**Purpose**: Ensure all systems, equipment, and documentation ready before start date

**Your Actions**:

1. **Initialize Onboarding Workspace**:
   ```
   Create directory structure:
   .aiwg/team/onboarding/{name}/
   ├── pre-boarding/
   ├── training/
   ├── check-ins/
   └── feedback/
   ```

2. **Launch Pre-Boarding Agents** (parallel):
   ```
   # Agent 1: HR Coordinator
   Task(
       subagent_type="human-resources-coordinator",
       description="Prepare pre-boarding checklist and paperwork",
       prompt="""
       Create pre-boarding checklist for new team member:
       - Name: {name}
       - Role: {role}
       - Start Date: {start-date}

       Document requirements:
       1. System Access
          - [ ] Git repository access (read/write)
          - [ ] CI/CD pipeline access
          - [ ] Issue tracker account
          - [ ] Monitoring/logging tools
          - [ ] Communication channels (Slack, email lists)
          - [ ] VPN credentials
          - [ ] SSO/MFA setup

       2. Equipment
          - [ ] Laptop provisioned with OS and dev tools
          - [ ] Monitor(s) and peripherals
          - [ ] Security badge/access card

       3. Documentation
          - [ ] Project README and CLAUDE.md
          - [ ] Architecture documentation
          - [ ] Runbooks and procedures
          - [ ] Team conventions

       4. First Day Logistics
          - [ ] Welcome email with agenda
          - [ ] Meeting invites sent
          - [ ] Workspace prepared

       Output: .aiwg/team/onboarding/{name}/pre-boarding-checklist.md
       """
   )

   # Agent 2: Operations Liaison
   Task(
       subagent_type="operations-liaison",
       description="Request system access and equipment",
       prompt="""
       Process technical onboarding requirements:

       1. Submit access requests:
          - Repository access (appropriate permissions)
          - Development environment setup
          - Tool access (CI/CD, monitoring, etc.)
          - Security clearances if needed

       2. Order equipment:
          - Development laptop (specs for role)
          - Peripherals (monitors, keyboard, mouse)
          - Mobile devices if required

       3. Prepare credentials document:
          - Initial passwords (secure delivery)
          - Access instructions
          - Support contacts

       Track request status and escalate blockers.

       Output: .aiwg/team/onboarding/{name}/access-requests.md
       """
   )
   ```

3. **Validate Pre-Boarding Readiness**:
   ```
   Task(
       subagent_type="project-manager",
       description="Validate pre-boarding completion",
       prompt="""
       Review pre-boarding status:
       - Read checklist: .aiwg/team/onboarding/{name}/pre-boarding-checklist.md
       - Read access status: .aiwg/team/onboarding/{name}/access-requests.md

       Validate all items complete or on-track:
       - System access: READY | PENDING | BLOCKED
       - Equipment: READY | PENDING | BLOCKED
       - Documentation: READY | PENDING
       - Logistics: CONFIRMED | PENDING

       If any BLOCKED items, escalate immediately.
       Target: 100% complete 2 business days before start.

       Generate readiness report with status and any risks.

       Output: .aiwg/team/onboarding/{name}/pre-boarding-status.md
       """
   )
   ```

**Communicate Progress**:
```
✓ Pre-boarding initialized for {name}
⏳ Preparing access and equipment...
  ✓ System access requests submitted
  ✓ Equipment ordered (delivery by {date})
  ✓ Documentation prepared
✓ Pre-boarding 95% complete (awaiting VPN setup)
```

### Step 2: Create Personalized Onboarding Plan

**Purpose**: Develop role-specific 90-day plan with clear milestones

**Your Actions**:

1. **Analyze Role and Context**:
   ```
   Read available context:
   - Project intake: .aiwg/intake/project-intake.md
   - Team roster: .aiwg/team/team-roster.md
   - Architecture: .aiwg/architecture/software-architecture-doc.md
   ```

2. **Launch Planning Agents** (parallel):
   ```
   # Agent 1: Training Coordinator
   Task(
       subagent_type="training-coordinator",
       description="Create training schedule for {role}",
       prompt="""
       Design training plan for new {role}:

       Week 1: Orientation and Environment
       - Company/team culture and values
       - Development environment setup
       - Git workflow and PR process
       - CI/CD pipeline overview
       - Basic codebase walkthrough

       Week 2-4: Technical Ramp-Up
       - Architecture deep dive
       - Domain knowledge transfer
       - Coding standards and patterns
       - Testing strategies
       - Security best practices

       Month 2: Applied Learning
       - Pair programming sessions
       - Code review participation
       - Feature development with support
       - Production support shadowing

       Month 3: Independent Contribution
       - Solo feature ownership
       - On-call rotation (if applicable)
       - Process improvement contributions

       Include specific courses, documentation, and hands-on exercises.

       Output: .aiwg/team/onboarding/{name}/training-schedule.md
       """
   )

   # Agent 2: Technical Lead
   Task(
       subagent_type="technical-lead",
       description="Identify starter tasks and progression",
       prompt="""
       Create starter task sequence for {role}:

       Selection criteria:
       - Self-contained (minimal dependencies)
       - Low risk (not critical path)
       - Good learning opportunity
       - Clear acceptance criteria
       - Progressive complexity

       Week 1-2 Tasks (Low Complexity):
       - Documentation improvements
       - Unit test additions
       - Bug fixes (minor)
       - Code refactoring (small scope)

       Week 3-4 Tasks (Medium Complexity):
       - Small feature implementation
       - Integration test creation
       - Performance optimization (isolated)
       - API endpoint addition

       Month 2+ Tasks (Increasing Complexity):
       - Cross-component features
       - System design participation
       - Architecture improvements
       - Production issue resolution

       For each task provide:
       - Task ID and title
       - Description and context
       - Acceptance criteria
       - Estimated effort
       - Learning objectives

       Output: .aiwg/team/onboarding/{name}/starter-tasks.md
       """
   )

   # Agent 3: Team Lead
   Task(
       subagent_type="team-lead",
       description="Define 30/60/90 day goals",
       prompt="""
       Set milestone goals for {name} in {role}:

       30-Day Goals:
       - Development environment fully functional
       - Completed 3-5 starter tasks
       - Participated in team ceremonies
       - Basic codebase familiarity
       - First PR merged

       60-Day Goals:
       - Delivered 1-2 features independently
       - Active code review participation
       - Domain knowledge proficiency
       - Velocity approaching team average
       - Established working relationships

       90-Day Goals:
       - Full workload capacity
       - Mentoring capability
       - Process improvement contributions
       - On-call rotation ready
       - Trusted team member

       Make goals specific, measurable, and role-appropriate.

       Output: .aiwg/team/onboarding/{name}/milestone-goals.md
       """
   )
   ```

3. **Synthesize Onboarding Plan**:
   ```
   Task(
       subagent_type="project-manager",
       description="Create comprehensive onboarding plan",
       prompt="""
       Synthesize onboarding components:
       - Training schedule: .aiwg/team/onboarding/{name}/training-schedule.md
       - Starter tasks: .aiwg/team/onboarding/{name}/starter-tasks.md
       - Milestone goals: .aiwg/team/onboarding/{name}/milestone-goals.md

       Create unified 90-day onboarding plan:

       1. Overview
          - Team member: {name}
          - Role: {role}
          - Start date: {start-date}
          - Buddy: {to be assigned}

       2. Week-by-Week Schedule
          - Training activities
          - Task assignments
          - Check-in meetings
          - Deliverables

       3. Milestone Checkpoints
          - 30-day goals and validation
          - 60-day goals and assessment
          - 90-day goals and graduation

       4. Support Structure
          - Buddy responsibilities
          - Manager 1:1 cadence
          - Team integration activities

       5. Success Metrics
          - Quantitative measures
          - Qualitative feedback
          - Ramp-up velocity tracking

       Output: .aiwg/team/onboarding/{name}/onboarding-plan.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Creating personalized onboarding plan...
  ✓ Training schedule designed
  ✓ Starter tasks identified (8 tasks)
  ✓ 30/60/90 day goals defined
✓ Onboarding plan complete: .aiwg/team/onboarding/{name}/onboarding-plan.md
```

### Step 3: Buddy Assignment and Pairing Setup

**Purpose**: Match appropriate buddy and establish support structure

**Your Actions**:

1. **Select and Assign Buddy**:
   ```
   Task(
       subagent_type="team-lead",
       description="Assign buddy for {name}",
       prompt="""
       Select appropriate buddy based on:
       - Domain expertise match
       - Availability (20% capacity first month)
       - Mentoring experience
       - Personality fit
       - Timezone alignment (if remote)

       Document buddy assignment:

       1. Buddy Selection
          - Selected: {buddy-name}
          - Rationale: {why this person}
          - Backup buddy: {alternate if needed}

       2. Buddy Responsibilities
          Week 1-4 (Intensive):
          - Daily pairing (1-2 hours)
          - Priority code review
          - On-demand Q&A support
          - Weekly check-in (30 min)

          Week 5-12 (Ongoing):
          - 2-3x weekly pairing
          - Code review with feedback
          - Monthly progress check

       3. Pairing Schedule
          - Week 1: Daily 10am-12pm
          - Week 2-4: MWF 2pm-4pm
          - Month 2-3: As needed

       4. Knowledge Transfer Topics
          - Architecture walkthrough
          - Codebase navigation
          - Development workflow
          - Team conventions
          - Domain concepts

       Output: .aiwg/team/onboarding/{name}/buddy-assignment.md
       """
   )
   ```

2. **Notify Buddy and Set Expectations**:
   ```
   Task(
       subagent_type="human-resources-coordinator",
       description="Communicate buddy assignment",
       prompt="""
       Create buddy notification and prep materials:

       1. Buddy Notification
          - Inform selected buddy of assignment
          - Share onboarding plan
          - Clarify time commitment
          - Provide mentoring resources

       2. Capacity Adjustment
          - Reduce buddy's sprint capacity by 20%
          - Communicate to project manager
          - Update team velocity planning

       3. Support Materials
          - Onboarding checklist for buddy
          - Common questions and answers
          - Escalation procedures
          - Feedback collection process

       Output: .aiwg/team/onboarding/{name}/buddy-prep.md
       """
   )
   ```

**Communicate Progress**:
```
✓ Buddy assigned: {buddy-name}
✓ Pairing schedule established
✓ Capacity adjustments made
```

### Step 4: Execute Onboarding with Progress Tracking

**Purpose**: Monitor daily/weekly progress and address issues proactively

**Your Actions**:

1. **Week 1 Execution**:
   ```
   Task(
       subagent_type="project-manager",
       description="Monitor Week 1 onboarding progress",
       prompt="""
       Track Week 1 activities for {name}:

       Daily Checklist:
       Day 1:
       - [ ] Welcome and introductions
       - [ ] Equipment setup complete
       - [ ] Account access verified
       - [ ] First buddy session

       Day 2-3:
       - [ ] Development environment setup
       - [ ] Codebase walkthrough
       - [ ] First documentation task assigned

       Day 4-5:
       - [ ] First PR submitted
       - [ ] Team meeting participation
       - [ ] Week 1 feedback collected

       Document any blockers or concerns.
       Escalate access issues immediately.

       Output: .aiwg/team/onboarding/{name}/week-1-status.md
       """
   )
   ```

2. **Ongoing Progress Monitoring** (weekly):
   ```
   Task(
       subagent_type="team-lead",
       description="Weekly onboarding progress check",
       prompt="""
       Assess weekly progress for {name}:

       Review:
       - Task completion rate
       - Training attendance
       - Buddy session feedback
       - Team integration observations

       Metrics:
       - Tasks completed: X/Y
       - PRs submitted: count
       - Code review participation: count
       - Training modules completed: X/Y

       Identify:
       - Strengths observed
       - Areas needing support
       - Pace adjustment needs
       - Additional resources required

       Output: .aiwg/team/onboarding/{name}/week-{N}-status.md
       """
   )
   ```

### Step 5: Conduct 30/60/90 Day Check-Ins

**Purpose**: Formal milestone reviews with feedback and adjustments

**Your Actions**:

1. **30-Day Check-In**:
   ```
   Task(
       subagent_type="project-manager",
       description="Conduct 30-day check-in for {name}",
       prompt="""
       Facilitate 30-day milestone review:

       Attendees: {name}, Manager, Buddy, Technical Lead

       Agenda:
       1. Goal Review
          - Environment setup: COMPLETE | PARTIAL | BLOCKED
          - Starter tasks (3-5): X completed
          - Team integration: STRONG | GOOD | NEEDS SUPPORT

       2. Feedback Discussion
          - What's going well?
          - What challenges exist?
          - What support is needed?

       3. Performance Assessment
          - Technical progress: ON TRACK | SLOW | FAST
          - Team fit: EXCELLENT | GOOD | DEVELOPING
          - Communication: STRONG | ADEQUATE | NEEDS IMPROVEMENT

       4. Plan Adjustments
          - Training modifications
          - Task complexity changes
          - Support level adjustments

       5. Next 30 Days
          - Confirm goals
          - Address concerns
          - Set expectations

       Output: .aiwg/team/onboarding/{name}/30-day-checkin.md
       """
   )
   ```

2. **60-Day Check-In**:
   ```
   Task(
       subagent_type="project-manager",
       description="Conduct 60-day check-in for {name}",
       prompt="""
       Facilitate 60-day milestone review:

       Focus: Increasing autonomy and contribution

       Assessment Areas:
       1. Technical Competence
          - Feature delivery: {count} completed
          - Code quality: EXCELLENT | GOOD | DEVELOPING
          - Problem solving: INDEPENDENT | SUPPORTED | DEPENDENT

       2. Velocity Metrics
          - Current velocity: X story points
          - Team average: Y story points
          - Trajectory: APPROACHING | BELOW | EXCEEDING

       3. Collaboration
          - Code reviews given: {count}
          - Design participation: ACTIVE | OBSERVING
          - Team communication: STRONG | ADEQUATE

       4. Domain Knowledge
          - Business understanding: STRONG | DEVELOPING
          - Technical depth: PROFICIENT | LEARNING

       Decision Point:
       - Ready for full workload? YES | NOT YET
       - Buddy support reduction? YES | MAINTAIN

       Output: .aiwg/team/onboarding/{name}/60-day-checkin.md
       """
   )
   ```

3. **90-Day Check-In (Graduation)**:
   ```
   Task(
       subagent_type="project-manager",
       description="Conduct 90-day graduation review for {name}",
       prompt="""
       Facilitate 90-day final review:

       Graduation Criteria:
       - [ ] Operating at full capacity
       - [ ] Independently delivering features
       - [ ] Actively contributing to team
       - [ ] Ready for on-call (if applicable)

       Final Assessment:
       1. Overall Performance
          - Rating: EXCEEDS | MEETS | APPROACHING
          - Strengths: {list}
          - Growth areas: {list}

       2. Integration Status
          - Team member status: FULLY INTEGRATED | NEEDS MORE TIME
          - Recommendation: GRADUATE | EXTEND SUPPORT

       3. Future Development
          - Next learning goals
          - Stretch assignments
          - Mentoring opportunities

       4. Process Feedback
          - What worked well in onboarding?
          - What could improve?
          - Recommendations for future onboardings

       Decision: ONBOARDING COMPLETE | EXTEND 30 DAYS

       Output: .aiwg/team/onboarding/{name}/90-day-checkin.md
       """
   )
   ```

**Communicate Progress**:
```
✓ 30-day check-in complete: ON TRACK
✓ 60-day check-in complete: APPROACHING TARGET
✓ 90-day check-in complete: GRADUATED
```

### Step 6: Generate Final Onboarding Report

**Purpose**: Summarize complete onboarding journey and capture lessons learned

**Your Actions**:

```
Task(
    subagent_type="project-manager",
    description="Generate comprehensive onboarding report",
    prompt="""
    Create final onboarding summary for {name}:

    Read all artifacts:
    - Onboarding plan: .aiwg/team/onboarding/{name}/onboarding-plan.md
    - Check-ins: .aiwg/team/onboarding/{name}/*-checkin.md
    - Weekly status: .aiwg/team/onboarding/{name}/week-*-status.md

    Generate report:

    # Team Onboarding Report

    **Team Member**: {name}
    **Role**: {role}
    **Start Date**: {start-date}
    **Graduation Date**: {90-day-date}
    **Status**: COMPLETE | EXTENDED | IN PROGRESS

    ## Milestone Achievement

    30-Day Milestone:
    - Status: ACHIEVED | PARTIAL | MISSED
    - Key accomplishments: {list}

    60-Day Milestone:
    - Status: ACHIEVED | PARTIAL | MISSED
    - Velocity: {X} vs team average {Y}

    90-Day Milestone:
    - Status: GRADUATED | EXTENDED
    - Full integration: YES | NO

    ## Metrics Summary

    - Total tasks completed: {count}
    - Features delivered: {count}
    - PRs submitted: {count}
    - Code reviews performed: {count}
    - Training modules completed: {X}/{Y}
    - Ramp-up velocity: {FAST | NORMAL | SLOW}

    ## Buddy Relationship

    - Buddy: {buddy-name}
    - Total pairing hours: {hours}
    - Effectiveness: {rating and feedback}

    ## Strengths Demonstrated
    - {strength 1}
    - {strength 2}
    - {strength 3}

    ## Development Areas
    - {area 1}
    - {area 2}

    ## Process Improvements

    Based on this onboarding:
    - {improvement 1}
    - {improvement 2}
    - {improvement 3}

    ## Recommendations

    For {name}:
    - Next development goals
    - Suggested projects/features
    - Mentoring opportunities

    For future onboardings:
    - Process adjustments
    - Resource additions
    - Timeline modifications

    Output: .aiwg/reports/onboarding-complete-{name}.md
    """
)
```

## Quality Gates

Before marking workflow complete, verify:
- [ ] Pre-boarding 100% complete before start date
- [ ] Buddy assigned and prepared
- [ ] Onboarding plan reviewed and approved
- [ ] All milestone check-ins conducted
- [ ] Graduation criteria met or extension justified
- [ ] Feedback collected and documented
- [ ] Process improvements identified

## User Communication

**At start**: Confirm understanding and timeline

```
Understood. I'll orchestrate onboarding for {name} starting {date}.

This will include:
- Pre-boarding preparation (access, equipment, docs)
- 90-day personalized onboarding plan
- Buddy assignment and pairing schedule
- Starter tasks with progressive complexity
- 30/60/90 day milestone check-ins
- Progress tracking and reporting

Expected timeline: 90 days total, with weekly progress updates.

Starting pre-boarding preparation...
```

**During**: Regular status updates

```
Week 1 Status:
✓ Day 1: Welcome complete, environment 80% setup
✓ Day 2: First PR submitted (documentation fix)
⏳ Day 3: Codebase walkthrough with buddy
⚠️ Blocker: CI/CD access pending (escalated)
```

**At milestones**: Detailed checkpoint summaries

```
30-Day Check-In Complete:
- Status: ON TRACK
- Tasks completed: 4/5
- First feature delivered
- Team integration: STRONG
- Next focus: Increase task complexity
```

## Error Handling

**Access Delays**:
```
⚠️ System access delayed - impacting onboarding

Missing access:
- {system}: Expected {date}, now {new-date}

Mitigation:
- Buddy providing screen-share access
- Read-only access granted temporarily
- Adjusting task sequence

Impact: Minimal if resolved within 48 hours
```

**Buddy Unavailable**:
```
⚠️ Buddy unavailable due to {reason}

Action taken:
- Backup buddy activated: {backup-name}
- Knowledge transfer session scheduled
- Pairing schedule adjusted

No impact to onboarding timeline expected.
```

**Slow Progress**:
```
⚠️ 30-day milestone partially met

Gaps:
- Tasks completed: 2/5 (target: 3-5)
- PR velocity below target

Adjustments:
- Increased buddy pairing time
- Simplified task complexity
- Additional training scheduled

Reviewing progress weekly for improvement.
```

## Success Criteria

This orchestration succeeds when:
- [ ] New team member fully productive by day 90
- [ ] All milestones achieved or explicitly adjusted
- [ ] Positive feedback from team member and buddy
- [ ] No critical knowledge gaps identified
- [ ] Team integration successful
- [ ] Process improvements documented

## References

**Templates** (via $AIWG_ROOT):
- Team Roster: team roster fields in this skill
- Onboarding Plan: onboarding plan fields in this skill
- Buddy Assignment: buddy assignment fields in this skill
- Training Schedule: training schedule fields in this skill
- Work Package: `templates/management/work-package-card.md`
- Milestone Checklist: milestone checklist in this skill

**Related Flows**:
- `flow-team-coordination` - Ongoing team management
- `flow-knowledge-transfer` - Deep technical knowledge sharing
- `flow-training-certification` - Formal training programs

**Supporting Documents**:
- `docs/team-onboarding-best-practices.md`
- `docs/buddy-system-guide.md`
- `docs/remote-onboarding-adjustments.md`