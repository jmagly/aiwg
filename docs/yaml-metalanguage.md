# YAML Metalanguage Schemas

**Issue:** #447 (merge: YAML metalanguage schemas and multi-provider hooks)
**Version:** 2026.2.0
**Status:** Active

## Overview

AIWG defines four JSON Schema definitions (expressed as `.schema.json` files) for declaring agents, rules, skills, and flows in YAML. These schemas form a declarative metalanguage for AIWG extension definitions — a structured alternative to the prose-heavy markdown format used by most AI tool configurations.

Declarative YAML definitions are:

- **Validated** — schema-checked at `aiwg validate-metadata` time
- **Portable** — the same definition can be projected onto the supported surfaces of all 15 named provider integrations
- **Parseable** — tools like `aiwg catalog` and `aiwg index` can read structure without parsing prose
- **Version-controlled** — diffs are meaningful (a field change, not a prose rewrite)

Markdown format (`.md` files with YAML frontmatter) remains fully supported and is the default for complex agents with long prose instructions. YAML definitions are best suited for concise, well-bounded definitions.

## Schema Locations

```
agentic/code/frameworks/sdlc-complete/schemas/metalanguage/
├── agent.schema.json     ← Agent identity, capabilities, operating rhythm
├── rule.schema.json      ← Enforcement rule with prohibitions and recovery
├── skill.schema.json     ← Natural language skill with triggers and workflow
├── flow.schema.json      ← Multi-agent workflow orchestration
└── examples/
    ├── code-reviewer.agent.yaml
    ├── anti-laziness.rule.yaml
    ├── project-awareness.skill.yaml
    └── inception-to-elaboration.flow.yaml
```

Schema IDs follow the pattern `https://aiwg.io/schemas/metalanguage/{type}.schema.json`.

## Agent Schema

Declares an agent's identity, tools, responsibilities, operating rhythm, and deliverables.

**Required fields:** `agent.id`, `agent.responsibilities`

```yaml
agent:
  id: code-reviewer            # Lowercase, hyphenated
  name: Code Reviewer
  role: reviewer
  model: sonnet                # opus | sonnet | haiku | auto
  tools: [Read, Grep, Glob, Write]

  responsibilities:
    - security: [input_validation, auth, crypto, injection]
    - performance: [algorithms, db_queries, n_plus_one, caching]
    - quality: [naming, structure, duplication, complexity]

  operating_rhythm:
    - scan: { tools: [Read, Grep] }
    - analyze: { depends_on: scan }
    - report: { depends_on: analyze }

  deliverables:
    - critical_issues: "Security vulnerabilities, data loss risks"
    - performance_issues: "N+1 queries, missing indexes, unbounded loops"
    - quality_assessment: "Score with rationale"

  rules: [token-security, executable-feedback, anti-laziness]
  platforms: [claude-code, opencode, cursor, copilot, devin, warp, factory]
```

**`operating_rhythm`** is an ordered list of named steps. Each step can declare which tools it uses and which prior step it depends on. This makes execution order explicit and enables tooling to validate that dependencies are satisfied.

**`responsibilities`** is a list of objects where each key is a domain and each value is a list of specific capabilities. This structure allows `aiwg catalog` to surface agents by capability.

## Rule Schema

Declares an enforcement rule with severity, tier, prohibitions, requirements, and recovery protocol.

**Required fields:** `rule.id`, `rule.severity`

```yaml
rule:
  id: anti-laziness
  name: Anti-Laziness
  description: Prevent destructive avoidance behaviors in agent execution
  severity: HIGH              # CRITICAL | HIGH | MEDIUM | LOW
  tier: core                  # core | sdlc | research | addon
  when_to_apply: Test failures, difficult bugs, refactoring, coverage regression

  prohibitions:
    - delete_tests_to_pass
    - skip_tests
    - remove_features_instead_of_fixing
    - weaken_assertions
    - premature_task_abandonment

  requirements:
    - escalate_after_3_failed_attempts
    - preserve_test_coverage
    - fix_root_cause_not_symptoms

  recovery_protocol:
    - PAUSE
    - DIAGNOSE
    - ADAPT
    - RETRY
    - ESCALATE

  max_retries: 3

  exceptions:
    - explicitly_requested_by_user
    - test_is_genuinely_obsolete
```

**`tier`** maps to the rules deployment tier: `core` rules deploy to every AIWG installation; `sdlc` rules deploy with the SDLC framework; `research` with the research addon; `addon` with specific addons.

## Skill Schema

Declares a natural language skill with trigger phrases, parameters, an optional workflow, and platform targeting.

**Required fields:** `skill.id`, `skill.triggers`

```yaml
skill:
  id: project-awareness
  name: Project Awareness
  description: Automatically detect and surface project context
  version: 1.0.0

  triggers:
    - "what's the project status"
    - "where are we in the SDLC"
    - "project overview"
    - "what phase are we in"

  parameters:
    include_risks:
      type: boolean
      required: false
      default: true
      description: Include risk register summary
    format:
      type: string
      required: false
      default: summary
      description: Output format (summary | detailed | json)

  platforms: [claude-code, cursor, copilot]

  workflow:
    - step: read-phase
      action: Read current SDLC phase from .aiwg/planning/
    - step: read-artifacts
      action: List key artifacts in .aiwg/
      depends_on: read-phase
    - step: read-risks
      action: Summarize .aiwg/risks/risk-register.md
      depends_on: read-phase
    - step: synthesize
      action: Produce status summary
      depends_on: [read-artifacts, read-risks]
```

**`triggers`** are natural language phrases that activate the skill. The platform-specific routing layer matches incoming messages against these phrases.

## Flow Schema

Declares a multi-agent workflow with entry criteria, ordered steps with parallel groups, and exit criteria.

**Required fields:** `flow.id`, `flow.steps`

```yaml
flow:
  id: inception-to-elaboration
  name: Inception to Elaboration Transition
  description: Orchestrate the transition from Inception to Elaboration phase
  model: opus

  entry_criteria:
    gate: LOM
    artifacts:
      - path: .aiwg/requirements/vision-document.md
        required: true
      - path: .aiwg/intake/project-intake.md
        required: true

  steps:
    - id: requirements-analysis
      agent: requirements-analyst
      parallel_group: reviews
      inputs: [vision-document.md]
      outputs:
        - path: .aiwg/requirements/use-case-briefs/
          type: directory
      prompt: |
        Analyze vision document, generate use case briefs
        for all identified features.
      max_retries: 3

    - id: architecture-baseline
      agent: architecture-designer
      parallel_group: reviews
      inputs: [vision-document.md]
      outputs:
        - path: .aiwg/architecture/architecture-baseline.md
          type: file

    - id: synthesis
      agent: documentation-synthesizer
      depends_on: [requirements-analysis, architecture-baseline]
      outputs:
        - path: .aiwg/reports/abm-report.md
          type: file

  exit_criteria:
    gate: ABM
    decision: [GO, CONDITIONAL_GO, NO_GO]

  next_flows:
    GO: elaboration-to-construction
    CONDITIONAL_GO: elaboration-to-construction
```

**`parallel_group`** — steps sharing the same group name run concurrently. The synthesizer step above waits for both parallel steps to complete before running (`depends_on`).

**`entry_criteria.gate`** and **`exit_criteria.gate`** reference phase milestone names (LOM = Lifecycle Objective Milestone, ABM = Architecture Baseline Milestone). The orchestrator checks these before starting and after completing the flow.

**`next_flows`** maps exit decision values to the next flow ID, enabling chained phase transitions.

## Validation

Run schema validation against all YAML definitions in the project:

```bash
aiwg validate-metadata
```

This checks:
- Required fields are present
- `id` fields match the `^[a-z0-9-]+$` pattern
- `severity` and `tier` values are from the allowed enums
- `model` values are from the allowed list
- `platforms` values are known provider names

Validation errors include the field path and the violated constraint, making them easy to locate and fix.

## When to Use YAML vs Markdown

Use YAML definitions when:
- The agent has a short, well-bounded system prompt that fits naturally in a `prompt` field
- The definition is primarily structural (responsibilities, tools, operating rhythm)
- You want tight schema validation and catalog discoverability

Use markdown definitions when:
- The agent has extensive prose instructions, examples, or reference tables
- The definition includes few-shot examples that benefit from rich formatting
- You are iterating quickly and do not want schema constraints yet

Both formats coexist in the same project. The extension loader handles both.

## References

- `agentic/code/frameworks/sdlc-complete/schemas/metalanguage/agent.schema.json`
- `agentic/code/frameworks/sdlc-complete/schemas/metalanguage/rule.schema.json`
- `agentic/code/frameworks/sdlc-complete/schemas/metalanguage/skill.schema.json`
- `agentic/code/frameworks/sdlc-complete/schemas/metalanguage/flow.schema.json`
- `agentic/code/frameworks/sdlc-complete/schemas/metalanguage/examples/`
- @src/extensions/types.ts — TypeScript extension type definitions
- @src/extensions/validation.ts — Extension validation (uses these schemas)
- @docs/extensions/extension-types.md — Extension type reference
