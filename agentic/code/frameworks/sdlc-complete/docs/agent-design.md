# Agent Design Bible

The definitive guide for designing reliable, production-grade AI agents in the AIWG framework.

## Research Foundation

This guide synthesizes empirical findings from:

- **[REF-001](#research-production-workflows)**: Bandara et al. (2024) "Production-Grade Agentic AI Workflows" - 9 best practices for production reliability
- **[REF-002](#research-failure-modes)**: Roig (2025) "How Do LLMs Fail In Agentic Scenarios?" - 4 failure archetypes from 900 execution traces

**Key Empirical Finding**: Recovery capability—not model scale or initial correctness—is the dominant predictor of agentic task success. DeepSeek V3.1 achieves 92% success via post-training for verification/recovery, not architectural changes.

## The 10 Golden Rules

### Rule 1: Single Responsibility

Each agent does ONE thing well.

**Rationale**: REF-001 BP-4 establishes that agents with focused responsibilities produce more predictable outputs. Roig (2025) shows multi-purpose agents exhibit higher rates of Archetype 4 failures (coherence loss under load).

**Checklist**:

- [ ] Agent purpose describable in one sentence
- [ ] No "and" in the agent's core function
- [ ] Clear input/output contract
- [ ] Obvious when to use (and when NOT to use) this agent

**Anti-pattern**:

```markdown
# BAD: Multi-purpose agent
name: Code Helper
description: Reviews code, writes tests, fixes bugs, and documents functions
```

**Pattern**:

```markdown
# GOOD: Focused agent
name: Code Reviewer
description: Performs comprehensive code reviews focusing on quality, security, and maintainability
```

### Rule 2: Minimal Tools

Assign 0-3 tools per agent. Prefer fewer.

**Rationale**: REF-001 BP-3 warns against tool sprawl. Each additional tool increases the agent's decision space exponentially. Roig (2025) Archetype 4 shows tool-heavy agents suffer more fragile execution.

**Tool Assignment Guide**:

| Agent Type | Recommended Tools | Rationale |
|------------|-------------------|-----------|
| Research/Analysis | Read, Grep, Glob | Read-only exploration |
| Content Creation | Read, Write | Focused output |
| Code Modification | Read, Edit, Bash | Surgical changes |
| Orchestration | Task | Delegation only |
| Validation | Read, Grep | Verification only |

**Anti-pattern**:

```markdown
tools: Bash, Glob, Grep, Read, Write, Edit, MultiEdit, WebFetch, WebSearch, Task, NotebookEdit
```

**Pattern**:

```markdown
tools: Read, Grep, Write
```

### Rule 3: Explicit Inputs/Outputs

Define exactly what the agent receives and produces.

**Rationale**: Ambiguous contracts cause Roig Archetype 2 failures (over-helpfulness). When agents don't know what they're supposed to produce, they substitute plausible alternatives.

**Contract Template**:

```markdown
## Inputs
- **Required**: [What MUST be provided]
- **Optional**: [What MAY be provided]
- **Context**: [What ambient information is available]

## Outputs
- **Primary**: [The main deliverable]
- **Secondary**: [Supporting artifacts]
- **Format**: [Exact structure/schema]
```

**Example**:

```markdown
## Inputs
- **Required**: File path(s) to review
- **Optional**: Focus areas (security, performance, style)
- **Context**: Project coding standards from CLAUDE.md

## Outputs
- **Primary**: Prioritized list of issues with file:line references
- **Secondary**: Positive observations and overall assessment
- **Format**: Markdown with Critical/High/Medium/Low sections
```

### Rule 4: Grounding Before Action

ALWAYS verify assumptions before modifying external state.

**Rationale**: Roig (2025) Archetype 1 (Premature Action Without Grounding) is a leading cause of cascading failures. Agents that guess schemas instead of inspecting them produce incorrect outputs that compound downstream.

**Grounding Checkpoint**:

Before ANY operation touching external state (files, APIs, databases):

1. **List** available inspection tools (ls, head, schema, describe)
2. **Execute** minimum inspection to confirm assumptions
3. **Document** confirmed state in reasoning
4. **Only then** proceed with modification

**Example**:

```markdown
## Process (Code Reviewer)

1. **Scan**: Read all specified files using Read/Grep/Glob tools
   - VERIFY files exist before analyzing
   - CONFIRM file types match expectations
2. **Analyze**: Evaluate against criteria
3. **Report**: Provide findings with exact file:line references
```

**Anti-pattern**:

```markdown
# BAD: Assumes structure
"The config file has a 'database' section with 'host' and 'port' fields..."
```

**Pattern**:

```markdown
# GOOD: Verifies first
"Let me read the config file to understand its structure..."
[Reads file]
"The config has sections: database, cache, logging. The database section contains..."
```

### Rule 5: Escalate Uncertainty

NEVER silently substitute missing or ambiguous data.

**Rationale**: Roig (2025) Archetype 2 (Over-Helpfulness Under Uncertainty) shows models substitute plausible alternatives when data is missing, producing confidently wrong outputs.

**Uncertainty Protocol**:

When encountering entity mismatches or ambiguous references:

1. **STOP** - Do not proceed with assumptions
2. **LIST** - Show all potential matches with confidence indicators
3. **REPORT** - "Entity 'X' not found. Similar candidates: [list]"
4. **WAIT** - Request clarification before proceeding
5. **DOCUMENT** - Log any assumptions in trace output

**Example Escalation**:

```markdown
## Uncertainty Detected

Task requested: "Update the User service configuration"

Found multiple matches:
- `src/services/UserService.ts` (85% confidence - naming match)
- `src/services/AuthService.ts` (40% confidence - contains user logic)
- `config/services/user.yaml` (60% confidence - configuration file)

**Action Required**: Please specify which file(s) to modify, or confirm the primary match.
```

**Anti-pattern**:

```markdown
# BAD: Silent substitution
Task: "Find revenue for Acme Corp"
[CSV contains "Acme Corporation" and "Acme Inc"]
"The revenue for Acme Corp is $1.2M" (silently used "Acme Corporation")
```

### Rule 6: Scoped Context

Only process information relevant to the current task.

**Rationale**: Roig (2025) Archetype 3 (Distractor-Induced Context Pollution) shows that irrelevant but superficially similar information derails reasoning. The "Chekhov's gun" effect—if data is present, models assume it must be relevant.

**Context Scoping Protocol**:

1. **Identify** explicit task scope (time ranges, entity filters, operation type)
2. **Classify** context sections:
   - **RELEVANT**: Directly supports task
   - **PERIPHERAL**: May be useful for edge cases
   - **DISTRACTOR**: Similar but out of scope
3. **Process** RELEVANT first, PERIPHERAL only if needed
4. **Ignore** DISTRACTOR content entirely

**Example**:

```markdown
## Task Scope Analysis

Task: "Calculate Q4 revenue for Product A"

Context Classification:
- RELEVANT: Q4 data rows, Product A entries
- PERIPHERAL: Q4 data for Products B, C (same time period)
- DISTRACTOR: Q1-Q3 data for Product A (wrong time period)

Processing: Focus on rows where quarter='Q4' AND product='A'
```

### Rule 7: Recovery-First Design

Build agents that can diagnose and recover from failures.

**Rationale**: REF-002's key finding: recovery capability is THE dominant predictor of success. DeepSeek V3.1's 92% success rate comes from post-training for verification/recovery behaviors.

**Recovery Protocol**:

```
1. PAUSE   - Stop execution, preserve state
2. DIAGNOSE - Analyze error message and execution trace
   - Syntax error? → Fix formatting
   - Schema mismatch? → Re-inspect target
   - Logic error? → Decompose into smaller steps
   - Loop detected? → Change approach entirely
3. ADAPT   - Choose recovery strategy based on diagnosis
4. RETRY   - With adapted approach (max 3 attempts)
5. ESCALATE - If 3 adapted retries fail, request human intervention
```

**Agent Template Addition**:

```markdown
## Error Handling

When encountering errors:
1. Capture the full error message and context
2. Analyze root cause before retrying
3. Adapt approach if same error occurs twice
4. Report blocking issues with:
   - What was attempted
   - What failed
   - What was tried to recover
   - What human input is needed
```

### Rule 8: Appropriate Model Tier

Match model capability to task complexity.

**Rationale**: REF-001 BP-6 and REF-002 both show that model scale alone doesn't predict reliability. Use the right tier for the task—don't waste capacity on simple operations.

**Model Selection Guide**:

| Tier | Model | Use For | Avoid For |
|------|-------|---------|-----------|
| **Efficiency** | haiku | Validation, formatting, simple transforms | Complex reasoning, architecture |
| **Balanced** | sonnet | Most development tasks, code review | Novel architecture, critical decisions |
| **Reasoning** | opus | Architecture, security analysis, complex trade-offs | Routine operations, high-volume tasks |

**Task-to-Tier Mapping**:

```markdown
# HAIKU (efficiency)
- Linting and formatting
- Simple file operations
- Template population
- Status checks

# SONNET (balanced)
- Code review
- Test generation
- Documentation
- Bug investigation

# OPUS (reasoning)
- Architecture design
- Security threat modeling
- Complex refactoring
- Critical decision making
```

### Rule 9: Parallel-Ready

Design agents to run concurrently when tasks are independent.

**Rationale**: REF-001 BP-9 (KISS) emphasizes simple, composable agents. Independent agents can run in parallel, dramatically improving throughput.

**Parallel Design Checklist**:

- [ ] Agent has no dependencies on other agents' outputs (or dependencies are explicit)
- [ ] Agent doesn't modify shared state without coordination
- [ ] Agent can be launched via Task tool alongside others
- [ ] Agent's output is self-contained and mergeable

**Orchestration Pattern**:

```markdown
## Parallel Review Pattern

For comprehensive document review, launch simultaneously:
- Security Architect → Security validation
- Test Architect → Testability review
- Technical Writer → Clarity review
- Requirements Analyst → Traceability check

All reviewers read the same input, produce independent feedback.
Synthesizer agent merges feedback afterward.
```

### Rule 10: Observable Execution

Produce traceable outputs for debugging and improvement.

**Rationale**: REF-001 emphasizes observability throughout. Without traces, failures can't be diagnosed or prevented.

**Observability Requirements**:

```markdown
## Trace Output

Every agent should log:
1. **Start**: Task received, inputs summary
2. **Plan**: Intended approach
3. **Steps**: Each significant action taken
4. **Decisions**: Why alternatives were rejected
5. **Result**: Final output summary
6. **Metrics**: Duration, tokens used, tools invoked
```

**Example Trace**:

```
[2025-12-10T10:30:00Z] CODE-REVIEWER started
  Input: src/api/*.ts (12 files)
  Focus: security, performance
[2025-12-10T10:30:01Z] PLAN: Scan → Analyze → Prioritize → Report
[2025-12-10T10:30:02Z] STEP: Reading src/api/auth.ts (342 lines)
[2025-12-10T10:30:05Z] FINDING: SQL injection at auth.ts:87
[2025-12-10T10:30:15Z] COMPLETE
  Duration: 15s
  Findings: 3 critical, 5 high, 12 medium
  Files reviewed: 12/12
```

## When NOT to Use an Agent

**REF-001 BP-2** explicitly identifies when to bypass agents for direct function calls.

### Use Direct Functions For

| Operation | Why Not Agent |
|-----------|---------------|
| File I/O (read/write) | Deterministic, no reasoning needed |
| String formatting | Pure transformation |
| Data validation (schema) | Rule-based, predictable |
| HTTP requests | API call, not decision |
| Math calculations | Deterministic computation |

### Use Agents For

| Operation | Why Agent |
|-----------|-----------|
| Code review | Requires judgment |
| Architecture decisions | Trade-off analysis |
| Content generation | Creative reasoning |
| Error diagnosis | Root cause analysis |
| Multi-step workflows | Coordination needed |

**Decision Rule**: If the operation is deterministic and requires no judgment, use a direct function. If it requires reasoning, judgment, or creativity, use an agent.

## Agent Definition Template

```markdown
---
name: [Agent Name]
description: [One sentence describing single responsibility]
model: [claude-haiku-4-5|claude-sonnet-5|claude-opus-5]  # Pin variant; bare aliases inherit parent context. See #1442.
tools: [Minimal tool list, 0-3 preferred]
---

# [Agent Name]

You are a [role] specializing in [specific focus].

## Inputs

- **Required**: [What must be provided]
- **Optional**: [What may be provided]
- **Context**: [Ambient information available]

## Outputs

- **Primary**: [Main deliverable]
- **Format**: [Structure/schema]

## Process

1. **Ground**: [Verification step before action]
2. **Execute**: [Core task steps]
3. **Validate**: [Output verification]

## Uncertainty Handling

When encountering ambiguity:
1. Stop and document the uncertainty
2. List potential interpretations
3. Request clarification before proceeding

## Error Recovery

When encountering errors:
1. Capture full error context
2. Diagnose root cause
3. Adapt approach (don't retry blindly)
4. Escalate if 3 adapted attempts fail

## Example Usage

[Concrete example of input → output]
```

## Validation Checklist

Before deploying any agent, verify:

### Structure

- [ ] Single responsibility (Rule 1)
- [ ] 0-3 tools assigned (Rule 2)
- [ ] Explicit inputs/outputs (Rule 3)
- [ ] Appropriate model tier (Rule 8)

### Behavior

- [ ] Grounding step included (Rule 4)
- [ ] Uncertainty escalation defined (Rule 5)
- [ ] Context scoping guidance (Rule 6)
- [ ] Recovery protocol specified (Rule 7)

### Operations

- [ ] Parallel-ready design (Rule 9)
- [ ] Observable execution (Rule 10)

### Meta

- [ ] Clear when NOT to use this agent
- [ ] Example usage provided
- [ ] Error scenarios documented

## Failure Archetype Prevention

Quick reference for avoiding the four empirically-identified failure modes:

| Archetype | Prevention | Rule |
|-----------|------------|------|
| Premature Action | Grounding checkpoint | Rule 4 |
| Over-Helpfulness | Uncertainty escalation | Rule 5 |
| Distractor Pollution | Context scoping | Rule 6 |
| Fragile Execution | Recovery-first design | Rule 7 |

## Multi-Agent Patterns

### Primary → Reviewers → Synthesizer

Standard pattern for artifact generation:

```
Primary Author (opus) → Creates draft
    ↓
Parallel Reviewers (sonnet) → Independent review
    - Security review
    - Technical review
    - Standards review
    ↓
Synthesizer (sonnet) → Merges feedback into final
```

### Decompose → Execute → Validate

Pattern for complex tasks:

```
Decomposer (opus) → Breaks into ≤7 subtasks
    ↓
Executors (haiku/sonnet) → Complete subtasks in parallel
    ↓
Validator (sonnet) → Verifies completeness and consistency
```

### Scout → Decide → Act

Pattern for uncertain operations:

```
Scout (haiku) → Gathers information, identifies options
    ↓
Decider (opus) → Evaluates options, chooses approach
    ↓
Actor (sonnet) → Executes chosen approach
```

## References

- [REF-001: Production-Grade Agentic AI Workflows](#research-production-workflows)
- [REF-002: How Do LLMs Fail In Agentic Scenarios?](#research-failure-modes)
- [Production-Grade Guide](#ref-production-grade)

## Revision History

| Date | Author | Changes |
|------|--------|---------|
| 2025-12-10 | AIWG | Initial version synthesizing REF-001 and REF-002 findings |
