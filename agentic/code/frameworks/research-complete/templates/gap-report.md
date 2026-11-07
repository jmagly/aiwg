# Research Gap Analysis Report Template

---
template_id: gap-report
version: 1.0.0
reasoning_required: true
framework: research-complete
---

## Ownership & Collaboration

- Document Owner: Research Analyst
- Contributor Roles: Domain Expert, Architecture Designer
- Automation Inputs: Literature corpus, extraction records, synthesis topics
- Automation Outputs: `gap-report-[topic]-YYYY-MM-DD.md` identifying research gaps

## Phase 1: Core (ESSENTIAL)

### Gap Report Header

**Topic:** [Research topic or domain]

<!-- EXAMPLE: Multi-Agent Coordination Patterns -->

**Date:** YYYY-MM-DD

**Scope:** [Breadth of gap analysis]

<!-- EXAMPLE: Literature review covering 23 papers on agentic systems, focusing on inter-agent communication and task decomposition -->

**Motivation:** [Why identifying this gap matters]

<!-- EXAMPLE: AIWG implements multi-agent SDLC workflows but lacks research-backed coordination patterns for handoffs, conflicts, and parallel work -->

### Executive Summary

> 2-3 sentence summary: What gap exists, why it matters, what's at stake

<!-- EXAMPLE:
Current research on agentic systems focuses on single-agent reasoning and tool use (ReAct, Self-Refine, MetaGPT), but lacks rigorous evaluation of multi-agent coordination patterns. AIWG requires evidence-based patterns for agent handoffs (Requirements Analyst → Architect → Implementer), conflict resolution when agents disagree, and parallel workflow management. Without this research, AIWG's multi-agent orchestration relies on intuition rather than validated patterns, risking coordination failures in production.
-->

## Reasoning

> Complete this section BEFORE detailed gap analysis. Per @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/reasoning-sections.md

1. **Gap Identification Strategy**: How will we systematically identify gaps?
   > [Define methodology: keyword search, citation network analysis, claim aggregation, synthesis review]

<!-- EXAMPLE:
Method: Cross-reference claims from 23 agentic systems papers to identify unstudied areas:
1. Extract all agent coordination patterns mentioned
2. Map coverage across single-agent vs multi-agent contexts
3. Identify AIWG requirements not addressed by existing research
4. Consult domain experts for blind spots
-->

2. **Criticality Assessment**: How do we prioritize gaps?
   > [Define criteria: AIWG dependency, risk if unaddressed, feasibility of research]

<!-- EXAMPLE:
Priority matrix:
- CRITICAL: AIWG currently uses pattern with no research backing (high risk)
- HIGH: AIWG planned feature requires research we don't have
- MEDIUM: Research would improve existing pattern
- LOW: Interesting but not AIWG-blocking
-->

3. **Scope Boundary**: What's in/out of scope for this analysis?
   > [Clearly define what gaps we're looking for and what we're deliberately excluding]

<!-- EXAMPLE:
IN SCOPE:
- Multi-agent coordination patterns
- Agent-to-agent communication protocols
- Conflict resolution strategies
- Task decomposition approaches

OUT OF SCOPE:
- Single-agent reasoning (well-covered by existing research)
- LLM training methods (not AIWG focus)
- Human-agent collaboration (separate gap analysis)
-->

4. **Evidence Standards**: What constitutes "gap" vs "understudied"?
   > [Define thresholds: 0 papers = gap, 1-2 papers = understudied, 3+ = researched]

<!-- EXAMPLE:
GAP: Zero rigorous studies found
UNDERSTUDIED: 1-2 studies with limitations (small scale, specific domain only)
RESEARCHED: 3+ studies with consistent findings
WELL-RESEARCHED: Systematic review or meta-analysis available
-->

5. **Action Planning**: What do we do with identified gaps?
   > [For each gap: commission research, use best judgment, implement with caution flag, defer feature]

<!-- EXAMPLE:
CRITICAL gaps → Commission research or pilot study before production use
HIGH gaps → Implement with explicit caution, plan for revision when research emerges
MEDIUM gaps → Use industry best practices, document assumptions
LOW gaps → Defer until research available
-->

## Phase 2: Gap Analysis (EXPAND WHEN READY)

<details>
<summary>Click to expand detailed gap findings</summary>

### Literature Review Summary

**Papers Reviewed:** [Count]

<!-- EXAMPLE: 23 papers on agentic systems -->

**Date Range:** YYYY - YYYY

<!-- EXAMPLE: 2020 - 2024 -->

**Sources:**
- Peer-reviewed conferences: [Count]
- Peer-reviewed journals: [Count]
- Preprints: [Count]
- Technical reports: [Count]

<!-- EXAMPLE:
- Peer-reviewed conferences: 15 (NeurIPS, ICLR, ACL, EMNLP)
- Peer-reviewed journals: 3 (JAIR, AIJ)
- Preprints: 4 (arXiv)
- Technical reports: 1 (Industry)
-->

**Coverage by Topic:**

| Topic | Papers | Coverage Level | Notes |
|-------|--------|----------------|-------|
| [Topic 1] | X | WELL_RESEARCHED | [Note] |
| [Topic 2] | X | RESEARCHED | [Note] |
| [Topic 3] | X | UNDERSTUDIED | [Note] |
| [Topic 4] | 0 | GAP | [Note] |

<!-- EXAMPLE:
| Topic | Papers | Coverage Level | Notes |
| Single-agent reasoning | 12 | WELL_RESEARCHED | ReAct, CoT, Self-Refine, etc. |
| Tool use patterns | 8 | RESEARCHED | Toolformer, MetaGPT patterns |
| Agent communication | 2 | UNDERSTUDIED | AutoGen only, limited scope |
| Conflict resolution | 0 | GAP | No studies found |
| Parallel workflows | 1 | UNDERSTUDIED | Limited to coding tasks |
-->

### Identified Gaps

#### Gap 1: [Gap Name]

**Criticality:** CRITICAL | HIGH | MEDIUM | LOW

<!-- EXAMPLE: CRITICAL -->

**Description:**

[Detailed description of what's not researched]

<!-- EXAMPLE:
No research exists on conflict resolution patterns when multiple agents provide contradictory recommendations. Example: Architecture Designer recommends microservices, Security Auditor flags increased attack surface, Performance Engineer warns of latency overhead. How should orchestrator resolve this three-way conflict?
-->

**Why This Is a Gap:**

[Evidence that this is genuinely unresearched]

<!-- EXAMPLE:
- AutoGen (REF-022): Mentions agent disagreement but provides no resolution mechanism
- MetaGPT (REF-013): Assumes hierarchical coordination, no peer conflict handling
- Reviewed 23 papers: zero address multi-way agent conflicts
- Citation network search: no papers citing "agent conflict resolution" or similar
-->

**Impact on AIWG:**

[Consequences of this gap for AIWG implementation]

<!-- EXAMPLE:
AIWG's SDLC workflow requires multiple specialist agents (architect, security, performance, cost optimizer) who may provide conflicting advice. Current orchestrator has no research-backed strategy for:
- Detecting conflicts (beyond simple disagreement)
- Weighing agent expertise by domain
- Negotiating compromises
- Escalating to human when needed

Risk: Arbitrary conflict resolution leads to poor architectural decisions.
-->

**Current Workaround:**

[What we're doing in absence of research]

<!-- EXAMPLE:
Current workaround: Orchestrator uses simple majority voting with human escalation on ties.
Limitation: Ignores domain expertise (security expert vote = same weight as docs writer vote on security issue).
Status: Flagged as "CAUTION - No research backing" in @.aiwg/architecture/orchestrator-sad.md
-->

**Desired Research:**

- Research question: [Specific question needing answer]
- Methodology needed: [Type of study that would address this]
- Success criteria: [What would "answer" this gap]

<!-- EXAMPLE:
- Research question: What conflict resolution strategies optimize multi-agent decision quality while minimizing human escalation?
- Methodology needed: Comparative evaluation of strategies (voting, expertise-weighting, negotiation, ensemble) across diverse decision types
- Success criteria: Quantitative measures of decision quality, resolution time, human escalation rate, stakeholder satisfaction
-->

**Priority Rationale:**

[Why this criticality level?]

<!-- EXAMPLE:
CRITICAL because:
1. Affects every SDLC phase (multiple agents in each phase)
2. High production risk (bad architectural decisions expensive)
3. No acceptable workaround (simple voting demonstrably suboptimal)
4. Immediate AIWG need (orchestrator refactor blocked on this)
-->

**Action Plan:**

- [ ] [Immediate action]
- [ ] [Short-term action]
- [ ] [Long-term action]

<!-- EXAMPLE:
- [ ] Document gap in orchestrator SAD with explicit caution
- [ ] Implement expertise-weighted voting as interim improvement
- [ ] Track conflict resolution outcomes to build pilot data
- [ ] Commission or conduct formal study (entry: pilot findings reviewed)
- [ ] Revise orchestrator based on findings (entry: study findings validated)
-->

#### Gap 2: [Gap Name]

[Repeat structure from Gap 1]

<!-- EXAMPLE:
**Gap 2: Agent Task Decomposition Strategies**

**Criticality:** HIGH

**Description:**
Limited research on optimal strategies for decomposing complex SDLC tasks into agent-sized subtasks. Current work focuses on code-only tasks (MetaGPT, Agentless) but SDLC requires diverse task types (requirements, architecture, testing, deployment).

**Why This Is a Gap:**
- MetaGPT (REF-013): Task decomposition for coding only
- Agentless (REF-XXX): Automated localization for code edits only
- No research on requirements elicitation decomposition
- No research on architectural decision task breakdown

**Impact on AIWG:**
Orchestrator must decompose user request "Build authentication system" into sequence of agent tasks. No research-backed approach for:
- Granularity (how small should subtasks be?)
- Dependency ordering (which tasks must precede others?)
- Parallelization (which tasks can run concurrently?)

Risk: Too coarse = agents overwhelmed; too fine = coordination overhead

**Current Workaround:**
Orchestrator uses heuristic decomposition based on SDLC phases.
Status: Works but suboptimal; occasional agent failures from task scope issues.

**Desired Research:**
- Research question: How should SDLC workflows be decomposed for optimal agent performance?
- Methodology: Comparative evaluation of decomposition strategies on SDLC benchmark
- Success criteria: Agent success rate, workflow efficiency, human intervention rate

**Priority Rationale:**
HIGH (not CRITICAL) because workaround functional but improvable.

**Action Plan:**
- [ ] Document heuristics in orchestrator codebase
- [ ] Collect failure cases for pattern analysis
- [ ] Conduct pilot study on AIWG dogfooding projects (entry: protocol and case sample approved)
- [ ] Propose decomposition framework based on pilot data
-->

### Gap Categories

**By Research Type:**

| Category | Gap Count | Examples |
|----------|-----------|----------|
| Methodology gaps | X | [Gaps in methods/algorithms] |
| Evaluation gaps | X | [Missing benchmarks/metrics] |
| Domain gaps | X | [Unstudied application areas] |
| Scale gaps | X | [Untested at scale] |

<!-- EXAMPLE:
| Category | Gap Count | Examples |
| Methodology gaps | 3 | Conflict resolution, task decomposition, quality assessment |
| Evaluation gaps | 2 | SDLC workflow benchmarks, multi-agent coordination metrics |
| Domain gaps | 4 | Requirements engineering, architecture design, deployment orchestration, testing strategy |
| Scale gaps | 2 | Long-running agent sessions (10+ iterations), large team coordination (5+ agents) |
-->

**By AIWG Component:**

| Component | Gap Count | Blocked Features |
|-----------|-----------|------------------|
| Orchestrator | X | [Features blocked by gaps] |
| Agent X | X | [Features blocked by gaps] |
| Agent Loop | X | [Features blocked by gaps] |

<!-- EXAMPLE:
| Component | Gap Count | Blocked Features |
| Orchestrator | 4 | Multi-agent conflict resolution, task decomposition optimization, parallel workflow management |
| Requirements Analyst | 1 | Automated elicitation strategy |
| Agent Loop | 2 | Multi-loop coordination, quality-based early stopping |
| Test Engineer | 1 | Coverage optimization strategies |
-->

### Understudied Areas

[Areas with limited research but not complete gaps]

#### Understudied Area 1: [Area Name]

**Coverage:** [How many studies, what limitations]

<!-- EXAMPLE:
**Understudied Area 1: Agent-to-Agent Communication Protocols**

**Coverage:** 2 studies (AutoGen, MetaGPT) with significant limitations
-->

**What We Know:**
- [Finding 1 from limited research]
- [Finding 2 from limited research]

<!-- EXAMPLE:
**What We Know:**
- AutoGen: ConversableAgent interface enables send/receive/generateReply
- MetaGPT: Hierarchical publish-subscribe for agent communication
- Both: Focus on simple message passing, not complex coordination
-->

**What We Don't Know:**
- [Unknown 1]
- [Unknown 2]

<!-- EXAMPLE:
**What We Don't Know:**
- Optimal communication topology (direct, hierarchical, broadcast, hybrid?)
- Coordination overhead at scale (5+ agents)
- Error handling when agent fails mid-conversation
- Privacy/isolation (should agent A see all messages to agent B?)
-->

**Implications:**
[How this limited knowledge affects AIWG]

<!-- EXAMPLE:
**Implications:**
AIWG can implement basic communication (per AutoGen) but lacks guidance on:
- When to use pub-sub vs direct communication
- How to prevent message storms with many agents
- How to handle agent failures gracefully

Risk: Medium (functional but potentially inefficient or brittle)
-->

**Action Plan:**
- [ ] [Steps to address this understudied area]

<!-- EXAMPLE:
**Action Plan:**
- [ ] Implement AutoGen pattern as baseline
- [ ] Monitor performance metrics (message volume, latency, failure rate)
- [ ] Identify pain points in production use
- [ ] Contribute findings to research community or conduct follow-up study
-->

</details>

## Phase 3: Action Planning (ADVANCED)

<details>
<summary>Click to expand research agenda and priorities</summary>

### Research Priorities

#### Priority 1: [Highest Priority Gap/Area]

**Gap/Area:** [Reference to gap above]

<!-- EXAMPLE: Gap 1 - Multi-Agent Conflict Resolution -->

**Research Approach:**

**Option A: Commission External Research**
- Target venue: [Conference/journal]
- Potential collaborators: [Institutions/researchers]
- Scope and evidence gate: [Study deliverables, investigator/reviewer roles, passes, and acceptance checks]
- Cost estimate: [Budget if applicable]

<!-- EXAMPLE:
- Target venue: ICLR 2027, AAMAS 2027
- Potential collaborators: Stanford HAI, CMU, UC Berkeley
- Scope and evidence gate: Approved protocol → reproducible dataset → peer-reviewed analysis → submission package
- Cost: $50K-$100K if funded research
-->

**Option B: Internal Pilot Study**
- Methodology: [Approach for lightweight study]
- Data source: [Where we get data]
- Scope and evidence gate: [Pilot cases, analysis passes, validity checks, and owner]
- Validity: [Limitations of internal study]

<!-- EXAMPLE:
- Methodology: A/B test conflict resolution strategies on AIWG dogfooding projects
- Data source: 50+ orchestration decisions from AIWG development
- Scope and evidence gate: Analyze 50+ orchestration decisions; investigator and reviewer verify comparison and limitations
- Validity: Limited generalizability, but actionable for AIWG-specific patterns
-->

**Option C: Implement with Caution**
- Best-guess approach: [What we'll do without research]
- Documentation: [How we flag uncertainty]
- Monitoring: [What we track to validate]
- Revision trigger: [When we revisit based on data]

<!-- EXAMPLE:
- Best-guess approach: Expertise-weighted voting (architect 3x weight on architecture, security 3x on security)
- Documentation: Flag as "EXPERIMENTAL - No research backing" in all docs
- Monitoring: Track decision quality (stakeholder satisfaction), escalation rate
- Revision trigger: If escalation rate >20% or satisfaction <70%, revise approach
-->

**Recommendation:** [Which option and why]

<!-- EXAMPLE:
**Recommendation:** Option B (Internal Pilot) followed by Option A (External Research)

Rationale:
- Need immediate improvement (Option C workaround insufficient)
- Pilot study provides data for better research design
- Prerequisite gate: Reviewed pilot results and limitations inform the external research protocol
-->

#### Priority 2: [Next Priority]

[Repeat structure from Priority 1]

### Research Agenda

**Discovery Pass (entry: gap scope approved):**
- [ ] [Research task 1]
- [ ] [Research task 2]

<!-- EXAMPLE:
- [ ] Conduct conflict resolution pilot study on AIWG projects
- [ ] Collect agent communication metrics from production orchestrator
- [ ] Survey practitioners on multi-agent coordination challenges
-->

**Validation Pass (entry: pilot dataset and practitioner feedback reviewed):**
- [ ] [Research task 1]
- [ ] [Research task 2]

<!-- EXAMPLE:
- [ ] Complete pilot studies and analyze results
- [ ] Publish findings in industry forum or workshop
- [ ] Refine AIWG patterns based on pilot data
- [ ] Commission formal research for critical gaps
-->

**Integration Pass (entry: findings validated and limitations documented):**
- [ ] [Research task 1]
- [ ] [Research task 2]

<!-- EXAMPLE:
- [ ] Contribute to formal research publications
- [ ] Implement research-backed patterns in AIWG
- [ ] Share validated patterns with broader community
- [ ] Update gap analysis with new research findings
-->

### Success Metrics

| Metric | Current | Target | Completion Gate |
|--------|---------|--------|----------|
| [Metric 1] | [Baseline] | [Goal] | [Observable evidence check] |
| [Metric 2] | [Baseline] | [Goal] | [Observable evidence check] |

<!-- EXAMPLE:
| Metric | Current | Target | Completion Gate |
| Critical gaps with no plan | 4 | 0 | Each critical gap has an owner and accepted study scope |
| AIWG patterns with research backing | 60% | 85% | Reviewed evidence linked to each supported pattern |
| Understudied areas investigated | 0 | 3 | Three area analyses reviewed with limitations |
| Community contributions | 0 | 2 papers | Two reproducible submission packages accepted by reviewers |
-->

### Collaboration Opportunities

**Academic Institutions:**
- [Institution 1]: [Expertise relevant to gaps]
- [Institution 2]: [Expertise relevant to gaps]

<!-- EXAMPLE:
- Stanford HAI: Multi-agent systems, human-AI collaboration
- CMU: Agent coordination, task planning
- UC Berkeley: LLM reasoning, tool use
-->

**Industry Partners:**
- [Company 1]: [Mutual interest in gap]
- [Company 2]: [Mutual interest in gap]

<!-- EXAMPLE:
- OpenAI: Agent architecture patterns
- Anthropic: Constitutional AI, agent safety
- Google DeepMind: Multi-agent research
-->

**Open Source Communities:**
- [Community 1]: [Relevant project]
- [Community 2]: [Relevant project]

<!-- EXAMPLE:
- AutoGen: Multi-agent frameworks
- LangChain: Agent orchestration
- Agentless: Code-focused agents
-->

</details>

## Related Gap Analyses

- @.aiwg/research/gap-reports/gap-report-[related-topic]-YYYY-MM-DD.md
- @.aiwg/research/synthesis/topic-XX-[related-topic].md

## References

- @.aiwg/research/findings/ - Literature corpus reviewed
- @.aiwg/research/synthesis/ - Synthesis topics covering this domain
- @.aiwg/architecture/orchestrator-sad.md - Orchestrator affected by gaps
- @.aiwg/requirements/use-cases/ - Use cases requiring gap-filling research

## Template Usage Notes

**When to create a gap report:**
- After completing synthesis on a topic
- Before implementing major framework features
- Annually as part of research corpus maintenance
- When stakeholders request evidence for patterns

**Gap analysis approach:**
1. Define scope clearly (topic boundaries)
2. Review all relevant papers systematically
3. Map coverage using extraction records
4. Identify true gaps vs understudied areas
5. Assess criticality based on AIWG needs
6. Develop action plans with named scope units, owners, prerequisite gates, and verification passes

**Anti-patterns to avoid:**
- Declaring "gap" without systematic search
- Ignoring AIWG relevance (not all gaps matter to us)
- No action plan (gap report without next steps is useless)
- Overstating criticality (not everything is CRITICAL)

## Metadata

- **Template Type:** research-gap-analysis
- **Framework:** research-complete
- **Primary Agent:** @$AIWG_ROOT/agentic/code/frameworks/research-complete/agents/discovery-agent.md
- **Related Templates:**
  - @$AIWG_ROOT/agentic/code/frameworks/research-complete/templates/literature-note.md
  - @$AIWG_ROOT/agentic/code/frameworks/research-complete/templates/extraction.yaml
- **Version:** 1.0.0
- **Last Updated:** 2026-02-03
