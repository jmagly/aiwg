---
namespace: aiwg
name: cost-report
platforms: [all]
description: Generate a cost report for an AIWG session or observe per-bot OpenRouter fleet spend

---

# cost-report

You generate a cost and token-spending report for the current or most recent workflow session. You read accumulated token usage data from `.aiwg/ralph/cost-tracking.json` and present a breakdown by operation, model, and time period.

## Triggers

Alternate expressions and non-obvious activations (primary phrases are matched automatically from the skill description):

- "how much did that cost" → report for most recent session
- "what did this iteration cost" → report scoped to current agent loop
- "token breakdown" → report with per-model detail
- "did we stay in budget" → report with budget threshold comparison

## Trigger Patterns Reference

| Pattern | Example | Action |
|---------|---------|--------|
| Session cost | "cost report" | `aiwg cost-report` |
| Current loop cost | "how much has this session cost so far" | `aiwg cost-report --session current` |
| Named session | "cost for the greenfield run" | `aiwg cost-report --session greenfield` |
| Model breakdown | "show costs by model" | `aiwg cost-report --by-model` |
| Budget check | "are we over budget" | `aiwg cost-report --budget <N>` |
| Fleet spend | "show fleet spend" | `aiwg cost-report --fleet` |

## Behavior

When triggered:

### Fleet mode

For `--fleet`, run the native CLI handler. It reads `~/.config/aiwg/fleet.yaml`, resolves each `key_ref` only from `~/.config/aiwg/keys/` or `AIWG_OPENROUTER_KEY_*`, and reports `bot | machine | spend MTD | cap | % used | top-3 expensive sessions`.

Fleet manifests contain references only. Never read a credential from a project manifest, print a credential, or copy one into an artifact. AIWG observes and correlates spend; OpenRouter enforces all limits and caps. Session/model correlation is optional and uses locally recorded `bot=`, `session=`, and `generation_id=` tags in `.aiwg/activity.log`.

```bash
aiwg cost-report --fleet
aiwg cost-report --fleet --json
aiwg cost-report --key <key_ref> --monthly-cap 10
```

For setup and security details, see `@$AIWG_ROOT/docs/guides/openrouter-fleet-costs.md`.

### Session mode

1. **Determine scope**:
   - Default: most recent completed session
   - `--session current`: running session (live data)
   - `--session <name>`: named session from history

2. **Read cost tracking data**:
   - Primary source: `.aiwg/ralph/cost-tracking.json`
   - Fallback: aggregate from `.aiwg/ralph/sessions/*/metrics.json`

3. **Compute the report**:
   - Total tokens (input + output)
   - Estimated cost using model pricing table
   - Breakdown by workflow step and model
   - Comparison to MetaGPT baseline (124 tokens/line, REF-013)

4. **Run the command**:

   ```bash
   # Default report (most recent session)
   aiwg cost-report

   # Current running session
   aiwg cost-report --session current

   # JSON output (for scripting)
   aiwg cost-report --json

   # Filter to specific model
   aiwg cost-report --model claude-sonnet-5

   # Budget threshold check
   aiwg cost-report --budget 5.00
   ```

## Report Format

### Standard Output

```
Cost Report — Session: sdlc-review-20260401-143022
Duration: 4m 12s
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Token Usage
  Input tokens:   42,310
  Output tokens:  18,940
  Total tokens:   61,250

Estimated Cost
  claude-sonnet-4-5:  $0.18  (61,250 tokens)
  Total:              $0.18

Efficiency vs Benchmark
  Tokens/line:    112  (MetaGPT baseline: 124)  [green]
  vs baseline:    -9.7%  (better than benchmark)

Steps
  architecture-designer  →  18,200 tokens  $0.07
  security-architect     →  14,600 tokens  $0.06
  test-architect         →  13,100 tokens  $0.05
  technical-writer       →  15,350 tokens  $0.06 (incl. synthesis)
```

### Budget Check Output

```
Budget: $5.00
Used:   $0.18  (3.6% of budget)
Status: Within budget
```

## Data Sources

| Source | Contents |
|--------|----------|
| `.aiwg/ralph/cost-tracking.json` | Aggregated session costs |
| `.aiwg/ralph/sessions/*/metrics.json` | Per-session detailed metrics |
| `src/metrics/token-counter.ts` | Token estimation logic (4 chars/token) |

## Examples

### Example 1: Quick session report

**User**: "How much did that cost?"

**Extraction**: Cost report for most recent session

**Action**:
```bash
aiwg cost-report
```

**Response**: Session report with token totals, estimated cost, and efficiency rating against the MetaGPT baseline.

### Example 2: Budget check mid-session

**User**: "Are we over the $2 budget for this run?"

**Extraction**: Budget comparison for current session

**Action**:
```bash
aiwg cost-report --session current --budget 2.00
```

**Response**:
```
Budget: $2.00
Used:   $0.43  (21.5% of budget)
Status: Within budget
Projected total (at current rate): $0.71
```

### Example 3: Model breakdown

**User**: "Show me costs broken down by model"

**Action**:
```bash
aiwg cost-report --by-model
```

**Response**:
```
Cost by Model
  claude-sonnet-4-5:   $0.12  (38,400 tokens)
  claude-haiku-3-5:    $0.02   (6,200 tokens)
  Total:               $0.14  (44,600 tokens)
```

## Clarification Prompts

If the session is ambiguous:

- "Should I report on the current session or the most recent completed session?"

## References

- @$AIWG_ROOT/src/cli/handlers/subcommands.ts — Cost report handler
- @$AIWG_ROOT/src/metrics/token-counter.ts — Token counting and MetaGPT baseline (REF-013)
- @$AIWG_ROOT/docs/cli-reference.md — CLI reference
- @$AIWG_ROOT/docs/guides/openrouter-fleet-costs.md — OpenRouter fleet configuration and security contract
