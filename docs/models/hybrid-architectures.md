# Hybrid Model Architecture Guide

Model routing does not grant authority. Apply [autonomy classification and human operating roles](../autonomy-and-human-roles.md); the most restrictive risk dimension controls checkpoints.

Cost-optimized strategies for routing AIWG workloads across multiple models and providers. Covers cascade patterns, task classification, cost modeling, and AIWG configuration templates for multi-provider setups.

---

## When to Use This Guide

Use this guide if you are:

- Running AIWG at scale and want to reduce API spend
- Mixing Claude, GPT/Codex, and local models in one deployment
- Building custom orchestration that routes tasks to different model tiers
- Using the RLM addon for sub-agent delegation across providers
- Designing a team setup where different agents use different backends

---

## Quick Start

```bash
# Deploy SDLC framework with cost-optimized routing
# Reasoning agents → Claude Opus
# Coding agents → Claude Sonnet
# Efficiency agents → Claude Haiku
aiwg use sdlc

# Override specific tiers for cost reduction
aiwg use sdlc \
  --reasoning-model claude-opus-5 \
  --coding-model claude-sonnet-5 \
  --efficiency-model claude-haiku-4-5

# Preview without deploying
aiwg use sdlc --dry-run
```

---

## Core Principle: Match Model Capability to Task Complexity

The most effective cost reduction strategy is not using cheaper models — it is using the right model for each task.

| Task Complexity | Appropriate Tier | Example Tasks |
|----------------|-----------------|---------------|
| Analytical, strategic | opus (reasoning) | Architecture review, threat modeling, requirements analysis |
| Technical, multi-step | sonnet (coding) | Code generation, debugging, test writing |
| Mechanical, repetitive | haiku (efficiency) | Formatting, summarization, file operations, diff generation |

Mismatches are expensive in both directions: using opus for formatting wastes money; using haiku for architecture decisions wastes developer time reviewing low-quality output.

---

## Model Cascade Pattern

A cascade uses a fast, cheap model first and escalates to a more capable model only when necessary. This reduces cost on workloads where most inputs are simple, with occasional complex cases.

### Cascade Architecture

```
User request
    │
    ▼
[Fast model: haiku/gpt-5.6-luna]
    │
    ├── Simple case detected → Return result directly
    │
    └── Complex case detected → Escalate
            │
            ▼
        [Mid-tier: sonnet/gpt-5.6-terra]
            │
            ├── Resolved → Return result
            │
            └── Requires deep reasoning → Escalate
                        │
                        ▼
                [Premium: opus/gpt-5.6-sol]
                        │
                        └── Return final result
```

### Implementing Cascade in AIWG

Use the RLM addon's sub-agent spawning to implement cascades:

```bash
# Deploy RLM addon
aiwg use rlm

# RLM spawns focused sub-agents per file/task
# Configure sub-agent model in RLM agent definition
```

In a custom orchestration script:

```python
import anthropic

client = anthropic.Anthropic()

def cascade_review(code: str) -> dict:
    # First pass: fast classification
    fast_response = client.messages.create(
        model="claude-haiku-4-5",
        max_tokens=200,
        messages=[{
            "role": "user",
            "content": f"""Classify this code review task complexity.
Return JSON: {{"complexity": "simple|medium|complex", "reason": "..."}}

Code:
{code[:2000]}"""
        }]
    )

    complexity = extract_json(fast_response.content[0].text)["complexity"]

    if complexity == "simple":
        # Use haiku for the full review
        model = "claude-haiku-4-5"
    elif complexity == "medium":
        # Escalate to sonnet
        model = "claude-sonnet-5"
    else:
        # Escalate to opus for complex cases
        model = "claude-opus-5"

    review_response = client.messages.create(
        model=model,
        max_tokens=2000,
        messages=[{
            "role": "user",
            "content": f"Review this code for issues:\n\n{code}"
        }]
    )

    return {
        "model_used": model,
        "complexity": complexity,
        "review": review_response.content[0].text
    }
```

### Cascade Confidence Thresholds

Define explicit confidence signals for escalation. Avoid using vague "I'm not sure" patterns:

| Signal | Action |
|--------|--------|
| Output contains TODO or [NEEDS REVIEW] markers | Escalate |
| Response length below expected minimum | Escalate |
| Model flags security-relevant code paths | Escalate |
| Task involves unfamiliar framework or pattern | Escalate |
| Fast model timeout exceeded | Escalate |

---

## Cross-Model Consistency Strategies

When multiple models contribute to the same SDLC artifact, outputs must be consistent. Different models have different defaults for formatting, terminology, and structure.

### Template-Enforced Consistency

Provide an explicit output template to every model regardless of tier. Do not rely on the model to infer structure:

```python
REVIEW_TEMPLATE = """
## Review: {filename}

### Findings
| Severity | Line | Description | Remediation |
|----------|------|-------------|-------------|
{findings_table}

### Summary
{summary}

### Verdict
{verdict}
"""

def review_with_template(code: str, model: str) -> str:
    return client.messages.create(
        model=model,
        messages=[{
            "role": "user",
            "content": f"""Review this code and fill in the template below exactly.
Do not add sections. Do not change column names.

Template:
{REVIEW_TEMPLATE}

Code to review:
{code}"""
        }]
    ).content[0].text
```

### Normalization Pass

After collecting outputs from multiple models, run a normalization pass using a cheap model to enforce formatting consistency:

```python
def normalize_outputs(outputs: list[str]) -> str:
    combined = "\n\n---\n\n".join(outputs)

    return client.messages.create(
        model="claude-haiku-4-5",  # Cheap normalization pass
        messages=[{
            "role": "user",
            "content": f"""Merge these review outputs into a single report.
Use consistent formatting. Remove duplicates. Preserve all unique findings.
Return only the merged report, no preamble.

Outputs to merge:
{combined}"""
        }]
    ).content[0].text
```

### Shared Vocabulary

Define a glossary in your agent system prompts to prevent different models from using different terms for the same concept:

```
Terminology used in this project:
- "endpoint" not "route" or "handler"
- "authentication" not "auth" or "authn"
- "requirement" not "story" or "ticket"
- CRITICAL / HIGH / MEDIUM / LOW for severity (not P0/P1 or other schemes)
```

---

## Task Classification Framework

Classify tasks before assigning a model. This prevents over-spending on simple tasks and under-spending on critical ones.

### Task Classification Matrix

| Dimension | Low (haiku) | Medium (sonnet) | High (opus) |
|-----------|-------------|-----------------|-------------|
| Reasoning depth | Pattern matching, formatting | Multi-step logic, code synthesis | Trade-off analysis, strategic decisions |
| Output criticality | Summary, draft | Implementation, test | Architecture, security |
| Error tolerance | High (review later) | Medium (test coverage) | Low (must be correct) |
| Context needed | Single file or snippet | Module or feature scope | System-wide |
| Ambiguity | Clearly specified | Some interpretation needed | Open-ended problem |

### Classification Examples

| Task | Tier | Reason |
|------|------|--------|
| Generate inline code comments | haiku | Mechanical, low error tolerance, single file |
| Write unit tests for a function | sonnet | Multi-step, moderate complexity |
| Design authentication system | opus | Strategic, high stakes, cross-cutting |
| Format JSON output | haiku | Deterministic transformation |
| Debug intermittent race condition | opus | Complex reasoning, system-wide context |
| Summarize a PR diff | haiku | Pattern matching, low criticality |
| Review PR for security issues | opus | High stakes, cannot miss findings |
| Convert REST endpoint to GraphQL | sonnet | Technical transformation, moderate complexity |

---

## Cost Comparison Framework

### Pricing Reference (February 2026)

| Provider | Model | Input (per 1M tokens) | Output (per 1M tokens) |
|----------|-------|----------------------|------------------------|
| Anthropic | claude-opus-4-6 | ~$15 | ~$75 |
| Anthropic | claude-sonnet-4-6 | ~$3 | ~$15 |
| Anthropic | claude-haiku-3-5 | ~$0.25 | ~$1.25 |
| OpenAI | gpt-5.3-codex | Premium tier | Premium tier |
| OpenAI | codex-mini-latest | $1.50 | $6.00 |
| OpenAI | gpt-5-codex-mini | Budget tier | Budget tier |
| Local (Ollama) | llama3.3:70b | ~$0.015* | ~$0.015* |
| Local (Ollama) | codellama:34b | ~$0.008* | ~$0.008* |

*Electricity cost estimate at $0.15/kWh on RTX 4090.

### Example Cost Calculation: SDLC Sprint

Scenario: 10-engineer team, 2-week sprint, using AIWG for full SDLC.

| Activity | Tier | Requests | Avg Tokens | Cost (Claude) |
|----------|------|----------|------------|---------------|
| Architecture review (1x) | opus | 5 | 20K in / 5K out | $0.75 + $0.375 |
| Feature implementation (20x) | sonnet | 200 | 8K in / 4K out | $4.80 + $12.00 |
| Test generation (20x) | sonnet | 100 | 5K in / 3K out | $1.50 + $4.50 |
| Code comments (all files) | haiku | 500 | 2K in / 1K out | $0.25 + $0.625 |
| PR summaries (30x) | haiku | 30 | 4K in / 1K out | $0.03 + $0.0375 |
| Security review (1x) | opus | 10 | 15K in / 8K out | $2.25 + $6.00 |

**Total estimated cost: ~$33/sprint** for a 10-engineer team.

Compare to equivalent manual effort: 2 hours/engineer/week in code review and documentation = $2,000+ in developer time.

### Cost Optimization Scenarios

#### Scenario A: All-Opus (Baseline, No Optimization)

```
500 requests × 10K avg tokens × $15/1M input = $75
500 requests × 3K avg tokens × $75/1M output = $112.50
Total: ~$188/sprint
```

#### Scenario B: Tiered Routing (AIWG Default)

```
Opus: 15 requests = $1.13
Sonnet: 300 requests = $6.30 + $13.50 = $19.80
Haiku: 185 requests = $0.28 + $0.66 = $0.94
Total: ~$22/sprint
```

#### Scenario C: Haiku-Heavy with Escalation

```
Initial haiku pass: 480 requests = $1.20 + $0.60 = $1.80
Escalated to sonnet: 60 requests = $1.44 + $2.70 = $4.14
Escalated to opus: 10 requests = $0.75 + $3.75 = $4.50
Total: ~$10.44/sprint
```

Scenario C requires custom cascade logic. Scenario B (AIWG's default tiered routing) is the best starting point.

---

## AIWG-Specific: RLM Addon Multi-Provider Sub-Agents

The RLM addon supports spawning sub-agents across different model backends. This is the primary mechanism for hybrid architectures in AIWG.

```bash
# Deploy RLM addon
aiwg use rlm

# RLM sub-agent spawning uses the configured model per agent definition
# Each spawned sub-agent inherits the model from its agent file
/rlm-batch "src/**/*.ts" "extract exported function signatures"
```

### Configuring Sub-Agent Models

In the RLM agent definition, set the model for sub-tasks:

```yaml
---
name: rlm-agent
model: sonnet    # Orchestrator uses sonnet
description: Recursive decomposition specialist
---

You orchestrate large-scale operations by decomposing work into
sub-agent tasks. Each sub-agent is spawned with the model appropriate
for the task type:
- Extraction and search tasks: haiku
- Analysis and synthesis: sonnet
- Security and architecture review: opus
```

### Multi-Provider Sub-Agent Pattern

When AIWG is deployed to multiple providers, sub-agents can target different backends:

```
Orchestrator (Claude Code, opus)
    │
    ├── Batch extraction tasks → Ollama llama3.2:3b (local, haiku-tier)
    │
    ├── Code review sub-agents → gpt-5.6-luna (Codex provider)
    │
    └── Security review → claude-opus-5 (Claude provider)
```

This requires deploying AIWG to multiple providers and configuring environment-based routing.

---

## Configuration Templates

### Single-Provider Tiered Setup

For teams using Claude Code exclusively:

```json
{
  "claude": {
    "reasoning": { "model": "claude-opus-5" },
    "coding": { "model": "claude-sonnet-5" },
    "efficiency": { "model": "claude-haiku-4-5" }
  },
  "shorthand": {
    "opus": "claude-opus-5",
    "sonnet": "claude-sonnet-5",
    "haiku": "claude-haiku-4-5"
  }
}
```

### Hybrid Claude + Local Setup

Routing efficiency tasks to local models, keeping reasoning on Claude:

```json
{
  "claude": {
    "reasoning": { "model": "claude-opus-5" },
    "coding": { "model": "claude-sonnet-5" },
    "efficiency": { "model": "claude-haiku-4-5" }
  },
  "openai": {
    "reasoning": { "model": "llama3.3:70b" },
    "coding": { "model": "codellama:34b" },
    "efficiency": { "model": "llama3.2:3b" }
  }
}
```

Set `OPENAI_BASE_URL=http://localhost:11434/v1` for the local endpoint.

### Air-Gapped Setup

Full local model stack:

```json
{
  "openai": {
    "reasoning": { "model": "llama3.3:70b" },
    "coding": { "model": "qwen2.5-coder:14b" },
    "efficiency": { "model": "llama3.2:3b" }
  },
  "shorthand": {
    "opus": "llama3.3:70b",
    "sonnet": "qwen2.5-coder:14b",
    "haiku": "llama3.2:3b"
  }
}
```

### Cost-Minimized Cloud Setup

Minimizing spend while keeping cloud convenience:

```json
{
  "openai": {
    "reasoning": { "model": "gpt-5.6-terra" },
    "coding": { "model": "gpt-5.6-luna" },
    "efficiency": { "model": "gpt-5.6-luna" }
  },
  "shorthand": {
    "opus": "gpt-5.6-terra",
    "sonnet": "gpt-5.6-luna",
    "haiku": "gpt-5.6-luna"
  }
}
```

---

## Deploying to Multiple Providers

AIWG supports deploying to multiple providers in sequence. Each provider gets its own set of deployed artifacts with provider-appropriate model substitution:

```bash
# Deploy to Claude Code (primary)
aiwg use sdlc

# Deploy to Codex (parallel use or team members on Codex)
aiwg use sdlc --provider codex

# Deploy to Cursor
aiwg use sdlc --provider cursor

# Verify all deployments
aiwg status
```

Each deployment translates `model: opus/sonnet/haiku` shorthand into the correct provider-specific identifier. A single source agent definition serves all providers.

---

## Monitoring and Iteration

### Track Model Distribution

After implementing tiered routing, verify the distribution is sensible:

```bash
# Check which model each agent uses after deployment
grep -r "^model:" .claude/agents/ | sort | uniq -c | sort -rn
# Expected: most agents use sonnet or haiku, few use opus
```

### Cost Signals to Watch

| Signal | Possible Cause | Action |
|--------|---------------|--------|
| Opus usage > 30% of requests | Over-assignment to opus tier | Review agent tier assignments |
| High output token count | Agents generating verbose output | Add length constraints to system prompts |
| Many escalations in cascade | Threshold too aggressive | Tune classification confidence thresholds |
| Quality complaints despite low cost | Haiku used for wrong task types | Re-classify affected agent to higher tier |

---

## See Also

- `docs/models/claude-optimization.md` — Claude-specific prompt engineering
- `docs/models/gpt-optimization.md` — GPT/Codex integration patterns
- `docs/models/local-models.md` — Local model deployment and sizing
- `docs/configuration/model-configuration.md` — Full models.json reference
- `agentic/code/addons/rlm/README.md` — Sub-agent orchestration with RLM
- `agentic/code/frameworks/sdlc-complete/config/models.json` — AIWG default model assignments
