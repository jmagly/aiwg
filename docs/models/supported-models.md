# AIWG Supported Models

Canonical reference for models tested with AIWG. Cloud models are built-in; local models are validated by the AIWG team or community contributors.

---

## Cloud Providers (Built-in)

These models are fully supported and configured automatically when using AIWG with cloud providers.

### Anthropic

| Model | AIWG Tier | Context | Tool Use | Status |
|-------|-----------|---------|----------|--------|
| claude-fable-5-1 | fable | 1M | Yes | Fully supported — user-elected only, never a default |
| claude-opus-5 | opus | 1M | Yes | Fully supported |
| claude-sonnet-5 | sonnet | 1M | Yes | Fully supported |
| claude-haiku-4-5-20251001 | haiku | 200K | Yes | Fully supported |
| claude-opus-4-6 | opus | 200K | Yes | Superseded — use claude-opus-5 |
| claude-sonnet-4-6 | sonnet | 200K | Yes | Superseded — use claude-sonnet-5 |

### OpenAI

| Model | AIWG Tier | Context | Tool Use | Status |
|-------|-----------|---------|----------|--------|
| gpt-6-astra | opus | 1.05M (272K in Codex) | Yes | Fully supported — user-elected only, never a default |
| gpt-5.6-sol | opus | 1.05M (272K in Codex) | Yes | Fully supported |
| gpt-5.6-terra | sonnet | 1.05M (272K in Codex) | Yes | Fully supported |
| gpt-5.6-luna | haiku | 1.05M (272K in Codex) | Yes | Fully supported |
| gpt-5.4 | opus | 256K | Yes | Superseded — use gpt-5.6-sol |
| gpt-5.3-codex | sonnet | 256K | Yes | Superseded — use gpt-5.6-terra |
| gpt-5.1-codex-mini | haiku | 192K | Yes | Superseded — use gpt-5.6-luna |

### Google

| Model | AIWG Tier | Context | Tool Use | Status |
|-------|-----------|---------|----------|--------|
| gemini-2.5-pro | opus | 1M | Yes | Fully supported |
| gemini-2.5-flash | sonnet | 1M | Yes | Fully supported |

---

## Local Models — Validated

Models tested with AIWG by the team or community, with confirmed compatibility results.

| Model | Size | Backend | AIWG Tier | Tool Use | Coding | Reasoning | SDLC Workflows | Tested By | Notes |
|-------|------|---------|-----------|----------|--------|-----------|----------------|-----------|-------|
| qwen3.5:9b | 9B | Ollama | sonnet | Yes | Good | Good | Partial | Community | Strong coding, vision support (256K context), reasoning degrades in long chains |
| hermes-3-llama-3.1:8b | 8B | Ollama | haiku | Yes | Good | Moderate | Limited | Community | Good instruction following, limited multi-step planning |
| codellama:34b | 34B | Ollama | sonnet | No | Excellent | Moderate | Limited | AIWG team | Strong code gen, no native tool use support |
| qwen2.5-coder:14b | 14B | Ollama | sonnet | Yes | Excellent | Moderate | Partial | AIWG team | Best coding quality per VRAM of validated local models |
| llama3.3:70b | 70B | Ollama/vLLM | opus | Partial | Good | Good | Partial | AIWG team | Requires 48GB+ VRAM; closest to cloud quality |
| llama3.2:3b | 3B | Ollama | haiku | No | Basic | Basic | No | AIWG team | Fast summaries and formatting only |
| llama3.1:8b | 8B | Ollama | haiku | No | Moderate | Moderate | No | AIWG team | General purpose, budget tier |
| codellama:13b | 13B | Ollama | haiku | No | Good | Basic | No | AIWG team | Budget code generation |

### Capability Legend

- **Yes** — Works reliably in testing
- **Partial** — Works with limitations (see Notes)
- **No** — Not supported or not functional
- **Good/Moderate/Basic/Excellent** — Relative quality rating

### Status Definitions

| Status | Meaning |
|--------|---------|
| Fully supported | Built into AIWG, tested with every release |
| AIWG team tested | Validated by maintainers, not regression-tested |
| Community tested | Reported working by community contributor (see notes for details) |
| Expected compatible | Should work based on architecture, not formally tested |

---

## Local Models — Expected Compatible (Untested)

Models that should work with AIWG based on architecture and capabilities, but haven't been formally validated.

| Model | Size | Expected Tier | Notes |
|-------|------|---------------|-------|
| deepseek-coder-v2:16b | 16B | sonnet | MoE architecture, strong coding benchmarks |
| mistral:7b | 7B | haiku | Good instruction following |
| mixtral:8x7b | 47B (MoE) | sonnet | MoE architecture, good general capability |
| phi-4:14b | 14B | sonnet | Microsoft, strong reasoning for size |
| gemma2:27b | 27B | sonnet | Google, good structured output |
| command-r:35b | 35B | sonnet | Cohere, tool use support |

---

## Tier Mapping Guide

When configuring local models, map them to AIWG tiers based on their demonstrated capabilities:

| AIWG Tier | Expected Capability | Typical Model Size |
|-----------|--------------------|--------------------|
| opus | Complex reasoning, architecture review, multi-step planning | 70B+ |
| sonnet | Code generation, debugging, structured output, moderate reasoning | 13B–34B |
| haiku | Summaries, formatting, simple transformations, fast tasks | 3B–8B |

### Example models.json for Local Setup

```json
{
  "openai": {
    "reasoning": {
      "model": "qwen3.5:9b",
      "description": "Local Qwen 3.5 for coding and reasoning"
    },
    "coding": {
      "model": "qwen2.5-coder:14b",
      "description": "Local Qwen 2.5 Coder for implementation"
    },
    "efficiency": {
      "model": "llama3.2:3b",
      "description": "Local 3B for quick tasks"
    }
  },
  "shorthand": {
    "opus": "qwen3.5:9b",
    "sonnet": "qwen2.5-coder:14b",
    "haiku": "llama3.2:3b"
  }
}
```

---

## Contributing Model Test Results

See [Community Model Testing Guide](../contributing/model-testing.md) for how to submit your own model test results.

---

## See Also

- [Local Model Deployment Guide](local-models.md) — Setup instructions for Ollama, llama.cpp, vLLM
- [Hybrid Architectures](hybrid-architectures.md) — Routing between local and cloud models
- [Community Model Testing](../contributing/model-testing.md) — How to contribute test results
