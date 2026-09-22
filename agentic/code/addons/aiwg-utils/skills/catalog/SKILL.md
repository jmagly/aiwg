---
namespace: aiwg
name: catalog
platforms: [all]
description: Browse the AIWG model catalog — list available AI models, fetch model details, and search by capability or name
---

# Model Catalog

You access the AIWG model catalog — listing available AI models, fetching details for a specific model, and searching by capability or name.

## Triggers

Alternate expressions and non-obvious activations (primary phrases are matched automatically from the skill description):

- "which models does aiwg know about" → list
- "tell me about gpt-4o" → info <model-id>
- "find models that support vision" → search vision
- "what's available for code generation" → search code generation

## Trigger Patterns Reference

| Pattern | Example | Action |
|---------|---------|--------|
| List all models | "list available models" | Run `aiwg catalog list` |
| Model details | "show me details for claude-3-5-sonnet" | Run `aiwg catalog info claude-3-5-sonnet` |
| Capability search | "what models support tool use?" | Run `aiwg catalog search "tool use"` |
| Name search | "search for GPT models" | Run `aiwg catalog search gpt` |
| Provider filter | "show Anthropic models" | Run `aiwg catalog search --provider anthropic` |

## Behavior

When triggered:

1. **Identify the subcommand**:
   - Is the user browsing all models, looking up a specific one, or searching by capability/name?
   - Is a model ID or capability keyword mentioned?

2. **Run the appropriate command**:

   ```bash
   # List all catalogued models
   aiwg catalog list

   # Show details for a specific model
   aiwg catalog info <model-id>

   # Search by capability or name
   aiwg catalog search <query>

   # Filter by provider
   aiwg catalog search --provider <provider-name>

   # Machine-readable output
   aiwg catalog list --json
   aiwg catalog info <model-id> --json
   ```

3. **Report the result** — summarize relevant models or the requested model's details.

## Examples

### Example 1: List all models

**User**: "What models are available in the catalog?"

**Extraction**: List subcommand, no filter

**Action**:
```bash
aiwg catalog list
```

**Response**: "Catalog contains 24 models across 6 providers: Anthropic (6), OpenAI (8), Google (4), Meta (3), Mistral (2), Cohere (1). Run `aiwg catalog info <id>` for details on any model."

### Example 2: Model details

**User**: "Show me details for claude-sonnet-5"

**Extraction**: Info subcommand, model-id = claude-sonnet-5

**Action**:
```bash
aiwg catalog info claude-sonnet-5
```

**Response**: "claude-sonnet-5: Anthropic Claude Sonnet 5. Context: 1M tokens. Capabilities: tool use, vision, code, analysis. Recommended for: SDLC agents, code review, architecture design."

### Example 3: Capability search

**User**: "Which models support vision?"

**Extraction**: Search subcommand, query = vision

**Action**:
```bash
aiwg catalog search vision
```

**Response**: "7 models support vision: claude-3-5-sonnet, claude-3-opus, gpt-4o, gpt-4-turbo, gemini-1.5-pro, gemini-1.5-flash, llama-3.2-11b-vision."

### Example 4: Provider-filtered search

**User**: "Show me all OpenAI models"

**Extraction**: Search subcommand with provider filter

**Action**:
```bash
aiwg catalog search --provider openai
```

**Response**: "8 OpenAI models catalogued: gpt-4o, gpt-4o-mini, gpt-4-turbo, gpt-4, gpt-3.5-turbo, o1, o1-mini, o3-mini."

## Clarification Prompts

If the user's intent is ambiguous:

- "Are you looking for a specific model by name, or searching by capability (e.g., vision, tool use, code)?"
- "Would you like the full list or results filtered by a provider?"

## References

- @$AIWG_ROOT/src/cli/handlers/subcommands.ts — Catalog subcommand handler
- @$AIWG_ROOT/docs/cli-reference.md — CLI reference (catalog section)
