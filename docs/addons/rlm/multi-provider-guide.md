# RLM Multi-Provider Guide

**Version**: 1.0.0
**Last Updated**: 2026-02-09
**Status**: ACTIVE

## Overview

The RLM (Recursive Language Models) addon supports running root agents and sub-agents across multiple AI providers. This enables cost optimization (e.g., Claude Opus root with Codex Mini sub-calls), provider-specific strengths (e.g., Claude for reasoning, OpenAI Codex for code generation), and resource deployment across AIWG's 13 named provider integrations. Runtime sub-agent execution still depends on the selected provider's capabilities.

## Model Mapping for RLM

### AIWG Abstract Model Names

AIWG uses abstract model names that map to provider-specific models:

| Abstract Name | Tier | Use Case |
|---------------|------|----------|
| `opus` | Reasoning | Complex reasoning, architecture design, strategic decisions |
| `sonnet` | Coding | Code generation, implementation, debugging |
| `haiku` | Efficiency | Quick tasks, file operations, simple edits |

### Provider-Specific Model Mappings

Based on `agentic/code/frameworks/sdlc-complete/config/models.json`:

| Provider | opus → | sonnet → | haiku → |
|----------|--------|----------|---------|
| **Claude** | claude-opus-4-6 | claude-sonnet-4-6 | claude-haiku-3-5 |
| **OpenAI/Codex** | gpt-5.3-codex | codex-mini-latest | gpt-5-codex-mini |
| **Factory** | claude-opus-4-6 | claude-sonnet-4-6 | claude-haiku-3-5 |
| **Copilot** | gpt-4-turbo | gpt-4 | gpt-3.5-turbo |
| **Cursor** | claude-opus-latest | claude-sonnet-latest | claude-haiku-latest |
| **OpenCode** | provider-default | provider-default | provider-default |
| **Warp** | claude-opus-latest | claude-sonnet-latest | claude-haiku-latest |
| **Windsurf** | claude-opus-4-6 | claude-sonnet-4-6 | claude-haiku-3-5 |

### Root Model vs Sub-Call Model Selection

**Default Configuration** (from `manifest.json`):
```yaml
configuration:
  defaults:
    defaultSubModel: "sonnet"
```

This means:
- **Root agent**: Uses the model specified in the agent definition (`model: opus` in `rlm-agent.md`)
- **Sub-agents**: Use `sonnet` by default (overridable)

**Why This Default?**

From REF-089 research:
- Root agents need strong reasoning for task decomposition
- Sub-agents perform focused, simpler tasks (search, extraction, aggregation)
- `sonnet` offers best cost/capability balance for sub-calls

## Cost/Capability Tradeoffs

### Strategy 1: Balanced (Default)

```yaml
root_model: opus
sub_model: sonnet
```

| Metric | Value |
|--------|-------|
| Root reasoning | Excellent |
| Sub-call quality | Good |
| Cost multiplier | 1.5x (vs all-sonnet) |
| Best for | Complex decomposition tasks |

**When to use**: Default for most RLM tasks requiring strong decomposition.

### Strategy 2: Cost-Optimized

```yaml
root_model: sonnet
sub_model: haiku
```

| Metric | Value |
|--------|-------|
| Root reasoning | Good |
| Sub-call quality | Adequate |
| Cost multiplier | 0.5x (vs balanced) |
| Best for | Large fan-out (>20 sub-calls), simple extraction |

**When to use**: High sub-call count where sub-tasks are straightforward (e.g., extracting specific fields from many files).

### Strategy 3: Quality-Optimized

```yaml
root_model: opus
sub_model: opus
```

| Metric | Value |
|--------|-------|
| Root reasoning | Excellent |
| Sub-call quality | Excellent |
| Cost multiplier | 3.0x (vs balanced) |
| Best for | Critical analysis, security audits |

**When to use**: Quality is paramount, cost is secondary (e.g., compliance reviews, security threat modeling).

### Strategy 4: Hybrid (Cross-Provider)

```yaml
root_provider: claude
root_model: opus
sub_provider: openai
sub_model: codex-mini-latest
```

| Metric | Value |
|--------|-------|
| Root reasoning | Excellent (Claude) |
| Sub-call quality | Good (Codex) |
| Cost multiplier | 0.8x (cheapest option) |
| Best for | Cost-sensitive large-scale analysis |

**When to use**: Maximum cost optimization with strong root reasoning (Claude Opus ~$15/1M input, Codex Mini ~$1.50/1M input = 10x difference).

## Provider-Specific Configuration

### Claude Code

**Invocation**:
```bash
claude -p -m "opus" -- aiwg rlm-query "Analyze auth module" --sub-model sonnet
```

**Model selection**:
- Root: Specified via `-m` flag
- Sub-calls: Specified via `--sub-model` flag

**Output token limits** (from REF-089):
- Opus: 16K output tokens
- Sonnet: 8K output tokens
- Haiku: 4K output tokens

**Notes**: Claude has highest output token limits, best for sub-agents that need to generate large intermediate results.

### OpenAI Codex

**Invocation**:
```bash
codex -q "Analyze auth module" --model gpt-5.3-codex --sub-model codex-mini-latest
```

**Model selection**:
- Root: `--model` flag
- Sub-calls: `--sub-model` flag

**Output token limits**:
- gpt-5.3-codex: 4K output tokens
- codex-mini-latest: 4K output tokens
- gpt-5-codex-mini: 4K output tokens

**Cost comparison** (Feb 2026):
- gpt-5.3-codex: $15/1M input (same as Claude Opus)
- codex-mini-latest: $1.50/1M input (10x cheaper)
- gpt-5-codex-mini: $5/1M input

**Notes**: Codex Mini is the cheapest option for high-volume sub-calls. Best for large corpus analysis with cost constraints.

### GitHub Copilot

**Invocation**:
```bash
gh copilot --model gpt-4-turbo --sub-model gpt-3.5-turbo
```

**Model selection**:
- Root: `--model` flag
- Sub-calls: `--sub-model` flag

**Output token limits**:
- gpt-4-turbo: 4K output tokens
- gpt-4: 4K output tokens
- gpt-3.5-turbo: 4K output tokens

**Notes**: All Copilot models have same output limit. Not ideal for large intermediate results.

### Factory AI

**Invocation**:
```bash
factory-ai --model claude-opus-4-6 --sub-model claude-sonnet-4-6
```

**Model selection**: Uses full Claude model identifiers.

**Output token limits**: Same as Claude (uses Claude API).

**Notes**: Factory uses Claude models directly. No cost advantage over direct Claude usage.

### Cursor

**Invocation**:
```bash
cursor --model claude-opus-latest --sub-model claude-haiku-latest
```

**Model selection**:
- Uses `-latest` aliases for simplicity
- Maps to current Claude versions

**Notes**: Cursor abstracts version numbers. Good for always-latest approach.

### Warp Terminal

**Invocation**:
```bash
warp-agent --model opus --sub-model sonnet
```

**Model selection**: Uses AIWG shorthand (`opus`, `sonnet`, `haiku`).

**Notes**: Warp supports Claude models via API. Configuration in `WARP.md`.

### Windsurf

**Status**: EXPERIMENTAL

**Invocation**:
```bash
windsurf --model claude-opus-4-6 --sub-model claude-sonnet-4-6
```

**Notes**: Windsurf uses Claude models via API (experimental support).

## Provider-Specific Prompt Adjustments

From REF-089 Appendix C, different models require different system prompts:

### GPT-5/Codex

**Observation** (REF-089, p. 7):
> "While both GPT-5 and Qwen3-Coder-480B exhibit strong performance as RLMs... they also exhibit different performance and behavior across all tasks."

**Required adjustment**:
```markdown
CRITICAL: Limit sub-calls to essential queries only. Excessive sub-calls
degrade performance. Prefer batch operations over individual queries.
```

**Why**: GPT-5/Codex models tend to over-segment tasks, leading to excessive sub-calls.

### Claude Opus/Sonnet

**No special adjustments needed**. Claude models naturally balance decomposition depth.

### Qwen3-Coder

**Required adjustment** (from REF-089):
```markdown
WARNING: You may be tempted to make many small llm_query() calls. This
is inefficient. Batch related queries when possible.
```

**Why**: Qwen3-Coder exhibits highest sub-call rate in research benchmarks.

### Implementation in AIWG

AIWG's RLM agent definition includes:

```markdown
## Capabilities

### Core Functions

| Function | Description |
|----------|-------------|
| ...
| Recursive Delegation | Spawn sub-agents for independent sub-problems |
...

## Decision Authority

### You MUST

- **Track recursion depth**: Log sub-call depth to prevent runaway recursion

### You MUST NOT

- **Recurse without bound**: Stop recursion if depth exceeds 5 levels; escalate to human
```

This applies limits regardless of model, preventing over-segmentation.

## Mixed-Provider Trees

### Configuration Syntax

**Root on Claude, Sub-calls on Codex**:

```bash
# Set environment variables
export RLM_ROOT_PROVIDER=claude
export RLM_ROOT_MODEL=opus
export RLM_SUB_PROVIDER=openai
export RLM_SUB_MODEL=codex-mini-latest

# Execute RLM task
aiwg rlm-query "Analyze 100 research papers" \
  --provider claude \
  --model opus \
  --sub-provider openai \
  --sub-model codex-mini-latest
```

**Root on Codex, Sub-calls on Claude**:

```bash
aiwg rlm-query "Generate API documentation" \
  --provider openai \
  --model gpt-5.3-codex \
  --sub-provider claude \
  --sub-model sonnet
```

### Use Cases

| Root Provider | Sub Provider | Use Case |
|---------------|--------------|----------|
| Claude (Opus) | OpenAI (Codex Mini) | Best reasoning + cheapest sub-calls |
| Claude (Sonnet) | Claude (Haiku) | Balanced quality, single-provider simplicity |
| OpenAI (GPT-5.3) | OpenAI (Codex Mini) | All OpenAI (if API keys only for one provider) |
| Claude (Opus) | Claude (Sonnet) | Default balanced approach (manifest default) |

### Limitations

| Limitation | Impact | Mitigation |
|------------|--------|------------|
| **Different context windows** | Claude 200K, OpenAI 128K | Root uses larger window, sub-calls stay small |
| **Different tool availability** | Provider-specific tools | RLM uses standard tools (Read, Grep, Bash) |
| **API rate limits** | Mixed providers = separate limits | Parallel sub-calls across providers |
| **Authentication complexity** | Need API keys for both providers | Environment variables or config files |

## Model Selection Strategy

### By Task Type

| Task Type | Recommended Configuration | Rationale |
|-----------|--------------------------|-----------|
| **Corpus analysis** | Root: opus, Sub: haiku (cross-provider if available) | High fan-out, simple extraction tasks |
| **Code refactoring** | Root: sonnet, Sub: sonnet | Consistent code quality across tree |
| **Security audit** | Root: opus, Sub: opus | Quality paramount, cost secondary |
| **Multi-file search** | Root: sonnet, Sub: haiku | Simple search tasks for sub-agents |
| **Documentation generation** | Root: opus (reasoning), Sub: codex-mini (writing) | Root plans structure, sub-agents write sections |
| **Test generation** | Root: sonnet, Sub: sonnet | Consistent test quality |

### By Budget Constraints

| Budget | Root Model | Sub Model | Estimated Cost (100K input) |
|--------|------------|-----------|----------------------------|
| **Unlimited** | opus | opus | $3.00 (all opus) |
| **High** | opus | sonnet | $1.80 (balanced) |
| **Medium** | sonnet | sonnet | $1.20 (default) |
| **Low** | sonnet | haiku | $0.60 (cost-optimized) |
| **Minimal** | opus (Claude) | codex-mini (OpenAI) | $0.30 (cheapest hybrid) |

**Assumptions**:
- Root: 10K input, 2K output
- Sub-calls: 10 sub-agents × 5K input each, 500 output each
- Claude pricing: Opus $15/1M input, Sonnet $3/1M input, Haiku $1/1M input
- OpenAI pricing: gpt-5.3-codex $15/1M input, codex-mini-latest $1.50/1M input

### By Quality Requirements

| Quality Need | Configuration | Use Case |
|--------------|---------------|----------|
| **Critical** | opus → opus | Compliance, security, architecture |
| **High** | opus → sonnet | Production code, API design |
| **Standard** | sonnet → sonnet | Feature development, refactoring |
| **Acceptable** | sonnet → haiku | Documentation, extraction tasks |

## Provider Compatibility Matrix

| Provider | Root Support | Sub-Call Support | Max Context | Max Output | Notes |
|----------|--------------|------------------|-------------|------------|-------|
| **Claude** | ✅ Full | ✅ Full | 200K | 16K | Best output token limit |
| **OpenAI/Codex** | ✅ Full | ✅ Full | 128K | 4K | Cheapest sub-calls (codex-mini) |
| **Factory** | ✅ Full | ✅ Full | 200K | 16K | Uses Claude API |
| **Copilot** | ✅ Full | ✅ Full | 128K | 4K | GitHub integration |
| **Cursor** | ✅ Full | ✅ Full | 200K | 16K | Auto-updates to latest |
| **OpenCode** | ⚠️ Partial | ⚠️ Partial | Varies | Varies | Provider-dependent |
| **Warp** | ✅ Full | ✅ Full | 200K | 16K | Terminal-native |
| **Windsurf** | 🧪 Experimental | 🧪 Experimental | 200K | 16K | Experimental support |

**Legend**:
- ✅ Full: Native support, all features available
- ⚠️ Partial: Limited support, some features missing
- 🧪 Experimental: Under development, may be unstable

### Which Providers Can Serve as Root vs Sub-Call Agents?

| Provider | Root Agent | Sub-Call Agent | Notes |
|----------|------------|----------------|-------|
| Claude | ✅ Recommended | ✅ Recommended | Default choice, best output limits |
| OpenAI/Codex | ✅ Yes | ✅ Best for cost | Cheapest sub-calls (codex-mini) |
| Factory | ✅ Yes | ✅ Yes | Identical to Claude (uses Claude API) |
| Copilot | ✅ Yes | ⚠️ Limited | Output limit 4K may truncate results |
| Cursor | ✅ Yes | ✅ Yes | Auto-updates, good for latest models |
| OpenCode | ⚠️ Limited | ⚠️ Limited | Depends on configured provider |
| Warp | ✅ Yes | ✅ Yes | Terminal context, good for dev tasks |
| Windsurf | 🧪 Experimental | 🧪 Experimental | May have stability issues |

### Tool Availability Differences

All AIWG providers support the core RLM tools:

| Tool | Claude | OpenAI | Factory | Copilot | Cursor | OpenCode | Warp | Windsurf |
|------|--------|--------|---------|---------|--------|----------|------|----------|
| Read | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Grep | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Glob | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Bash | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Write | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Edit | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Task | ✅ | ⚠️ | ✅ | ⚠️ | ✅ | ⚠️ | ✅ | ⚠️ |

**Notes**:
- ⚠️ Task tool: OpenAI/Codex, Copilot, OpenCode, Windsurf may require explicit sub-agent spawning (not native Task tool)
- AIWG abstracts this via provider-specific implementations

## Configuration Examples

### Example 1: Default (Single Provider, Balanced)

**Scenario**: Standard RLM usage on Claude.

**Configuration**:
```bash
aiwg rlm-query "Analyze authentication module for security issues" \
  --model opus \
  --sub-model sonnet
```

**Equivalent environment variables**:
```bash
export RLM_ROOT_MODEL=opus
export RLM_SUB_MODEL=sonnet
aiwg rlm-query "Analyze authentication module for security issues"
```

**Result**:
- Root: Claude Opus (strong reasoning for task decomposition)
- Sub-agents: Claude Sonnet (good quality, reasonable cost)
- Cost: ~1.5x baseline (Sonnet everywhere)

### Example 2: Cost-Optimized (Single Provider)

**Scenario**: Large corpus analysis (100 papers), cost-sensitive.

**Configuration**:
```bash
aiwg rlm-batch "Extract key findings from all papers" \
  --input-dir .aiwg/research/sources/ \
  --model sonnet \
  --sub-model haiku \
  --max-sub-calls 100
```

**Result**:
- Root: Claude Sonnet (adequate decomposition)
- Sub-agents: Claude Haiku (100 sub-calls, minimal cost)
- Cost: ~0.5x baseline

### Example 3: Quality-Optimized (Single Provider)

**Scenario**: Security threat modeling for production API.

**Configuration**:
```bash
aiwg rlm-query "Generate threat model for payment API" \
  --model opus \
  --sub-model opus \
  --max-depth 3
```

**Result**:
- Root: Claude Opus (best reasoning)
- Sub-agents: Claude Opus (high-quality threat analysis)
- Cost: ~3.0x baseline (all Opus)

### Example 4: Cross-Provider (Cost-Optimized)

**Scenario**: Maximum cost savings with strong root reasoning.

**Configuration**:
```bash
# Set providers
export RLM_ROOT_PROVIDER=claude
export RLM_SUB_PROVIDER=openai

# Execute
aiwg rlm-query "Analyze 50 TypeScript modules for anti-patterns" \
  --model opus \
  --sub-model codex-mini-latest \
  --max-sub-calls 50
```

**Equivalent inline**:
```bash
aiwg rlm-query "Analyze 50 TypeScript modules for anti-patterns" \
  --provider claude \
  --model opus \
  --sub-provider openai \
  --sub-model codex-mini-latest \
  --max-sub-calls 50
```

**Result**:
- Root: Claude Opus ($15/1M input)
- Sub-agents: OpenAI Codex Mini ($1.50/1M input)
- Cost: ~0.8x baseline (10x savings on sub-calls)

### Example 5: Per-Project Defaults (manifest.json)

**Scenario**: Set project-wide RLM defaults.

**File**: `.aiwg/rlm/config.json`
```json
{
  "rlm": {
    "defaultRootModel": "opus",
    "defaultSubModel": "sonnet",
    "defaultRootProvider": "claude",
    "defaultSubProvider": "claude",
    "maxDepth": 3,
    "maxSubCalls": 20,
    "parallelSubCalls": true
  }
}
```

**Usage**:
```bash
# No flags needed, uses project defaults
aiwg rlm-query "Analyze codebase"
```

**Override**:
```bash
# Override sub-model for this task
aiwg rlm-query "Analyze codebase" --sub-model haiku
```

### Example 6: Environment Variable Override

**Scenario**: Temporary provider switch for testing.

**Configuration**:
```bash
# Project default: Claude Opus → Sonnet
# Override for this session: OpenAI GPT-5.3 → Codex Mini

export RLM_ROOT_PROVIDER=openai
export RLM_ROOT_MODEL=gpt-5.3-codex
export RLM_SUB_PROVIDER=openai
export RLM_SUB_MODEL=codex-mini-latest

# Execute (uses environment overrides)
aiwg rlm-query "Test task decomposition"

# Restore defaults
unset RLM_ROOT_PROVIDER RLM_ROOT_MODEL RLM_SUB_PROVIDER RLM_SUB_MODEL
```

**Precedence order**:
1. Command-line flags (`--model`, `--sub-model`)
2. Environment variables (`RLM_ROOT_MODEL`, `RLM_SUB_MODEL`)
3. Project config (`.aiwg/rlm/config.json`)
4. Framework defaults (`manifest.json`)

## Research Foundation

### REF-089: Recursive Language Models (Zhang et al., 2026)

**Key findings for multi-provider/multi-model usage**:

**Observation 5** (p. 7):
> "While both GPT-5 and Qwen3-Coder-480B both exhibit strong performance as RLMs... they also exhibit different performance and behavior across all tasks."

**Implication**: Different models require different prompts. AIWG mitigates with explicit depth limits and sub-call warnings.

**Observation 3** (p. 6):
> "RLMs are up to 3× cheaper than summarization agents because the RLM is able to selectively view context."

**Implication**: Cost optimization through selective access, not just model choice. Combine with cheaper sub-call models for maximum savings.

**Appendix B** (p. 14):
> "Synchronous sub-calls are slow. Output token limits matter."

**Implication**: Provider output token limits (Claude 16K vs OpenAI 4K) affect sub-agent performance. Choose providers carefully for tasks requiring large intermediate results.

**Appendix C**:
> "Qwen3-Coder required explicit warning about excessive sub-calls."

**Implication**: Model-specific prompt tuning needed. AIWG's generic limits (max depth 5, max sub-calls 20) work across all providers.

## Best Practices

### Choosing Root Provider/Model

**Priorities for root agent**:
1. **Reasoning capability** (most important)
2. **Context window** (for understanding full task)
3. **Output token limit** (for detailed decomposition plan)
4. **Cost** (secondary for root, only one call)

**Recommendation**: Claude Opus or OpenAI GPT-5.3-Codex (both $15/1M input, excellent reasoning).

### Choosing Sub-Call Provider/Model

**Priorities for sub-agents**:
1. **Cost** (most important for high fan-out)
2. **Output token limit** (if large intermediate results needed)
3. **Quality** (must be adequate for sub-task)
4. **API rate limits** (for parallel sub-calls)

**Recommendation**: OpenAI codex-mini-latest ($1.50/1M input) for cost, Claude Sonnet ($3/1M input) for balance.

### When to Use Mixed Providers

✅ **Use mixed providers when**:
- Cost is paramount (high sub-call count)
- Root reasoning needs are higher than sub-call needs
- You have API keys for multiple providers
- Sub-tasks are simple (extraction, search, aggregation)

❌ **Avoid mixed providers when**:
- Authentication complexity is a concern
- Single-provider rate limits are sufficient
- Sub-tasks require same quality as root (e.g., security analysis)
- Debugging complexity outweighs cost savings

### Monitoring Cost and Quality

Track these metrics:

| Metric | Target | Tool |
|--------|--------|------|
| Cost per task | Baseline × 0.8-1.2 | `aiwg rlm-status --cost` |
| Sub-call count | <20 (default limit) | `aiwg rlm-status --sub-calls` |
| Recursion depth | <3 (typical), <5 (max) | `aiwg rlm-status --depth` |
| Quality score | >0.8 (good), >0.9 (excellent) | Human review of outputs |

## Troubleshooting

### Issue: Sub-calls using wrong model

**Symptom**: Expected Codex Mini, but seeing Claude Sonnet in logs.

**Cause**: Environment variable or config override.

**Fix**:
```bash
# Check current configuration
aiwg rlm-status --config

# Clear environment variables
unset RLM_SUB_MODEL RLM_SUB_PROVIDER

# Or specify explicitly
aiwg rlm-query "task" --sub-model codex-mini-latest
```

### Issue: Output truncation on sub-agents

**Symptom**: Sub-agent results are cut off mid-response.

**Cause**: Provider output token limit exceeded (e.g., OpenAI 4K limit).

**Fix**: Switch to provider with higher output limit (Claude 16K).

```bash
# Before (OpenAI, 4K output limit)
aiwg rlm-query "task" --sub-provider openai --sub-model codex-mini-latest

# After (Claude, 16K output limit)
aiwg rlm-query "task" --sub-provider claude --sub-model haiku
```

### Issue: API rate limits hit

**Symptom**: Sub-calls failing with 429 errors.

**Cause**: Too many parallel sub-calls for provider rate limit.

**Fix**: Reduce parallel sub-calls or use multiple providers.

```bash
# Option 1: Reduce parallelism
aiwg rlm-query "task" --max-parallel 5

# Option 2: Use multiple providers (distributes load)
aiwg rlm-query "task" \
  --root-provider claude \
  --sub-provider openai  # OpenAI has separate rate limits
```

### Issue: Authentication failure on sub-calls

**Symptom**: Sub-calls fail with auth errors.

**Cause**: API key not configured for sub-call provider.

**Fix**: Ensure API keys are set for both providers.

```bash
# Check current keys
echo $ANTHROPIC_API_KEY  # For Claude
echo $OPENAI_API_KEY     # For OpenAI

# Set missing key
export OPENAI_API_KEY="sk-..."

# Or use single provider
aiwg rlm-query "task" --provider claude --sub-provider claude
```

## References

- @$AIWG_ROOT/agentic/code/addons/rlm/manifest.json - Default configuration
- @$AIWG_ROOT/agentic/code/addons/rlm/agents/rlm-agent.md - RLM agent definition
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/config/models.json - Model mappings
- @.aiwg/research/findings/REF-089-recursive-language-models.md - Research foundation
- @$AIWG_ROOT/docs/integrations/codex-quickstart.md - OpenAI Codex setup
- @.aiwg/planning/codex-integration-plan.md - Codex integration details
- Issue #325 - Multi-provider RLM support

---

**Status**: ACTIVE
**Maintainer**: AIWG Contributors
**Last Reviewed**: 2026-02-09
