---
namespace: aiwg
name: intake-start
platforms: [all]
description: Ingest the Project Intake Form and kick off Concept → Inception with agent assignments, accepts optional guidance to tailor process
commandHint:
  argumentHint: <path-to-intake-folder-or-form> [--guidance "context" --interactive]
  allowedTools: Read, Write, Glob, Grep
  model: haiku
  category: sdlc-management
  modelRole: efficiency
  modelTier: economy
---

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


# Intake Start (SDLC)

## Purpose

**IMPORTANT**: This command is for teams who have **manually crafted their own intake documents** (project-intake.md, solution-profile.md, option-matrix.md) and want to validate them before starting the SDLC process.

**If you need to generate intake documents**, use one of these instead:
- `/intake-wizard "description"` - Generate intake from scratch with interactive guidance
- `/intake-from-codebase .` - Generate intake by analyzing existing codebase

**This command is NOT required** if you used `intake-wizard` or `intake-from-codebase` - those commands produce complete, validated intake forms ready for the next phase.

## Task

Given existing, manually-created Project Intake documents:

1. **Process guidance** from user prompt (if provided) to tailor analysis
2. **Validate** required fields and note gaps
3. **Generate** or update phase-plan-inception.md and risk-list.md
4. **Recommend** initial ADRs and agent assignments
5. **Hand off** to Executive Orchestrator to start Concept → Inception flow

## Parameters

- **`<path-to-intake-folder-or-form>`** (required): Path to intake directory (default: `.aiwg/intake/`)
- **`--guidance "text"`** (optional): User-provided context to guide inception planning

### Guidance Parameter Usage

The `--guidance` parameter accepts free-form text to help tailor the Inception phase planning. Use it for:

**Process Focus**:
```bash
/intake-start .aiwg/intake/ --guidance "Focus on security architecture first, compliance is critical path"
```

**Risk Priorities**:
```bash
/intake-start .aiwg/intake/ --guidance "Third-party API integration is biggest unknown, needs spike ASAP"
```

**Team Constraints**:
```bash
/intake-start .aiwg/intake/ --guidance "Team has limited DevOps experience, need extra support for infrastructure setup"
```

**Stakeholder Expectations**:
```bash
/intake-start .aiwg/intake/ --guidance "Executive demo required in 2 weeks, need working prototype for fundraising"
```

**Technical Unknowns**:
```bash
/intake-start .aiwg/intake/ --guidance "Performance at scale unproven, need load testing POC before committing to architecture"
```

**How guidance influences planning**:
- **Prioritizes** specific risks based on guidance (e.g., "API integration" → elevate integration risks)
- **Tailors** agent assignments (e.g., "limited DevOps" → assign DevOps Engineer + provide training resources)
- **Adjusts** phase plan (e.g., "demo in 2 weeks" → front-load UI prototype tasks)
- **Highlights** critical path items (e.g., "compliance critical" → security gates moved earlier)
- **Documents** in phase-plan-inception.md (captures strategic focus and constraints)
- **Recommends** spikes/POCs based on unknowns mentioned in guidance

## Inputs

- `project-intake.md` (filled) - Comprehensive system documentation with metadata, architecture, scale, security, team details
- `solution-profile.md` (filled) - Current profile characteristics, improvement roadmap, risk mitigation, key decisions
- `option-matrix.md` (filled) - 6-step framework application analysis with priorities and trade-offs

## Outputs

- `phase-plan-inception.md` - Tailored inception plan based on validated intake
- `risk-list.md` - Prioritized risks with mitigation strategies
- `agent-assignments.md` - Recommended agent assignments based on project characteristics

## Workflow

### Step 1: Read and Process Guidance

If `--guidance` parameter provided:
- Extract guidance text from user prompt
- Document guidance in notes for later use
- Use guidance to prioritize validation checks (e.g., "security critical" → focus security validation)

### Step 2: Locate and Read Intake Documents

**Default location**: `.aiwg/intake/` (or user-provided path)

**Required files**:
1. `project-intake.md`
2. `solution-profile.md`
3. `option-matrix.md`

**Error handling**:
- If path is a directory, look for files within it
- If path is a single file, read it and look for other files in same directory
- If files missing, report which ones and stop (cannot proceed without complete intake)

### Step 3: Validate Project Intake (Comprehensive)

**Critical sections to validate** (from new comprehensive template):

#### Metadata Validation
- [ ] Project name present
- [ ] Requestor/owner identified
- [ ] Date present
- [ ] Stakeholders listed (minimum: Engineering, Product)

#### System Overview Validation
- [ ] Purpose clearly stated (1-2 sentences minimum)
- [ ] Current Status specified (Planning/Development/Early Users/Production)
- [ ] Users defined (count, personas, or description)
- [ ] Tech Stack documented:
  - [ ] Languages specified
  - [ ] Frontend (if applicable)
  - [ ] Backend (if applicable)
  - [ ] Database specified
  - [ ] Deployment approach specified

#### Problem and Outcomes Validation
- [ ] Problem statement present (for existing systems) OR goal statement (for greenfield)
- [ ] Outcomes defined (success criteria, key results)

#### Current Scope and Features Validation
- [ ] Feature list present (minimum 1 feature for MVP+, 3+ for Production)
- [ ] Features categorized or prioritized

#### Architecture Validation
- [ ] Architectural style specified (monolith/microservices/serverless/etc.)
- [ ] Major components listed (minimum 2-3 for Production+)
- [ ] Data models documented (at least high-level entities)
- [ ] Integration points identified (external APIs, third-party services)

#### Scale and Performance Validation
- [ ] Expected user capacity documented (even if estimate)
- [ ] Active users estimate provided
- [ ] Performance characteristics specified (response times, throughput, etc.)

#### Security and Compliance Validation
- [ ] Security posture stated (Minimal/Baseline/Strong/Enterprise)
- [ ] Data classification documented (if handling user data)
- [ ] Security controls listed (authentication, authorization, etc.)
- [ ] Compliance requirements specified (if any: GDPR, HIPAA, SOC2, etc.)

#### Team and Operations Validation
- [ ] Team size documented (minimum: developer count)
- [ ] Current velocity/cadence noted (for existing teams)
- [ ] Process maturity described (trunk-based, PR workflow, CI/CD, etc.)
- [ ] Operational support plan outlined (on-call, monitoring, etc.)

#### Dependencies and Infrastructure Validation
- [ ] Third-party services listed (all critical external dependencies)
- [ ] Infrastructure details specified (cloud provider, regions, etc.)

#### Known Issues and Technical Debt Validation
- [ ] Known risks documented (even if "none identified yet")
- [ ] Technical debt acknowledged (if existing system)

#### Why This Intake Now? Validation
- [ ] Context provided (why starting SDLC process now)
- [ ] Goals clearly stated
- [ ] Triggers identified (timeline, funding, user need, etc.)

**Gap Handling**:
- For **critical gaps** (no purpose, no tech stack, no team size): **STOP** and request user fill gaps
- For **moderate gaps** (missing performance estimates, unclear compliance): **WARN** and note in phase plan
- For **minor gaps** (missing optional sections): **NOTE** in validation summary

### Step 4: Validate Solution Profile (Comprehensive)

**Critical sections to validate** (from new comprehensive template):

#### Profile Selection Validation
- [ ] Profile chosen (Prototype/MVP/Production/Enterprise)
- [ ] Selection rationale provided (explains why this profile fits)

#### Current State Characteristics Validation

**Security**:
- [ ] Posture specified (Minimal/Baseline/Strong/Enterprise)
- [ ] Controls present documented
- [ ] Gaps identified
- [ ] Recommendation provided

**Reliability**:
- [ ] Current SLOs documented (or "N/A" for non-services)
- [ ] Availability targets specified
- [ ] Monitoring maturity described
- [ ] User priority noted (from option-matrix)
- [ ] Recommendation provided (investment areas)

**Testing & Quality**:
- [ ] Test coverage documented (current percentage)
- [ ] Test types detected/planned
- [ ] Quality gates specified
- [ ] User priority noted
- [ ] Recommendation provided (testing strategy)

**Process Rigor**:
- [ ] SDLC adoption level documented
- [ ] Code review process described
- [ ] Documentation status assessed
- [ ] Recommendation provided (process improvements)

#### Recommended Profile Adjustments Validation
- [ ] Current profile stated
- [ ] Recommended profile specified
- [ ] Transition plan outlined (phases with actions and timelines)

#### Improvement Roadmap Validation
- [ ] **Phase 1** (Immediate) defined with critical gaps
- [ ] **Phase 2** (Short-term) defined with important improvements
- [ ] **Phase 3** (Long-term) defined with strategic improvements
- [ ] Each phase includes: rationale, success metrics

#### Risk Mitigation Validation
- [ ] Top 3-5 risks identified with:
  - [ ] Risk description
  - [ ] Impact level (HIGH/MEDIUM/LOW)
  - [ ] Mitigation strategies
  - [ ] Timeline for mitigation

#### Key Decisions Needed Validation
- [ ] Critical decisions documented (minimum 1-3 for Production+)
- [ ] Each decision includes:
  - [ ] Question framing
  - [ ] Options (2-3 alternatives)
  - [ ] Recommendation
  - [ ] Timeline for decision

**Gap Handling**:
- For **critical gaps** (no profile, no improvement roadmap): **STOP** and request completion
- For **moderate gaps** (missing risk mitigation, unclear decisions): **WARN** and elevate in phase plan
- For **minor gaps** (incomplete success metrics): **NOTE** in validation summary

### Step 5: Validate Option Matrix (Comprehensive)

**Critical sections to validate** (from new 6-step template):

#### Step 1: Project Reality Validation
- [ ] **What IS This Project?** - Clear description (2-3 sentences minimum)
- [ ] **Audience & Scale** - Target users and scale documented
- [ ] **Deployment & Infrastructure** - Deployment model specified
- [ ] **Technical Complexity** - Complexity assessment provided

#### Step 2: Constraints & Context Validation
- [ ] **Resources** - Team size, timeline, budget constraints documented
- [ ] **Regulatory & Compliance** - Requirements specified (or "None")
- [ ] **Technical Context** - Legacy systems, existing infrastructure noted

#### Step 3: Priorities & Trade-offs Validation (CRITICAL)
- [ ] **Priority Weights** table present
- [ ] Weights sum to 1.0 (verify mathematically)
- [ ] Each criterion has rationale:
  - [ ] Delivery Speed (0.10-0.50)
  - [ ] Cost Efficiency (0.10-0.40)
  - [ ] Quality/Security (0.10-0.50)
  - [ ] Reliability/Scale (0.10-0.40)
- [ ] Trade-off context provided (explains hard choices)

**Priority validation is CRITICAL** because it drives:
- Phase plan task prioritization
- Agent assignment decisions
- Quality gate thresholds
- Risk tolerance levels

#### Step 4: Intent & Decision Context Validation (CRITICAL)
- [ ] **Why This Intake Now?** - Clearly stated (business/technical triggers)
- [ ] **What decisions need making?** - Key decisions identified
- [ ] **What's uncertain?** - Unknowns acknowledged

**Intent validation is CRITICAL** because it shapes:
- Phase plan focus areas
- Spike/POC recommendations
- Early ADR topics

#### Step 5: Framework Application Validation
- [ ] **Templates** - Checked boxes for applicable templates (or explicit "NONE")
- [ ] **Commands** - Checked boxes for applicable commands
- [ ] **Agents** - Checked boxes for applicable agents
- [ ] **Process Rigor Level** - Specified (Minimal/Moderate/Full/Enterprise)
- [ ] **Rationale** - Explains why these components selected

#### Step 6: Evolution & Adaptation Validation
- [ ] **Expected Changes** - Documented (team growth, feature expansion, etc.)
- [ ] **Adaptation Triggers** - Specified (when to revisit framework choices)
- [ ] **Planned Framework Evolution** - Outlined (how framework will evolve with project)

#### Architectural Options Analysis Validation (Optional but Recommended)
- [ ] Option A documented (if applicable)
- [ ] Option B documented (if applicable)
- [ ] Option C documented (if applicable)
- [ ] Recommendation provided with rationale

**Gap Handling**:
- For **critical gaps** (no Step 3 weights, no Step 4 intent): **STOP** and request completion
- For **moderate gaps** (missing Step 6, incomplete rationale): **WARN** and use defaults
- For **minor gaps** (no architectural options): **NOTE** (optional section)

### Step 6: Generate Validation Summary

Create structured validation report:

```markdown
# Intake Validation Summary

**Validation Date**: {current date}
**Intake Path**: {path to intake directory}
**Guidance Provided**: {yes/no, summary if provided}

## Completeness Assessment

**Project Intake**: {COMPLETE | GAPS PRESENT | CRITICAL GAPS}
- {list critical gaps if any}
- {list moderate gaps if any}

**Solution Profile**: {COMPLETE | GAPS PRESENT | CRITICAL GAPS}
- {list critical gaps if any}
- {list moderate gaps if any}

**Option Matrix**: {COMPLETE | GAPS PRESENT | CRITICAL GAPS}
- {list critical gaps if any}
- {list moderate gaps if any}

## Readiness for Inception

**Status**: {READY | NEEDS COMPLETION | BLOCKED}

**Recommendation**:
- {If READY: proceed to phase planning}
- {If NEEDS COMPLETION: list required actions}
- {If BLOCKED: explain blockers and resolution steps}

## Key Insights from Intake

**Project Profile**: {Prototype/MVP/Production/Enterprise}
**Top Priority**: {from Step 3 weights}
**Biggest Risk**: {from solution-profile risk mitigation}
**Critical Decision**: {from solution-profile key decisions}

## Next Steps

1. {action 1}
2. {action 2}
3. {action 3}
```

**Decision point**:
- If **READY**: Proceed to Step 7 (Generate Phase Plan)
- If **NEEDS COMPLETION**: Output validation summary and STOP (user must complete intake)
- If **BLOCKED**: Output validation summary with resolution steps and STOP

### Step 7: Generate Phase Plan (Inception)

Create `phase-plan-inception.md` based on validated intake:

**Structure**:

```markdown
# Phase Plan: Inception

**Project**: {from project-intake metadata}
**Profile**: {from solution-profile}
**Generated**: {current date}
**Guidance Applied**: {summary of --guidance if provided}

## Phase Overview

**Duration**: {estimate based on profile: Prototype=1-2 weeks, MVP=2-4 weeks, Production=4-6 weeks, Enterprise=6-8 weeks}
**Team Size**: {from project-intake team section}
**Primary Focus**: {derived from option-matrix Step 4 intent}

## Phase Goals

1. **Architectural Foundation**: {from solution-profile improvement roadmap Phase 1}
2. **Risk Retirement**: {from solution-profile risk mitigation top risks}
3. **Team Alignment**: {from project-intake team section}
4. **Decision Making**: {from solution-profile key decisions}

## Priority-Driven Focus

**Top Priority** (from option-matrix Step 3): {highest weighted criterion}
**Implication**: {explain how this priority shapes Inception tasks}

**Examples**:
- If **Reliability/Scale** is top priority → focus architecture scalability, load testing POC, SLO definition
- If **Quality/Security** is top priority → focus security architecture, threat modeling, compliance review
- If **Delivery Speed** is top priority → focus MVP scope definition, technical spikes, rapid prototyping
- If **Cost Efficiency** is top priority → focus cloud cost modeling, resource optimization, vendor selection

## Key Activities (Tailored to Intake)

### Week 1: Foundation
- [ ] Kick-off meeting with stakeholders (from project-intake stakeholders list)
- [ ] Architecture baseline (from project-intake architecture section)
- [ ] Risk register initialization (from solution-profile risk mitigation)
- [ ] Tool and environment setup (from project-intake tech stack)

### Week 2-3: Exploration and Decision Making
- [ ] {activity 1 from solution-profile improvement roadmap Phase 1}
- [ ] {activity 2 from solution-profile key decisions}
- [ ] {spike/POC recommendation if guidance or option-matrix Step 4 mentions unknowns}
- [ ] Initial ADRs (see recommendations below)

### Week 4: Closure and Handoff
- [ ] Architecture review (validate against option-matrix architectural options)
- [ ] Risk reassessment (update risk-list.md)
- [ ] Inception gate check (validate readiness for Elaboration)
- [ ] Handoff to Elaboration (prepare phase-plan-elaboration.md)

## Risks and Mitigation (From Solution Profile)

{Pull top 3-5 risks from solution-profile risk mitigation section}

**Risk 1**: {risk name}
- **Impact**: {HIGH/MEDIUM/LOW}
- **Mitigation**: {strategies from solution-profile}
- **Timeline**: {when to address}

**Risk 2**: {risk name}
- **Impact**: {HIGH/MEDIUM/LOW}
- **Mitigation**: {strategies from solution-profile}
- **Timeline**: {when to address}

{...additional risks}

## Critical Decisions (From Solution Profile)

{Pull from solution-profile key decisions section}

**Decision 1**: {decision question}
- **Options**: {list 2-3 alternatives}
- **Recommendation**: {from solution-profile}
- **Deadline**: {when decision must be made}
- **Owner**: {assign based on decision type}

**Decision 2**: {decision question}
- **Options**: {list 2-3 alternatives}
- **Recommendation**: {from solution-profile}
- **Deadline**: {when decision must be made}
- **Owner**: {assign based on decision type}

{...additional decisions}

## Guidance Integration

{If --guidance provided, document how it influenced this phase plan}

**Guidance Provided**: "{verbatim guidance text}"

**Impact on Phase Plan**:
- {specific adjustment 1 based on guidance}
- {specific adjustment 2 based on guidance}
- {specific adjustment 3 based on guidance}

**Examples**:
- Guidance: "Security architecture first" → Moved threat modeling to Week 1, assigned Security Architect early
- Guidance: "API integration biggest unknown" → Added integration spike to Week 2, elevated API risks
- Guidance: "Team has limited DevOps experience" → Added DevOps Engineer + training resources to agent assignments

## Success Criteria

**Inception complete when**:
1. Architecture baseline documented (ADRs approved)
2. Top 3 risks retired or mitigated
3. Critical decisions resolved
4. Team aligned on approach
5. Inception gate passed (ready for Elaboration)

## Next Phase

**Handoff to**: Elaboration
**Trigger**: Inception gate passed
**Preparation**: Update risk-list.md, generate phase-plan-elaboration.md
```

**Key tailoring points**:
1. **Duration** scales with profile (Prototype fast, Enterprise slow)
2. **Activities** pulled from solution-profile improvement roadmap Phase 1
3. **Risks** pulled from solution-profile risk mitigation
4. **Decisions** pulled from solution-profile key decisions
5. **Guidance** explicitly integrated and documented
6. **Priority focus** derived from option-matrix Step 3 weights

### Step 8: Generate Risk List

Create `risk-list.md` based on solution-profile risk mitigation:

**Structure**:

```markdown
# Risk List

**Project**: {from project-intake metadata}
**Generated**: {current date}
**Last Updated**: {current date}

## Active Risks

{For each risk from solution-profile risk mitigation section}

### Risk #{n}: {Risk Name}

**Category**: {Technical | Process | Resource | External | Compliance}
**Impact**: {HIGH | MEDIUM | LOW}
**Probability**: {HIGH | MEDIUM | LOW}
**Status**: {Identified | Analyzing | Mitigating | Monitoring | Retired}

**Description**: {from solution-profile}

**Impact if Realized**: {from solution-profile impact description}

**Mitigation Strategies**:
1. {strategy 1 from solution-profile}
2. {strategy 2 from solution-profile}
3. {strategy 3 from solution-profile}

**Timeline**: {from solution-profile mitigation timeline}
**Owner**: {assign based on risk category}
**Last Review**: {current date}

---

{Repeat for all risks from solution-profile}

## Risk Register Summary

| ID | Risk Name | Impact | Probability | Status | Owner |
|----|-----------|--------|-------------|--------|-------|
| R1 | {name} | {H/M/L} | {H/M/L} | {status} | {owner} |
| R2 | {name} | {H/M/L} | {H/M/L} | {status} | {owner} |
| ... | ... | ... | ... | ... | ... |

## Risk Burn-down Target

**Inception Phase Goal**: Retire or mitigate top 3 risks
**Elaboration Phase Goal**: Retire or mitigate remaining HIGH risks
**Construction Phase Goal**: Monitor and address emerging risks
**Transition Phase Goal**: All HIGH risks retired or accepted

## Next Review

**Date**: {1-2 weeks from current date}
**Trigger**: Weekly risk review meeting OR significant risk event
```

**Categorization logic**:
- **Technical**: Architecture, technology choice, integration, performance, scalability
- **Process**: Team coordination, code review, testing, deployment
- **Resource**: Team size, skill gaps, timeline, budget
- **External**: Third-party dependencies, vendor reliability, API changes
- **Compliance**: Regulatory requirements, security posture, data protection

**Owner assignment logic**:
- Technical risks → Architecture Designer or Component Owner
- Process risks → Project Manager or Executive Orchestrator
- Resource risks → Project Manager or Vision Owner
- External risks → Integration Engineer or API Designer
- Compliance risks → Security Architect or Legal Liaison

### Step 9: Generate Agent Assignments

Create `agent-assignments.md` based on option-matrix Step 5 framework application:

**Structure**:

```markdown
# Agent Assignments (Inception Phase)

**Project**: {from project-intake metadata}
**Profile**: {from solution-profile}
**Generated**: {current date}

## Assignment Strategy

**Process Rigor Level**: {from option-matrix Step 5}
**Team Size**: {from project-intake team section}
**Priority Focus**: {from option-matrix Step 3 top weight}

## Core Agents (Always Assigned)

### Executive Orchestrator
**Role**: Lifecycle coordination, gate enforcement, artifact synchronization
**Priority Tasks**:
- Orchestrate Inception phase activities
- Enforce Inception gate criteria
- Coordinate agent handoffs

### Vision Owner
**Role**: Product vision alignment, requirement validation
**Priority Tasks**:
- Validate project-intake alignment with business goals
- Review architectural options against vision
- Approve critical decisions

### Architecture Designer
**Role**: System architecture, technical direction
**Priority Tasks**:
- {from solution-profile improvement roadmap Phase 1 architecture tasks}
- Document ADRs (see recommendations below)
- Review architectural options from option-matrix

## Priority-Driven Agents

{Based on option-matrix Step 3 top priority}

**If Reliability/Scale is top priority**:
- **Reliability Engineer**: Establish SLO/SLI, capacity planning
- **Performance Engineer**: Baseline performance, bottleneck identification
- **DevOps Engineer**: Infrastructure design, monitoring setup

**If Quality/Security is top priority**:
- **Security Architect**: Threat modeling, security requirements
- **Security Gatekeeper**: Security gate criteria, compliance validation
- **Code Reviewer**: Code review standards, quality gates

**If Delivery Speed is top priority**:
- **Software Implementer**: Rapid prototyping, MVP development
- **Test Engineer**: Fast feedback loops, smoke tests
- **Toolsmith**: Developer experience, automation tooling

**If Cost Efficiency is top priority**:
- **Cloud Architect**: Cost modeling, resource optimization
- **DevOps Engineer**: Infrastructure efficiency, right-sizing
- **Integration Engineer**: Vendor selection, API cost analysis

## Risk-Driven Agents

{Based on solution-profile risk mitigation top risks}

**Risk**: {risk 1 name}
**Agent**: {appropriate agent for this risk category}
**Tasks**:
- {mitigation strategy 1}
- {mitigation strategy 2}

**Risk**: {risk 2 name}
**Agent**: {appropriate agent for this risk category}
**Tasks**:
- {mitigation strategy 1}
- {mitigation strategy 2}

{...additional risk-driven assignments}

## Guidance-Driven Agents

{If --guidance provided, assign agents based on guidance context}

**Guidance**: "{verbatim guidance text}"

**Agent Assignments**:
- {agent 1 assigned because of guidance}
- {agent 2 assigned because of guidance}

**Examples**:
- Guidance: "Limited DevOps experience" → Assign DevOps Engineer + provide training resources
- Guidance: "Security critical path" → Assign Security Architect + Security Gatekeeper early
- Guidance: "API integration biggest unknown" → Assign Integration Engineer + API Designer for spike

## Framework-Driven Agents (From Option Matrix Step 5)

{Based on option-matrix Step 5 checked boxes}

**Checked Agents** (from option-matrix):
- {agent 1 from option-matrix rationale}
- {agent 2 from option-matrix rationale}
- {agent 3 from option-matrix rationale}

**Rationale**: {from option-matrix Step 5 rationale section}

## Assignment Timeline

**Week 1** (Inception kickoff):
- Executive Orchestrator (immediate)
- Vision Owner (immediate)
- Architecture Designer (immediate)

**Week 2** (Risk and decision focus):
- {priority-driven agents}
- {risk-driven agents}

**Week 3-4** (As needed):
- {additional agents based on emerging needs}

## Handoff to Elaboration

**Agents continuing into Elaboration**:
- Executive Orchestrator (lifecycle coordination)
- Architecture Designer (architecture evolution)
- {priority-driven agents that remain relevant}

**Agents completing in Inception**:
- {agents whose work ends after Inception}

**New agents for Elaboration**:
- {agents not needed until Elaboration phase}
```

**Agent selection logic**:
1. **Core agents** (always): Executive Orchestrator, Vision Owner, Architecture Designer
2. **Priority-driven** (from option-matrix Step 3 weights): Match top priority to specialized agents
3. **Risk-driven** (from solution-profile risks): Assign agents who can mitigate specific risks
4. **Guidance-driven** (from --guidance parameter): Assign agents mentioned or implied by guidance
5. **Framework-driven** (from option-matrix Step 5): Assign checked agents from framework application

### Step 10: Generate Initial ADR Recommendations

Within phase-plan-inception.md, include section:

```markdown
## Recommended Initial ADRs

{Based on project-intake architecture section, option-matrix architectural options, and solution-profile key decisions}

**ADR-001**: {Decision title from option-matrix architectural options recommendation}
- **Context**: {from option-matrix Step 1 project reality}
- **Decision**: {from option-matrix architectural options recommendation}
- **Rationale**: {from option-matrix recommendation rationale}
- **Status**: Proposed (to be reviewed in Week 2)

**ADR-002**: {Decision title from solution-profile key decisions}
- **Context**: {from solution-profile decision question}
- **Decision**: {from solution-profile recommendation}
- **Rationale**: {from solution-profile recommendation}
- **Status**: Proposed (to be reviewed in Week 2-3)

{Additional ADRs based on guidance or high-impact risks}

**Guidance**: If guidance mentions specific technical decisions or unknowns, recommend ADRs to address them.
```

### Step 11: Summary and Handoff

Output summary message to user:

```markdown
# Intake Start Complete

✅ **Validation**: All intake documents validated
✅ **Phase Plan**: phase-plan-inception.md generated
✅ **Risk List**: risk-list.md generated
✅ **Agent Assignments**: agent-assignments.md generated

## Key Insights

**Project**: {name}
**Profile**: {profile}
**Top Priority**: {priority}
**Biggest Risk**: {risk}
**Critical Decision**: {decision}

## Generated Artifacts

1. `phase-plan-inception.md` - {file size} KB
2. `risk-list.md` - {file size} KB
3. `agent-assignments.md` - {file size} KB

## Next Steps

1. **Review** generated artifacts (ensure alignment with expectations)
2. **Adjust** if needed (especially if guidance interpretation missed nuances)
3. **Execute** Inception phase using `flow-concept-to-inception` command
4. **Coordinate** with assigned agents (Executive Orchestrator will orchestrate)

## Ready to Start?

To begin Inception phase execution:
```bash
/flow-concept-to-inception .aiwg/
```

This will activate the Executive Orchestrator and assigned agents to begin Inception activities.
```

## Error Handling

### Missing Files
- If project-intake.md missing: **STOP** - "Cannot proceed without project-intake.md. Please run /intake-wizard or /intake-from-codebase first."
- If solution-profile.md missing: **STOP** - "Cannot proceed without solution-profile.md. Please complete intake generation first."
- If option-matrix.md missing: **WARN** - "option-matrix.md missing. Will use defaults for priorities and framework application."

### Incomplete Sections
- If critical gaps found: **STOP** with validation summary - user must complete gaps before proceeding
- If moderate gaps found: **WARN** in validation summary - proceed with noted gaps
- If minor gaps found: **NOTE** in validation summary - proceed normally

### Conflicting Information
- If project-intake and solution-profile conflict (e.g., different team sizes): **WARN** and use project-intake as source of truth
- If option-matrix and solution-profile priorities conflict: **WARN** and use option-matrix Step 3 weights as source of truth

### Invalid Data
- If option-matrix Step 3 weights don't sum to 1.0: **STOP** - "Priority weights must sum to 1.0. Current sum: {calculated sum}. Please fix option-matrix.md."
- If profile not one of (Prototype/MVP/Production/Enterprise): **STOP** - "Invalid profile: {profile}. Must be one of: Prototype, MVP, Production, Enterprise."

## Best Practices

1. **Always validate before generating** - Don't generate phase plans from incomplete intake
2. **Leverage guidance parameter** - Use guidance to prioritize and tailor (don't ignore user's strategic intent)
3. **Be explicit about gaps** - Don't silently fill gaps with assumptions (warn user and document)
4. **Cross-reference documents** - Pull risks from solution-profile, priorities from option-matrix, architecture from project-intake
5. **Tailor to profile** - Prototype gets lightweight plan, Enterprise gets comprehensive plan
6. **Document guidance impact** - Explicitly show how guidance influenced phase plan (transparency builds trust)

## Star the Repository

After successfully validating and generating phase plans, offer the user an opportunity to star the repository:

**Prompt**:
```
The AIWG is an open-source project that helps improve AI-generated content.
If you found this helpful, would you like to star the repository on GitHub?

Options:
- Yes, star the repo
- No thanks
```

**If user selects "Yes, star the repo"**:

1. Check if `gh` CLI is available:
   ```bash
   which gh
   ```

2. If `gh` is available, attempt to star:
   ```bash
   gh api -X PUT /user/starred/jmagly/ai-writing-guide
   ```
   - If successful: "⭐ Thank you for starring the AIWG! Your support helps the project grow."
   - If fails: "Could not star via gh CLI. You can star manually at: https://github.com/jmagly/aiwg"

3. If `gh` is not available:
   ```
   GitHub CLI (gh) not found. You can star the repository at:
   https://github.com/jmagly/aiwg
   ```

**If user selects "No thanks"**:
```
No problem! Thanks for using the AIWG.
```

## References

- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/human-authorization.md — Stop and await user action when critical gaps are found; never silently fill required fields
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/instruction-comprehension.md — Process the --guidance parameter fully before tailoring phase plan; do not ignore strategic intent
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/vague-discretion.md — Phase plan completion criteria must be concrete (artifacts present, weights sum to 1.0, not "good enough")
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/skills/project-status/SKILL.md — Use after intake-start completes to confirm phase and next steps
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/skills/orchestrate-project/SKILL.md — Hands off to orchestrator once intake validation and planning artifacts are generated

