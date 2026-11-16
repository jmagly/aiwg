---
namespace: aiwg
name: flow-elaboration-to-construction
platforms: [all]
description: Orchestrate Elaboration→Construction phase transition with iteration planning, team scaling, and full-scale development kickoff
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
> declarative YAML Flow at `flows/flow-elaboration-to-construction.playbook.yaml` (source of truth for the step
> sequence + gates). This SKILL.md remains the discoverable trigger surface and prose
> reference. See epic #1534.

# Elaboration → Construction Phase Transition Flow

**You are the Core Orchestrator** for the critical Elaboration→Construction phase transition.

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

**From**: Elaboration (architecture proven, risks retired)
**To**: Construction (full-scale iterative development)

**Key Milestone**: Construction Phase Entry

**Success Criteria**:
- Architecture baselined and stable
- First 2 iterations planned with ready backlog
- Development process tailored and team trained
- CI/CD pipeline operational
- Iteration 0 (infrastructure) complete

**Expected Duration**: 1-2 weeks setup, 15-20 minutes orchestration

## Natural Language Triggers

Users may say:
- "Transition to Construction"
- "Start Construction phase"
- "Begin building"
- "Move to Construction"
- "Scale up for Construction"
- "Start full development"

You recognize these as requests for this orchestration flow.

## Parameter Handling

### --guidance Parameter

**Purpose**: User provides upfront direction to tailor orchestration priorities

**Examples**:
```
--guidance "Team scaling from 5 to 20 developers, need extensive onboarding"
--guidance "Fast track, minimal documentation, focus on delivery"
--guidance "Offshore team joining, need extra process documentation"
--guidance "Complex integrations, need thorough environment setup"
```

**How to Apply**:
- Parse guidance for keywords: scaling, timeline, team, infrastructure
- Adjust agent assignments (add environment-engineer for complex setup)
- Modify artifact depth (comprehensive vs minimal documentation)
- Influence priority ordering (infrastructure vs process focus)

### --interactive Parameter

**Purpose**: You ask 5-8 strategic questions to understand project context

**Questions to Ask** (if --interactive):

```
I'll ask 6 strategic questions to tailor the Construction transition to your needs:

Q1: What's your team scaling plan?
    (e.g., 5→20 developers, gradual vs immediate, onshore/offshore mix)

Q2: What are your infrastructure priorities?
    (Help me focus Iteration 0 on critical infrastructure needs)

Q3: What's your iteration cadence preference?
    (1 week, 2 weeks, 3 weeks - affects planning depth)

Q4: How mature is your CI/CD pipeline?
    (Determines infrastructure setup focus)

Q5: What's your biggest concern for Construction?
    (e.g., quality, velocity, team coordination, technical debt)

Q6: Do you need specialized environments?
    (e.g., compliance environments, performance testing, security scanning)

Based on your answers, I'll adjust:
- Agent assignments (infrastructure vs process focus)
- Iteration planning depth (detailed vs high-level)
- Onboarding materials (comprehensive vs minimal)
- Environment setup complexity
```

**Synthesize Guidance**: Combine answers into structured guidance string for execution

## Artifacts to Generate

**Primary Deliverables**:
- **ABM Validation Report**: Elaboration exit criteria → `.aiwg/reports/abm-validation-report.md`
- **Iteration 0 Completion Report**: Infrastructure readiness → `.aiwg/reports/iteration-0-completion.md`
- **Development Process Guide**: Tailored process → `.aiwg/planning/development-process-guide.md`
- **Iteration Plan - Sprint 1**: First iteration → `.aiwg/planning/iteration-plan-001.md`
- **Iteration Plan - Sprint 2**: Second iteration → `.aiwg/planning/iteration-plan-002.md`
- **Team Onboarding Guide**: New member guide → `.aiwg/team/onboarding-guide.md`
- **Architecture Stability Report**: Change tracking → `.aiwg/reports/architecture-stability-report.md`
- **Construction Readiness Report**: Final go/no-go → `.aiwg/reports/construction-readiness-report.md`

**Supporting Artifacts**:
- Environment setup scripts
- CI/CD pipeline configurations
- Team RACI matrix updates
- Dual-track workflow setup

## Multi-Agent Orchestration Workflow

### Step 1: Validate Architecture Baseline Milestone (ABM)

**Purpose**: Verify Elaboration phase complete before starting Construction

**Your Actions**:

1. **Check for Required Elaboration Artifacts**:
   ```
   Read and verify presence of:
   - .aiwg/architecture/software-architecture-doc.md
   - .aiwg/architecture/adr/*.md
   - .aiwg/requirements/supplemental-specification.md
   - .aiwg/testing/master-test-plan.md
   - .aiwg/risks/risk-list.md (≥70% retired)
   - .aiwg/requirements/realizations/DES-UCR-*.md (behavioral specs — Layer 3)
   - .aiwg/architecture/method-contracts/DES-MIC-*.md (interface contracts)
   ```

2. **Launch ABM Validation Agent**:
   ```
   Task(
       subagent_type="project-manager",
       description="Validate Architecture Baseline Milestone criteria",
       prompt="""
       Read gate criteria from: $AIWG_ROOT/agentic/code/frameworks/sdlc-complete/flows/gate-criteria-by-phase.md

       Validate ABM criteria:
       - Software Architecture Document BASELINED
       - Executable architecture baseline OPERATIONAL
       - All P0/P1 architectural risks RETIRED/MITIGATED
       - ≥70% of all risks retired or mitigated
       - Requirements baseline ESTABLISHED (≥10 use cases)
       - Behavioral specifications COMPLETE (Layer 3):
         - ≥80% of architecturally significant UCs have realizations
         - State machine specs for stateful entities
         - Decision tables for complex branching logic
         - Method-level interface contracts for key components
       - Pseudo-code specifications COMPLETE for first iteration scope (Layer 4):
         - Algorithm specs for non-trivial logic
         - Error handling trees for critical paths
         - Data structure definitions with invariants
         - Spec-to-UC traceability chain validated
       - Master Test Plan APPROVED
       - Development Case tailored
       - Test environments OPERATIONAL

       Generate ABM Validation Report:
       - Status: PASS | FAIL
       - Criteria checklist with evidence
       - Behavioral spec coverage: X/Y use cases with realizations
       - Pseudo-code spec coverage: X/Y methods with specs
       - Decision: GO to Construction | NO-GO
       - Gaps (if NO-GO): List missing artifacts and specs

       Save to: .aiwg/reports/abm-validation-report.md
       """
   )
   ```

3. **Decision Point**:
   - If ABM PASS → Continue to Step 2
   - If ABM FAIL → Report gaps, recommend extending Elaboration
   - Escalate to user for executive decision if criteria partially met

**Communicate Progress**:
```
✓ Initialized ABM validation
⏳ Validating Elaboration exit criteria...
✓ ABM Validation complete: [PASS | FAIL]
```

### Step 2: Execute Iteration 0 (Infrastructure Setup)

**Purpose**: Scale infrastructure for full Construction team

**Your Actions**:

1. **Launch Infrastructure Setup Agents** (parallel):
   ```
   # Agent 1: DevOps Engineer
   Task(
       subagent_type="devops-engineer",
       description="Setup CI/CD pipeline and environments",
       prompt="""
       Setup Construction infrastructure:

       CI/CD Pipeline:
       - Build automation (compile, package, containerize)
       - Test automation (unit, integration, E2E)
       - Deployment automation (dev, test, staging)
       - Quality gates (coverage, security scans)

       Environments:
       - Development: Per-developer or shared
       - Test: Shared integration environment
       - Staging: Production-like validation
       - Production: Provisioned (not deployed)

       Document setup in: .aiwg/working/construction/infrastructure/ci-cd-setup.md
       """
   )

   # Agent 2: Build Engineer
   Task(
       subagent_type="build-engineer",
       description="Configure build and artifact management",
       prompt="""
       Configure build infrastructure:

       - Build scripts and configurations
       - Dependency management
       - Artifact repository setup
       - Version control branching strategy
       - Build optimization (caching, parallelization)

       Document in: .aiwg/working/construction/infrastructure/build-config.md
       """
   )

   # Agent 3: Reliability Engineer
   Task(
       subagent_type="reliability-engineer",
       description="Setup monitoring and observability",
       prompt="""
       Configure monitoring infrastructure:

       - Application metrics (APM)
       - Infrastructure metrics
       - Log aggregation and retention
       - Alerting rules and escalation
       - Dashboard creation
       - SLO/SLI definitions

       Document in: .aiwg/working/construction/infrastructure/monitoring-setup.md
       """
   )

   # Agent 4: Environment Engineer
   Task(
       subagent_type="environment-engineer",
       description="Setup development environment and tools",
       prompt="""
       Configure development environment:

       - IDE configurations and plugins
       - Local development setup (Docker, etc)
       - Debugging tools
       - Code quality tools (linters, formatters)
       - Security scanning tools
       - Collaboration tools (Slack, Jira, Wiki)

       Create developer setup guide: .aiwg/working/construction/infrastructure/dev-environment-guide.md
       """
   )
   ```

2. **Synthesize Infrastructure Report**:
   ```
   Task(
       subagent_type="devops-engineer",
       description="Create Iteration 0 Completion Report",
       prompt="""
       Read all infrastructure setup documents:
       - .aiwg/working/construction/infrastructure/*.md

       Create comprehensive Iteration 0 Completion Report:

       1. Version Control (repository, branching, access)
       2. CI/CD Pipeline (build, test, deploy status)
       3. Environments (dev, test, staging operational status)
       4. Monitoring & Observability (metrics, logs, alerts)
       5. Collaboration Tools (chat, tracking, documentation)
       6. Security (secrets management, scanning)
       7. Developer Tools (IDE, debugging, quality)

       Include:
       - Checklist of completed items
       - Outstanding items (if any)
       - Access instructions for team
       - Overall status: COMPLETE | INCOMPLETE

       Save to: .aiwg/reports/iteration-0-completion.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Setting up Construction infrastructure (Iteration 0)...
  ✓ CI/CD pipeline configured
  ✓ Environments provisioned (dev, test, staging)
  ✓ Monitoring and observability operational
  ✓ Development tools configured
✓ Iteration 0 complete: Infrastructure ready for full team
```

### Step 3: Tailor Development Process and Create Onboarding

**Purpose**: Finalize process for Construction and prepare team scaling

**Your Actions**:

1. **Launch Process Definition Agents** (parallel):
   ```
   # Agent 1: Project Manager
   Task(
       subagent_type="project-manager",
       description="Tailor Development Case for Construction",
       prompt="""
       Create Development Process Guide:

       Iteration Configuration:
       - Length: {1 week | 2 weeks | 3 weeks}
       - Ceremonies: Planning, Daily Standup, Review, Retrospective
       - Schedules and durations

       Roles and Responsibilities:
       - Update RACI matrix for Construction phase
       - Define approval processes
       - Establish escalation paths

       Workflow:
       - Definition of Ready (DoR)
       - Definition of Done (DoD)
       - Code review process
       - Deployment process

       Template: agentic/code/frameworks/sdlc-complete/templates/environments/development-case-template.md

       Save to: .aiwg/planning/development-process-guide.md
       """
   )

   # Agent 2: Software Implementer
   Task(
       subagent_type="software-implementer",
       description="Create coding and design guidelines",
       prompt="""
       Document technical guidelines:

       Design Guidelines:
       - Architecture patterns to follow
       - Component boundaries
       - API design standards
       - Data model conventions

       Programming Guidelines:
       - Coding standards (language-specific)
       - Naming conventions
       - Error handling patterns
       - Logging standards
       - Documentation requirements

       Test Guidelines:
       - Test naming and organization
       - Coverage targets
       - Test data management
       - Mocking strategies

       Save to: .aiwg/working/construction/guidelines/
       """
   )

   # Agent 3: Human Resources Coordinator
   Task(
       subagent_type="human-resources-coordinator",
       description="Create team onboarding guide",
       prompt="""
       Create comprehensive onboarding guide for new team members:

       Week 1: Orientation
       - Project overview and vision
       - Architecture walkthrough
       - Development environment setup
       - Tool access and training

       Week 2: Ramp-up
       - Codebase tour
       - First starter task assignment
       - Pair programming sessions
       - Process training

       Resources:
       - Key documentation links
       - Team contacts and expertise areas
       - FAQ and troubleshooting
       - Escalation paths

       Checklists:
       - [ ] Accounts created
       - [ ] Tools installed
       - [ ] First commit completed
       - [ ] Process training attended

       Save to: .aiwg/team/onboarding-guide.md
       """
   )
   ```

2. **Plan Team Training**:
   ```
   Task(
       subagent_type="training-coordinator",
       description="Create training schedule for Construction team",
       prompt="""
       Design training program:

       Process Training (2-4 hours):
       - Development Case walkthrough
       - Ceremony participation
       - Tool usage (Jira, GitHub, Slack)
       - Quality standards

       Technical Training (as needed):
       - Architecture overview (SAD walkthrough)
       - Coding standards
       - Test strategy
       - Deployment process

       Training Materials:
       - Slide decks
       - Recorded sessions
       - Hands-on exercises
       - Knowledge checks

       Schedule:
       - Session dates and times
       - Attendee lists
       - Completion tracking

       Save to: .aiwg/team/training-schedule.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Tailoring development process...
  ✓ Development Process Guide created
  ✓ Technical guidelines documented
  ✓ Team onboarding guide prepared
  ✓ Training schedule planned
✓ Process ready for Construction team
```

### Step 4: Plan First Two Iterations

**Purpose**: Create detailed iteration plans with ready backlog

**Your Actions**:

1. **Assess Backlog Readiness**:
   ```
   Task(
       subagent_type="requirements-analyst",
       description="Validate backlog readiness for Construction",
       prompt="""
       Assess backlog status:

       1. Count total backlog items
       2. Validate Definition of Ready (DoR) for each:
          - Use case documented
          - Acceptance criteria defined
          - Dependencies identified
          - Estimates provided
          - Risks assessed

       3. Calculate ready backlog size (story points)
       4. Assess backlog health:
          - Healthy: 1.5x-2x capacity ready
          - Marginal: 1x-1.5x capacity
          - Starved: <1x capacity

       Report:
       - Total items: {count}
       - Ready items: {count}
       - Ready size: {story points}
       - Health status: {HEALTHY | MARGINAL | STARVED}

       Save to: .aiwg/working/construction/backlog-assessment.md
       """
   )
   ```

2. **Launch Iteration Planning Agents** (sequential):
   ```
   # Iteration 1 Planning
   Task(
       subagent_type="project-manager",
       description="Plan Iteration 1 (conservative start)",
       prompt="""
       Create Iteration 1 Plan:

       Configuration:
       - Dates: {start} to {end}
       - Team capacity: {story points} (80% of full - ramp-up factor)
       - Buffer: 20% for unknowns

       Work Item Selection:
       - Prioritize: Must-have items first
       - Include: Architecture validation items
       - Avoid: High-risk items (save for Iteration 2+)
       - Target: {points} including buffer

       For each work item:
       - ID and name
       - Story points
       - Priority (MoSCoW)
       - Owner assignment
       - Dependencies
       - Acceptance criteria

       Objectives:
       - Validate development process
       - Establish team rhythm
       - Deliver first working features

       Template: $AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/management/iteration-plan-template.md

       Save to: .aiwg/planning/iteration-plan-001.md
       """
   )

   # Iteration 2 Planning
   Task(
       subagent_type="project-manager",
       description="Plan Iteration 2 (baseline velocity)",
       prompt="""
       Create Iteration 2 Plan:

       Configuration:
       - Dates: {start} to {end}
       - Team capacity: {story points} (100% - full capacity)
       - Buffer: 15% for unknowns

       Work Item Selection:
       - Continue priority order
       - Include: More complex items
       - Consider: Technical debt items
       - Target: {points} including buffer

       For each work item:
       - ID and name
       - Story points
       - Priority (MoSCoW)
       - Owner assignment
       - Dependencies
       - Acceptance criteria

       Objectives:
       - Establish baseline velocity
       - Tackle complex features
       - Refine estimation accuracy

       Template: $AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/management/iteration-plan-template.md

       Save to: .aiwg/planning/iteration-plan-002.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Planning first 2 iterations...
  ✓ Backlog assessed: {status}
  ✓ Iteration 1 planned: {points} points
  ✓ Iteration 2 planned: {points} points
✓ Iteration planning complete
```

### Step 5: Setup Dual-Track Workflow

**Purpose**: Establish parallel Discovery and Delivery tracks

**Your Actions**:

1. **Configure Dual-Track Process**:
   ```
   Task(
       subagent_type="project-manager",
       description="Setup dual-track Discovery/Delivery workflow",
       prompt="""
       Configure dual-track workflow:

       Discovery Track (Iteration N+1):
       - Team: Requirements Analyst, Product Owner, Domain Experts
       - Focus: Prepare backlog for next iteration
       - Deliverables: Ready work items passing DoR
       - Timing: 1 iteration ahead of Delivery

       Delivery Track (Iteration N):
       - Team: Developers, Testers, Component Owners
       - Focus: Implement current iteration work
       - Deliverables: Working software increments
       - Timing: Current iteration

       Synchronization:
       - Handoff: End of Discovery N → Start of Delivery N
       - Gate: Definition of Ready (DoR)
       - Cadence: Every iteration boundary

       Shared Resources:
       - Software Architect (design reviews)
       - Security Architect (security reviews)
       - Project Manager (coordination)

       Document workflow in: .aiwg/planning/dual-track-workflow.md
       """
   )
   ```

2. **Launch Initial Tracks**:
   ```
   # Start Discovery for Iteration 3
   Task(
       subagent_type="requirements-analyst",
       description="Begin Discovery track for Iteration 3",
       prompt="""
       Initiate Discovery for Iteration 3:

       1. Review product backlog priorities
       2. Select candidate items for Iteration 3
       3. Begin requirement elaboration:
          - User stories
          - Acceptance criteria
          - Interface specifications
          - Data contracts

       4. Identify dependencies and risks
       5. Coordinate with architects for feasibility

       Target: Prepare {capacity * 1.5} story points
       Due: Before Iteration 2 ends

       Track progress in: .aiwg/working/discovery/iteration-003/
       """
   )

   # Confirm Delivery ready for Iteration 1
   Task(
       subagent_type="software-implementer",
       description="Confirm Delivery track ready for Iteration 1",
       prompt="""
       Validate Delivery readiness for Iteration 1:

       1. Confirm all Iteration 1 work items ready (DoR met)
       2. Verify team assignments complete
       3. Check development environment access
       4. Validate CI/CD pipeline operational
       5. Confirm daily standup scheduled

       Report readiness status

       Save to: .aiwg/working/delivery/iteration-001/readiness.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Setting up dual-track workflow...
  ✓ Discovery track configured (Iteration 3)
  ✓ Delivery track ready (Iteration 1)
  ✓ Synchronization points established
✓ Dual-track workflow operational
```

### Step 6: Monitor Architecture Stability

**Purpose**: Ensure architecture remains stable during Construction startup

**Your Actions**:

```
Task(
    subagent_type="architecture-designer",
    description="Assess architecture stability for Construction",
    prompt="""
    Analyze architecture stability:

    1. Review architectural changes since ABM:
       - Count new ADRs created
       - Identify component boundary changes
       - Check technology stack modifications
       - Assess integration changes

    2. Calculate metrics:
       - Architectural Change Rate: % changes (target <10%)
       - ADR Frequency: ADRs per iteration
       - Component Violations: boundary breaches (target 0)
       - Prototype Divergence: % rewritten (target <30%)

    3. Identify risks:
       - Architecture drift indicators
       - Instability patterns
       - Technical debt accumulation

    4. Recommendations:
       - Continue as-is
       - Conduct architecture review
       - Adjust Construction approach

    Generate Architecture Stability Report:
    - Overall status: STABLE | UNSTABLE
    - Metrics with targets
    - Risk assessment
    - Action items

    Save to: .aiwg/reports/architecture-stability-report.md
    """
)
```

**Communicate Progress**:
```
⏳ Monitoring architecture stability...
✓ Architecture stability: [STABLE | UNSTABLE]
  - Change rate: {X}% (target <10%)
  - Component violations: {N} (target 0)
```

### Step 7: Generate Construction Readiness Report

**Purpose**: Final readiness assessment and go/no-go decision

**Your Actions**:

```
Task(
    subagent_type="project-manager",
    description="Generate Construction Phase Readiness Report",
    prompt="""
    Read all transition artifacts:
    - .aiwg/reports/abm-validation-report.md
    - .aiwg/reports/iteration-0-completion.md
    - .aiwg/planning/development-process-guide.md
    - .aiwg/planning/iteration-plan-001.md
    - .aiwg/planning/iteration-plan-002.md
    - .aiwg/team/onboarding-guide.md
    - .aiwg/reports/architecture-stability-report.md

    Generate comprehensive Construction Readiness Report:

    1. Overall Status
       - Construction Readiness: READY | NOT READY
       - Decision: PROCEED | DEFER

    2. Gate Validation (6 criteria)
       - ABM Complete: {status}
       - Infrastructure Ready: {status}
       - Process Defined: {status}
       - Iterations Planned: {status}
       - Dual-Track Setup: {status}
       - Architecture Stable: {status}

    3. Team Readiness
       - Team size and scaling status
       - Training completion
       - Onboarding materials ready

    4. Infrastructure Readiness
       - CI/CD operational
       - Environments ready
       - Monitoring configured

    5. Backlog Readiness
       - Ready backlog size vs capacity
       - DoR compliance
       - First 2 iterations planned

    6. Decision and Next Steps
       - If READY: Kickoff instructions
       - If NOT READY: Gap closure plan

    7. Success Metrics to Track
       - Velocity targets
       - Quality targets
       - Schedule targets

    Save to: .aiwg/reports/construction-readiness-report.md
    """
)
```

**Present Summary to User**:
```
# You present this directly (not via agent)

Read .aiwg/reports/construction-readiness-report.md

Present summary:
─────────────────────────────────────────────
Construction Phase Readiness Assessment
─────────────────────────────────────────────

**Overall Status**: {READY | NOT READY}
**Decision**: {PROCEED | DEFER}

**Gate Criteria Status**:
✓ Architecture Baseline Milestone: PASS
✓ Infrastructure (Iteration 0): COMPLETE
✓ Development Process: READY
✓ Iteration Planning: COMPLETE (2 sprints)
✓ Dual-Track Workflow: OPERATIONAL
✓ Architecture Stability: STABLE

**Team Scaling**:
- Elaboration team: {N} members
- Construction team: {M} members
- Onboarding status: READY

**Infrastructure**:
- CI/CD Pipeline: OPERATIONAL
- Environments: Dev, Test, Staging READY
- Monitoring: CONFIGURED

**Backlog**:
- Ready items: {X} story points
- Capacity ratio: {Y}x (target 1.5x-2x)
- Iteration 1: {Z} points planned
- Iteration 2: {W} points planned

**Artifacts Generated**:
- ABM Validation Report (.aiwg/reports/abm-validation-report.md)
- Iteration 0 Completion (.aiwg/reports/iteration-0-completion.md)
- Development Process Guide (.aiwg/planning/development-process-guide.md)
- Iteration Plans (.aiwg/planning/iteration-plan-*.md)
- Onboarding Guide (.aiwg/team/onboarding-guide.md)
- Architecture Stability (.aiwg/reports/architecture-stability-report.md)
- Construction Readiness (.aiwg/reports/construction-readiness-report.md)

**Next Steps**:
- Kick off Iteration 1: {date}
- First daily standup: {date}
- Discovery continues for Iteration 3
- Monitor velocity and quality metrics

─────────────────────────────────────────────
```

## Quality Gates

Before marking workflow complete, verify:
- [ ] All required artifacts generated and reviewed
- [ ] Infrastructure validated operational (Iteration 0)
- [ ] Team process defined and training scheduled
- [ ] First 2 iterations planned with ready backlog
- [ ] Dual-track workflow configured
- [ ] Architecture stability confirmed
- [ ] Construction readiness validated

## User Communication

**At start**: Confirm understanding and list artifacts to generate

```
Understood. I'll orchestrate the Elaboration → Construction transition.

This will generate:
- ABM Validation Report
- Iteration 0 Completion Report
- Development Process Guide
- Iteration Plans (first 2 sprints)
- Team Onboarding Guide
- Architecture Stability Report
- Construction Readiness Report

I'll coordinate multiple agents for infrastructure setup and planning.
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

**At end**: Summary report with artifact locations and status

## Error Handling

**If ABM Not Met**:
```
❌ Elaboration phase incomplete - cannot proceed to Construction

Gaps identified:
- {list missing artifacts or incomplete criteria}

Recommendation: Extend Elaboration
- Complete missing artifacts
- Re-run: /flow-inception-to-elaboration

Contact Software Architect for architecture completion.
```

**If Infrastructure Not Ready**:
```
❌ Iteration 0 incomplete - infrastructure not operational

Issues:
- {list infrastructure gaps}

Actions:
1. Complete infrastructure setup
2. Validate CI/CD pipeline
3. Confirm environment access

Impact: Construction blocked until infrastructure ready.
```

**If Backlog Starved**:
```
⚠️ Backlog health: STARVED ({ratio}x capacity)

Ready backlog insufficient for smooth Construction start.

Actions:
1. Accelerate Discovery track
2. Simplify requirements for faster preparation
3. Consider starting with reduced team

Risk: Delivery team may be blocked waiting for work.
```

**If Architecture Unstable**:
```
⚠️ Architecture stability: UNSTABLE

Metrics:
- Change rate: {X}% (target <10%)
- Violations: {N}

Recommendation: Architecture review needed
- Stabilize architecture before scaling team
- Document pending decisions as ADRs
- Consider architecture refactoring in Iteration 1

Risk: Continued instability will impact Construction velocity.
```

## Success Criteria

This orchestration succeeds when:
- [ ] Architecture Baseline Milestone validated (ABM complete)
- [ ] Iteration 0 infrastructure setup COMPLETE
- [ ] Development process tailored and team trained
- [ ] First 2 iterations planned with ready backlog
- [ ] Dual-track workflow OPERATIONAL
- [ ] Architecture stability confirmed (<10% change)
- [ ] Construction Phase Readiness Report shows READY
- [ ] Complete audit trails archived

## Metrics to Track

**During orchestration, track**:
- Team scaling time: Days to onboard new members
- Infrastructure setup time: Iteration 0 completion
- Training completion rate: % of team trained
- Backlog readiness: Ratio to team capacity
- Architecture stability: % changes since ABM
- Cycle time: Transition duration (target: 1-2 weeks, orchestration: 15-20 min)

## References

**Templates** (via $AIWG_ROOT):
- Development Case: `agentic/code/frameworks/sdlc-complete/templates/environments/development-case-template.md`
- Iteration Plan: `templates/management/iteration-plan-template.md`
- Programming Guidelines: `agentic/code/frameworks/sdlc-complete/templates/environments/programming-guidelines-template.md`
- Design Guidelines: `agentic/code/frameworks/sdlc-complete/templates/environments/design-guidelines-template.md`
- Test Guidelines: `agentic/code/frameworks/sdlc-complete/templates/environments/test-guidelines-template.md`

**Gate Criteria**:
- `flows/gate-criteria-by-phase.md` (Construction section)

**Related Flows**:
- `commands/flow-iteration-dual-track.md`
- `commands/flow-discovery-track.md`
- `commands/flow-delivery-track.md`

**Multi-Agent Pattern**:
- `docs/multi-agent-documentation-pattern.md`

**Orchestrator Architecture**:
- `docs/orchestrator-architecture.md`