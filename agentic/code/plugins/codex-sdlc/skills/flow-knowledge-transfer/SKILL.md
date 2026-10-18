---
namespace: aiwg
name: flow-knowledge-transfer
platforms: [all]
description: Orchestrate Knowledge Transfer flow with assessment, documentation, shadowing, validation, and handover
commandHint:
  argumentHint: <from-member> <to-member> [domain] [--guidance "text"] [--interactive]
  allowedTools: Task, Read, Write, Glob, TodoWrite
  model: sonnet
  category: sdlc-orchestration
  orchestration: true
  modelRole: coding
  modelTier: standard
---

> **Declarative Flow (#1539):** This flow's orchestration is now also expressed as a
> declarative YAML Flow at `flows/flow-knowledge-transfer.playbook.yaml` (source of truth for the step
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


# Knowledge Transfer Orchestration Flow

**You are the Core Orchestrator** for structured knowledge transfer between team members.

## Your Role

**You orchestrate multi-agent workflows. You do NOT execute bash scripts.**

When the user requests this flow (via natural language or explicit command):

1. **Interpret the request** and confirm understanding
2. **Read this template** as your orchestration guide
3. **Extract agent assignments** and workflow steps
4. **Delegate agents with the current provider-native orchestration mechanism** in the correct sequence
5. **Synthesize results** and finalize artifacts
6. **Report completion** with summary

## Knowledge Transfer Overview

**Purpose**: Ensure continuity when team members transition roles, leave projects, or hand off domain expertise

**Key Milestone**: Knowledge Transfer Signoff

**Success Criteria**:
- Knowledge gaps identified and addressed
- Documentation complete and reviewed
- Shadowing and reverse shadowing completed
- Practical validation passed
- Handover checklist signed off

**Expected Duration**: 2-6 weeks (typical), 30-45 minutes orchestration

## Natural Language Triggers

Users may say:
- "Knowledge transfer from Alice to Bob"
- "Handoff backend responsibilities to new team member"
- "Transfer knowledge from {from} to {to}"
- "Documentation handoff for {domain}"
- "Onboard new team member to {area}"

You recognize these as requests for this orchestration flow.

## Parameter Handling

### Required Parameters

- **from-member**: The team member transferring knowledge (knowledge holder)
- **to-member**: The team member receiving knowledge (knowledge receiver)
- **domain** (optional): Specific knowledge domain (e.g., "backend-api", "deployment", "security")

### --guidance Parameter

**Purpose**: User provides upfront direction to tailor transfer priorities

**Examples**:
```
--guidance "Focus on production support and incident response procedures"
--guidance "Tight timeline, prioritize critical operational knowledge"
--guidance "Receiver has strong technical background but no domain experience"
--guidance "Include compliance and regulatory knowledge for audit requirements"
```

**How to Apply**:
- Parse guidance for keywords: operations, compliance, security, timeline, experience level
- Adjust focus areas (operational vs. architectural knowledge)
- Modify shadowing depth (minimal vs. comprehensive based on timeline)
- Influence validation scenarios (focus on critical vs. comprehensive testing)

### --interactive Parameter

**Purpose**: You ask 6 strategic questions to understand transfer context

**Questions to Ask** (if --interactive):

```
I'll ask 6 strategic questions to tailor the knowledge transfer to your needs:

Q1: What are your top priorities for this knowledge transfer?
    (e.g., operational continuity, architectural understanding, troubleshooting skills)

Q2: What are your biggest constraints?
    (e.g., timeline, availability of knowledge holder, complexity of domain)

Q3: What risks concern you most for this transfer?
    (e.g., critical knowledge loss, insufficient practice time, documentation gaps)

Q4: What's the receiver's experience level with similar domains?
    (Helps calibrate transfer depth and pace)

Q5: What's your target timeline for independent operation?
    (Influences shadowing duration and validation rigor)

Q6: Are there compliance or regulatory requirements?
    (e.g., SOX separation of duties, HIPAA training requirements)

Based on your answers, I'll adjust:
- Focus areas (operational vs. architectural vs. compliance)
- Shadowing duration (standard vs. extended)
- Validation rigor (basic vs. comprehensive)
- Documentation depth (reference vs. tutorial)
```

**Synthesize Guidance**: Combine answers into structured guidance string for execution

## Artifacts to Generate

**Primary Deliverables**:
- **Knowledge Map**: Domain expertise assessment → `.aiwg/knowledge/knowledge-map-{domain}.md`
- **Transfer Plan**: Structured handoff schedule → `.aiwg/knowledge/transfer-plan-{from}-to-{to}.md`
- **Documentation Package**: Updated/created docs → `.aiwg/knowledge/docs/`
- **Shadowing Logs**: Observation records → `.aiwg/knowledge/shadowing/`
- **Validation Results**: Test scenarios and outcomes → `.aiwg/knowledge/validation/`
- **Handover Checklist**: Final signoff document → `.aiwg/knowledge/handover-checklist-{domain}.md`
- **Transfer Report**: Completion summary → `.aiwg/reports/knowledge-transfer-report-{domain}.md`

**Supporting Artifacts**:
- Knowledge gap analysis
- Runbook updates
- Training materials
- Follow-up plans

## Multi-Agent Orchestration Workflow

### Step 1: Knowledge Assessment and Transfer Scope

**Purpose**: Identify knowledge domain(s) and define transfer scope

**Your Actions**:

1. **Validate Team Members Exist**:
   ```
   Read .aiwg/team/team-profile.yaml (if exists)
   Verify from-member and to-member are valid team members
   If not found, proceed with provided names but note in report
   ```

2. **Launch Knowledge Assessment Agents** (parallel):
   ```
   # Agent 1: Knowledge Manager (lead)
   Task(
       subagent_type="knowledge-manager",
       description="Assess knowledge domain and create transfer scope",
       prompt="""
       Create knowledge assessment for transfer:
       - From: {from-member}
       - To: {to-member}
       - Domain: {domain if specified, else "all responsibilities"}

       Define Knowledge Map:
       1. Knowledge Areas (list all relevant areas)
       2. Criticality Assessment (Critical, High, Medium, Low)
       3. Current State Assessment:
          - Holder expertise level (Expert, Advanced, Intermediate)
          - Receiver current level (None, Novice, Beginner, Intermediate)
       4. Knowledge Gaps (delta between holder and receiver)
       5. Transfer Priority (HIGH, MEDIUM, LOW for each area)

       Define Transfer Scope:
       - In Scope: Areas requiring active transfer
       - Out of Scope: Already documented or low priority
       - Success Criteria: What defines successful transfer

       Estimate Timeline:
       - Based on scope and gaps
       - Typical: 2-6 weeks

       Use template if available: $AIWG_ROOT/templates/knowledge/knowledge-map-template.md

       Output: .aiwg/knowledge/knowledge-map-{domain}.md
       """
   )

   # Agent 2: Training Coordinator
   Task(
       subagent_type="training-coordinator",
       description="Create structured transfer plan",
       prompt="""
       Based on knowledge assessment, create transfer plan:

       Structure:
       1. Documentation Phase (Week 1)
          - Review existing docs
          - Identify and fill gaps
          - Create runbooks

       2. Shadowing Phase (Week 2-3)
          - 4-8 observation sessions
          - Knowledge holder leads, receiver observes
          - Q&A and note-taking

       3. Reverse Shadowing (Week 3-4)
          - 4-8 practice sessions
          - Receiver leads, holder observes
          - Feedback and correction

       4. Validation Phase (Week 4-5)
          - Practical scenarios
          - Independent operation test
          - Knowledge verification

       5. Handover Phase (Week 5-6)
          - Final checklist
          - Signoffs
          - Follow-up plan

       Adjust timeline based on:
       - Scope complexity
       - Availability constraints
       - {guidance if provided}

       Use template if available: $AIWG_ROOT/templates/knowledge/transfer-plan-template.md

       Output: .aiwg/knowledge/transfer-plan-{from}-to-{to}.md
       """
   )
   ```

3. **Review and Confirm Scope**:
   ```
   Task(
       subagent_type="project-manager",
       description="Review and validate transfer scope",
       prompt="""
       Read:
       - .aiwg/knowledge/knowledge-map-{domain}.md
       - .aiwg/knowledge/transfer-plan-{from}-to-{to}.md

       Validate:
       - Scope is realistic for timeline
       - Critical knowledge areas covered
       - Success criteria are measurable
       - Plan accounts for constraints

       Create gate decision:
       - GO: Proceed with transfer
       - ADJUST: Modify scope or timeline
       - ESCALATE: Needs management decision

       Output validation summary to transfer plan
       """
   )
   ```

**Communicate Progress**:
```
✓ Knowledge assessment complete
✓ Transfer scope defined: {X} knowledge areas, {Y} weeks estimated
✓ Transfer plan created: .aiwg/knowledge/transfer-plan-{from}-to-{to}.md
```

### Step 2: Documentation Review and Knowledge Artifacts

**Purpose**: Compile and enhance documentation for knowledge transfer

**Your Actions**:

1. **Inventory Existing Documentation**:
   ```
   # Use Glob to find relevant docs
   Glob("**/*.md")
   Glob("**/*.txt")

   Filter for domain-relevant documentation
   Create inventory list
   ```

2. **Launch Documentation Agents** (parallel):
   ```
   # Agent 1: Documentation Archivist
   Task(
       subagent_type="documentation-archivist",
       description="Organize and review existing documentation",
       prompt="""
       Domain: {domain}

       Review existing documentation:
       1. Architecture documents
       2. Runbooks and procedures
       3. Configuration guides
       4. Troubleshooting guides
       5. Historical incident reports

       Assess each document:
       - Currency (up-to-date?)
       - Completeness (gaps?)
       - Clarity (understandable?)
       - Relevance (needed for transfer?)

       Create Documentation Inventory:
       - Core Docs (must review)
       - Reference Docs (good to know)
       - Archive Docs (historical context)
       - Missing Docs (gaps to fill)

       Organize in logical learning sequence

       Output: .aiwg/knowledge/docs/documentation-inventory.md
       """
   )

   # Agent 2: Subject Matter Expert (knowledge holder role)
   Task(
       subagent_type="subject-matter-expert",
       description="Identify and create missing documentation",
       prompt="""
       Acting as {from-member} (knowledge holder perspective)

       Based on documentation inventory, create missing critical docs:

       1. Runbooks for common operations:
          - Daily/weekly tasks
          - Deployment procedures
          - Rollback procedures
          - Monitoring and alerting

       2. Troubleshooting guides:
          - Common issues and solutions
          - Debugging techniques
          - Log analysis patterns
          - Performance tuning

       3. Architecture notes:
          - Design decisions and rationale
          - System boundaries and interfaces
          - Data flows and dependencies
          - Security considerations

       4. Tribal knowledge:
          - Undocumented gotchas
          - Historical context ("why it's this way")
          - Stakeholder relationships
          - Political/organizational context

       Focus on practical, hands-on knowledge needed for independent operation

       Output to: .aiwg/knowledge/docs/{category}/
       """
   )

   # Agent 3: Technical Writer
   Task(
       subagent_type="technical-writer",
       description="Enhance documentation clarity and completeness",
       prompt="""
       Review and enhance documentation for knowledge transfer:

       Improvements:
       1. Add missing context for newcomers
       2. Clarify technical jargon
       3. Add examples and scenarios
       4. Create quick reference guides
       5. Add diagrams where helpful

       Ensure documentation is:
       - Self-contained (minimal external references)
       - Progressive (basic → advanced)
       - Actionable (clear steps)
       - Verifiable (testable outcomes)

       Create consolidated reading list in order

       Output enhanced docs to: .aiwg/knowledge/docs/enhanced/
       """
   )
   ```

**Communicate Progress**:
```
⏳ Documentation review in progress...
  ✓ {X} existing documents inventoried
  ✓ {Y} documentation gaps identified
  ✓ {Z} new documents created
✓ Documentation package complete: .aiwg/knowledge/docs/
```

### Step 3: Shadowing Phase (Receiver Observes)

**Purpose**: Knowledge receiver observes holder performing actual work

**Your Actions**:

1. **Initialize Shadowing Sessions**:
   ```
   # Create session structure
   mkdir -p .aiwg/knowledge/shadowing/sessions

   # Define 4-8 sessions based on knowledge areas
   For each critical knowledge area, allocate 1-2 sessions
   ```

2. **Launch Shadowing Simulation** (for each session):
   ```
   # For each shadowing session (4-8 total)
   Task(
       subagent_type="training-coordinator",
       description="Simulate shadowing session {N}",
       prompt="""
       Shadowing Session {N}
       Knowledge Area: {area from knowledge map}
       Duration: 1-2 hours (simulated)

       Simulate session where {from-member} demonstrates:
       1. Task execution (step-by-step)
       2. Decision points (what and why)
       3. Tool usage (specific commands/interfaces)
       4. Common issues (what to watch for)
       5. Best practices (efficiency tips)

       {to-member} perspective:
       - Observations noted
       - Questions asked
       - Concepts clarified
       - Confidence assessment (1-5)

       Create session log including:
       - Tasks demonstrated
       - Key decisions explained
       - Questions and answers
       - Key learnings captured
       - Follow-up items identified
       - Confidence rating

       Output: .aiwg/knowledge/shadowing/sessions/session-{N}-{area}.md
       """
   )
   ```

3. **Synthesize Shadowing Learnings**:
   ```
   Task(
       subagent_type="knowledge-manager",
       description="Synthesize shadowing phase learnings",
       prompt="""
       Read all shadowing session logs

       Create synthesis:
       1. Knowledge areas covered
       2. Key learnings consolidated
       3. Remaining questions
       4. Confidence progression (trend over sessions)
       5. Areas needing more practice

       Identify patterns:
       - Concepts requiring repetition
       - Complex areas needing breakdown
       - Tools requiring hands-on practice

       Recommend focus for reverse shadowing

       Output: .aiwg/knowledge/shadowing/shadowing-synthesis.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Shadowing phase in progress...
  ✓ Session 1: Database operations (confidence: 3/5)
  ✓ Session 2: Deployment procedures (confidence: 2/5)
  ✓ Session 3: Incident response (confidence: 4/5)
  ✓ Session 4: Performance tuning (confidence: 2/5)
✓ Shadowing complete: {X} sessions, average confidence: {Y}/5
```

### Step 4: Reverse Shadowing Phase (Receiver Leads)

**Purpose**: Knowledge receiver performs tasks with holder observing

**Your Actions**:

1. **Plan Reverse Shadowing Sessions**:
   ```
   Based on shadowing synthesis, prioritize:
   - Low confidence areas (2/5 or below)
   - Critical operations
   - Complex procedures
   ```

2. **Launch Reverse Shadowing** (for each session):
   ```
   # For each reverse shadowing session (4-8 total)
   Task(
       subagent_type="learner",
       description="Simulate reverse shadowing session {N}",
       prompt="""
       Reverse Shadowing Session {N}
       Knowledge Area: {area}
       Receiver Leading: {to-member}
       Holder Observing: {from-member}

       Simulate {to-member} performing tasks:
       1. Task approach (how they tackle it)
       2. Decision making (choices and reasoning)
       3. Challenges faced (what's difficult)
       4. Holder interventions (when and why)
       5. Corrections made (learning moments)

       Holder feedback:
       - What went well
       - Areas for improvement
       - Specific corrections
       - Confidence assessment

       Success indicators:
       - Task completed correctly
       - Minimal interventions needed
       - Sound reasoning demonstrated

       Create session log:
       - Tasks performed
       - Interventions required
       - Feedback provided
       - Outcome (SUCCESS, PARTIAL, NEEDS_PRACTICE)
       - Confidence growth

       Output: .aiwg/knowledge/shadowing/reverse/session-{N}-{area}.md
       """
   )
   ```

3. **Assess Progress and Readiness**:
   ```
   Task(
       subagent_type="training-coordinator",
       description="Assess reverse shadowing progress",
       prompt="""
       Read all reverse shadowing sessions

       Assess readiness:
       1. Tasks completed successfully (%)
       2. Intervention frequency (trending down?)
       3. Confidence ratings (trending up?)
       4. Decision quality (sound reasoning?)

       For each knowledge area:
       - Status: READY | NEEDS_PRACTICE | NOT_READY
       - Remaining gaps
       - Recommended actions

       Overall assessment:
       - Ready for validation: YES/NO
       - Areas needing more practice
       - Estimated additional time needed

       Output: .aiwg/knowledge/shadowing/reverse/readiness-assessment.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Reverse shadowing in progress...
  ✓ Session 1: Database operations (SUCCESS, minimal intervention)
  ✓ Session 2: Deployment procedures (PARTIAL, 2 interventions)
  ✓ Session 3: Incident response (SUCCESS, no intervention)
  ⚠️ Session 4: Performance tuning (NEEDS_PRACTICE, multiple interventions)
✓ Reverse shadowing complete: 75% success rate
```

### Step 5: Knowledge Validation and Practical Testing

**Purpose**: Validate knowledge acquisition through realistic scenarios

**Your Actions**:

1. **Create Validation Scenarios**:
   ```
   Task(
       subagent_type="test-architect",
       description="Design validation scenarios",
       prompt="""
       Based on knowledge domain {domain}, create 4 validation scenarios:

       Scenario 1: Routine Operation
       - Common daily/weekly task
       - Expected to complete independently
       - Time limit: reasonable for task

       Scenario 2: Troubleshooting
       - Realistic problem to diagnose and fix
       - Tests analytical skills
       - Multiple solution paths acceptable

       Scenario 3: Teach-Back
       - Explain concept to simulated junior member
       - Tests depth of understanding
       - Must be accurate and clear

       Scenario 4: Novel Situation
       - New problem not explicitly covered
       - Tests knowledge application
       - Reasonable extrapolation expected

       Each scenario includes:
       - Context and setup
       - Success criteria
       - Evaluation rubric
       - Time expectations

       Output: .aiwg/knowledge/validation/validation-scenarios.md
       """
   )
   ```

2. **Execute Validation Tests** (parallel where possible):
   ```
   # For each validation scenario
   Task(
       subagent_type="learner",
       description="Execute validation scenario {N}",
       prompt="""
       As {to-member}, complete validation scenario {N}

       Demonstrate:
       1. Understanding of the problem
       2. Systematic approach
       3. Correct solution or diagnosis
       4. Appropriate tool usage
       5. Documentation of actions

       For teach-back scenario:
       - Explain clearly
       - Use examples
       - Check understanding

       For novel situation:
       - Show problem-solving process
       - Use available resources
       - Apply learned principles

       Document:
       - Approach taken
       - Solution provided
       - Time taken
       - Confidence level
       - Resources consulted

       Output: .aiwg/knowledge/validation/scenario-{N}-results.md
       """
   )

   # Parallel evaluation by holder
   Task(
       subagent_type="subject-matter-expert",
       description="Evaluate validation scenarios",
       prompt="""
       As {from-member}, evaluate {to-member}'s performance

       For each scenario:
       - Accuracy (correct solution?)
       - Approach (systematic and logical?)
       - Efficiency (reasonable time?)
       - Independence (minimal help needed?)
       - Documentation (clear and complete?)

       Rating scale:
       - EXCELLENT: Exceeds expectations
       - PASS: Meets requirements
       - CONDITIONAL: Mostly correct, minor gaps
       - FAIL: Significant gaps, more practice needed

       Provide specific feedback:
       - What was done well
       - Areas for improvement
       - Recommendations

       Overall readiness assessment:
       - READY for independent operation
       - READY with support period
       - NOT READY, need more practice

       Output: .aiwg/knowledge/validation/evaluation-results.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Validation testing in progress...
  ✓ Scenario 1 (Routine): PASS
  ✓ Scenario 2 (Troubleshooting): PASS
  ✓ Scenario 3 (Teach-Back): EXCELLENT
  ⚠️ Scenario 4 (Novel): CONDITIONAL (minor gaps noted)
✓ Validation complete: 3/4 PASS or better
```

### Step 6: Handover Checklist and Signoff

**Purpose**: Complete formal handover with all parties signing off

**Your Actions**:

1. **Generate Handover Checklist**:
   ```
   Task(
       subagent_type="project-manager",
       description="Create comprehensive handover checklist",
       prompt="""
       Create handover checklist for:
       - Domain: {domain}
       - From: {from-member}
       - To: {to-member}
       - Duration: {weeks from start to now}

       Checklist sections:

       1. Documentation
          - All docs reviewed: YES/NO
          - Gaps addressed: YES/NO
          - Bookmarks/access: YES/NO

       2. Practical Skills
          - Routine tasks: {validation results}
          - Troubleshooting: {validation results}
          - Emergency procedures: UNDERSTOOD/PRACTICED

       3. Knowledge Validation
          - Scenarios passed: {X}/4
          - Teach-back successful: YES/NO
          - Holder confidence: {rating}

       4. Access and Permissions
          - System access: GRANTED/PENDING
          - Tool access: GRANTED/PENDING
          - Communication channels: ADDED/PENDING

       5. Operational Handoff
          - On-call rotation: UPDATED/PENDING
          - Responsibility matrix: UPDATED/PENDING
          - Stakeholder notification: SENT/PENDING

       6. Follow-Up Plan
          - 1-week check-in: {date}
          - 1-month check-in: {date}
          - Support period: {duration}

       7. Residual Gaps (if any)
          - List with severity and remediation plan

       Use template if available: $AIWG_ROOT/templates/knowledge/handover-checklist-template.md

       Output: .aiwg/knowledge/handover-checklist-{domain}.md
       """
   )
   ```

2. **Collect Signoffs**:
   ```
   Task(
       subagent_type="project-manager",
       description="Collect handover signoffs",
       prompt="""
       Document signoffs for handover:

       Required signatures:
       1. Knowledge Receiver ({to-member}):
          "I am confident in my ability to perform {domain} responsibilities independently"
          Confidence level: {1-5}
          Concerns (if any): {list}

       2. Knowledge Holder ({from-member}):
          "I am confident the receiver has the knowledge to succeed independently"
          Confidence level: {1-5}
          Recommendations: {list}

       3. Project Manager:
          "Knowledge transfer is complete and receiver is ready for independent operation"
          Decision: APPROVED / CONDITIONAL / NOT_APPROVED

       Conditional requirements (if CONDITIONAL):
       - What must be completed
       - Timeline for completion
       - Re-validation plan

       Add signatures to handover checklist
       """
   )
   ```

3. **Generate Final Report**:
   ```
   Task(
       subagent_type="knowledge-manager",
       description="Generate knowledge transfer completion report",
       prompt="""
       Create comprehensive transfer report including:

       1. Executive Summary
          - Transfer status: COMPLETE/PARTIAL/INCOMPLETE
          - Readiness: READY/CONDITIONAL/NOT_READY
          - Key outcomes

       2. Transfer Summary
          - Scope (knowledge areas covered)
          - Timeline (planned vs actual)
          - Methods (shadowing, documentation, validation)

       3. Knowledge Acquisition Metrics
          - Shadowing sessions: {count}
          - Reverse shadowing: {count}
          - Validation scenarios: {passed}/{total}
          - Confidence progression: {start} → {end}

       4. Documentation Improvements
          - Docs created: {count}
          - Docs enhanced: {count}
          - Remaining gaps: {list}

       5. Validation Results
          - Detailed scenario outcomes
          - Evaluator feedback
          - Areas of strength
          - Areas for improvement

       6. Lessons Learned
          - What worked well
          - What could improve
          - Recommendations for future transfers

       7. Follow-Up Plan
          - Check-in schedule
          - Support arrangements
          - Escalation path

       8. Risk Assessment
          - Operational risks
          - Mitigation strategies
          - Contingency plans

       Output: .aiwg/reports/knowledge-transfer-report-{domain}.md
       """
   )
   ```

**Communicate Progress**:
```
✓ Handover checklist complete: .aiwg/knowledge/handover-checklist-{domain}.md
✓ All parties signed off
✓ Transfer report generated: .aiwg/reports/knowledge-transfer-report-{domain}.md
```

## Quality Gates

Before marking workflow complete, verify:
- [ ] Knowledge assessment documented
- [ ] Transfer plan created and followed
- [ ] Documentation gaps addressed
- [ ] Shadowing sessions completed (minimum 4)
- [ ] Reverse shadowing completed (minimum 4)
- [ ] Validation scenarios passed (≥75%)
- [ ] Handover checklist complete
- [ ] All required signoffs obtained
- [ ] Follow-up plan established

## User Communication

**At start**: Confirm understanding and outline process

```
Understood. I'll orchestrate the knowledge transfer from {from-member} to {to-member} for {domain}.

This will include:
- Knowledge assessment and gap analysis
- Documentation review and enhancement
- Shadowing sessions (observation)
- Reverse shadowing (practice)
- Validation testing
- Formal handover and signoff

Expected duration: 30-45 minutes orchestration.
Real-world timeline: 2-6 weeks for actual transfer.

Starting orchestration...
```

**During**: Update progress with clear indicators

```
✓ = Complete
⏳ = In progress
⚠️ = Attention needed
❌ = Failed/blocked
```

**At end**: Summary report with status and next steps

```
─────────────────────────────────────────────
Knowledge Transfer Complete
─────────────────────────────────────────────

**Transfer**: {from-member} → {to-member}
**Domain**: {domain}
**Status**: COMPLETE
**Readiness**: READY FOR INDEPENDENT OPERATION

**Summary**:
✓ Knowledge gaps identified and addressed
✓ Documentation: {X} docs created/updated
✓ Shadowing: {Y} sessions completed
✓ Validation: {Z}/4 scenarios passed
✓ Handover: All parties signed off

**Confidence Assessment**:
- Receiver confidence: 4/5
- Holder confidence: 4/5
- Manager approval: APPROVED

**Follow-Up Plan**:
- 1-week check-in: {date}
- 1-month review: {date}
- Support period: {from-member} available for {duration}

**Artifacts Generated**:
- Knowledge Map: .aiwg/knowledge/knowledge-map-{domain}.md
- Transfer Plan: .aiwg/knowledge/transfer-plan-{from}-to-{to}.md
- Documentation: .aiwg/knowledge/docs/
- Validation Results: .aiwg/knowledge/validation/
- Handover Checklist: .aiwg/knowledge/handover-checklist-{domain}.md
- Final Report: .aiwg/reports/knowledge-transfer-report-{domain}.md

**Next Steps**:
- Update team roster and responsibilities
- Schedule follow-up check-ins
- Monitor initial independent operation
- Address any residual gaps per remediation plan

─────────────────────────────────────────────
```

## Error Handling

**Team Member Not Found**:
```
⚠️ Team member not found in roster
Proceeding with provided names: {from-member} → {to-member}

Note: Consider updating .aiwg/team/team-profile.yaml
```

**Knowledge Domain Unclear**:
```
⚠️ Knowledge domain not specified

Defaulting to: "all responsibilities"
This may extend timeline and scope.

Recommendation: Specify domain for focused transfer
Example: "backend-api", "deployment", "security"
```

**Validation Failure**:
```
❌ Validation scenario failed: {scenario}

Result: {failure-reason}
Impact: Receiver not ready for independent operation

Recommendations:
1. Additional practice in {area}
2. Review relevant documentation
3. Schedule extra reverse shadowing session
4. Re-attempt validation after practice
```

**Insufficient Confidence**:
```
⚠️ Low confidence detected

Receiver confidence: {X}/5 (target: ≥3)
Holder confidence: {Y}/5 (target: ≥3)

Actions:
1. Identify specific concern areas
2. Provide additional shadowing/practice
3. Consider extended support period
4. Document contingency plans
```

**Timeline Overrun**:
```
⚠️ Transfer taking longer than planned

Original estimate: {X} weeks
Current duration: {Y} weeks

Factors:
- Complexity underestimated
- Availability constraints
- Additional gaps discovered

Recommendation: Adjust timeline and expectations
```

## Success Criteria

This orchestration succeeds when:
- [ ] Knowledge gaps identified and documented
- [ ] Transfer scope agreed by all parties
- [ ] Documentation complete and accessible
- [ ] Minimum 4 shadowing sessions completed
- [ ] Minimum 4 reverse shadowing sessions completed
- [ ] ≥75% validation scenarios passed
- [ ] Receiver confidence ≥3/5
- [ ] Holder confidence ≥3/5
- [ ] Handover checklist signed off
- [ ] Follow-up plan established

## Metrics to Track

**During orchestration, track**:
- Documentation coverage: % of knowledge areas documented
- Shadowing completion: # sessions completed vs planned
- Confidence progression: Rating trend over time
- Validation pass rate: % scenarios passed first attempt
- Time to competency: Weeks from start to signoff

## References

**Templates** (via $AIWG_ROOT):
- Knowledge Map: `templates/knowledge/knowledge-map-template.md`
- Transfer Plan: `templates/knowledge/transfer-plan-template.md`
- Shadowing Log: `templates/knowledge/shadowing-log-template.md`
- Validation Checklist: `templates/knowledge/knowledge-validation-checklist.md`
- Handover Checklist: `templates/knowledge/handover-checklist-template.md`

**Related Commands**:
- `team-roster` - Update team responsibilities
- `update-oncall` - Modify on-call schedules
- `flow-onboarding` - Full team member onboarding

**Best Practices**:
- `docs/knowledge-transfer-best-practices.md`
- `docs/shadowing-techniques.md`
- `docs/validation-scenario-design.md`