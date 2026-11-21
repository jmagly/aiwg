---
enforcement: medium
activation: bound
summary: Check AIWG_CONTEXT_WINDOW and provider caps before dispatch; use the smallest applicable cap and batch work within the available context budget.
bound_to:
  skills:
    - agent-loop
    - agent-loop-ext
    - aiwg-mission
    - artifact-orchestration
    - chunk
    - fanout
    - flow-architecture-evolution
    - flow-change-control
    - flow-compliance-validation
    - flow-concept-to-inception
    - flow-construction-to-transition
    - flow-cross-team-sync
    - flow-delivery-track
    - flow-deploy-to-production
    - flow-discovery-track
    - flow-elaboration-to-construction
    - flow-gate-check
    - flow-guided-implementation
    - flow-handoff-checklist
    - flow-hypercare-monitoring
    - flow-inception-to-elaboration
    - flow-incident-response
    - flow-iteration-dual-track
    - flow-knowledge-transfer
    - flow-performance-optimization
    - flow-release
    - flow-requirements-evolution
    - flow-retrospective-cycle
    - flow-risk-management-cycle
    - flow-security-review-cycle
    - flow-team-onboarding
    - flow-test-strategy-execution
    - mission-control
    - orchestrate-project
    - parallel-dispatch
    - ralph
    - ralph-external
    - ralph-resume
    - rlm-batch
    - rlm-mode
    - rlm-prep
    - rlm-query
    - rlm-search
    - rlm-status
  agents:
    - aiwg-orchestrator
    - executive-orchestrator
    - recovery-orchestrator
    - rlm-agent
    - ralph-loop
    - ralph-verifier
    - consortium-coordinator
  flows:
    - flow-agentloop-lfd-controls
    - flow-architecture-evolution
    - flow-change-control
    - flow-compliance-validation
    - flow-concept-to-inception
    - flow-construction-to-transition
    - flow-cross-team-sync
    - flow-delivery-track
    - flow-deploy-to-production
    - flow-discovery-track
    - flow-elaboration-to-construction
    - flow-gate-check
    - flow-guided-implementation
    - flow-handoff-checklist
    - flow-hypercare-monitoring
    - flow-inception-to-elaboration
    - flow-incident-response
    - flow-iteration-dual-track
    - flow-knowledge-transfer
    - flow-performance-optimization
    - flow-release
    - flow-requirements-evolution
    - flow-retrospective-cycle
    - flow-risk-management-cycle
    - flow-security-review-cycle
    - flow-team-onboarding
    - flow-test-strategy-execution
---

# Context Window Budget Rules

**Enforcement Level**: MEDIUM
**Scope**: All parallel subagent spawning and task scheduling
**Addon**: aiwg-utils (core, universal)

## Overview

When `AIWG_CONTEXT_WINDOW` is set in CLAUDE.md (or equivalent platform context file), agents MUST respect the declared context budget when deciding how many parallel subagents to spawn and how aggressively to compact context.

This directive is **opt-in**. When unset, behavior is unchanged and the platform decides parallelism limits. When set, it provides guidance for systems with smaller context windows (e.g., local GPU inference with 100k-256k context) where unconstrained parallel spawning causes client crashes.

## How to Configure

Users add the following directive to their CLAUDE.md team directives section (or equivalent for their platform):

```markdown
<!-- AIWG_CONTEXT_WINDOW: 100000 -->
```

The value is the total context window size in tokens. Common values:

| System | Typical Context Window |
|--------|----------------------|
| Local GPU (small) | 32,000-64,000 |
| Local GPU (medium) | 100,000-128,000 |
| Local GPU (large) | 200,000-256,000 |
| Cloud API (standard) | 200,000-500,000 |
| Anthropic cloud | 1,000,000+ |

## Mandatory Rules

### Rule 1: Check for AIWG_CONTEXT_WINDOW Before Parallel Spawning

Before spawning multiple subagents in parallel, check whether `AIWG_CONTEXT_WINDOW` is declared in the project's context file.

**If unset**: No change to default behavior. Spawn as many parallel subagents as the task decomposition requires.

**If set**: Use the lookup table below to determine the maximum number of concurrent parallel subagents.

### Rule 2: Parallel Subagent Limits

When `AIWG_CONTEXT_WINDOW` is set, respect these limits:

| Context Window | Max Parallel Subagents | Compaction Behavior |
|----------------|----------------------|---------------------|
| Unset (default) | No limit (platform decides) | Normal |
| ≤64k | 1-2 | Aggressive — prefer sequential |
| 65k-128k | 2-4 | Moderate — batch in groups of 2-3 |
| 129k-256k | 4-8 | Standard |
| 257k-512k | 8-12 | Relaxed |
| >512k | 12-20 | Normal (cloud default) |

**Formula**: `max_parallel = max(1, floor(context_window / 50000))` capped at 20.

**Important**: This limits how many subagents run *concurrently*, not the total number of subagents an orchestrator can spawn. If a task decomposes into 20 atomic subtasks but the budget allows only 3 parallel, run them in waves of 3.

### Rule 3: Prefer Sequential Batching When Budget Is Tight

When context budget is ≤128k tokens:

**FORBIDDEN**:
```
Task decomposes into 10 subtasks.
Spawn all 10 subagents simultaneously.
→ Client crashes or context overflow
```

**REQUIRED**:
```
Task decomposes into 10 subtasks.
Context budget allows 2-3 parallel.

Wave 1: Subagents 1, 2, 3 (parallel)
  → Wait for completion
Wave 2: Subagents 4, 5, 6 (parallel)
  → Wait for completion
Wave 3: Subagents 7, 8, 9 (parallel)
  → Wait for completion
Wave 4: Subagent 10
  → Done
```

### Rule 4: Keep Individual Subagent Tasks Smaller Under Tight Budgets

When context budget is constrained, each subagent should produce less output to avoid accumulating too much context in the parent agent's window.

| Context Window | Target Output Per Subagent |
|----------------|--------------------------|
| ≤64k | <3k tokens |
| 65k-128k | <5k tokens |
| 129k-256k | <10k tokens |
| >256k | Normal (no specific limit) |

### Rule 5: This Is Guidance, Not Programmatic Enforcement

These rules operate at the prompt/convention level. There is no runtime system that enforces them. Agents are expected to read the directive and adjust their behavior accordingly. The rules provide clear lookup tables so the agent can make the right decision without complex reasoning.

### Rule 6: Compose with Provider Parallelism Cap (#1359)

`.aiwg/aiwg.config` may declare a `parallelism.max_parallel_subagents` cap that reflects the model provider's rate-limit envelope (Anthropic per-key TPM/RPM caps in particular). When both `AIWG_CONTEXT_WINDOW` and the provider cap are set, the **smaller** wins:

```
effective_parallel = min(
  context_window_tier_cap,            // from this rule's table
  parallelism.max_parallel_subagents  // from aiwg.config (#1359)
)
```

For example, a Claude small-plan project with `AIWG_CONTEXT_WINDOW=512000` (which this rule would allow up to 12 parallel) and `parallelism.max_parallel_subagents=4` is capped at 4. The rate-limit cap wins because exceeding it produces 429s regardless of how much context fits. See `@$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/subagent-scoping.md` Rule 8 for the full composition formula across all four cap sources.

## Compaction Guidance

### Aggressive Compaction (≤64k)

- Run subagents sequentially or in pairs
- Summarize subagent results before spawning the next batch
- Prefer returning concise structured data (JSON, tables) over prose
- Each subagent task should be self-contained with minimal context

### Moderate Compaction (65k-128k)

- Batch subagents in groups of 2-3
- Wait for each batch to complete before starting the next
- Keep subagent output focused — specify word/token limits in the task description
- Summarize intermediate results when aggregating across batches

### Standard Operation (129k-256k)

- Parallel fan-out up to 4-8 subagents
- Normal output expectations
- Standard context management

### Relaxed/Normal (>256k)

- Full parallel fan-out as task decomposition dictates
- No special compaction needed
- Standard behavior as if directive is unset

## Integration

### With Subagent Scoping Rules

This rule extends `@$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/subagent-scoping.md` Rule 7 (Context Budget Estimation). When `AIWG_CONTEXT_WINDOW` is set, the context budget formula uses the declared value instead of assuming a default window size.

### With Agent Loops

Agent loops that spawn parallel subagents (e.g., via `rlm-batch` or `parallel-dispatch`) should batch subagent waves according to the context budget table. An agent loop on a 100k system should run 2-3 subagents per wave, not 10.

### With Orchestrator Fan-Out

Orchestrator patterns that decompose tickets into N subtasks should cap concurrent fan-out to the budget limit. All N subtasks still execute — just in sequential waves rather than all at once.

## Examples

### Example 1: Local GPU System (100k Context)

```markdown
<!-- In CLAUDE.md team directives -->
<!-- AIWG_CONTEXT_WINDOW: 100000 -->
```

Agent receives task requiring 8 parallel subagents:

```
Context budget: 100k → max_parallel = max(1, floor(100000/50000)) = 2
Compaction: Moderate

Wave 1: Subagents 1, 2 (parallel)
Wave 2: Subagents 3, 4 (parallel)
Wave 3: Subagents 5, 6 (parallel)
Wave 4: Subagents 7, 8 (parallel)

Each subagent targets <5k output tokens.
```

### Example 2: Cloud System (No Directive)

```markdown
<!-- No AIWG_CONTEXT_WINDOW set -->
```

Agent receives task requiring 8 parallel subagents:

```
No budget constraint. Spawn all 8 in parallel.
Normal output expectations.
```

### Example 3: Small Local Model (32k Context)

```markdown
<!-- AIWG_CONTEXT_WINDOW: 32000 -->
```

Agent receives task requiring 5 parallel subagents:

```
Context budget: 32k → max_parallel = max(1, floor(32000/50000)) = 1
Compaction: Aggressive — fully sequential

Run subagents 1 through 5 sequentially.
Each subagent targets <3k output tokens.
Summarize each result before proceeding to next.
```

## Platform Applicability

This directive works across all AIWG-supported platforms:

| Platform | Where to Set |
|----------|-------------|
| Claude Code | `CLAUDE.md` team directives |
| GitHub Copilot | `.github/copilot-instructions.md` |
| OpenAI Codex | `~/.codex/instructions.md` or `AGENTS.md` |
| Cursor | `.cursor/rules/` |
| Warp | `WARP.md` |
| Factory AI | `.factory/` context |
| OpenCode | `.opencode/` context |
| Devin Desktop | `AGENTS.md` or `.windsurf/rules/` |

The `aiwg use` and `aiwg regenerate` commands will include the directive (commented out) in generated context files when scaffolding new projects.

## Checklist

Before spawning parallel subagents:

- [ ] Check if `AIWG_CONTEXT_WINDOW` is declared in the project context
- [ ] If set, look up the max parallel count from the table
- [ ] If parallel count exceeds budget, batch into sequential waves
- [ ] Adjust subagent output expectations based on budget tier
- [ ] If unset, proceed with normal parallel behavior

## References

- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/subagent-scoping.md - Subagent scoping and delegation rules
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/subagent-scoping.md#rule-7 - Context budget estimation
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/instruction-comprehension.md - Understanding user constraints

---

**Rule Status**: ACTIVE
**Last Updated**: 2026-02-09
