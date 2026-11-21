# RLM — Recursive Language Models Addon

Evidence status: paper-reported ([REF-089](https://arxiv.org/abs/2512.24601)), not measured in AIWG.

**Version**: 1.0.0
**Status**: Experimental (effectiveness unmeasured in AIWG)
**Research Foundation**: REF-089 (Zhang et al., 2026) — [arXiv:2512.24601](https://arxiv.org/abs/2512.24601)

## Overview

The Recursive Language Models (RLM) addon enables AIWG agents to process arbitrarily large codebases, documentation corpora, and multi-file operations through recursive sub-agent delegation and programmatic environment interaction. Instead of loading entire contexts into the conversation window, RLM treats context as an external environment accessed selectively through code.

**Key insight from REF-089**: Long prompts should not be fed into the neural network directly but should instead be treated as part of the environment that the LLM is tasked to symbolically and recursively interact with. In the paper, this approach is lossless, cost-efficient, and scales to 10M+ tokens through recursive composition (paper-reported, not measured in AIWG).

**AIWG alignment**: Claude Code already operates this way through Read, Grep, and Glob tools. RLM formalizes and extends these patterns with recursive decomposition, parallel fan-out processing, and explicit task tree management.

The RLM paper reports up to 3x cost reduction compared to summarization approaches while maintaining stronger performance (paper-reported, not measured in AIWG; see [arXiv:2512.24601](https://arxiv.org/abs/2512.24601)), attributing it to the agent selectively accessing only relevant portions of context.

## Quick Start

```bash
# Deploy RLM addon to current provider
aiwg use rlm

# Spawn focused sub-agent for specific context
/rlm-query src/auth/login.ts "identify security issues"

# Parallel fan-out processing across multiple files
/rlm-batch "src/**/*.ts" "extract all exported function names"

# Check execution status and cost
/rlm-status --cost
```

## Components

| Component | Type | Description |
|-----------|------|-------------|
| **rlm-agent** | Agent | Recursive decomposition specialist orchestrating environment interaction |
| **rlm-query** | Command | Sub-agent spawner (equivalent to RLM's `llm_query()`) for focused context processing |
| **rlm-batch** | Command | Parallel fan-out processing for batch operations across multiple files |
| **rlm-status** | Command | Real-time status dashboard showing task tree, progress, and cost |
| **rlm-mode** | Skill | Natural language trigger detecting large-scale operations requiring decomposition |
| **rlm-context-management** | Rule | Enforcement rules for symbolic handles, programmatic access, and recursive delegation |

## When to Use RLM

Use RLM for tasks that meet any of these criteria:

**1. Context Window Constraints**
- Task involves files or data exceeding available context window
- Need to analyze entire codebase larger than model capacity
- Working with multi-file operations spanning hundreds of files

**2. Information Density**
- Task requires selective access to specific details throughout large corpus
- Cannot afford lossy summarization (need full information preserved)
- Need to maintain complete detail while processing large volumes

**3. Batch Processing**
- Same operation applied to many files independently
- Parallel processing would improve speed and cost
- Results need to be aggregated from distributed sub-tasks

**4. Recursive Structure**
- Problem naturally decomposes into independent sub-problems
- Sub-problems can be solved in parallel or sequentially
- Final result synthesized from sub-results

## Architecture

### Mapping to AIWG

RLM's three-component architecture maps cleanly to AIWG's existing capabilities:

```
RLM Component          → AIWG Equivalent
─────────────────────────────────────────────
REPL (code execution)  → Read, Grep, Glob, Bash tools
llm_query()            → Task tool (sub-agent spawning)
Final env variable     → Task completion criteria
```

### Execution Flow

```
┌────────────────────────────────────────────────────────┐
│                  Root Agent (RLM)                      │
│  "Analyze authentication security across codebase"    │
└─────────────┬──────────────────────────────────────────┘
              │
              │ Decompose
              ▼
    ┌─────────────────────────┐
    │ Symbolic Environment    │
    │ src/auth/**/*.ts        │
    └─────────────────────────┘
              │
              │ Programmatic Query
              ▼
    ┌─────────────────────────┐
    │ Grep: "password.*hash"  │
    │ → 12 relevant files     │
    └─────────────────────────┘
              │
              │ Spawn Sub-Agents
              ▼
    ┌──────────────┬──────────────┬──────────────┐
    │  Sub-Agent 1 │  Sub-Agent 2 │  Sub-Agent 3 │
    │  login.ts    │  register.ts │  reset.ts    │
    └──────────────┴──────────────┴──────────────┘
              │
              │ Aggregate Results
              ▼
    ┌─────────────────────────────────────────────┐
    │ Security Report:                            │
    │ - Password hashing: bcrypt (GOOD)           │
    │ - Token generation: crypto.randomBytes (OK) │
    │ - Reset flow: Missing rate limiting (BAD)   │
    └─────────────────────────────────────────────┘
```

**Key principles**:
1. Root agent never loads full file contents
2. Symbolic handles (file paths) used for references
3. Programmatic filtering (Grep/Glob) before reading
4. Independent sub-agents process chunks in parallel
5. Results aggregated incrementally through intermediate artifacts

## Model Tiering

Different nodes in a task tree should use different model tiers based on their role. Using Opus for everything wastes budget; using Haiku for complex reasoning produces poor results.

### Recommended Model Assignments

| Role | Model | Rationale |
|------|-------|-----------|
| **Screener / Filter** | Haiku | Simple classification, yes/no decisions, low cost |
| **Extractor / Mapper** | Haiku | Structured data extraction from well-defined inputs |
| **Orchestrator / Synthesizer** | Sonnet | Coordination, result merging, moderate reasoning |
| **Analyzer / Reviewer** | Sonnet | Code analysis, pattern detection, quality review |
| **Reasoner / Judge** | Opus | Complex reasoning, final quality judgment, nuanced decisions |
| **Evaluator (quality gate)** | Sonnet | Scoring against rubric, feedback generation |

### Example: Filter-Recurse Pipeline

```yaml
nodes:
  - node_id: screener
    preferred_model: haiku       # Quick relevance filtering
    prompt: "Screen documents for relevance to the query"

  - node_id: investigator
    preferred_model: sonnet      # Moderate analysis
    prompt: "Extract detailed findings from relevant documents"

  - node_id: reasoner
    preferred_model: opus        # Complex synthesis and judgment
    prompt: "Synthesize findings into a comprehensive answer"
    quality_gate:
      min_score: 85
      scorer_model: sonnet
      max_iterations: 3
```

### Cost Impact

Model tiering is intended to cost less than uniform Opus usage (unmeasured in AIWG; no cost comparison has been run), on the assumption that most nodes in a tree perform simple tasks.

## Chunking Strategies

When decomposing large inputs into child tasks, the chunking strategy determines how to split the content.

| Strategy | When to Use | Example |
|----------|-------------|---------|
| `semantic-boundary` | Documents, markdown, code with clear structure | Split at headers, function boundaries, class definitions |
| `fixed-count` | Uniform content without clear boundaries | Split into 4-8 equal pieces |
| `adaptive` | Unknown structure, let the model decide | Default — model examines content and determines optimal splits |

### Semantic Boundary Chunking

Preferred for structured content. Respects logical units:
- **Markdown**: Split at `##` headers
- **Code**: Split at function/class/module boundaries
- **Data**: Split at record boundaries
- **Mixed**: Split at section breaks or paragraph clusters

### Batch Sizing

For `map-reduce` and pairwise comparison patterns, the `batch_size` field controls how many items are processed per parallel group. Default is 25, which balances:
- Parallelism (more batches = more parallel work)
- Context efficiency (each batch fits comfortably in a sub-agent window)
- Cost (fewer batches = fewer sub-agent invocations)

Reduce to 10-15 on constrained systems or when items are individually large.

## Quality Gates

Quality gates enforce minimum output standards before accepting a node's result. When a gate is present, the output is scored against criteria and refined iteratively until the threshold is met.

### How It Works

```
Node executes → Scorer evaluates output → Score ≥ threshold? → Accept
                                          Score < threshold? → Refine with feedback → Re-execute
                                          Max iterations? → Fallback (return_best | fail | escalate)
```

### Schema

```yaml
quality_gate:
  min_score: 85              # 0-100, default 85
  scoring_criteria: "Completeness, accuracy, clarity"
  scorer_model: sonnet       # Model for the evaluator
  max_iterations: 5          # Max refinement cycles
  fallback: return_best      # return_best | fail | escalate
```

### When to Use Quality Gates

- **Final synthesis nodes** — the output that users see
- **Security analysis** — must be thorough, not just fast
- **Data extraction** — accuracy matters more than speed
- **Research synthesis** — completeness against a rubric

Avoid gates on screening/filtering nodes — the overhead isn't worth it for simple classification tasks.

## Antipatterns

Common mistakes when building RLM task trees, adapted from OpenProse's antipattern guidance with AIWG-specific context.

### parallel-then-synthesize

**Problem**: Fan out work to parallel sub-agents that produce conflicting partial results, then try to merge.

**AIWG risk**: RLM `decomposition_strategy: parallel` with `merge_strategy: summarize` may produce contradictions when sub-agents analyze overlapping context.

**Mitigation**: Use `sequential` or `conditional` when sub-tasks have dependencies. Use `parallel` only for truly independent work (different files, different concerns).

### fixed-observation-window

**Problem**: Always using the same recursion depth regardless of task complexity.

**AIWG risk**: Default `maxDepth: 3` may be too shallow for complex multi-file analysis, or unnecessarily deep for simple extraction.

**Mitigation**: Set depth per task tree based on actual complexity. Simple extraction: depth 1. Multi-file analysis: depth 2-3. Cross-cutting research: depth 3-5.

### excessive-user-checkpoints

**Problem**: Pausing for human validation too often in automated pipelines.

**AIWG risk**: agent loop completion criteria or quality gates may trigger unnecessary human review in batch processing.

**Mitigation**: Use `fallback: return_best` instead of `fallback: escalate` for non-critical nodes. Reserve human escalation for final deliverables.

### opus-for-everything

**Problem**: Using the most expensive model for all nodes regardless of task complexity.

**AIWG risk**: Default `defaultSubModel: sonnet` is reasonable, but not differentiating between screener (Haiku) and reasoner (Opus) nodes wastes budget.

**Mitigation**: Use `preferred_model` per node. See the Model Tiering section above.

### context-bloat

**Problem**: Passing full conversation history or unnecessary context to sub-agents.

**AIWG risk**: Sub-agents receiving entire parent context when they only need a slice.

**Mitigation**: Use `context.type: filtered` or `context.type: slice` instead of `context.type: full`. Follow the subagent-scoping rule: each sub-agent gets <20% of the context window.

### unbounded-loop

**Problem**: Refinement loops without termination conditions.

**AIWG risk**: Quality gates with high `min_score` and high `max_iterations` may loop excessively on tasks that can't meet the threshold.

**Mitigation**: Set realistic `min_score` (85 is a good default). Keep `max_iterations` at 3-5. Use `fallback: return_best` to guarantee termination.

## Configuration

Default settings from `manifest.json`:

```json
{
  "maxDepth": 3,
  "maxSubCalls": 20,
  "defaultSubModel": "sonnet",
  "budgetTokens": 500000,
  "parallelSubCalls": true,
  "persistState": true
}
```

### Override Configuration

**Project-level** (`aiwg.yml`):
```yaml
addons:
  rlm:
    maxDepth: 5
    maxSubCalls: 50
    budgetTokens: 1000000
```

**Command-level** (inline):
```bash
/rlm-query file.ts "analyze" --depth 2
/rlm-batch "src/**/*.ts" "check" --max-parallel 5
```

### Configuration Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `maxDepth` | 3 | Maximum recursion depth for sub-agent chains |
| `maxSubCalls` | 20 | Maximum number of sub-agents per task |
| `defaultSubModel` | sonnet | Model for sub-agents (root agent always uses opus) |
| `budgetTokens` | 500000 | Maximum token budget across entire task tree |
| `parallelSubCalls` | true | Enable parallel execution of independent sub-agents |
| `persistState` | true | Save task tree state for recovery and analysis |

## Research Foundation

**REF-089: Recursive Language Models (Zhang et al., 2026)**

Key findings reported in the paper (paper-reported, not measured in AIWG):
- **10M+ token processing**: Scales beyond any fixed context window through recursion
- **3x cost reduction**: Selective access cheaper than loading full context
- **Superior performance**: Maintains details lost to summarization
- **28.3% improvement**: Additional gain from training on RLM trajectories

**Core design choices**:
1. **Treat context as environment**: Long prompts are not model input but external data
2. **Programmatic access**: Query context via code rather than reading sequentially
3. **Recursive composition**: Decompose problems into sub-problems solved by sub-agents
4. **Selective reading**: Access only relevant portions, not entire corpus

**Research quote** (from [REF-089](https://arxiv.org/abs/2512.24601); paper-reported, not measured in AIWG):
> "Compared to the summarization agent which ingests the entire input context, RLMs are up to 3× cheaper while maintaining stronger performance across all tasks because the RLM is able to selectively view context."

## Integration Points

RLM integrates with multiple AIWG systems:

### Agent Supervisor (`tools/daemon/agent-supervisor.mjs`)
- Sub-agent lifecycle management
- Model selection and routing
- Resource allocation and limits

### Task Store (`tools/daemon/task-store.mjs`)
- Persistent task tree storage
- State recovery after failures
- Progress tracking across restarts

### Messaging Hub (`tools/messaging/index.mjs`)
- Sub-agent result collection
- Parallel execution coordination
- Aggregation patterns

### Agent Loops (`tools/ralph-external/`)
- Iterative refinement within sub-agents
- Best-output selection from multiple attempts
- Feedback-driven improvement

### Multi-Provider Support
- Codex, Claude, Copilot, Cursor, Factory, OpenCode, Warp, Devin Desktop
- Model mapping handles provider differences
- Consistent RLM patterns across all platforms

## Schemas

RLM defines four core schemas:

**1. Task Tree** (`schemas/rlm-task-tree.yaml`)
- Hierarchical decomposition structure
- Parent-child relationships
- Dependency tracking

**2. State** (`schemas/rlm-state.yaml`)
- Execution status per sub-task
- Intermediate results
- Completion signals

**3. Trajectory** (`schemas/rlm-trajectory.yaml`)
- Tool invocation history
- Decision points and rationale
- Learning data for future training

**4. Cost** (`schemas/rlm-cost.yaml`)
- Token usage by depth
- Model costs per sub-agent
- Total budget tracking

## Dependencies

**Required**: None (RLM operates independently)

**Optional**:
- **ralph**: Enhanced iteration loops with best-output selection
- **aiwg-utils**: Development utilities for testing and debugging

## Usage Patterns

### Pattern 1: Single-File Deep Analysis

```bash
# Large file that exceeds context window
/rlm-query src/large-module.ts "identify all async race conditions"

# RLM will:
# 1. Chunk file by function/class
# 2. Grep for async patterns
# 3. Spawn sub-agents for each async function
# 4. Aggregate race condition findings
```

### Pattern 2: Corpus-Wide Search

```bash
# Find all API endpoints across entire codebase
/rlm-batch "src/**/*.ts" "list all HTTP route handlers"

# RLM will:
# 1. Glob match 50 TypeScript files
# 2. Spawn 50 parallel sub-agents (respecting max-parallel)
# 3. Each extracts endpoints from one file
# 4. Aggregate into comprehensive API inventory
```

### Pattern 3: Cross-Cutting Refactor

```bash
# Rename function across entire codebase
/rlm-query "src/**/*.js" "find all calls to oldFunctionName()"
# → intermediate result: call-sites.json

/rlm-batch "@call-sites.json" "rename oldFunctionName to newFunctionName"
# → applies changes to each file independently

/rlm-query "src/**/*.js" "verify no references to oldFunctionName remain"
# → validation check
```

### Pattern 4: Research Synthesis

```bash
# Analyze 100 research papers for common themes
/rlm-batch ".aiwg/research/sources/**/*.pdf" "extract main contribution"
# → 100 summaries

/rlm-query "@summaries/*.txt" "identify 5 most common themes"
# → synthesized analysis
```

## Examples

Complete task tree examples in `examples/`:

| Example | Pattern | Model Tiering | Quality Gate |
|---------|---------|---------------|--------------|
| `rlm-self-refine.yaml` | Evaluator + refiner loop | Sonnet (drafter + scorer) | Yes (85+, 5 iterations) |
| `rlm-divide-conquer.yaml` | Chunker → analyzer → synthesizer | Haiku (chunker), Sonnet (analyzer + synth) | Yes (on synthesizer) |
| `rlm-filter-recurse.yaml` | Screener → investigator → reasoner | Haiku → Sonnet → Opus | Yes (90+, escalate fallback) |

These examples demonstrate the full feature set: `preferred_model`, `quality_gate`, `chunking_strategy`, and `batch_size`.

## Advanced Topics

See documentation in `docs/`:

- **Architecture Deep Dive**: `docs/architecture.md`
- **Cost Optimization**: `docs/cost-optimization.md`
- **Parallel Execution**: `docs/parallel-patterns.md`
- **Error Recovery**: `docs/error-recovery.md`
- **Trajectory Analysis**: `docs/trajectory-analysis.md`
- **Integration Guide**: `docs/integration.md`
- **Research Background**: `docs/research-foundation.md`

## Performance Characteristics

Based on REF-089 paper benchmarks (paper-reported, not measured in AIWG):

| Metric | RLM | Summarization | Direct Context |
|--------|-----|---------------|----------------|
| **Max tokens** | 10M+ (unbounded) | ~1M (limited by compression ratio) | ~200K (context window) |
| **Cost** | 1x (baseline) | 3x (reads everything) | N/A (overflow) |
| **Quality** | High (lossless) | Medium (lossy) | N/A (fails) |
| **Latency** | Variable (parallel) | High (sequential) | N/A (fails) |

**When RLM is expected to help (design intent, unmeasured)**:
- Information-dense tasks requiring full detail
- Tasks that decompose naturally into independent sub-problems
- Operations benefiting from parallelism

**When alternatives may fit better (design intent)**:
- Small contexts (<50K tokens) where direct reading works
- Tasks requiring global understanding that cannot decompose
- Real-time latency-critical operations

## Troubleshooting

**Problem**: Sub-agents exceed budget

**Solution**: Reduce `maxSubCalls` or `budgetTokens`, or increase sub-agent focus

**Problem**: Task tree too deep

**Solution**: Reduce `maxDepth`, or improve decomposition strategy

**Problem**: Slow execution despite parallelization

**Solution**: Check `parallelSubCalls` is enabled, verify provider supports concurrency

**Problem**: Results incomplete after timeout

**Solution**: Use `/rlm-status` to check progress, increase timeout, or resume from checkpoint

## References

**Research**:
- `.aiwg/research/findings/REF-089-recursive-language-models.md` — Primary research paper
- `.aiwg/research/synthesis/topic-04-tool-grounding.md` — Tool grounding patterns
- `.aiwg/research/synthesis/topic-02-decomposition.md` — Task decomposition strategies

**AIWG Documentation**:
- `agentic/code/addons/rlm/docs/architecture.md` — Architecture details
- `agentic/code/addons/rlm/docs/cost-optimization.md` — Cost optimization guide
- `agentic/code/addons/rlm/docs/parallel-patterns.md` — Parallelization patterns

**Rules and Schemas**:
- `agentic/code/addons/rlm/rules/rlm-context-management.md` — Context management rules
- `agentic/code/addons/rlm/schemas/` — All schema definitions

**Related Issues**:
- #322 — Core RLM addon implementation
- #323 — Parallel batch processing
- #324 — Task tree visualization
- #325 — Cost tracking and budgets

**Related Addons**:
- `agentic/code/addons/agent-loop/` — Iterative refinement loops
- `agentic/code/addons/aiwg-utils/` — Development utilities
- `agentic/code/frameworks/sdlc-complete/` — SDLC agent workflows

---

**License**: MIT
**Author**: AIWG Contributors
**Repository**: https://github.com/jmagly/aiwg
