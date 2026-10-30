# AIWG SDLC Rules Index

Rules owned by the sdlc-complete framework. Each entry provides a summary sufficient to determine relevance — load the full rule via @-link only when needed.

**How to use**: Scan summaries below. When a rule is relevant to your current task, load the full rule file for detailed enforcement instructions. Rules are grouped by tier and ordered by enforcement level (CRITICAL > HIGH > MEDIUM).

---

## ⚠ Discover-First Protocol (HIGH-priority pre-flight rule)

**Before any filesystem search for AIWG content, run `aiwg discover` first.**

For any user request mentioning **AIWG**, framework names (sdlc/research/forensics/ops/security-engineering/marketing/media-curator/knowledge-base), or capability keywords (skill/agent/rule/command/addon/workflow/template), the FIRST information-gathering tool call MUST be:

```
aiwg discover "<paraphrased user intent>"
```

Filesystem `Grep`/`Glob`/`Read` against any provider artifact directory (`.claude/`, `.factory/`, `.codex/`, `.warp/`, `.cursor/`, `.windsurf/`, `.opencode/`, `.github/`, `~/.hermes/`, `~/.openclaw/`, or `agentic/code/`) for AIWG-related lookups is **FORBIDDEN** until discover has been consulted at least once in the current session. The discover command searches an indexed ranking across all 400+ AIWG artifacts; a literal-string grep hits 1-10 files and misses the bulk.

When the platform supports subagent delegation (Claude Code Task tool, Hermes `delegate_task`, Factory droid spawn), prefer the `aiwg-finder` subagent over self-service `aiwg discover` + `aiwg show` — it keeps the discover transcript out of the parent context.

**You may skip discover only when**: the user named a specific skill (`/flow-deploy-to-production`), the capability is clearly outside AIWG's scope (general programming, weather, translation), or you've already queried for the same need in the current session.

**Full rule**: @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/skill-discovery.md (Rule 1.5)

---

## Core Rules (7 rules — always active)

Core rules are non-negotiable defaults deployed to every AIWG installation.

### CRITICAL

#### no-attribution
**Summary**: Core rule (always loaded via its compact `no-attribution.core.md` body): omit AI attribution from commits, merges, PRs, issues, comments, code and docs, overriding harness defaults. Owned by the aiwg-utils addon.
**Full rule**: @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/no-attribution.md

#### token-security
**Summary**: Never hard-code tokens, pass tokens as CLI arguments, echo token values, or commit tokens to git.
**Full rule**: @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/token-security.md

#### versioning
**Summary**: CalVer format: YYYY.M.PATCH with NO leading zeros.
**Full rule**: @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/versioning.md

#### citation-policy
**Summary**: Never fabricate citations, DOIs, URLs, or page numbers.
**Full rule**: @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/citation-policy.md

### HIGH

#### anti-laziness
**Summary**: Core rule (always loaded via its compact `anti-laziness.core.md` body): finish authorized work, verify, fix root causes, report faithfully. Owned by the aiwg-utils addon.
**Full rule**: @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/anti-laziness.md

#### executable-feedback
**Summary**: Code-generating agents must execute tests before returning results.
**Full rule**: @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/executable-feedback.md

#### failure-mitigation
**Summary**: Mitigation strategies for 6 LLM failure archetypes: hallucination, context loss, instruction drift, safety issues, technical errors, consistency failures.
**Full rule**: @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/failure-mitigation.md

---

## SDLC Rules (24 rules — active with framework)

SDLC rules enforce workflow quality when the SDLC framework is deployed via `aiwg use sdlc`.

### HIGH

#### actionable-feedback
**Summary**: Structured, actionable feedback following Self-Refine principles.
**Full rule**: @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/actionable-feedback.md

#### mention-wiring
**Summary**: Wire @-mentions during artifact creation, not as a separate step.
**Full rule**: @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/mention-wiring.md

#### hitl-gates
**Summary**: Human-in-the-loop gates at SDLC phase transitions.
**Full rule**: @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/hitl-gates.md

#### agent-fallback
**Summary**: Graceful degradation when specialized agents fail or are unavailable.
**Full rule**: @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/agent-fallback.md

#### provenance-tracking
**Summary**: W3C PROV-compliant tracking for all artifacts using Entity-Activity-Agent model with URN schema.
**Full rule**: @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/provenance-tracking.md

#### tao-loop
**Summary**: Standardizes Thought > Action > Observation loop across all iterative execution, including LFD-style structural variation after flat cycles.
**Full rule**: @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/tao-loop.md

#### reproducibility-validation
**Summary**: Validates workflow reproducibility by detecting non-determinism sources.
**Full rule**: @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/reproducibility-validation.md

#### sdlc-orchestration
**Summary**: Core orchestrator for SDLC workflows: interprets natural language, reads flow templates, launches multi-agent workflows.
**Full rule**: @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/sdlc-orchestration.md

#### agent-friendly-code
**Summary**: Quantitative thresholds (300 LOC warning, 500 error) and qualitative patterns for agent-processable code.
**Full rule**: @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/agent-friendly-code.md

#### agent-generation-guardrails
**Summary**: Runtime guardrails for code-generating agents.
**Full rule**: @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/agent-generation-guardrails.md

#### artifact-discovery
**Summary**: Agent protocol for using `aiwg index` CLI as self-service artifact discovery tool.
**Full rule**: @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/artifact-discovery.md

#### self-maintenance
**Summary**: Prefer AIWG CLI commands for installation/deployment tasks when available — the CLI keeps the registry in sync and handles provider detection.
**Full rule**: @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/self-maintenance.md

### MEDIUM

#### hitl-patterns
**Summary**: Human-in-the-loop patterns for agent-human collaboration including draft-then-edit workflow.
**Full rule**: @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/hitl-patterns.md

#### human-gate-display
**Summary**: Rich display format for human approval gates with artifact preview, diff display, and decision logging.
**Full rule**: @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/human-gate-display.md

#### thought-protocol
**Summary**: Seven thought types structure agent reasoning: Goal, Research, Progress, Extraction, Reasoning, Exception, Synthesis.
**Full rule**: @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/thought-protocol.md

#### reasoning-sections
**Summary**: Explicit reasoning sections in artifact templates following Chain-of-Thought patterns.
**Full rule**: @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/reasoning-sections.md

#### few-shot-examples
**Summary**: 2-3 concrete examples required in every agent system prompt.
**Full rule**: @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/few-shot-examples.md

#### best-output-selection
**Summary**: Non-monotonic output selection — track highest quality across iterations rather than accepting final result; includes hypothesis-before-change, eval-harness evidence, VOID exclusion, and budget-stop reports for autonomous loops.
**Full rule**: @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/best-output-selection.md

#### lfd-control-tiers
**Summary**: Classifies LFD agent-loop controls as mechanical (budget stops, resume guard — not substitutable by self-report), hybrid (exploration quota, stall rule, plateau — depend on the analyzer quality signal), or cooperative (hypothesis records). Mechanical tier stays load-bearing under adversarial/high-criticality conditions.
**Full rule**: @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/lfd-control-tiers.md

#### reproducibility
**Summary**: Reproducibility practices for workflows: strict mode (temperature=0, fixed seed), checkpoints at phase boundaries, configuration snapshots, holdout isolation, and score/lint/probe/status feedback-channel separation for eval-driven loops.
**Full rule**: @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/reproducibility.md

#### progressive-disclosure
**Summary**: Progressive revelation in SDLC templates reducing cognitive load via collapsible sections.
**Full rule**: @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/progressive-disclosure.md

#### conversable-agent-interface
**Summary**: Standardized send/receive/generateReply agent interface following AutoGen pattern.
**Full rule**: @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/conversable-agent-interface.md

#### auto-reply-chains
**Summary**: Autonomous agent conversations with self-termination based on context.
**Full rule**: @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/auto-reply-chains.md

#### criticality-panel-sizing
**Summary**: Ensemble review panel sizes based on task criticality.
**Full rule**: @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/criticality-panel-sizing.md

#### qualified-references
**Summary**: Extends @-mentions with semantic relationship qualifiers (implements, tested-by, depends, derives-from, etc.).
**Full rule**: @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/qualified-references.md

---

## Research Rules (2 rules — optional)

Research rules manage the research corpus. Deployed when research features are active.

### HIGH

#### research-metadata
**Summary**: FAIR-compliant metadata for research documents with required YAML frontmatter.
**Full rule**: @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/research-metadata.md

### MEDIUM

#### index-generation
**Summary**: Auto-generate INDEX.md files from YAML frontmatter per FAIR F4 discoverability principle.
**Full rule**: @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/index-generation.md

---

## 12-Factor App Rules (4 rules — architecture guidance)

These rules encode 12-factor methodology principles (https://12factor.net/) as default architectural guidance. Added per issue #821 gap analysis.

### HIGH

#### stateless-processes
**Summary**: Application processes must be stateless — externalize session state, uploaded files, caches, and work state to backing services.
**Full rule**: @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/stateless-processes.md

#### disposable-processes
**Summary**: Fast startup (<10s) and graceful shutdown (SIGTERM handler, in-flight work completion within grace window).
**Full rule**: @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/disposable-processes.md

#### logs-as-event-streams
**Summary**: Write logs to stdout/stderr as unbuffered streams — no local log files, no in-app rotation.
**Full rule**: @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/logs-as-event-streams.md

### MEDIUM

#### config-in-environment
**Summary**: Configuration values that differ between environments (URLs, feature flags, resource limits) must come from environment variables.
**Full rule**: @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/config-in-environment.md

---

## Component Rule Indexes

Rules contributed by installed addons. Load the component index for full rule summaries.

| Component | Index | Rules |
|-----------|-------|-------|
| aiwg-utils | @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/RULES-INDEX.md | 7 |

---

## Quick Reference by Context

> For aiwg-utils contexts, see @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/RULES-INDEX.md

| Task Type | Relevant Rules |
|-----------|---------------|
| **Writing code** | no-attribution, executable-feedback, anti-laziness, agent-friendly-code, agent-generation-guardrails, config-in-environment, logs-as-event-streams |
| **Service/process design** | stateless-processes, disposable-processes, config-in-environment, logs-as-event-streams |
| **Deployment/operations** | disposable-processes, logs-as-event-streams, config-in-environment |
| **Running tests** | executable-feedback, anti-laziness, reproducibility, reproducibility-validation |
| **Creating artifacts** | mention-wiring, provenance-tracking, qualified-references, progressive-disclosure, artifact-discovery |
| **Phase transitions** | hitl-gates, sdlc-orchestration, human-gate-display |
| **Agent loops** | tao-loop, actionable-feedback, best-output-selection, lfd-control-tiers, anti-laziness, reproducibility |
| **Agent design** | few-shot-examples, conversable-agent-interface, agent-fallback, thought-protocol |
| **Documentation** | citation-policy, no-attribution, reasoning-sections, research-metadata |
| **Security review** | token-security, failure-mitigation |
| **Multi-agent work** | auto-reply-chains, criticality-panel-sizing, sdlc-orchestration |
| **Versioning/release** | versioning, no-attribution |
| **Self-maintenance** | self-maintenance |
| **Background orchestration** | self-maintenance, sdlc-orchestration |
| **Research** | research-metadata, index-generation, citation-policy |

---

*Generated from manifest.json v2.0.0 — 37 rules across 4 tiers*
*Full rule files: @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/*
