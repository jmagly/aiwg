# AIWG Utilities Rules Index

Core meta-utility rules for agent coordination, context management, and platform interaction. Deployed automatically with all AIWG installations (`core: true, autoInstall: true`).

---

## AIWG Utilities Rules (27 rules — active with aiwg-utils addon)

### HIGH

#### auto-compact-continue
**Summary**: The answer to "should I keep working?" is always YES — until the task's measurable completion criteria are met or the user redirects.
**Full rule**: @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/auto-compact-continue.md

#### cli-secondary
**Summary**: AIWG is agentic-first.
**Full rule**: @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/cli-secondary.md

#### no-time-estimates
**Summary**: Never produce wall-clock time estimates in AI-assisted work contexts.
**Full rule**: @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/no-time-estimates.md

#### god-session
**Summary**: A single agent that tries to do everything — research, implement, test, document, deploy — is a god session.
**Full rule**: @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/god-session.md

#### vague-discretion
**Summary**: Loop termination conditions and quality gates must be concrete and measurable.
**Full rule**: @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/vague-discretion.md

#### subagent-scoping
**Summary**: Each subagent gets ONE focused task with minimal context.
**Full rule**: @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/subagent-scoping.md

#### instruction-comprehension
**Summary**: Fully parse and confirm understanding of all user instructions before acting.
**Full rule**: @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/instruction-comprehension.md

#### research-before-decision
**Summary**: Research codebase, docs, and sources before making technical decisions.
**Full rule**: @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/research-before-decision.md

#### escalation-discipline
**Summary**: Agents must summarize before moving above their declared default model tier, confirm Tier 3 explicitly, and never auto-escalate unattended bots to premium tiers.
**Full rule**: @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/escalation-discipline.md

#### tool-quota
**Summary**: Tool-using agents must track per-session tool calls, stop repeating similar failed calls without progress, and honor `tool_quota` / `loop_detection` declarations when present.
**Full rule**: @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/tool-quota.md

#### quiet-mode
**Summary**: Chat and bot agents in group rooms should respond only when mentioned, replied to, or invoked by a direct command.
**Full rule**: @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/quiet-mode.md

#### respect-repo-access-manifest
**Summary**: Tool capability is not authorization.
**Full rule**: @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/respect-repo-access-manifest.md

#### skill-discovery
**Summary**: Most AIWG skills are NOT loaded into your context — only the kernel set (framework quickrefs + core utilities).
**Full rule**: @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/skill-discovery.md

#### native-ux-tools
**Summary**: Agents MUST prefer platform-native interaction tools (e.g., AskUserQuestion in Claude Code) over plain text output for interactive questions.
**Full rule**: @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/native-ux-tools.md

#### human-authorization
**Summary**: Agents must seek explicit human authorization before irreversible or high-stakes actions — especially when those actions are implied by findings rather than explicitly requested.
**Full rule**: @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/human-authorization.md

#### delivery-policy
**Summary**: AIWG projects declare their git workflow in `.aiwg/aiwg.config` `delivery` block (`mode`: direct / feature-branch / pr-required, `default_branch`, `require_ci_green`, `force_push_policy`, `auto_close_issues`).
**Full rule**: @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/delivery-policy.md

#### artifact-output-policy
**Summary**: Write governed outputs (issues, comments, PRs, reports, SDLC artifacts) from their discovered template, filling every required section; write the canonical artifact to the AIWG store first; provider-native destinations are explicit-only.
**Full rule**: @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/artifact-output-policy.md

#### sdlc-right-sizing
**Summary**: Match SDLC artifacts to the actual scope of change.
**Full rule**: @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/sdlc-right-sizing.md

### MEDIUM

#### context-bloat
**Summary**: Sub-agents should receive only the context directly relevant to their task.
**Full rule**: @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/context-bloat.md

#### parallel-then-synthesize
**Summary**: Spawning parallel agents for *related* analytical work that feeds one conclusion often produces lower quality than a single focused agent — coordination overhead and context fragmentation outweigh parallelism benefits.
**Full rule**: @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/parallel-then-synthesize.md

#### implicit-dependencies
**Summary**: Sub-agents must receive all required context explicitly — they have no access to the parent session's conversation, prior agent outputs, or any context not in their prompt.
**Full rule**: @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/implicit-dependencies.md

#### context-budget
**Summary**: When `AIWG_CONTEXT_WINDOW` is set in project context, agents must respect the declared context budget for parallel subagent spawning.
**Full rule**: @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/context-budget.md

#### diagram-generation
**Summary**: Diagram generation is a standard output alongside every major documentation artifact.
**Full rule**: @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/diagram-generation.md

#### agent-deployment
**Summary**: Rules for working with agent definitions and multi-provider deployment.
**Full rule**: @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/agent-deployment.md

#### activity-log
**Summary**: Agents must append a single-line entry to `.aiwg/activity.log` after completing any create, update, delete, ingest, deploy, archive, promote, lint, or actioned query operation on AIWG artifacts.
**Full rule**: @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/activity-log.md

#### debug-source-not-output
**Summary**: When debugging in multi-project or monorepo contexts, agents must navigate to the originating source code rather than analyze build artifacts (minified JS, compiled bundles, vendored output).
**Full rule**: @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/debug-source-not-output.md

#### post-commit-index-refresh
**Summary**: After a successful git commit, check whether artifact indices are configured (`.aiwg/index/`) and rebuild any indices whose source paths were touched by the commit.
**Full rule**: @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/post-commit-index-refresh.md

#### soul-enforcement
**Summary**: When `SOUL.md` is present at project root, agents must read it fully and internalize the identity, worldview, and voice it defines before generating any content.
**Full rule**: @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/soul-enforcement.md

---

## Quick Reference by Context

| Task Type | Relevant Rules |
|-----------|---------------|
| **Delegating to subagents** | subagent-scoping, context-budget, instruction-comprehension |
| **Sub-agent prompt construction** | context-bloat, implicit-dependencies, subagent-scoping |
| **Interactive commands** | native-ux-tools, instruction-comprehension |
| **Agent deployment** | agent-deployment |
| **Agent definition scope** | god-session, subagent-scoping |
| **Documentation** | diagram-generation |
| **Research/decisions** | research-before-decision |
| **Model escalation / spend gates** | escalation-discipline, human-authorization, native-ux-tools |
| **Tool-call loops / quotas** | tool-quota, research-before-decision, vague-discretion |
| **Chat bot quiet mode** | quiet-mode, tool-quota, escalation-discipline |
| **Skill / capability lookup** | skill-discovery, research-before-decision |
| **Error diagnosis** | research-before-decision, instruction-comprehension |
| **Constrained systems** | context-budget, subagent-scoping |
| **Authorization gates** | human-authorization, native-ux-tools |
| **Scope management** | human-authorization, instruction-comprehension, god-session |
| **Loop/gate conditions** | vague-discretion |
| **Parallel dispatch design** | parallel-then-synthesize, subagent-scoping, context-budget |
| **Activity tracking** | activity-log |
| **Git workflow / branching / PRs** | delivery-policy, human-authorization |
| **Artifact destinations / provider-native exports** | artifact-output-policy, human-authorization |
| **Estimation and planning** | no-time-estimates, vague-discretion, subagent-scoping |
| **Debugging in monorepos / output trees** | debug-source-not-output |
| **Post-commit hygiene** | post-commit-index-refresh, activity-log |
| **Identity / voice / persona** | soul-enforcement |
| **CLI vs skill routing** | cli-secondary, skill-discovery, research-before-decision |

---

*Generated from aiwg-utils manifest.json — 27 rules*
*Full rule files: @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/*
