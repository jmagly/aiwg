# Flow Command Parameters Template

**Purpose**: Standard parameter handling for all SDLC flow commands

## Standard Parameters

All flow commands in `agentic/code/frameworks/sdlc-complete/commands/flow-*.md` should support:

### Required Parameters
- `<primary-parameter>`: Command-specific required parameter (varies by flow)

### Optional Parameters
- `[project-directory]`: Path to project root (default: `.`)
- `--guidance "text"`: Free-form strategic guidance to influence execution
- `--interactive`: Enable interactive mode with strategic questions

## Parameter Usage Patterns

### --guidance Parameter

**Purpose**: Allow users to provide strategic direction upfront rather than redirecting post-generation.

**Format**: `--guidance "free-form text describing priorities, constraints, or focus areas"`

**Examples**:
```bash
# Security focus
/flow-architecture-evolution --guidance "Focus on security architecture first, SOC2 audit in 3 months"

# Performance focus
/flow-performance-optimization --guidance "User-facing latency critical, aim for <100ms p95"

# Team skill gaps
/flow-inception-to-elaboration --guidance "Team has limited DevOps experience, need extra infrastructure support"

# Business constraints
/flow-change-control --guidance "Regulatory approval required, prioritize compliance impact analysis"
```

**Implementation**:
```markdown
## Parameter Handling

### Step 0: Parse Guidance (if provided)

If `--guidance` parameter present:

1. **Extract Strategic Context**:
   ```bash
   GUIDANCE="$1"  # Captured from command invocation
   ```

2. **Influence Execution**:
   - **Priority Adjustments**: If guidance mentions priorities (security, performance, cost, speed), weight activities accordingly
   - **Focus Areas**: If guidance specifies domain focus (compliance, scale, team skills), emphasize relevant templates and agents
   - **Risk Awareness**: If guidance mentions risks or constraints, add to risk considerations
   - **Agent Selection**: If guidance implies specialized needs, assign domain-specific agents

3. **Document Guidance**:
   ```bash
   # Add to artifact metadata
   cat >> .aiwg/working/{artifact}/metadata.json <<EOF
   {
     "guidance-provided": "$GUIDANCE",
     "guidance-influence": {
       "priorities-adjusted": true,
       "focus-areas": ["security", "compliance"],
       "additional-agents": ["security-architect", "legal-liaison"]
     }
   }
   EOF
   ```

**Example Influence Logic**:
- Guidance mentions "security" → Add Security Architect to reviewers, prioritize security templates
- Guidance mentions "tight timeline" → Reduce optional artifacts, focus on critical path
- Guidance mentions "compliance" → Add Legal Liaison and Privacy Officer to reviewers
- Guidance mentions "team skills gap" → Add mentoring focus to agent assignments
```

### --interactive Parameter

**Purpose**: Prompt user with 5-10 strategic questions to gather context before execution.

**Format**: `--interactive` (boolean flag)

**Examples**:
```bash
# Interactive mode prompts before execution
/flow-architecture-evolution --interactive

# Can combine with guidance (guidance pre-fills answers)
/flow-inception-to-elaboration --interactive --guidance "Focus on security"
```

**Implementation**:
```markdown
### Step 0: Interactive Mode (if enabled)

If `--interactive` flag present:

1. **Display Flow Context**:
   ```markdown
   # {Flow Name} - Interactive Setup

   **Purpose**: {brief description of what this flow accomplishes}
   **Scope Units**: {named artifacts, agent roles, review passes, and completion gates}
   **Key Outputs**: {main artifacts generated}

   **Context**: I'll ask 5-10 strategic questions to tailor this flow to your project's needs.
   Your answers will influence agent assignments, template selection, and activity priorities.
   ```

2. **Ask Strategic Questions** (5-10 questions, flow-specific):

   **Question Categories**:
   - **Priority/Focus**: What matters most? (Security, Performance, Cost, Speed, Quality)
   - **Constraints**: What are your main constraints? (Operator-supplied commitments, Budget, Team Skills, Compliance)
   - **Risk Awareness**: What keeps you up at night about this project?
   - **Team Context**: What are your team's strengths and gaps?
   - **Domain Specifics**: {flow-specific domain questions}
   - **Success Criteria**: How will you measure success for this activity?

   **Example Question Flow** (Architecture Evolution):
   ```
   Q1: What's driving this architecture change? (New requirements, performance issues, tech debt, scaling needs)

   Q2: What are your top priorities for the architecture? (Rank: Security, Performance, Maintainability, Cost)

   Q3: What are your biggest constraints? (Operator-supplied commitments, team skills, budget, compliance requirements)

   Q4: What architectural risks concern you most? (Data migration, backward compatibility, integration complexity)

   Q5: How mature is your current architecture documentation? (Comprehensive, Outdated, Minimal, None)

   Q6: What's your team's experience level with architecture reviews? (Expert, Intermediate, Learning, New)

   Q7: Are there compliance or regulatory requirements? (If yes, specify: GDPR, HIPAA, SOC2, PCI-DSS, etc.)

   Q8: Which deliverables and acceptance gates define this architecture evolution? Record any operator-supplied dates separately with their source; do not infer dates or durations.
   ```

3. **Synthesize Guidance**:
   ```markdown
   Based on your answers, I'll:
   - Prioritize: {derived priorities from Q2}
   - Focus on: {key constraints and risks from Q3-Q4}
   - Assign agents: {recommended agents based on team gaps from Q6}
   - Adapt templates: {template adjustments based on maturity from Q5}
   - Address compliance: {compliance focus from Q7}
   - Define scope and gates: {deliverables and acceptance checks from Q8}; preserve supplied commitments separately

   Proceed with these adjustments? (yes/no)
   ```

4. **Convert to Guidance String** (for internal use):
   ```bash
   # Synthesize answers into guidance string
   GUIDANCE="Priorities: Security>Performance>Cost. Constraints: Operator-supplied SOC2 audit in 3 months (source: user guidance); team skills gap in DevOps. Scope: architecture baseline, security review, migration validation; gates: reviewer approval and passing checks. Risks: Data migration complexity, backward compatibility. Compliance: SOC2 audit required. Architecture maturity: Minimal docs, need comprehensive."

   # Continue with guidance-influenced execution
   ```

**Question Design Guidelines**:
- **Provide Context**: Explain why you're asking each question
- **Offer Examples**: Show example answers to guide users
- **Allow Skip**: Let users skip questions with "unsure" or "N/A"
- **Keep Focused**: 5-10 questions max, prioritize most impactful
- **Be Specific**: Ask about this flow's domain, not generic project questions
- **Show Influence**: Explain how answers will affect execution
```

## Integration Pattern for Existing Flow Commands

### Frontmatter Update

**Before**:
```yaml
---
description: Execute {Flow Name} with automated coordination
argument-hint: <primary-param> [project-directory]
---
```

**After**:
```yaml
---
description: Execute {Flow Name} with automated coordination
argument-hint: <primary-param> [project-directory] [--guidance "text"] [--interactive]
---
```

### Command Documentation Update

Add to "Your Task" section:

```markdown
## Your Task

When invoked with `/flow-{name} <primary-param> [options]`:

**Options**:
- `[project-directory]`: Path to project root (default: `.`)
- `--guidance "text"`: Strategic guidance to influence execution (priorities, constraints, focus areas)
- `--interactive`: Enable interactive mode with 5-10 strategic questions

**Execution Flow**:
1. **Step 0**: Parse guidance (if provided) or prompt interactively (if flag set)
2. **Step 1-N**: Execute flow-specific steps with guidance-influenced decisions
3. **Final Step**: Generate outputs reflecting guidance priorities
```

### Parameter Parsing Logic

Add as first step in flow:

```markdown
## Execution Steps

### Step 0: Parameter Parsing and Guidance Setup

**Parse Command Line**:
```bash
# Extract parameters
PRIMARY_PARAM="$1"
PROJECT_DIR="${2:-.}"
GUIDANCE=""
INTERACTIVE=false

# Parse optional flags
shift 2  # Skip primary and project-dir
while [[ $# -gt 0 ]]; do
  case "$1" in
    --guidance)
      GUIDANCE="$2"
      shift 2
      ;;
    --interactive)
      INTERACTIVE=true
      shift
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done
```

**Handle Interactive Mode**:
```bash
if [ "$INTERACTIVE" = true ]; then
  # Display flow context
  echo "# {Flow Name} - Interactive Setup"
  echo ""
  echo "**Purpose**: {description}"
  echo ""
  echo "I'll ask 5-10 strategic questions to tailor this flow."
  echo ""

  # Ask questions (flow-specific)
  read -p "Q1: {question}? " answer1
  read -p "Q2: {question}? " answer2
  # ... (5-10 questions)

  # Synthesize guidance
  GUIDANCE="Priorities: $answer2. Constraints: $answer3. Focus: $answer1."
  echo ""
  echo "Synthesized guidance: $GUIDANCE"
  echo ""
  read -p "Proceed with these adjustments? (yes/no) " confirm
  if [ "$confirm" != "yes" ]; then
    echo "Aborting flow."
    exit 0
  fi
fi
```

**Apply Guidance**:
```bash
if [ -n "$GUIDANCE" ]; then
  # Parse guidance for keywords
  if echo "$GUIDANCE" | grep -qi "security"; then
    FOCUS_SECURITY=true
  fi
  if echo "$GUIDANCE" | grep -qi "performance"; then
    FOCUS_PERFORMANCE=true
  fi
  # ... (add more keyword detection)

  # Adjust agent assignments
  if [ "$FOCUS_SECURITY" = true ]; then
    REVIEWERS="$REVIEWERS security-architect privacy-officer"
  fi

  # Document guidance influence
  mkdir -p .aiwg/working/{artifact}
  cat >> .aiwg/working/{artifact}/metadata.json <<EOF
{
  "guidance-provided": "$GUIDANCE",
  "guidance-keywords": ["security", "performance"],
  "adjusted-agents": ["security-architect", "privacy-officer"]
}
EOF
fi
```
```

## Flow-Specific Question Examples

### flow-inception-to-elaboration

**Strategic Questions** (8 questions):
1. What are your top priorities for Elaboration? (Rank: Requirements detail, Architecture refinement, Risk retirement, Prototype)
2. What percentage of requirements do you estimate are understood? (0-25%, 25-50%, 50-75%, 75-100%)
3. What are your biggest architectural unknowns? (Tech stack feasibility, integration complexity, performance, scalability)
4. What's your team's size and composition? (Solo, 2-5 people, 5-10, 10+ with roles)
5. What deliverables and gates are required for Elaboration? Are there operator-supplied commitments to record with their source?
6. What domain expertise does your team have? (Strong, Moderate, Learning, New to domain)
7. Are there regulatory or compliance requirements? (None, GDPR, HIPAA, SOC2, PCI-DSS, Other)
8. What's your testing maturity? (Comprehensive automated, Some tests, Manual only, No tests yet)

### flow-architecture-evolution

**Strategic Questions** (7 questions):
1. What's driving this architecture change? (New requirements, Performance issues, Tech debt, Scaling needs, Security)
2. What are your top priorities? (Rank: Security, Performance, Maintainability, Cost, Speed)
3. What are your biggest constraints? (Operator-supplied commitments, Team skills, Budget, Compliance, Backward compatibility)
4. What architectural risks concern you most? (Data migration, Breaking changes, Integration complexity, Performance regression)
5. How mature is your current architecture documentation? (Comprehensive, Outdated, Minimal, None)
6. What's your team's architecture review experience? (Expert, Intermediate, Learning, New)
7. Which scope units, review passes, and completion gates are required for this evolution?

### flow-test-strategy-execution

**Strategic Questions** (6 questions):
1. What test levels are you targeting? (Unit, Integration, E2E, Performance, Security - select all)
2. What's your current test coverage? (High >80%, Medium 50-80%, Low <50%, None)
3. What are your top quality concerns? (Correctness, Performance, Security, Reliability, Usability)
4. What's your test automation maturity? (Comprehensive CI/CD, Some automation, Manual testing, No tests)
5. What's your acceptable test execution time? (<5 min, 5-15 min, 15-30 min, >30 min acceptable)
6. What's your team's testing expertise? (QA specialists, Developers test, Learning TDD, New to testing)

### flow-security-review-cycle

**Strategic Questions** (8 questions):
1. What's triggering this security review? (New feature, Audit prep, Incident, Scheduled, Compliance)
2. What are your top security concerns? (Rank: Authentication, Data protection, API security, Infrastructure, Code vulnerabilities)
3. What compliance frameworks apply? (None, GDPR, HIPAA, SOC2, PCI-DSS, ISO 27001, Other)
4. How sensitive is your data? (Public, Internal, Confidential, Restricted/PII)
5. What's your security tooling maturity? (Comprehensive SAST/DAST/SCA, Some tools, Manual review, None)
6. What's your team's security expertise? (Dedicated security team, Security-aware developers, Learning, New)
7. What's your incident response readiness? (Documented playbooks, Ad-hoc process, No process)
8. What is the review scope and required coverage? (Critical paths, Changed components, Full architecture); record operator commitments separately.

### flow-performance-optimization

**Strategic Questions** (7 questions):
1. What performance issue are you addressing? (Latency, Throughput, Resource usage, Scalability, Cost)
2. What's your current performance baseline? (Measured SLOs, Rough estimates, Unknown)
3. What's your target performance improvement? (10-30%, 2-5x, 10x+, Just fix critical issues)
4. Where do you suspect bottlenecks? (Database, API, Frontend, Network, Algorithm complexity)
5. What's your monitoring maturity? (Comprehensive APM, Basic metrics, Logs only, None)
6. What's your acceptable optimization investment? (Quick wins only, Moderate refactor, Major redesign)
7. What's your timeline pressure? (Urgent production issue, Scheduled optimization, Ongoing improvement)

### flow-change-control

**Strategic Questions** (6 questions):
1. What type of change is this? (Feature, Bug fix, Refactor, Infrastructure, Security patch, Emergency)
2. What's the change urgency? (Emergency, High, Medium, Low)
3. What's the change scope? (Single component, Multiple services, Architecture, Infrastructure)
4. What are the biggest risks? (Breaking changes, Data migration, Downtime, Backward compatibility)
5. What's your rollback confidence? (Automated rollback, Manual revert tested, Difficult to rollback, Irreversible)
6. What's your change control maturity? (Formal CCB, Lightweight approval, Ad-hoc, No process)

## Template Repository Path Configuration

All template references should use the configurable AIWG_ROOT path resolution:

```bash
# Source path resolution function (once per flow)
AIWG_ROOT=$(resolve_aiwg_root)  # From aiwg-config-template.md

# Use in template paths
TEMPLATE=$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/{category}/{template-name}.md

# Error handling
if [ ! -f "$TEMPLATE" ]; then
  echo "Error: Template not found: $TEMPLATE"
  echo "Please ensure AIWG is installed or set AIWG_ROOT environment variable"
  exit 1
fi
```

## Summary

**For each flow command**:
1. Update frontmatter with `[--guidance "text"] [--interactive]` in argument-hint
2. Add Step 0: Parameter Parsing and Guidance Setup
3. Add flow-specific strategic questions for interactive mode
4. Apply guidance keywords to influence agent assignments, template selection, priorities
5. Document guidance influence in artifact metadata
6. Use configurable AIWG_ROOT for template paths (not hardcoded ~/.local/share/ai-writing-guide)

**Benefits**:
- Users express direction upfront (vs redirecting post-generation)
- Consistent parameter handling across all flows
- Interactive mode lowers barrier for new users
- Guidance parameter enables power users to streamline
- Agent assignments adapt to project context
- Template selection responds to priorities and constraints
