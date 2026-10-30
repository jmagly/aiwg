# Ralph-RLM Integration

**Version**: 1.0.0
**Status**: Active
**Research Foundation**: REF-089 Recursive Language Models (Zhang et al., 2026), REF-018 ReAct
**Issue**: #329

## Overview

This document describes how the RLM (Recursive Language Models) addon integrates with agent loops as a processing strategy for long-context tasks. Al provides the outer TAO (Thought→Action→Observation) iteration loop, while RLM handles recursive decomposition of large-context tasks into manageable sub-problems.

## Quick Reference

```bash
# Explicit RLM strategy
ralph "Analyze this large codebase" --strategy rlm --completion "analysis complete"

# Auto-detection (Al suggests RLM when appropriate)
ralph "Search for API key leaks across all repos" --completion "report generated"
# → Detects batch pattern, suggests: "Use --strategy rlm for better performance?"

# Override RLM defaults
ralph "Analyze security risks" --strategy rlm --max-depth 5 --max-sub-calls 50
```

## Why RLM + Al?

### Problem: Context Window Limitations

Al alone:
- User: "Analyze all 89 research papers for memory patterns"
- Al iteration 1: Tries to load all 89 papers into context → context overflow
- Al iteration 2: Summarizes all papers → loses critical details
- Result: Incomplete or shallow analysis

Al + RLM:
- User: "Analyze all 89 research papers for memory patterns"
- Al uses RLM agent strategy
- RLM: Filters to 12 relevant papers → delegates per-paper analysis → aggregates
- Result: Complete, lossless analysis within context limits

### Solution: Structural Equivalence

RLM's REPL loop IS structurally equivalent to Al's TAO loop:

| RLM Component | Al Component | Description |
|---------------|-----------------|-------------|
| `code ← LLM(hist)` | Thought → Action | Generate action based on state |
| `REPL(state, code)` | Action execution | Execute tool/code in environment |
| `Metadata(stdout)` | Observation | Capture execution result |
| `state[Final] is set` | Completion criteria | Task completion signal |

This structural equivalence makes RLM a natural strategy for Al when context decomposition is needed.

## TAO Loop Mapping

### RLM REPL Cycle

From REF-089:
```
Loop:
  1. code ← LLM(hist)
  2. stdout, stderr ← REPL(state, code)
  3. hist ← hist ∪ Metadata(stdout)
  4. IF state[Final] is set: DONE
  5. ELSE: continue loop
```

### Al TAO Cycle

From AIWG Al implementation:
```
Loop:
  1. THOUGHT: What should I do next?
  2. ACTION: Execute tool/command
  3. OBSERVATION: Capture result
  4. IF completion criteria met: DONE
  5. ELSE: continue loop
```

### Mapping Table

| Concept | RLM | Al | Notes |
|---------|-----|-------|-------|
| **Decision** | `LLM(hist)` generates code | `THOUGHT` determines action | Both: reasoning about next step |
| **Execution** | `REPL(state, code)` runs code | `ACTION` executes tool | Both: interact with environment |
| **Feedback** | `Metadata(stdout)` captures output | `OBSERVATION` records result | Both: incorporate execution outcome |
| **State** | `state` variables (Final, prompt, etc.) | Al reflection memory | Both: persistent context |
| **Completion** | `state[Final] != null` | Completion criteria met | Both: explicit termination |
| **Recursion** | `llm_query()` spawns sub-LMs | Al sub-agents via Task tool | Both: delegate sub-problems |

### Example Parallel Execution

**RLM REPL Trajectory**:
```python
# Iteration 1
code: grep_files("**/*.ts", "authenticate")
output: ["src/auth.ts:42", "src/login.ts:18"]
state: {"files_found": 2}

# Iteration 2
code: llm_query("Analyze src/auth.ts authentication logic")
output: sub_result_1
state: {"files_found": 2, "auth_analysis": "..."}

# Iteration 3
code: set_final("Analysis complete")
state: {"Final": "Analysis complete", ...}
```

**Al TAO Trajectory**:
```yaml
# Iteration 1
thought: "I need to find files with authentication logic"
action: Grep(pattern="authenticate", glob="**/*.ts")
observation: ["src/auth.ts:42", "src/login.ts:18"]
state: {"files_found": 2}

# Iteration 2
thought: "Delegate analysis of src/auth.ts to sub-agent"
action: Task("Analyze src/auth.ts authentication logic")
observation: sub_agent_result
state: {"files_found": 2, "auth_analysis": "..."}

# Iteration 3
thought: "Analysis is complete"
action: Write(final_report)
observation: success
completion: criteria met
```

**Key Insight**: RLM's REPL loop is a domain-specific instance of Al's TAO loop, specialized for code-driven context decomposition.

## Explicit RLM Strategy: `--strategy rlm`

### Usage

```bash
ralph "task description" --strategy rlm [--rlm-options] --completion "criteria"
```

### How It Changes Al Behavior

| Aspect | Al Default | Al + RLM Strategy |
|--------|---------------|---------------------|
| **Agent Selection** | General-purpose agent | RLM-specific agent (rlm-agent.md) |
| **Context Handling** | Load files directly into context | Programmatic filtering via Grep/Glob first |
| **Decomposition** | Manual agent decision | Automatic recursive decomposition |
| **Sub-Agent Pattern** | Ad-hoc Task tool usage | Structured llm_query() pattern |
| **State Management** | Al reflection memory | RLM state variables (.aiwg/rlm/state/) |
| **Completion Signal** | Completion criteria string match | `Final` variable set in RLM state |

### Configuration Options

```yaml
rlm_strategy_config:
  max_depth: 5                    # Maximum recursion depth
  max_sub_calls: 20               # Maximum sub-agents per iteration
  sub_model: "sonnet"             # Model for sub-agents (default: same as parent)
  parallel_sub_calls: true        # Allow parallel Task execution
  budget_tokens: 500000           # Token budget across entire task tree
  intermediate_dir: ".aiwg/rlm/tasks/{task-id}/intermediate/"
  state_dir: ".aiwg/rlm/tasks/{task-id}/state/"
  completion_artifact: "final-result.md"
```

### Command-Line Override

```bash
# Override max depth
ralph "Analyze codebase" --strategy rlm --max-depth 3

# Override sub-call limit
ralph "Batch process files" --strategy rlm --max-sub-calls 50

# Override token budget
ralph "Large corpus analysis" --strategy rlm --budget-tokens 1000000

# Combine overrides
ralph "Complex task" --strategy rlm --max-depth 4 --max-sub-calls 30 --sub-model haiku
```

## Auto-Detection Heuristics

Al automatically suggests RLM mode when it detects long-context patterns.

### Detection Triggers

| Pattern | Example | Confidence | Action |
|---------|---------|------------|--------|
| **Batch keywords** | "all files", "entire codebase", "every module" | High (0.9) | Auto-activate RLM |
| **Large file count** | Task targets >50 files | High (0.85) | Auto-activate RLM |
| **Estimated tokens** | Context >100K tokens | High (0.9) | Auto-activate RLM |
| **Corpus mention** | "all papers", "research corpus" | Medium (0.7) | Suggest RLM |
| **Fan-out pattern** | "for each X, do Y" | Medium (0.65) | Suggest RLM |
| **Recursive keywords** | "recursively", "all subdirectories" | Medium (0.6) | Suggest RLM |

### Detection Algorithm

```python
def should_use_rlm(task: str, context_files: List[str]) -> Tuple[bool, float]:
    """
    Returns: (should_use, confidence)
    """
    confidence = 0.0

    # Keyword analysis
    batch_keywords = ["all files", "entire", "every", "across all"]
    if any(kw in task.lower() for kw in batch_keywords):
        confidence += 0.4

    # File count analysis
    if len(context_files) > 50:
        confidence += 0.3
    elif len(context_files) > 20:
        confidence += 0.15

    # Token estimation
    estimated_tokens = estimate_token_count(context_files)
    if estimated_tokens > 100000:
        confidence += 0.3
    elif estimated_tokens > 50000:
        confidence += 0.15

    # Corpus patterns
    corpus_keywords = ["corpus", "all papers", "all documents"]
    if any(kw in task.lower() for kw in corpus_keywords):
        confidence += 0.2

    # Fan-out patterns
    if "for each" in task.lower() or "map" in task.lower():
        confidence += 0.1

    # Decision thresholds
    if confidence >= 0.8:
        return (True, confidence)  # Auto-activate
    elif confidence >= 0.5:
        return (False, confidence)  # Suggest
    else:
        return (False, confidence)  # Don't use RLM
```

### User Experience

**Auto-activation (confidence ≥ 0.8)**:
```bash
$ ralph "Analyze security of all 500 source files" --completion "report ready"

→ Detected long-context task (confidence: 0.90)
→ Auto-activating RLM strategy for optimal performance
→ Override with --no-rlm if you prefer standard processing

[Agent loop begins with RLM agent]
```

**Suggestion (0.5 ≤ confidence < 0.8)**:
```bash
$ ralph "Find API key leaks across the repository" --completion "results saved"

⚠️  This task might benefit from RLM strategy (confidence: 0.65)
   Reason: Batch pattern detected, multiple files expected

   Continue with standard processing? [Y/n]
   Or use RLM: ralph "..." --strategy rlm
```

**No suggestion (confidence < 0.5)**:
```bash
$ ralph "Fix the bug in src/auth.ts" --completion "tests pass"

[Standard Al processing, no RLM suggestion]
```

## Checkpoint Integration

RLM state seamlessly integrates with Al's checkpoint system.

### RLM State as Al Checkpoints

RLM maintains explicit state variables that map to Al checkpoints:

```yaml
# Al checkpoint structure
ralph_checkpoint:
  iteration: 5
  thought: "Delegating per-file analysis"
  action: "Task(analyze_file_1)"
  observation: "..."
  rlm_state:
    state_id: "state-a1b2c3d4"
    tree_id: "tree-87654321"
    variables:
      Final: null
      prompt: "Analyze all source files"
      files_analyzed: 12
      files_remaining: 38
    checkpoints:
      - checkpoint_id: "ckpt-iteration-5"
        snapshot_path: ".aiwg/rlm/checkpoints/ckpt-a1b2c3d4.json"
```

### On Agent Loop Crash

Al's crash recovery protocol with RLM:

```
1. Al detects crash (unhandled exception, timeout, OOM)
2. Al loads last checkpoint
3. Al detects RLM state reference in checkpoint
4. Al restores RLM state from `.aiwg/rlm/states/{state_id}/state.json`
5. Al resumes with RLM agent at last known state
6. RLM agent reads state variables, sees partial progress
7. RLM continues from where it left off (no re-work)
```

**Example Recovery**:

```bash
# Original run
$ ralph "Analyze 100 papers" --strategy rlm
→ Iteration 1-10: Analyzed 30 papers
→ Iteration 11: Started analyzing paper 31
→ CRASH (OOM)

# Resume
$ ralph --resume last
→ Loaded checkpoint from iteration 10
→ Restored RLM state (30 papers analyzed)
→ Resuming from paper 31
→ No duplicate work
```

### Partial Results Preserved

RLM writes intermediate results to files, not just memory:

```
.aiwg/rlm/tasks/task-{id}/
├── state/
│   └── state.json              # State variables (Final, files_analyzed, etc.)
├── intermediate/
│   ├── analysis-paper-001.md   # Preserved across crashes
│   ├── analysis-paper-002.md
│   └── ...
├── checkpoints/
│   ├── ckpt-iteration-5.json
│   └── ckpt-iteration-10.json
└── final-result.md             # Only written on completion
```

**On crash**: All intermediate files remain on disk. On resume, RLM reads these files instead of re-analyzing.

### State Variable Restoration

```yaml
# Before crash (iteration 10)
rlm_state:
  variables:
    Final: null
    papers_analyzed: 30
    papers_remaining: 70
    current_batch: [31, 32, 33, 34, 35]
    results_so_far: "file:.aiwg/rlm/intermediate/aggregated-results.json"

# After crash recovery
rlm_state:
  variables:
    Final: null
    papers_analyzed: 30          # Restored
    papers_remaining: 70         # Restored
    current_batch: [31, 32, 33, 34, 35]  # Restored
    results_so_far: "file:.aiwg/rlm/intermediate/aggregated-results.json"  # File still exists
```

### Checkpoint Frequency

```yaml
checkpoint_policy:
  # Al creates checkpoints every N iterations
  standard_frequency: 5

  # RLM creates internal checkpoints on state changes
  rlm_internal_checkpoints:
    - before_sub_agent_spawn
    - after_batch_completion
    - on_state_variable_update

  # Combined: Al checkpoints include RLM state snapshots
  combined_checkpoint_trigger:
    - every_5_ralph_iterations
    - every_rlm_internal_checkpoint
    - on_ralph_loop_boundary
```

## RLM State Variables → Al Reflection Memory

Mapping between RLM and agent loop state systems:

| RLM State Variable | Al Reflection Memory | Purpose |
|-------------------|------------------------|---------|
| `Final` | Completion signal | Both: indicates task done |
| `prompt` | Original task | Both: preserve original request |
| `{custom_vars}` | Reflection entries | Both: intermediate findings |
| `state[files_analyzed]` | Progress counter | Track work completed |
| `state[errors]` | Failure log | Debug failed sub-calls |
| `state[cost_so_far]` | Cost tracking | Monitor budget usage |

### Cross-System Access

```yaml
# RLM agent can read Al reflection memory
rlm_access_to_ralph:
  - "Read reflection memory to avoid duplicate work"
  - "Check if similar task was attempted before"
  - "Learn from past failures"

# Al can read RLM state variables
ralph_access_to_rlm:
  - "Check RLM completion status (Final variable)"
  - "Monitor RLM progress (custom variables)"
  - "Incorporate RLM results into reflection"
```

### Example Integration

```yaml
# Al iteration 15
ralph_reflection:
  iteration: 15
  thought: "RLM agent has analyzed 50/100 papers"
  rlm_state_snapshot:
    papers_analyzed: 50
    cost_so_far_usd: 2.35
    current_quality_score: 0.87
  decision: "Continue RLM processing, quality is good"

# RLM uses reflection
rlm_state:
  variables:
    Final: null
    papers_analyzed: 50
    ralph_reflection_note: "Al confirms quality is good, continue"
```

## Combined Workflow Patterns

### Al Outer + RLM Inner

**Pattern**: Al orchestrates high-level flow, RLM handles context-heavy steps.

```yaml
workflow:
  phase_1_requirements:
    agent: requirements-analyst
    strategy: standard

  phase_2_architecture:
    agent: rlm-agent
    strategy: rlm
    reason: "Need to analyze all existing APIs for consistency"

  phase_3_implementation:
    agent: software-implementer
    strategy: standard

  phase_4_testing:
    agent: rlm-agent
    strategy: rlm
    reason: "Need to analyze all code paths for test coverage"
```

### When to Use Each Approach

| Scenario | Use Al Alone | Use RLM Alone | Use Al + RLM |
|----------|----------------|---------------|-----------------|
| **Single focused task** | ✓ | | |
| **Iterative refinement** | ✓ | | |
| **Large file analysis** | | ✓ | |
| **Multi-file search** | | ✓ | |
| **Multi-phase workflow with large-context steps** | | | ✓ |
| **Long-running corpus analysis** | | ✓ | |
| **Interactive debugging** | ✓ | | |
| **Batch processing** | | ✓ | |

### Decision Matrix

```
┌─────────────────────────────────────────────────────────────┐
│                  Task Characteristics                       │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Context Size        Iteration Need       Decomposition    │
│                                                             │
│   Small (<10K)          High         →    Al Alone      │
│   Small (<10K)          Low          →    Direct Agent     │
│   Large (>100K)         Low          →    RLM Alone        │
│   Large (>100K)         High         →    Al + RLM      │
│   Medium (10-100K)      High         →    Al (w/ RLM?)  │
│   Medium (10-100K)      Low          →    RLM or Al     │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Configuration Examples

### Basic Al + RLM

```yaml
# .aiwg/ralph-config.yml
ralph:
  max_iterations: 50
  completion_criteria: "analysis complete"
  strategy: rlm

rlm:
  max_depth: 3
  max_sub_calls: 20
  budget_tokens: 500000
```

### Advanced Al + RLM

```yaml
# .aiwg/ralph-config.yml
ralph:
  max_iterations: 100
  completion_criteria: "all files analyzed AND report generated"
  strategy: rlm
  checkpoint_frequency: 5
  enable_reflection_memory: true

rlm:
  max_depth: 5
  max_sub_calls: 50
  budget_tokens: 1000000
  parallel_sub_calls: true
  chunk_strategy: "by_structure"  # auto | by_function | by_section
  cache_intermediate: true
  cost_tracking: true
  intermediate_dir: ".aiwg/rlm/tasks/{task-id}/intermediate/"
  state_dir: ".aiwg/rlm/tasks/{task-id}/state/"

  # Sub-agent configuration
  sub_agent_config:
    model: "sonnet"
    temperature: 0.7
    timeout_ms: 300000

  # Checkpoint configuration
  checkpoint_policy:
    create_on_state_change: true
    create_on_sub_call_complete: true
    retention_count: 10
```

### Completion Criteria with RLM

```yaml
# Standard agent loop completion
ralph:
  completion_criteria: "tests pass"

# RLM-specific completion (Final variable)
ralph:
  strategy: rlm
  completion_criteria:
    type: rlm_final_set
    expected_pattern: "Analysis complete.*"
    timeout_iterations: 50

# Hybrid completion (both must be true)
ralph:
  strategy: rlm
  completion_criteria:
    - rlm_final_set: true
    - output_file_exists: ".aiwg/rlm/final-result.md"
    - ralph_criteria: "report generated"
```

## Example Workflows

### Workflow 1: Codebase Security Analysis (Auto-Detect)

**Command**:
```bash
ralph "Analyze security of entire codebase" --completion "security report ready"
```

**Auto-Detection**:
```
→ Detected: "entire codebase" (batch keyword)
→ File count: 487 files
→ Estimated tokens: 850K
→ Confidence: 0.95
→ AUTO-ACTIVATING RLM strategy
```

**Execution**:
```yaml
# Al Iteration 1
thought: "Need to discover all source files"
action: RLM.discover_files()
observation: "Found 487 .ts/.js files"
rlm_state:
  files_discovered: 487

# Al Iteration 2-10
thought: "RLM is analyzing files in batches"
action: RLM.batch_analyze(batch_size=50)
observation: "Batch 1/10 complete (50 files analyzed)"
rlm_state:
  files_analyzed: 50
  security_issues_found: 12

# Al Iteration 11-50
[RLM continues batch processing]

# Al Iteration 51
thought: "RLM has completed analysis"
action: RLM.finalize_report()
observation: "Security report written"
rlm_state:
  Final: "Security analysis complete. 47 issues found."
completion: "security report ready" → MATCHES
```

### Workflow 2: Refactor All Tests (Explicit --strategy rlm)

**Command**:
```bash
ralph "Refactor all test files to use new pattern" --strategy rlm --completion "all tests pass"
```

**Execution**:
```yaml
# Al Iteration 1
thought: "Using explicit RLM strategy"
action: RLM.discover_test_files()
observation: "Found 123 test files"
rlm_state:
  test_files: 123

# Al Iteration 2
thought: "Create refactoring plan"
action: RLM.analyze_current_pattern()
observation: "Current pattern identified"
rlm_state:
  current_pattern: "describe/it blocks"
  target_pattern: "test/expect blocks"

# Al Iteration 3-20
thought: "Delegate per-file refactoring"
action: RLM.spawn_refactor_agents(parallel=true)
observation: "Spawned 123 sub-agents"
rlm_state:
  refactorings_complete: 0/123

# Al Iteration 21-70
[RLM sub-agents complete refactoring]
rlm_state:
  refactorings_complete: 123/123

# Al Iteration 71
thought: "All refactorings complete, run tests"
action: Bash("npm test")
observation: "All tests pass"
rlm_state:
  Final: "Refactoring complete. All 123 files updated."
completion: "all tests pass" → MATCHES
```

### Workflow 3: Multi-Repo API Key Search (rlm-batch)

**Command**:
```bash
ralph "Search for API key leaks across all 5 repositories" --strategy rlm --completion "report saved"
```

**Execution**:
```yaml
# Al Iteration 1
thought: "RLM strategy for multi-repo search"
action: RLM.discover_repos()
observation: "Found 5 repos"
rlm_state:
  repos: ["repo1", "repo2", "repo3", "repo4", "repo5"]

# Al Iteration 2
thought: "Spawn parallel search per repo"
action: RLM.spawn_repo_searches(parallel=true)
observation: "5 sub-agents spawned"
rlm_state:
  searches_complete: 0/5

# Al Iteration 3-8
[Sub-agents search in parallel]
sub_agent_1: "repo1: 0 API keys found"
sub_agent_2: "repo2: 3 API keys found"
sub_agent_3: "repo3: 0 API keys found"
sub_agent_4: "repo4: 1 API key found"
sub_agent_5: "repo5: 0 API keys found"
rlm_state:
  searches_complete: 5/5
  total_keys_found: 4

# Al Iteration 9
thought: "Aggregate results"
action: RLM.generate_report()
observation: "Report written to .aiwg/rlm/api-key-leaks-report.md"
rlm_state:
  Final: "Search complete. 4 API keys found across 2 repos."
completion: "report saved" → MATCHES
```

## Workflow Visualization

### Ralph-Only Workflow

```
User Task
    ↓
┌───────────────────┐
│  Agent Loop       │
│                   │
│  Iteration 1-N:   │
│  - Think          │
│  - Act            │
│  - Observe        │
│  - Reflect        │
│                   │
│  Completion:      │
│  - Criteria met   │
└───────────────────┘
    ↓
Output
```

### RLM-Only Workflow

```
User Task
    ↓
┌────────────────────────────────────────┐
│  RLM Agent                             │
│                                        │
│  1. Discover context (Grep/Glob)      │
│  2. Decompose into sub-tasks          │
│  3. Spawn sub-agents (recursive)      │
│  4. Aggregate results                 │
│  5. Set Final variable                │
│                                        │
│  Completion:                           │
│  - Final != null                       │
└────────────────────────────────────────┘
    ↓
Output
```

### Al + RLM Workflow

```
User Task
    ↓
┌──────────────────────────────────────────────────────────┐
│  Agent Loop (Outer)                                      │
│                                                          │
│  Iteration 1:                                            │
│  - Thought: "This needs RLM strategy"                    │
│  - Action: Initialize RLM agent                          │
│  - Observation: RLM agent ready                          │
│                                                          │
│  Iteration 2-N:                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │  RLM Agent (Inner)                               │   │
│  │                                                  │   │
│  │  RLM Step 1: Discover context                   │   │
│  │  RLM Step 2: Decompose                          │   │
│  │  RLM Step 3: Spawn sub-agents                   │   │
│  │     ├── Sub-agent 1 (depth 1)                   │   │
│  │     ├── Sub-agent 2 (depth 1)                   │   │
│  │     └── Sub-agent N (depth 1)                   │   │
│  │  RLM Step 4: Aggregate                          │   │
│  │  RLM Step 5: Set Final                          │   │
│  └──────────────────────────────────────────────────┘   │
│  - Observation: RLM Final set, results ready             │
│                                                          │
│  Iteration N+1:                                          │
│  - Thought: "RLM complete, verify results"               │
│  - Action: Check completion criteria                     │
│  - Observation: Criteria met                             │
│                                                          │
│  Completion:                                             │
│  - Al criteria AND RLM Final set                      │
└──────────────────────────────────────────────────────────┘
    ↓
Output
```

## Cost Model

Based on REF-089 research:

| Metric | Ralph-Only | RLM-Only | Al + RLM |
|--------|-----------|----------|-------------|
| **Median cost** | 1.0x | 0.8-1.2x | 0.9-1.3x |
| **Best case** | 1.0x | 0.3x (sparse access) | 0.4x |
| **Worst case** | 3.0x (context overflow) | 3.0x (bad decomposition) | 3.5x |
| **Cost variance** | Low | Moderate | Moderate |

**When Al + RLM is cheaper**:
- Long contexts (>100K tokens)
- Sparse access patterns (only need 10% of context)
- Parallelizable sub-problems
- Good decomposition (RLM agent understands structure)

**When Al + RLM is more expensive**:
- Short contexts (<10K tokens) — overhead not justified
- Dense access patterns (need 90%+ of context)
- Sequential dependencies (can't parallelize)
- Poor decomposition (RLM creates too many sub-calls)

## Integration Points

### With Agent Supervisor

Agent Supervisor routes tasks to RLM-enabled Al:

```yaml
agent_supervisor_routing:
  rules:
    - condition: "task mentions 'all files' OR file_count > 50"
      route_to: ralph_with_rlm
      strategy: rlm

    - condition: "task is focused AND context < 10K tokens"
      route_to: ralph_standard
      strategy: standard
```

### With Cost Tracking

```yaml
cost_tracking:
  ralph_level:
    - total_iterations
    - total_duration
    - total_tokens

  rlm_level:
    - sub_calls_count
    - tree_depth
    - parallel_efficiency
    - per_node_cost

  combined_report:
    - ralph_overhead: "Al coordination cost"
    - rlm_decomposition_cost: "RLM planning cost"
    - rlm_execution_cost: "RLM sub-agent cost"
    - total_cost: sum(ralph + rlm)
    - cost_vs_baseline: comparison to direct processing
```

### With Reflection Memory

```yaml
reflection_memory_integration:
  # Al writes RLM state to reflection
  on_rlm_checkpoint:
    - capture_rlm_state_snapshot
    - write_to_ralph_reflection
    - tag: "rlm_state"

  # RLM reads past attempts from reflection
  on_rlm_init:
    - load_ralph_reflection_memory
    - check_for_similar_past_tasks
    - reuse_decomposition_if_applicable
```

## Best Practices

### When to Use --strategy rlm

✅ **Use RLM when**:
- Task involves >20 files or >50K tokens
- Task contains batch keywords ("all", "entire", "every")
- Need to preserve information fidelity (lossless)
- Sub-problems are parallelizable
- Cost efficiency matters

❌ **Don't use RLM when**:
- Task is focused on 1-3 files
- Context is <10K tokens
- Summarization is acceptable (lossy is OK)
- Real-time constraints (RLM adds latency)
- No clear decomposition strategy

### Effective Decomposition

```yaml
good_decomposition:
  - "Analyze each file independently"
  - "Search all repos, aggregate results"
  - "Per-module security review"
  - "Batch process documents"

poor_decomposition:
  - "Understand the entire system" (too vague)
  - "Find all bugs" (no clear sub-structure)
  - "Improve code quality" (subjective, hard to parallelize)
```

### Monitoring RLM Progress

```bash
# Check RLM state during execution
ralph-status --show-rlm-state

# Output:
# Al Iteration: 25/50
# RLM State:
#   - Files analyzed: 120/487
#   - Current depth: 2
#   - Sub-calls active: 8
#   - Cost so far: $3.42
#   - Estimated completion: 15 iterations
```

## Troubleshooting

### RLM Not Activating

**Problem**: Al doesn't use RLM even though task is long-context.

**Solutions**:
```bash
# Explicit activation
ralph "task" --strategy rlm

# Check detection confidence
ralph "task" --debug-strategy
# Shows: "RLM confidence: 0.45 (below threshold 0.5)"

# Lower threshold (if needed)
export AIWG_RLM_THRESHOLD=0.4
ralph "task"  # Now activates if confidence > 0.4
```

### RLM Creating Too Many Sub-Calls

**Problem**: RLM spawns 100+ sub-agents, costs spike.

**Solutions**:
```bash
# Limit sub-calls
ralph "task" --strategy rlm --max-sub-calls 20

# Increase chunk size (fewer sub-calls)
ralph "task" --strategy rlm --chunk-size 2000

# Use coarser decomposition
ralph "task" --strategy rlm --chunk-strategy by_module  # vs by_function
```

### RLM Recursion Too Deep

**Problem**: RLM creates depth-5 trees, loses context.

**Solutions**:
```bash
# Limit depth
ralph "task" --strategy rlm --max-depth 2

# Force flat decomposition
ralph "task" --strategy rlm --decomposition-strategy parallel
```

### Al + RLM Never Completes

**Problem**: Loop runs to max iterations without completion.

**Solutions**:
```bash
# Check RLM Final variable
ralph-status --show-rlm-state | grep Final
# If Final is null, RLM hasn't signaled completion

# Debug RLM state
cat .aiwg/rlm/tasks/{task-id}/state/state.json | jq '.variables.Final'

# Adjust completion criteria
ralph "task" --strategy rlm --completion "Final set AND output exists"
```

## References

- @$AIWG_ROOT/agentic/code/addons/rlm/agents/rlm-agent.md - RLM agent definition
- @$AIWG_ROOT/agentic/code/addons/rlm/schemas/rlm-task-tree.yaml - Task tree structure
- @$AIWG_ROOT/agentic/code/addons/rlm/schemas/rlm-state.yaml - State management
- @$AIWG_ROOT/agentic/code/addons/agent-loop/agents/ralph-loop.md - Agent loop implementation
- @.aiwg/research/findings/REF-089-recursive-language-models.md - Research foundation
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/tao-loop.md - TAO loop standardization
- @$AIWG_ROOT/tools/daemon/agent-supervisor.mjs - Task routing
- Issue #329 - Ralph-RLM integration epic

---

**Status**: Active
**Last Updated**: 2026-02-09
