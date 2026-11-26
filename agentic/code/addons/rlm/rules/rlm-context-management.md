---
activation: bound
summary: "Filter and read large context selectively; bound recursive calls by budget and concurrency caps, reconcile findings, and checkpoint long-running RLM work."
bound_to:
  skills:
    - chunk
    - fanout
    - rlm-batch
    - rlm-mode
    - rlm-prep
    - rlm-query
    - rlm-search
    - rlm-status
  agents:
    - rlm-agent
enforcement: high
---

# RLM Context Management Rules

**Enforcement Level**: HIGH
**Scope**: All agents operating on large codebases or document corpora
**Addon**: rlm (Recursive Language Model patterns)
**Research Basis**: REF-089 (RLM, Zhang et al. 2026, GRADE LOW), REF-086 (scaling agent systems, DeepMind 2025, LOW), REF-088 (Wexford 2026, VERY LOW), REF-127 (Zylos 2026, VERY LOW), REF-169 (Evans et al. 2026, MODERATE)
**Issue**: #322

## Overview

Treat large context as an external environment accessed programmatically (Grep, targeted Read, sub-agents) rather than loaded wholesale into the conversation window. REF-089: this is up to 3× cheaper than summarization while preserving stronger performance, because the agent selectively views context instead of compacting (compaction loses early details needed for dense tasks). The failure modes these rules prevent: context overflow/truncation, quality loss from compaction, token waste on irrelevant content, and inability to handle corpora larger than the window.

## Mandatory Rules

### Rule 1: Symbolic Handles Over Raw Text
Reference large files by symbolic handle (path) and read only the needed sections, rather than loading full content. **FORBIDDEN**: "read all 47 files in src/auth/ into context" (overflow → compaction → lost detail). **REQUIRED**: Grep for the pattern, identify the relevant functions, Read only those line ranges — full detail preserved at <10% window.

### Rule 2: Programmatic Access Over Full-Context Loading
Before loading a large file, filter with code (Grep, line-range Read). **FORBIDDEN**: read an entire 3,000-line file to find validation functions. **REQUIRED**: `grep -n` for matches, then Read only those sections. Emergent strategies (REF-089 §4.1): chunk by structure (headers/function/class boundaries), keyword-filter before reading, aggregate incrementally, and use domain priors to narrow the search space.

### Rule 3: Recursive Sub-Calls for Dense Tasks
When information is distributed across many files, delegate to parallel sub-agents (Task tool) that each Grep + read narrowly and return summaries — don't load everything into one context. Use sub-calls by file count:

| Files | Sub-calls? |
|-------|-----------|
| 1 | No — line-range Read suffices |
| 2–5 | Maybe (depends on size) |
| 6–20 | Yes |
| >20 or cross-cutting | Definitely |

### Rule 4: Cost-Aware Sub-Call Management
Track sub-call count and estimated token cost; filter before fanning out so you don't exhaust budget on preliminary analysis. **FORBIDDEN**: spawn 100 sub-agents (500k tokens) before any implementation. **REQUIRED**: estimate scope, check budget, Grep-filter to the critical files first, then dispatch. Cost thresholds: <30% safe; 30–50% monitor; 50–70% filter more before sub-calls; >70% go highly targeted or escalate; >90% abort and request guidance.

### Rule 5: Emergent Decomposition Patterns
Apply the strategies RLMs use naturally: **structural chunking** (read the ToC, then only relevant sections), **keyword filtering** (Grep `@Entity`, then narrow by field, then read the few matches), **incremental aggregation** (process in batches, write intermediate results to `.aiwg/working/*.json` as REPL variables, synthesize from the compact batch files), and **model priors** (search likely locations — `src/auth/`, `src/middleware/`, `*auth*`/`*login*` — before scanning everything).

### Rule 6: RLM Is Centralized Coordination — Aggregate, Don't Bag-of-Agents
RLM is centralized by design (root dispatches sub-agents and aggregates their output) → REF-086's 4.4× error bucket, not 17.2×. But parallel `rlm-batch` fan-out degrades into "bag of agents" if results are silently concatenated. **FORBIDDEN**: concatenate 5 sub-agent findings and call it a report. **REQUIRED**: reconcile conflicts, flag contradictions, synthesize with provenance into a single integrated result. The `--aggregate` strategy is the reconciliation layer; `concat` is acceptable only when outputs are provably independent (one file each, no cross-cutting concerns).

### Rule 7: Don't Use RLM When a Single Agent Already Works
RLM helps where a single agent struggles (long context, distributed info, multi-file synthesis); it adds pure overhead for focused queries and single-file analysis. **Decision threshold**: if a single Read+Grep resolves the task in <50% context, do not escalate to RLM. **Sequential-dependency warning**: if each step needs the prior step's answer, use one agent — splitting loses the chain. (REF-086: multi-agent returns go negative once the single-agent baseline exceeds ~45%.)

### Rule 8: Concurrent Sub-Agent Cap — 3–7 Sweet Spot, Hard Cap 7
Concurrent sub-agents per RLM dispatch: 1–2 trivial, **3–5 optimal**, 5–7 peak for complex tasks, 8+ coordination overhead dominates (auto-batch into waves of ≤7). `rlm-batch` default `--max-parallel=4`. **Hard cap: never >7** from one dispatch. Composes with the context-budget tier cap and the provider parallelism cap (#1359) — the effective limit is the **minimum** of all:

```
effective_rlm_parallel = min(
  parallelism.max_parallel_subagents,   // provider rate-limit cap
  context_budget_tier_cap,              // from AIWG_CONTEXT_WINDOW
  7                                     // RLM hard cap (this rule)
)
```

See `@$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/context-budget.md` and `subagent-scoping.md` Rule 8.

### Rule 9: Long-Running RLM Operations Must Checkpoint
For any RLM run expected to exceed ~30 min wall-clock (REF-127, VERY LOW — treat as a warning, not a precise ceiling): externalize state to `.aiwg/working/rlm-runs/{id}/` at intervals; make it resumable from the last checkpoint (not from scratch); prefer split-into-loops (`aiwg ralph`-style iterations with persistent state) over one long run; surface an elapsed-time warning at ~25 min.

### Rule 10: Coding-Capable Models for the RLM Root
RLM relies on the root emitting code (regex/glob/REPL) to filter context. Use a coding-capable standard tier for the root; premium requires evidence and authorization. Apply `subagent-scoping` Rule 4a (“Delegate by default”) for mode, keep-local exits and cheapest-capable workers: bounded extraction → economy, analysis/synthesis → standard, high-consequence reasoning → premium. Never inherit a flagship session tier. Models with output limits <4k require a warning before dispatch. Prefer independent `rlm-batch` work over serial query chains only within Rule 8’s minimum of caps.

## Detection

Signs of missing RLM patterns → mitigation: window repeatedly at 90%+ → symbolic handles + programmatic access; compaction losing detail → Grep-filter before loading; "cannot process all files" → recursive sub-calls; high analysis cost → keyword-filter first; superficial multi-file analysis → parallel sub-agents; repeated re-reading → intermediate files as REPL variables. Warning thresholds before overload: >10 files, >5,000 lines, >50% window estimate, high detail throughout, or cross-cutting logic.

## Checklist

Before processing large context: estimated direct-load tokens (>50% window?); Grep-filtered before loading; line-ranged Reads; symbolic handles kept; considered sub-calls (>10 files); budget allocated; intermediate results to files if iterative; cost tracking on. Before spawning sub-agents: task needs distributed access (>5 files); estimated cost <70% budget; each sub-task clearly scoped (per subagent-scoping); aggregation strategy defined; parent receives summaries, not raw content.

## References

- @.aiwg/research/findings/REF-089-recursive-language-models.md
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/research-before-decision.md
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/subagent-scoping.md
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/tao-loop.md
- @$AIWG_ROOT/tools/ralph-external/ — agent loop implementation

---

**Rule Status**: ACTIVE
**Last Updated**: 2026-05-08
**Issue**: #322; #1196, #1197, #1198, #1199
