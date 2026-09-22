# GPT Integration Patterns

Practical guide for using AIWG with OpenAI's GPT and Codex models. Covers function calling, structured output, the Codex CLI, and how AIWG's model mapping translates Claude shorthand into OpenAI identifiers.

---

## When to Use This Guide

Use this guide if you are:

- Running AIWG with `--provider codex` or `--provider openai`
- Working in the OpenAI Codex CLI terminal environment
- Building custom integrations against the OpenAI-compatible API endpoint
- Troubleshooting model mapping or deployment issues on the Codex provider

---

## Quick Start

```bash
# Deploy AIWG to the Codex provider
aiwg use sdlc --provider codex

# Deploy with specific model overrides
aiwg use sdlc --provider codex \
  --reasoning-model gpt-5.6-sol \
  --coding-model gpt-5.6-terra \
  --efficiency-model gpt-5.6-luna

# Preview deployment without writing files
aiwg use sdlc --provider codex --dry-run

# Deploy only commands to ~/.codex/prompts/
aiwg use sdlc --provider codex --commands-only
```

---

## Model Reference

AIWG's Codex provider maps the three standard tiers to OpenAI model identifiers in `tools/agents/providers/codex.mjs`.

| AIWG Tier | OpenAI Model | Pricing | Best For |
|-----------|--------------|---------|----------|
| `opus` (reasoning) | gpt-5.6-sol | Premium | Complex analysis, architecture |
| `sonnet` (coding) | gpt-5.6-terra | $2/$12 per 1M tokens | Code gen, debugging, CLI default |
| `haiku` (efficiency) | gpt-5.6-luna | 4x more usage quota | Quick tasks, summaries |

### Model Mapping Logic

When AIWG deploys agents to Codex, it replaces the `model:` field in each agent's frontmatter:

```javascript
// From tools/agents/providers/codex.mjs
const gptModels = {
  'opus':   'gpt-5.6-sol',
  'sonnet': 'gpt-5.6-terra',
  'haiku':  'gpt-5.6-luna'
};
```

An agent defined with `model: opus` in source becomes `model: gpt-5.6-sol` when deployed to `.codex/agents/`.

### Switching Models in Codex CLI

```bash
# Mid-session model switch
/model gpt-5.6-sol

# Set default in config.toml
# ~/.codex/config.toml
[model]
default = "gpt-5.6-terra"
```

---

## Deployment Paths

Codex uses a split deployment model that differs from other AIWG providers:

| Artifact | Location | Scope |
|----------|----------|-------|
| Agents | `.codex/agents/` | Project-local |
| Rules | `.codex/rules/` | Project-local |
| Commands | `~/.codex/prompts/` | User-level (all projects) |
| Skills | `~/.codex/skills/` | User-level (all projects) |

Commands and skills deploy to the home directory so they are available across all projects without re-deploying. Agents and rules are project-specific.

```bash
# Verify deployment locations after install
ls .codex/agents/
ls ~/.codex/prompts/
ls ~/.codex/skills/
```

---

## Function Calling vs. Claude Tool Use

The OpenAI function calling API and Claude's tool use API differ in structure. AIWG abstracts most of this, but it matters when writing custom integrations.

### OpenAI Function Calling Structure

```json
{
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "read_file",
        "description": "Read the contents of a file at the given path",
        "parameters": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "Absolute path to the file"
            }
          },
          "required": ["path"]
        }
      }
    }
  ],
  "tool_choice": "auto"
}
```

### Key Differences from Claude Tool Use

| Aspect | OpenAI | Claude |
|--------|--------|--------|
| Schema format | JSON Schema in `function.parameters` | JSON Schema in `input_schema` |
| Tool call result | `role: "tool"` message | `role: "user"` with `tool_result` block |
| Forcing tool use | `"tool_choice": {"type": "function", "function": {"name": "..."}}` | `"tool_choice": {"type": "tool", "name": "..."}` |
| Multiple tools | Parallel supported | Parallel supported |
| Tool name format | snake_case recommended | snake_case recommended |

### Codex CLI Built-in Tools

The Codex CLI provides these tools automatically, similar to Claude Code:

| Tool | Description |
|------|-------------|
| `shell` | Execute shell commands |
| `read_file` | Read file contents |
| `write_file` | Write file contents |
| `list_dir` | List directory contents |
| `search_files` | Search file contents |

Design AIWG agent prompts for Codex to use these tool names when giving explicit tool instructions.

---

## Structured Output and JSON Mode

GPT models support two mechanisms for structured output. Use these to ensure AIWG agents return parseable results.

### JSON Mode

Ensures the model returns valid JSON. Requires the word "JSON" in the system or user prompt.

```python
response = client.chat.completions.create(
    model="gpt-5.6-terra",
    response_format={"type": "json_object"},
    messages=[
        {
            "role": "system",
            "content": "You are an AIWG agent. Return your analysis as JSON."
        },
        {
            "role": "user",
            "content": f"Analyze this code and return a JSON report:\n\n{code}"
        }
    ]
)
```

### Structured Output (Preferred)

Guarantees schema adherence via constrained decoding. More reliable than JSON mode for complex schemas.

```python
from pydantic import BaseModel
from typing import List

class Finding(BaseModel):
    severity: str
    location: str
    description: str
    remediation: str

class SecurityReport(BaseModel):
    findings: List[Finding]
    risk_score: int
    summary: str

response = client.beta.chat.completions.parse(
    model="gpt-5.6-sol",
    messages=[...],
    response_format=SecurityReport
)

report = response.choices[0].message.parsed
```

### When to Use Each

| Method | Use When |
|--------|----------|
| JSON mode | Simple output, flexible schema |
| Structured output | Complex schema, downstream parsing required |
| Neither | Free-form text output (docs, explanations) |

---

## System Message Best Practices

OpenAI's `system` role message is the primary place for persistent instructions. Unlike Claude, where system prompts have strong behavioral weight, GPT models sometimes underweight long system messages. Compensate with these patterns.

### Keep System Messages Focused

```
# Less effective: long, multi-topic system message
You are a helpful assistant that can do many things including reviewing
code, writing documentation, answering questions, helping with
architecture, [... 500 more words ...]

# More effective: precise, single-role definition
You are an AIWG Code Reviewer. You review code diffs for logic errors,
security issues, and style violations. You output structured reports
using the format specified in the user message.
```

### Repeat Critical Instructions

For important constraints, reinforce in both the system and user messages:

```python
messages = [
    {
        "role": "system",
        "content": "You are an AIWG agent. Never include file paths outside the project root."
    },
    {
        "role": "user",
        "content": "Review these files. Important: only reference paths within /project/. Files: ..."
    }
]
```

### Use Numbered Steps for Procedures

GPT models follow numbered step sequences reliably:

```
System: You are an AIWG Test Engineer.

When given a specification, follow these steps:
1. Identify all acceptance criteria
2. For each criterion, write at least one test case
3. Identify edge cases not covered by the criteria
4. Write tests for the top 3 edge cases
5. Output tests in the format specified below
```

---

## Token Optimization

### Prompt Caching

`gpt-5.6-terra` supports prompt caching with a 75% discount on cached tokens. To maximize cache hits:

- Keep system messages identical across requests
- Place variable content (user input, artifacts) at the end of the prompt
- Use consistent agent definitions — do not modify system prompts between calls

```python
# Cache-friendly pattern: stable system + variable user
messages = [
    {"role": "system", "content": STABLE_SYSTEM_PROMPT},  # Cached after first call
    {"role": "user", "content": f"Review this:\n\n{variable_content}"}  # Variable
]
```

### Token Budget by Model

| Model | Input Cost | Recommended Max Input |
|-------|-----------|----------------------|
| gpt-5.6-sol | Premium | 50K tokens (reserve budget for complex tasks) |
| gpt-5.6-terra | $2/1M | 100K tokens (cost-effective for large inputs) |
| gpt-5.6-luna | Budget | 100K tokens (high volume tasks) |

### Reducing Repetition

For batch operations, extract common context to the system message:

```python
# Inefficient: repeat context in every user message
for file in files:
    messages = [
        {"role": "system", "content": "You review Python code."},
        {"role": "user", "content": f"Project context: {large_context}\n\nReview: {file}"}
    ]

# Efficient: context in system message, cached
SYSTEM = f"You review Python code.\n\nProject context:\n{large_context}"
for file in files:
    messages = [
        {"role": "system", "content": SYSTEM},  # Cached
        {"role": "user", "content": f"Review: {file}"}
    ]
```

---

## OpenAI-Compatible API Configuration

AIWG can target any OpenAI-compatible endpoint by setting the base URL. This is the entry point for local models and third-party providers using the same API format.

```json
{
  "openai": {
    "reasoning": {
      "model": "gpt-5.6-sol",
      "description": "Most capable reasoning"
    },
    "coding": {
      "model": "gpt-5.6-terra",
      "description": "Balanced coding tasks"
    },
    "efficiency": {
      "model": "gpt-5.6-luna",
      "description": "Fast, high-volume tasks"
    }
  }
}
```

For custom endpoints, set the base URL in your environment:

```bash
export OPENAI_BASE_URL="https://your-endpoint.example.com/v1"
export OPENAI_API_KEY="your-api-key"
```

---

## Codex CLI Configuration

After deploying AIWG artifacts, configure the Codex CLI to use them:

```toml
# ~/.codex/config.toml

[model]
default = "gpt-5.6-terra"
reasoning = "gpt-5.6-sol"

[context]
# AIWG agents load from .codex/agents/ automatically

[prompts]
# AIWG commands available at ~/.codex/prompts/
```

### Loading AIWG Context in Codex

```bash
# Start a Codex session with AIWG context
codex --context .codex/agents/architecture-designer.md

# Run an AIWG skill
/sdlc-status

# Use a deployed AIWG command
/mention-wire
```

---

## AIWG-Specific Configuration

### Customizing Codex Model Assignments

Override the default model mapping in `models.json`:

```json
{
  "openai": {
    "reasoning": {
      "model": "gpt-5.6-sol"
    },
    "coding": {
      "model": "gpt-5.6-terra"
    },
    "efficiency": {
      "model": "gpt-5.6-luna"
    }
  }
}
```

Place this at the project root or `~/.config/aiwg/models.json`.

### Verifying Deployed Models

After running `aiwg use sdlc --provider codex`, check that model replacement worked:

```bash
# Check a deployed agent's model field
head -5 .codex/agents/architecture-designer.md
# Should show: model: gpt-5.6-sol (not model: opus)

head -5 .codex/agents/software-implementer.md
# Should show: model: gpt-5.6-terra (not model: sonnet)
```

---

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| Agent still shows `model: opus` after deploy | Deployment did not run transformation | Re-run `aiwg use sdlc --provider codex --force` |
| Commands not available in Codex CLI | Deploy wrote to project, not home dir | Run `aiwg use sdlc --provider codex --commands-only` — writes to `~/.codex/prompts/` |
| JSON mode error: "must include JSON in prompt" | `response_format: json_object` requires JSON mention | Add "Return your response as JSON" to system prompt |
| High token costs on batch operations | Repeating large context per request | Move shared context to system message for caching |
| Structured output parse failure | Schema mismatch | Use `model.model_dump()` to debug schema vs response |

---

## See Also

- `docs/integrations/codex-quickstart.md` — Full Codex setup walkthrough
- `docs/models/hybrid-architectures.md` — Mixing GPT and Claude in one workflow
- `docs/models/local-models.md` — OpenAI-compatible local model setup
- `tools/agents/providers/codex.mjs` — Model mapping implementation
