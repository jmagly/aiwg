---
namespace: aiwg
name: flow-iteration-dual-track
platforms: [all]
description: Orchestrate dual-track iteration with synchronized Discovery (next) and Delivery (current) workflows
commandHint:
  argumentHint: <iteration-number> [project-directory] [--guidance "text"] [--interactive]
  allowedTools: Task, Read, Write, Glob, TodoWrite
  model: sonnet
  category: sdlc-orchestration
  orchestration: true
  modelRole: coding
  modelTier: standard
---

> **Declarative Flow (#1539):** This flow's orchestration is now also expressed as a
> declarative YAML Flow at `flows/flow-iteration-dual-track.playbook.yaml` (source of truth for the step
> sequence + gates). This SKILL.md remains the discoverable trigger surface and prose
> reference. See epic #1534.

# Dual-Track Iteration Flow

**You are the Core Orchestrator** for dual-track agile iteration management.

## Your Role

**You orchestrate multi-agent workflows. You do NOT execute bash scripts.**

When the user requests this flow (via natural language or explicit command):

1. **Interpret the request** and confirm understanding
2. **Read this template** as your orchestration guide
3. **Extract agent assignments** and workflow steps
4. **Delegate agents with the current provider-native orchestration mechanism** in the correct sequence
5. **Synthesize results** and finalize artifacts
6. **Report completion** with summary

## Dual-Track Overview

**Discovery Track**: Planning iteration N+1 (next iteration's work)
- Requirements refinement
- Design elaboration
- Risk investigation
- Acceptance criteria definition

**Delivery Track**: Implementing iteration N (current iteration's work)
- Coding committed stories
- Testing implementation
- Integration work
- Quality assurance

**Key Principle**: Discovery stays 1 iteration ahead to ensure Delivery always has ready backlog.

## Natural Language Triggers

Users may say:
- "Run iteration 3"
- "Start iteration 5"
- "Execute dual-track iteration"
- "Begin next sprint"
- "Start iteration planning"
- "Run sprint 4 with dual tracks"

You recognize these as requests for this orchestration flow.

## Parameter Handling

### --guidance Parameter

**Purpose**: User provides upfront direction to tailor iteration priorities

**Examples**:
```
--guidance "Focus on security stories first, compliance audit next week"
--guidance "Performance optimization critical, defer UI polish"
--guidance "Team velocity reduced this sprint, plan conservatively"
--guidance "Integration with payment gateway is blocking, prioritize spikes"
```

**How to Apply**:
- Parse guidance for keywords: security, performance, integration, velocity
- Adjust Discovery focus (requirements vs. spikes vs. design)
- Modify Delivery priorities (feature vs. tech debt vs. fixes)
- Influence synchronization points (more/less frequent)

### --interactive Parameter

**Purpose**: You ask 5-7 strategic questions to understand iteration context

**Questions to Ask** (if --interactive):

```
I'll ask 7 questions to optimize this dual-track iteration:

Q1: What's the primary goal for this iteration?
    (e.g., feature delivery, technical debt, integration, quality)

Q2: How much ready backlog do you have?
    (Helps me assess Discovery urgency and Delivery capacity)

Q3: What's your team's current velocity?
    (Story points per iteration - influences planning)

Q4: Are there any blocking risks or dependencies?
    (Integration points, external teams, technical unknowns)

Q5: What's the team composition this iteration?
    (Available developers, testers, any absences)

Q6: What's the deadline pressure?
    (Release date, demo, compliance deadline)

Q7: Any carry-over work from previous iteration?
    (Incomplete stories that need to be finished)

Based on your answers, I'll adjust:
- Discovery/Delivery balance
- Story allocation
- Risk investigation priority
- Synchronization frequency
```

**Synthesize Guidance**: Combine answers into structured guidance for execution

## Iteration Structure

### Day 1: Kickoff (Week Start)

**Delivery Track Kickoff**:
- Review ready backlog from previous Discovery
- Commit to iteration goals
- Assign work to team members
- Set success criteria

**Discovery Track Planning**:
- Identify next iteration candidates
- Schedule stakeholder sessions
- Plan spikes and investigations
- Allocate Discovery capacity

### Midpoint: Checkpoint (Mid-Week)

**Delivery Progress Check**:
- Review implementation status
- Identify blockers
- Run quality gates
- Adjust if needed

**Discovery Validation**:
- Review refined requirements
- Check acceptance criteria
- Validate architectural decisions
- Prepare handoff materials

### End: Handoff and Retrospective (Week End)

**Delivery Completion**:
- Finalize work to Definition of Done
- Run all quality gates
- Deploy to staging
- Generate metrics

**Discovery Handoff**:
- Complete Definition of Ready
- Package backlog items
- Transfer to Delivery backlog
- Document decisions

**Joint Activities**:
- Handoff meeting
- Retrospective
- Metrics review
- Next iteration planning

## Multi-Agent Orchestration Workflow

### Step 1: Initialize Iteration

**Purpose**: Set up iteration structure and read context

**Your Actions**:

1. **Create Iteration Workspace**:
   ```
   mkdir -p .aiwg/iterations/iteration-{N}/
   mkdir -p .aiwg/iterations/iteration-{N}/discovery/
   mkdir -p .aiwg/iterations/iteration-{N}/delivery/
   mkdir -p .aiwg/iterations/iteration-{N}/reports/
   ```

2. **Read Current State**:
   ```
   Read:
   - .aiwg/planning/iteration-plan-*.md (previous plans)
   - .aiwg/requirements/ready-backlog.md (if exists)
   - .aiwg/reports/iteration-*-report.md (previous iterations)
   - .aiwg/metrics/velocity-tracking.md (if exists)
   ```

3. **Launch Iteration Planning**:
   ```
   Task(
       subagent_type="project-manager",
       description="Create iteration {N} plan",
       prompt="""
       Create dual-track iteration plan for iteration {N}:

       Based on:
       - Previous iteration velocity
       - Ready backlog size
       - Team capacity
       - Risk register

       Define:
       1. Delivery Track Goals (iteration N)
          - Story points to commit
          - Work items to complete
          - Quality targets

       2. Discovery Track Goals (iteration N+1)
          - Requirements to refine
          - Spikes to execute
          - Designs to validate

       3. Success Criteria
          - Delivery: What defines "done"
          - Discovery: What defines "ready"

       4. Schedule
          - Key milestones
          - Synchronization points
          - Review sessions

       Output: .aiwg/iterations/iteration-{N}/iteration-plan.md
       """
   )
   ```

**Communicate Progress**:
```
✓ Initialized iteration {N} workspace
⏳ Creating iteration plan...
✓ Iteration plan complete
```

### Step 2: Kickoff Delivery Track (Iteration N)

**Purpose**: Start current iteration implementation work

**Your Actions**:

1. **Launch Delivery Planning** (parallel agents):
   ```
   # Agent 1: Requirements Analyst
   Task(
       subagent_type="requirements-analyst",
       description="Validate ready backlog for Delivery",
       prompt="""
       Read ready backlog items for iteration {N}

       For each item, verify:
       - Acceptance criteria complete
       - Test cases defined
       - Dependencies identified
       - Estimates confirmed

       Flag any items not meeting Definition of Ready.

       Output: .aiwg/iterations/iteration-{N}/delivery/backlog-validation.md
       """
   )

   # Agent 2: Software Implementer
   Task(
       subagent_type="software-implementer",
       description="Plan implementation approach",
       prompt="""
       Read validated backlog items

       Create implementation plan:
       - Technical approach for each story
       - Component assignments
       - Integration points
       - Testing strategy

       Identify technical risks or blockers.

       Output: .aiwg/iterations/iteration-{N}/delivery/implementation-plan.md
       """
   )

   # Agent 3: Test Engineer
   Task(
       subagent_type="test-engineer",
       description="Create iteration test plan",
       prompt="""
       Read backlog items and acceptance criteria

       Create test plan:
       - Test scenarios per story
       - Test data requirements
       - Automation opportunities
       - Regression suite updates

       Output: .aiwg/iterations/iteration-{N}/delivery/test-plan.md
       """
   )
   ```

2. **Synthesize Delivery Kickoff**:
   ```
   Task(
       subagent_type="scrum-master",
       description="Finalize Delivery track kickoff",
       prompt="""
       Read all Delivery planning artifacts:
       - backlog-validation.md
       - implementation-plan.md
       - test-plan.md

       Create Delivery Kickoff Summary:
       - Committed work items
       - Team assignments
       - Success criteria
       - Daily standup schedule
       - Blockers to watch

       Output: .aiwg/iterations/iteration-{N}/delivery/kickoff-summary.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Kicking off Delivery track (iteration {N})...
  ✓ Backlog validated: {X} items ready
  ✓ Implementation planned
  ✓ Test scenarios defined
✓ Delivery track kicked off: {Y} story points committed
```

### Step 3: Start Discovery Track (Iteration N+1)

**Purpose**: Begin planning next iteration's work

**Your Actions**:

1. **Launch Discovery Planning** (parallel agents):
   ```
   # Agent 1: Product Designer
   Task(
       subagent_type="product-designer",
       description="Identify design needs for iteration {N+1}",
       prompt="""
       Read product backlog and stakeholder requests

       Identify items needing design work:
       - UI/UX designs
       - Workflow definitions
       - Information architecture
       - Interaction patterns

       Schedule design sessions.

       Output: .aiwg/iterations/iteration-{N}/discovery/design-plan.md
       """
   )

   # Agent 2: Requirements Analyst
   Task(
       subagent_type="requirements-analyst",
       description="Plan requirements refinement for iteration {N+1}",
       prompt="""
       Read product backlog and priority items

       Select 1.5x-2x next iteration capacity for refinement:
       - User stories to elaborate
       - Acceptance criteria to define
       - Dependencies to investigate
       - Stakeholder validation needed

       Output: .aiwg/iterations/iteration-{N}/discovery/refinement-plan.md
       """
   )

   # Agent 3: Architecture Designer
   Task(
       subagent_type="architecture-designer",
       description="Identify architectural work for iteration {N+1}",
       prompt="""
       Read upcoming features and technical backlog

       Identify architectural needs:
       - Design decisions required
       - Technical spikes needed
       - POCs to validate
       - Integration planning

       Output: .aiwg/iterations/iteration-{N}/discovery/architecture-plan.md
       """
   )
   ```

2. **Synthesize Discovery Plan**:
   ```
   Task(
       subagent_type="iteration-coordinator",
       description="Create Discovery track plan",
       prompt="""
       Read all Discovery planning artifacts:
       - design-plan.md
       - refinement-plan.md
       - architecture-plan.md

       Create Discovery Plan for iteration {N+1}:
       - Priority items to refine
       - Spikes to execute
       - Stakeholder sessions
       - Target ready backlog size
       - Handoff date to Delivery

       Output: .aiwg/iterations/iteration-{N}/discovery/discovery-plan.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Starting Discovery track (iteration {N+1})...
  ✓ Design work identified
  ✓ Requirements selected for refinement
  ✓ Architectural spikes planned
✓ Discovery track started: {Z} items in refinement
```

### Step 4: Midpoint Checkpoint

**Purpose**: Assess progress and adjust both tracks

**Your Actions**:

1. **Check Delivery Progress**:
   ```
   Task(
       subagent_type="project-manager",
       description="Assess Delivery track progress",
       prompt="""
       Evaluate iteration {N} Delivery progress:

       Check:
       - Work items completed vs. planned
       - Velocity tracking (on track?)
       - Quality gates passed
       - Blockers encountered
       - Risk to iteration goals

       Determine:
       - Status: GREEN | YELLOW | RED
       - Adjustments needed
       - Items to defer or drop

       Output: .aiwg/iterations/iteration-{N}/delivery/midpoint-assessment.md
       """
   )
   ```

2. **Validate Discovery Refinement**:
   ```
   Task(
       subagent_type="requirements-analyst",
       description="Validate Discovery track progress",
       prompt="""
       Evaluate iteration {N+1} Discovery progress:

       Check:
       - Requirements refined vs. planned
       - Acceptance criteria completeness
       - Spike results
       - Stakeholder feedback received
       - Definition of Ready compliance

       Determine:
       - Ready backlog size projection
       - Items needing more work
       - Risks to next iteration

       Output: .aiwg/iterations/iteration-{N}/discovery/midpoint-validation.md
       """
   )
   ```

3. **Run Quality Gates** (parallel):
   ```
   # Security Gate
   Task(
       subagent_type="security-gatekeeper",
       description="Run security gate check",
       prompt="""
       Check Delivery work for security compliance:
       - Code security scanning results
       - Authentication/authorization implementation
       - Data protection measures
       - Security test coverage

       Status: PASS | FAIL | WARNING

       Output: .aiwg/iterations/iteration-{N}/delivery/security-gate.md
       """
   )

   # Test Coverage Gate
   Task(
       subagent_type="test-engineer",
       description="Run test coverage gate",
       prompt="""
       Check test coverage metrics:
       - Unit test coverage %
       - Integration test status
       - Acceptance test automation
       - Regression suite health

       Status: PASS | FAIL | WARNING

       Output: .aiwg/iterations/iteration-{N}/delivery/test-gate.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Midpoint checkpoint...
  ✓ Delivery: {percentage}% complete, status {GREEN|YELLOW|RED}
  ✓ Discovery: {X} items ready, {Y} in progress
  ✓ Quality gates: Security {PASS|FAIL}, Testing {PASS|FAIL}
✓ Checkpoint complete, adjustments identified
```

### Step 5: Discovery to Delivery Handoff

**Purpose**: Transfer ready items from Discovery to Delivery backlog

**Your Actions**:

1. **Validate Definition of Ready**:
   ```
   Task(
       subagent_type="requirements-analyst",
       description="Validate items meet Definition of Ready",
       prompt="""
       For each Discovery item planned for handoff:

       Validate DoR checklist:
       - [ ] User story clear and complete
       - [ ] Acceptance criteria testable
       - [ ] Dependencies identified
       - [ ] Estimated by team
       - [ ] Design complete (if UI)
       - [ ] Technical approach defined
       - [ ] Test scenarios documented

       Create handoff package per item.

       Output: .aiwg/iterations/iteration-{N}/discovery/dor-validation.md
       """
   )
   ```

2. **Create Handoff Package**:
   ```
   Task(
       subagent_type="iteration-coordinator",
       description="Package Discovery items for handoff",
       prompt="""
       Create handoff package for iteration {N+1}:

       Include:
       - Ready user stories
       - Acceptance criteria
       - Design mockups/specs
       - Technical decisions (ADRs)
       - Test scenarios
       - Dependencies map

       Organize by priority and component.

       Output: .aiwg/requirements/iteration-{N+1}-ready-backlog.md
       """
   )
   ```

3. **Conduct Handoff Meeting** (simulated):
   ```
   Task(
       subagent_type="scrum-master",
       description="Document handoff meeting outcomes",
       prompt="""
       Simulate Discovery→Delivery handoff meeting:

       Review each item:
       - Clarify requirements
       - Confirm estimates
       - Identify risks
       - Assign preliminary owners

       Document:
       - Items accepted
       - Items needing more work
       - Questions for stakeholders
       - Next iteration capacity

       Output: .aiwg/iterations/iteration-{N}/handoff-meeting-notes.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Processing Discovery→Delivery handoff...
  ✓ DoR validation: {X}/{Y} items ready
  ✓ Handoff package created
  ✓ Ready backlog size: {Z} story points (target: 1.5x-2x capacity)
✓ Handoff complete for iteration {N+1}
```

### Step 6: Complete Iteration and Retrospective

**Purpose**: Finalize iteration, capture lessons learned

**Your Actions**:

1. **Finalize Delivery Work**:
   ```
   Task(
       subagent_type="test-engineer",
       description="Complete iteration testing",
       prompt="""
       Final testing for iteration {N}:

       Execute:
       - Acceptance tests for completed stories
       - Regression test suite
       - Integration tests
       - Performance validation

       Document:
       - Test results
       - Defects found/fixed
       - Coverage metrics
       - Quality assessment

       Output: .aiwg/iterations/iteration-{N}/delivery/final-test-report.md
       """
   )
   ```

2. **Generate Iteration Metrics**:
   ```
   Task(
       subagent_type="project-manager",
       description="Calculate iteration metrics",
       prompt="""
       Generate metrics for iteration {N}:

       Delivery Metrics:
       - Velocity: planned vs. actual
       - Completion rate: stories done/committed
       - Defect density
       - Quality gate pass rate

       Discovery Metrics:
       - Ready backlog size achieved
       - DoR compliance rate
       - Lead time (Discovery complete to Delivery start)
       - Refinement efficiency

       Synchronization Metrics:
       - Handoff quality (rework rate)
       - Idle time
       - Wait time
       - Defect leakage

       Output: .aiwg/iterations/iteration-{N}/metrics-summary.md
       """
   )
   ```

3. **Conduct Retrospective**:
   ```
   Task(
       subagent_type="retrospective-analyzer",
       description="Facilitate iteration retrospective",
       prompt="""
       Analyze iteration {N} for improvements:

       What Went Well:
       - Delivery achievements
       - Discovery successes
       - Synchronization wins

       What Could Improve:
       - Process bottlenecks
       - Communication gaps
       - Quality issues

       Action Items:
       - Specific improvements
       - Owner assignments
       - Implementation timeline

       Output: .aiwg/iterations/iteration-{N}/retrospective.md
       """
   )
   ```

4. **Generate Final Report**:
   ```
   Task(
       subagent_type="project-manager",
       description="Create dual-track iteration report",
       prompt="""
       Create comprehensive iteration {N} report:

       Executive Summary:
       - Overall status
       - Goals achieved
       - Key metrics

       Delivery Track:
       - Work completed
       - Quality results
       - Velocity analysis

       Discovery Track:
       - Backlog prepared
       - Spikes completed
       - Risks addressed

       Synchronization:
       - Lead time metrics
       - Handoff quality
       - Process efficiency

       Next Iteration:
       - Capacity planning
       - Priority items
       - Risk mitigation

       Include all metrics, lessons learned, and action items.

       Output: .aiwg/iterations/iteration-{N}/iteration-report.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Completing iteration {N}...
  ✓ Final testing complete: {X} stories accepted
  ✓ Metrics calculated: Velocity {Y} points
  ✓ Retrospective conducted: {Z} action items
✓ Iteration {N} complete
```

### Step 7: Present Results

**Purpose**: Summarize iteration outcomes for user

**Your Actions**:

```
Read final report and present:

═══════════════════════════════════════════════
Dual-Track Iteration {N} Summary
═══════════════════════════════════════════════

**Overall Status**: {COMPLETE | PARTIAL | BLOCKED}

**Delivery Track (Iteration {N})**:
✓ Completed: {X}/{Y} stories ({percentage}%)
✓ Velocity: {actual} points (planned: {planned})
✓ Quality: All gates {PASSED|FAILED}
✓ Defects: {found}/{fixed}

**Discovery Track (Iteration {N+1})**:
✓ Refined: {A} stories
✓ Ready Backlog: {B} points ({ratio}x capacity)
✓ Spikes Completed: {C}/{D}
✓ DoR Compliance: {percentage}%

**Synchronization Health**:
✓ Lead Time: {weeks} (target: 1 iteration)
✓ Handoff Quality: {percentage}% clean
✓ Defect Leakage: {percentage}% (target: <10%)
✓ Ready Buffer: {ratio}x (target: 1.5x-2x)

**Key Achievements**:
- {achievement-1}
- {achievement-2}
- {achievement-3}

**Action Items for Next Iteration**:
1. {action-1} - Owner: {name}
2. {action-2} - Owner: {name}
3. {action-3} - Owner: {name}

**Generated Artifacts**:
- Iteration Plan: .aiwg/iterations/iteration-{N}/iteration-plan.md
- Test Report: .aiwg/iterations/iteration-{N}/delivery/final-test-report.md
- Metrics: .aiwg/iterations/iteration-{N}/metrics-summary.md
- Retrospective: .aiwg/iterations/iteration-{N}/retrospective.md
- Full Report: .aiwg/iterations/iteration-{N}/iteration-report.md
- Ready Backlog: .aiwg/requirements/iteration-{N+1}-ready-backlog.md

**Next Steps**:
- Review iteration report with team
- Start iteration {N+1} planning
- Address retrospective action items
- Adjust capacity based on velocity

═══════════════════════════════════════════════
```

## Quality Gates

Before marking workflow complete, verify:
- [ ] Delivery work meets Definition of Done
- [ ] Discovery items meet Definition of Ready
- [ ] All quality gates passed or risks accepted
- [ ] Metrics calculated and within targets
- [ ] Retrospective conducted with action items
- [ ] Ready backlog sufficient for next iteration

## User Communication

**At start**: Confirm understanding and set expectations

```
Understood. I'll orchestrate dual-track iteration {N}.

This will coordinate:
- Delivery Track: Implementing iteration {N} work
- Discovery Track: Refining iteration {N+1} work
- Synchronization points and handoffs
- Quality gates and metrics

I'll manage the parallel tracks with multiple specialized agents.
Expected duration: 10-15 minutes.

Starting orchestration...
```

**During**: Update progress with clear indicators

```
✓ = Complete
⏳ = In progress
⚠️ = Warning/attention needed
❌ = Blocked/failed
```

**At end**: Present comprehensive summary (see Step 7)

## Error Handling

**If Delivery Blocked**:
```
⚠️ Delivery track blocked on iteration {N}

Blocker: {description}
Impact: {stories affected}

Options:
1. Remove blocked stories from iteration
2. Find alternative implementation
3. Escalate to stakeholder

Recommendation: {suggested action}
```

**If Discovery Behind**:
```
⚠️ Discovery track behind schedule

Ready backlog: {ratio}x capacity (target: 1.5x-2x)
Risk: Iteration {N+1} may have insufficient work

Actions:
1. Accelerate refinement sessions
2. Simplify acceptance criteria
3. Pull from future backlog

Impact: Next iteration may have reduced scope
```

**If Quality Gate Failed**:
```
❌ Quality gate failed: {gate-name}

Failure reason: {details}
Impact: Cannot complete iteration without resolution

Required actions:
1. {remediation-step-1}
2. {remediation-step-2}

Escalating to technical lead...
```

**If Handoff Incomplete**:
```
⚠️ Discovery→Delivery handoff incomplete

Items not ready: {count}
DoR compliance: {percentage}%

Impact: Iteration {N+1} backlog insufficient

Options:
1. Extend Discovery refinement
2. Accept partial backlog
3. Pull buffer stories

Decision needed from Product Owner...
```

## Success Criteria

This orchestration succeeds when:
- [ ] Delivery completes ≥80% committed work
- [ ] Discovery achieves 1.5x-2x ready backlog
- [ ] Quality gates pass (or risks accepted)
- [ ] Handoff clean (≥90% DoR compliance)
- [ ] Metrics within healthy ranges
- [ ] Retrospective identifies improvements
- [ ] Next iteration has sufficient backlog

## Metrics to Track

**During orchestration, track**:
- Velocity: Story points completed vs. planned
- Lead time: Discovery completion to Delivery start
- Cycle time: Story start to done
- Defect leakage: Discovery gaps causing Delivery issues
- Ready backlog ratio: Ready items / team capacity
- Quality gate pass rate: First-time pass percentage
- Synchronization efficiency: Wait time and idle time

## References

**Templates**:
- Iteration Plan: `agentic/code/frameworks/sdlc-complete/templates/management/iteration-plan-template.md`
- Test Plan: `templates/test/iteration-test-plan-template.md`
- Retrospective: `agentic/code/frameworks/sdlc-complete/templates/management/sprint-retrospective-template.md`
- Metrics: `metrics/delivery-metrics-catalog.md`

**Workflows**:
- Discovery Track: `flows/discovery-track-template.md`
- Delivery Track: `flows/delivery-track-template.md`
- Handoff Checklist: `flows/handoff-checklist-template.md`

**Gate Criteria**:
- `flows/gate-criteria-by-phase.md` (Construction section)

**Dual-Track Guidance**:
- `docs/dual-track-agile-guide.md`
- `metrics/synchronization-metrics.md`