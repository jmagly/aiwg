---
namespace: aiwg
name: flow-retrospective-cycle
platforms: [all]
description: Orchestrate systematic retrospective cycle with structured feedback collection, improvement tracking, and action item management
commandHint:
  argumentHint: '[retrospective-type] [iteration-number] [project-directory] [--guidance "text"] [--interactive]'
  allowedTools: 'Task, Read, Write, Glob, TodoWrite'
  model: sonnet
  category: sdlc-orchestration
  orchestration: true
  modelRole: coding
  modelTier: standard
---

> **Declarative Flow (#1539):** This flow's orchestration is now also expressed as a
> declarative YAML Flow at `flows/flow-retrospective-cycle.playbook.yaml` (source of truth for the step
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


# Retrospective Cycle Flow

**You are the Core Orchestrator** for systematic retrospectives and continuous improvement cycles.

## Your Role

**You orchestrate multi-agent workflows. You do NOT execute bash scripts.**

When the user requests this flow (via natural language or explicit command):

1. **Interpret the request** and confirm understanding
2. **Read this template** as your orchestration guide
3. **Extract agent assignments** and workflow steps
4. **Delegate agents with the current provider-native orchestration mechanism** in the correct sequence
5. **Synthesize results** and finalize artifacts
6. **Report completion** with summary

## Retrospective Overview

**Purpose**: Facilitate structured team retrospectives to identify improvements, track action items, and measure effectiveness.

**Key Outputs**:
- Retrospective summary with insights
- Prioritized action items with owners
- Pattern analysis across retrospectives
- Improvement effectiveness metrics

**Success Criteria**:
- All team members participate
- At least 3 improvement opportunities identified
- 2-3 action items created with clear ownership
- Previous action items reviewed and updated
- Patterns documented across multiple retrospectives

**Expected Duration**: 2-3 hours (meeting), 30-45 minutes orchestration

## Natural Language Triggers

Users may say:
- "Run retrospective"
- "Hold retro"
- "Let's do a retrospective"
- "Retrospective for iteration {N}"
- "Sprint retrospective"
- "Team retrospective"
- "Post-incident review"
- "Lessons learned session"
- "What went well, what could improve"

You recognize these as requests for this orchestration flow.

## Parameter Handling

### Retrospective Types

- **iteration**: End-of-iteration retrospective (1-2 weeks)
- **release**: End-of-release retrospective (major milestone)
- **phase**: End-of-phase retrospective (Inception, Elaboration, Construction, Transition)
- **incident**: Post-incident retrospective (production issues)
- **project**: End-of-project retrospective (full lifecycle review)

### --guidance Parameter

**Purpose**: User provides upfront direction to tailor retrospective focus

**Examples**:
```
--guidance "Focus on team morale and burnout issues"
--guidance "Deep dive on quality problems, high defect rate"
--guidance "Address communication gaps between teams"
--guidance "Review deployment failures and infrastructure issues"
```

**How to Apply**:
- Parse guidance for keywords: morale, quality, communication, technical, process
- Select appropriate retrospective format (Mad/Sad/Glad for morale, Timeline for incidents)
- Adjust facilitation questions and focus areas
- Influence action item priorities

### --interactive Parameter

**Purpose**: You ask 6 strategic questions to understand retrospective context

**Questions to Ask** (if --interactive):

```
I'll ask 6 strategic questions to tailor the retrospective to your needs:

Q1: What are your main concerns or pain points from this iteration/phase?
    (Helps focus discussion on most impactful areas)

Q2: How would you rate team morale (1-10) and why?
    (Determines if we need morale-focused format like Mad/Sad/Glad)

Q3: Were there any major incidents or failures to discuss?
    (Indicates need for Timeline retrospective or root cause analysis)

Q4: What's your team's retrospective maturity?
    (New to retros, experienced, struggling with follow-through)

Q5: How many previous action items are still open?
    (Indicates potential action item overload or execution issues)

Q6: What specific outcomes do you want from this retrospective?
    (Clear goals help focus facilitation and ensure value)

Based on your answers, I'll:
- Select optimal retrospective format
- Focus on highest-impact areas
- Adjust facilitation approach
- Prioritize action item categories
```

**Synthesize Guidance**: Combine answers into structured guidance for execution

## Retrospective Formats

### Start/Stop/Continue
**Best for**: General purpose retrospectives, teams new to retros
- What should we START doing?
- What should we STOP doing?
- What should we CONTINUE doing?

### 4Ls (Liked, Learned, Lacked, Longed For)
**Best for**: Learning-focused retrospectives, new technology adoption
- What did we LIKE about this iteration?
- What did we LEARN?
- What did we LACK (missing resources, skills, information)?
- What did we LONG FOR (wish we had)?

### Mad/Sad/Glad
**Best for**: Addressing team morale and emotional health
- What made us MAD (frustrations)?
- What made us SAD (disappointments)?
- What made us GLAD (celebrations)?

### Timeline Retrospective
**Best for**: Complex iterations, incident retrospectives
- Create timeline of key events
- Mark emotional highs and lows
- Identify turning points
- Discuss root causes

### Sailboat Retrospective
**Best for**: Identifying impediments and accelerators
- Wind (what's helping us move forward?)
- Anchor (what's holding us back?)
- Rocks (risks ahead)
- Island (our goal)

## Multi-Agent Orchestration Workflow

### Step 1: Pre-Retrospective Preparation

**Purpose**: Gather data and prepare for effective retrospective session

**Your Actions**:

1. **Collect Metrics and Context**:
   ```
   Read existing artifacts:
   - .aiwg/planning/iteration-plans/*.md (recent iterations)
   - .aiwg/quality/code-reviews/*.md (quality trends)
   - .aiwg/testing/test-results/*.md (defect trends)
   - .aiwg/reports/previous-retrospectives/*.md (past retros)
   ```

2. **Launch Pre-Retro Analysis** (parallel agents):
   ```
   # Agent 1: Metrics Analyst
   Task(
       subagent_type="scrum-master",
       description="Collect iteration metrics for retrospective",
       prompt="""
       Gather metrics for retrospective preparation:

       Iteration Performance:
       - Velocity: Story points planned vs. completed
       - Cycle time: Average time from start to done
       - Defect escape rate: Bugs found in production
       - Deployment frequency: Number of deployments

       Quality Metrics:
       - Test coverage: Current percentage and trend
       - Code review cycle time: PR open to merge
       - Technical debt: Time spent on refactoring

       Team Health:
       - Unplanned work: Percentage of iteration
       - Meeting effectiveness: Time in meetings
       - On-call incidents: Number and severity

       Previous Actions:
       - Review .aiwg/reports/retrospectives/action-items.md
       - Status of previous action items (completed, in progress, blocked)

       Create metrics summary:
       Save to: .aiwg/working/retrospective/metrics-summary.md
       """
   )

   # Agent 2: Feedback Collector
   Task(
       subagent_type="agile-coach",
       description="Design pre-retrospective survey",
       prompt="""
       Create anonymous feedback survey for team members:

       Survey Questions:
       1. Rate this iteration (1-10) and why?
       2. What was your biggest win this iteration?
       3. What was your biggest challenge?
       4. What one thing would improve our team's effectiveness?
       5. Any topics you want discussed in the retrospective?

       Format Selection:
       Based on context, recommend retrospective format:
       - If morale issues → Mad/Sad/Glad
       - If incident occurred → Timeline
       - If general iteration → Start/Stop/Continue
       - If learning focus → 4Ls

       Create survey template:
       Save to: .aiwg/working/retrospective/pre-retro-survey.md
       """
   )

   # Agent 3: Pattern Analyzer
   Task(
       subagent_type="retrospective-analyzer",
       description="Identify patterns from previous retrospectives",
       prompt="""
       Read previous retrospectives: .aiwg/reports/retrospectives/*.md

       Identify patterns:
       - Recurring issues (appearing in 3+ retrospectives)
       - Chronic incomplete actions (never resolved)
       - Improvement trends (what's getting better/worse)
       - Team dynamics patterns

       Categorize patterns:
       - Process issues
       - Technical challenges
       - Communication gaps
       - Tool/infrastructure problems
       - Team health concerns

       Create pattern analysis:
       Save to: .aiwg/working/retrospective/pattern-analysis.md
       """
   )
   ```

3. **Prepare Retrospective Agenda**:
   ```
   Task(
       subagent_type="scrum-master",
       description="Create retrospective agenda",
       prompt="""
       Read preparation artifacts:
       - .aiwg/working/retrospective/metrics-summary.md
       - .aiwg/working/retrospective/pre-retro-survey.md
       - .aiwg/working/retrospective/pattern-analysis.md

       Create structured agenda:

       1. Set the Stage (10 min)
          - Welcome and safety check
          - Review working agreements
          - Share agenda and format

       2. Gather Data (20 min)
          - Review metrics summary
          - Share survey highlights
          - Timeline reconstruction (if applicable)

       3. Generate Insights (30 min)
          - {Selected format activities}
          - Pattern discussion
          - Root cause analysis for key issues

       4. Decide What to Do (20 min)
          - Dot voting on improvements
          - Convert top items to actions
          - Assign owners and dates

       5. Close (10 min)
          - Appreciation round
          - Commitment check
          - Next steps

       Total Duration: 90 minutes

       Save to: .aiwg/working/retrospective/agenda.md
       """
   )
   ```

**Communicate Progress**:
```
✓ Pre-retrospective preparation complete
  ✓ Metrics collected (velocity, quality, team health)
  ✓ Survey template created
  ✓ Patterns analyzed from 5 previous retrospectives
  ✓ Agenda prepared (90-minute session)
```

### Step 2: Facilitate Retrospective Session

**Purpose**: Guide structured retrospective using selected format

**Your Actions**:

1. **Set the Stage**:
   ```
   Task(
       subagent_type="scrum-master",
       description="Initialize retrospective session",
       prompt="""
       Create retrospective session opening:

       Safety Check:
       - Psychological safety reminder (no blame culture)
       - Vegas rule (what's said here, stays here)
       - Focus on systems, not people

       Working Agreements:
       - One conversation at a time
       - All ideas are valid
       - Time-boxed discussions
       - Action items must have owners

       Format Introduction:
       - Explain selected format: {format}
       - Set expectations for participation
       - Review timeline (90 minutes)

       Create session initialization:
       Save to: .aiwg/working/retrospective/session-opening.md
       """
   )
   ```

2. **Facilitate Format-Specific Activities** (based on selected format):
   ```
   # Example: Start/Stop/Continue Format
   Task(
       subagent_type="agile-coach",
       description="Facilitate Start/Stop/Continue retrospective",
       prompt="""
       Read metrics and patterns:
       - .aiwg/working/retrospective/metrics-summary.md
       - .aiwg/working/retrospective/pattern-analysis.md

       Facilitate discussion:

       START (What should we start doing?):
       - New practices to adopt
       - Tools or processes to try
       - Experiments to run

       STOP (What should we stop doing?):
       - Wasteful activities
       - Ineffective meetings
       - Outdated processes

       CONTINUE (What should we continue doing?):
       - Successful practices
       - Effective collaborations
       - Working processes

       For each category:
       - Brainstorm items (5-10 per category)
       - Group similar items
       - Discuss themes

       Create categorized lists:
       Save to: .aiwg/working/retrospective/start-stop-continue.md
       """
   )
   ```

3. **Generate Insights and Root Causes**:
   ```
   Task(
       subagent_type="retrospective-analyzer",
       description="Analyze feedback and identify root causes",
       prompt="""
       Read retrospective feedback:
       - .aiwg/working/retrospective/{format-output}.md

       Generate insights:

       1. Identify Top Issues (3-5):
          - Most mentioned problems
          - Highest impact on team
          - Easiest to address

       2. Root Cause Analysis (5 Whys):
          For each top issue:
          - Why did this happen? (surface cause)
          - Why did that occur? (deeper)
          - Continue until root cause found

       3. Pattern Recognition:
          - Link to historical patterns
          - Identify systemic issues
          - Highlight chronic problems

       4. Improvement Hypotheses:
          - If we do X, we expect Y
          - Measurable outcomes
          - Success criteria

       Create insights document:
       Save to: .aiwg/working/retrospective/insights-and-root-causes.md
       """
   )
   ```

**Communicate Progress**:
```
✓ Retrospective session facilitated
  ✓ Safety check and working agreements established
  ✓ {Format} activities completed
  ✓ 15+ improvement ideas generated
  ✓ Root causes identified for top 3 issues
```

### Step 3: Create and Prioritize Action Items

**Purpose**: Convert insights into specific, actionable improvements

**Your Actions**:

1. **Prioritize Improvements**:
   ```
   Task(
       subagent_type="scrum-master",
       description="Prioritize retrospective improvements",
       prompt="""
       Read insights: .aiwg/working/retrospective/insights-and-root-causes.md

       Prioritization using dot voting simulation:

       Criteria for prioritization:
       - Impact: How much will this help? (High/Medium/Low)
       - Effort: How hard is it to implement? (High/Medium/Low)
       - Team control: Can we do this ourselves? (Yes/Partial/No)

       Create prioritization matrix:
       - Quick wins (High impact, Low effort)
       - Strategic improvements (High impact, High effort)
       - Fill-ins (Low impact, Low effort)
       - Avoid (Low impact, High effort)

       Select top 2-3 improvements:
       - At least 1 quick win
       - No more than 1 high-effort item
       - Must be within team's control

       Document prioritization:
       Save to: .aiwg/working/retrospective/prioritized-improvements.md
       """
   )
   ```

2. **Create SMART Action Items**:
   ```
   Task(
       subagent_type="project-manager",
       description="Convert improvements to SMART action items",
       prompt="""
       Read prioritized improvements: .aiwg/working/retrospective/prioritized-improvements.md

       For each improvement (2-3 total), create SMART action item:

       Template:
       - Title: Clear, action-oriented title
       - Specific: What exactly will be done?
       - Measurable: How will we know it's complete?
       - Achievable: Is this realistic in 1-2 iterations?
       - Relevant: How does this address the root cause?
       - Time-bound: Due date (typically next retro)
       - Owner: Who is responsible? (specific person)
       - Success Criteria: Observable outcome

       Example:
       Title: Implement PR review SLA
       Specific: Add automated reminder for PRs open >24 hours
       Measurable: 90% of PRs reviewed within 24 hours
       Achievable: Yes, GitHub Actions supports this
       Relevant: Addresses slow feedback cycle pain point
       Time-bound: Implemented by next iteration (2 weeks)
       Owner: DevOps Lead (John Smith)
       Success: Average PR review time <24 hours for 2 weeks

       Create action items document:
       Save to: .aiwg/working/retrospective/action-items.md
       """
   )
   ```

3. **Link to Work Management**:
   ```
   Task(
       subagent_type="scrum-master",
       description="Create work items for action items",
       prompt="""
       Read action items: .aiwg/working/retrospective/action-items.md

       For each action item, create:

       1. Work Package Card:
          Use template: $AIWG_ROOT/.../work-package-card-template.md
          - Type: Improvement
          - Priority: High (retro action)
          - Iteration: Next iteration
          - Acceptance criteria from success criteria

       2. Add to Backlog:
          - Reserve capacity (10-20% of iteration)
          - Link to retrospective
          - Tag as "retro-action"

       3. Tracking Entry:
          Update: .aiwg/reports/retrospectives/action-tracker.md
          - Action ID (RETRO-{date}-{number})
          - Status: NOT_STARTED
          - Due date
          - Owner

       Create work packages:
       Save to: .aiwg/planning/work-packages/retro-actions-{date}.md
       """
   )
   ```

**Communicate Progress**:
```
✓ Action items created and assigned
  ✓ 3 improvements prioritized (2 quick wins, 1 strategic)
  ✓ SMART action items defined with owners
  ✓ Work packages created in backlog
  ✓ Tracking system updated
```

### Step 4: Document Retrospective Summary

**Purpose**: Create comprehensive record of retrospective outcomes

**Your Actions**:

1. **Generate Retrospective Report**:
   ```
   Task(
       subagent_type="scrum-master",
       description="Create retrospective summary report",
       prompt="""
       Read all retrospective artifacts:
       - .aiwg/working/retrospective/metrics-summary.md
       - .aiwg/working/retrospective/{format-output}.md
       - .aiwg/working/retrospective/insights-and-root-causes.md
       - .aiwg/working/retrospective/action-items.md
       - .aiwg/reports/retrospectives/action-tracker.md (previous actions)

       Create comprehensive report:

       # {Retrospective Type} Retrospective - {Iteration/Phase}

       **Date**: {current-date}
       **Participants**: {count} team members
       **Format**: {format used}
       **Facilitator**: Scrum Master

       ## Metrics Summary
       - Velocity: {points} (trend: {up/down/stable})
       - Cycle Time: {days} (trend: {up/down/stable})
       - Defect Rate: {percentage}%
       - Team Satisfaction: {score}/10

       ## Previous Action Items Review
       - Total: {count}
       - Completed: {count} ({percentage}%)
       - In Progress: {count}
       - Blocked: {count}

       ## What Went Well
       {List positive items with specific examples}

       ## What Could Improve
       {List improvement areas with specific examples}

       ## Root Cause Analysis

       Top Issue #1: {issue}
       Root Cause: {5 whys result}

       Top Issue #2: {issue}
       Root Cause: {5 whys result}

       ## Action Items

       1. {Action title}
          - Owner: {name}
          - Due: {date}
          - Success Criteria: {measurable outcome}

       2. {Action title}
          - Owner: {name}
          - Due: {date}
          - Success Criteria: {measurable outcome}

       3. {Action title}
          - Owner: {name}
          - Due: {date}
          - Success Criteria: {measurable outcome}

       ## Patterns and Trends
       {Patterns identified across retrospectives}

       ## Team Appreciation
       {Shout-outs and recognition}

       ## Next Retrospective
       - Date: {scheduled date}
       - Format: {proposed format}
       - Focus Areas: {topics to explore}

       Save to: .aiwg/reports/retrospectives/retro-{date}.md
       """
   )
   ```

2. **Update Action Item Tracker**:
   ```
   Task(
       subagent_type="project-manager",
       description="Update master action item tracker",
       prompt="""
       Read current tracker: .aiwg/reports/retrospectives/action-tracker.md
       Read new actions: .aiwg/working/retrospective/action-items.md

       Update tracker with:

       1. New Actions:
          - Add new action items with IDs
          - Status: NOT_STARTED
          - Source: Retro-{date}

       2. Previous Actions:
          - Update status (COMPLETED, IN_PROGRESS, BLOCKED, CANCELLED)
          - Add completion evidence if done
          - Document blockers if stuck

       3. Metrics:
          - Total actions to date
          - Completion rate (rolling 90 days)
          - Average time to completion
          - Chronic issues (3+ retros)

       Save updated tracker to: .aiwg/reports/retrospectives/action-tracker.md
       """
   )
   ```

3. **Archive Working Files**:
   ```
   # You do this directly
   mkdir -p .aiwg/archive/retrospectives/{date}
   mv .aiwg/working/retrospective/* .aiwg/archive/retrospectives/{date}/

   Create audit trail:
   .aiwg/archive/retrospectives/{date}/audit-trail.md
   ```

**Communicate Progress**:
```
✓ Retrospective documentation complete
  ✓ Comprehensive report generated
  ✓ Action tracker updated (lifetime: 47 actions, 72% completion rate)
  ✓ Working files archived
```

### Step 5: Track and Measure Effectiveness

**Purpose**: Monitor action item progress and measure improvement impact

**Your Actions**:

1. **Setup Progress Tracking**:
   ```
   Task(
       subagent_type="scrum-master",
       description="Create action item progress tracking",
       prompt="""
       Read action items: .aiwg/reports/retrospectives/action-tracker.md

       Create tracking mechanisms:

       1. Weekly Check-in Template:
          - Action item status review
          - Blocker identification
          - Progress percentage
          - Help needed flag

       2. Reminder Schedule:
          - Day 3: Initial progress check
          - Day 7: Mid-point review
          - Day 10: Final push reminder
          - Day 14: Due date

       3. Escalation Path:
          - If blocked >3 days: Team lead
          - If blocked >7 days: Manager
          - If chronic (3+ retros): Executive

       Create tracking template:
       Save to: .aiwg/reports/retrospectives/progress-tracking-template.md
       """
   )
   ```

2. **Define Success Metrics**:
   ```
   Task(
       subagent_type="retrospective-analyzer",
       description="Define improvement effectiveness metrics",
       prompt="""
       Read action items: .aiwg/working/retrospective/action-items.md

       For each action item, define:

       1. Baseline Metric:
          - Current state measurement
          - Data source
          - Collection method

       2. Target Metric:
          - Expected improvement
          - Success threshold
          - Measurement timeline

       3. Validation Method:
          - How to measure (automated, manual)
          - When to measure (daily, weekly)
          - Who validates (owner, team)

       Example:
       Action: Implement PR review SLA
       Baseline: Average PR review time = 48 hours
       Target: Average PR review time < 24 hours
       Validation: GitHub API daily report for 2 weeks

       Create metrics definition:
       Save to: .aiwg/reports/retrospectives/effectiveness-metrics.md
       """
   )
   ```

3. **Generate Follow-up Tasks**:
   ```
   Task(
       subagent_type="project-manager",
       description="Create follow-up tasks",
       prompt="""
       Create TodoWrite items for retrospective follow-up:

       Immediate (Due in 3 days):
       - [ ] Share retrospective summary with team
       - [ ] Add action items to sprint backlog
       - [ ] Schedule action item kick-off meeting

       Weekly (Recurring):
       - [ ] Review action item progress in standup
       - [ ] Update action tracker status
       - [ ] Identify and escalate blockers

       Before Next Retro:
       - [ ] Measure improvement effectiveness
       - [ ] Collect evidence of completion
       - [ ] Prepare action item status report

       Use TodoWrite tool to create tasks with due dates
       """
   )
   ```

**Communicate Progress**:
```
✓ Effectiveness tracking established
  ✓ Progress tracking template created
  ✓ Success metrics defined for all actions
  ✓ Follow-up tasks scheduled
```

## Success Criteria

This orchestration succeeds when:
- [ ] Pre-retrospective data collected (metrics, patterns, survey)
- [ ] Retrospective session facilitated with chosen format
- [ ] All team members participated (or input collected)
- [ ] At least 3 improvement opportunities identified
- [ ] 2-3 SMART action items created with owners
- [ ] Previous action items reviewed and updated
- [ ] Retrospective summary report generated
- [ ] Action item tracker updated
- [ ] Effectiveness metrics defined
- [ ] Follow-up tasks scheduled

## Common Anti-Patterns and Remediation

### Low Participation
**Detection**: <50% team attendance or engagement
**Remediation**:
- Use anonymous surveys for input
- Rotate retrospective times
- Try different formats to re-engage
- Consider shorter, more frequent retros

### Action Items Not Completed
**Detection**: <50% completion rate
**Remediation**:
- Reduce to 1-2 action items maximum
- Ensure items are within team control
- Reserve explicit capacity in iteration
- Escalate systemic blockers

### Same Issues Recurring
**Detection**: Issue appears in 3+ consecutive retrospectives
**Remediation**:
- Escalate to leadership as systemic issue
- Conduct focused problem-solving session
- Consider bringing in external facilitator
- Document as organizational impediment

### Superficial Analysis
**Detection**: Actions address symptoms, not root causes
**Remediation**:
- Use 5 Whys or fishbone diagrams
- Extend time for insight generation
- Bring in subject matter experts
- Conduct separate deep-dive sessions

## Quality Gates

Before marking workflow complete, verify:
- [ ] All artifacts saved to appropriate .aiwg/ directories
- [ ] Previous retrospectives reviewed for patterns
- [ ] Action items are SMART and assigned
- [ ] Tracking mechanisms established
- [ ] Summary report comprehensive and actionable

## User Communication

**At start**: Confirm understanding and outline process

```
Understood. I'll orchestrate a {type} retrospective cycle.

This will:
- Collect metrics and prepare agenda
- Facilitate {format} retrospective format
- Identify root causes and patterns
- Create 2-3 SMART action items
- Setup tracking and effectiveness measures

Expected duration: 30-45 minutes orchestration

Starting retrospective cycle...
```

**During**: Update progress with clear status indicators

```
✓ = Complete
⏳ = In progress
📊 = Metrics collected
🎯 = Action items created
```

**At end**: Summary with key outcomes and next steps

```
═══════════════════════════════════════════════
Retrospective Cycle Complete
═══════════════════════════════════════════════

**Type**: {Iteration} Retrospective
**Format Used**: Start/Stop/Continue
**Participation**: 8/10 team members

**Key Metrics**:
- Velocity: 42 points (↑ from 38)
- Cycle Time: 3.2 days (↓ from 4.1)
- Team Satisfaction: 7.5/10 (↑ from 6.8)

**Previous Actions**: 3 total
- Completed: 2 (67%)
- In Progress: 1 (33%)

**New Action Items**: 3 created
1. Implement PR review SLA automation
   Owner: DevOps Lead | Due: 2 weeks

2. Establish coding standards document
   Owner: Tech Lead | Due: 3 weeks

3. Add integration test coverage
   Owner: QA Lead | Due: Next iteration

**Patterns Identified**:
- Code review delays (4 retros)
- Test coverage gaps (3 retros)
- Documentation debt (5 retros)

**Artifacts Created**:
- Retrospective Report: .aiwg/reports/retrospectives/retro-{date}.md
- Action Tracker: .aiwg/reports/retrospectives/action-tracker.md
- Work Packages: .aiwg/planning/work-packages/retro-actions-{date}.md

**Next Steps**:
1. Share summary with team
2. Add actions to sprint backlog
3. Weekly progress reviews
4. Next retro: {date} (2 weeks)

═══════════════════════════════════════════════
```

## Error Handling

**If Low Participation**:
```
⚠️ Low participation detected: {count}/{total} team members

Adjusting approach:
- Collecting asynchronous feedback
- Extending input window to 24 hours
- Using anonymous survey format

Consider scheduling follow-up session for full team input.
```

**If Chronic Issues Detected**:
```
⚠️ Chronic issue detected: {issue} (appeared in 5 consecutive retros)

This requires escalation:
- Issue documented as organizational impediment
- Escalation report prepared for leadership
- Root cause analysis indicates systemic blocker

Recommendation: Schedule focused problem-solving session with stakeholders
```

**If Action Overload**:
```
⚠️ High number of incomplete actions: {count} open items

Recommendation:
- Close stale items (>60 days old)
- Limit new actions to 1-2 maximum
- Focus on highest impact items only
- Consider action item amnesty

Adjusting to create only 2 new actions (down from 3)
```

## References

**Templates** (via $AIWG_ROOT):
- Retrospective: `templates/management/retrospective-template.md`
- Action Tracker: `templates/management/action-item-tracker.md`
- Work Package: `templates/management/work-package-card-template.md`
- Lessons Learned: `templates/management/lessons-learned-card.md`

**Retrospective Formats**:
- Agile Retrospectives by Derby & Larsen
- Retromat.org format library

**Related Flows**:
- `flow-iteration-planning` - Plan iterations with retro actions
- `flow-gate-check` - Include retro completion in gates
- `flow-change-control` - Process improvements may need CCB

**Metrics Tracking**:
- `metrics/team-health-metrics.md`
- `metrics/process-efficiency-metrics.md`