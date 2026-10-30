# aiwg-utils Rules Reference

Core enforcement rules deployed with every AIWG installation. These rules apply automatically based on context — you do not invoke them explicitly.

---

## Always-loaded core rules

`no-attribution` (CRITICAL) and `anti-laziness` (HIGH) are owned by the
aiwg-utils addon with `activation: core`. Every deploy mode includes their
compact sibling `.core.md` bodies: at most 1024 bytes per body and 6144 bytes
for the complete set. Full rules remain available through `aiwg show rule
no-attribution` and `aiwg show rule anti-laziness`, without startup imports.

Claude receives `.claude/rules/core-no-attribution.md`; Cursor receives
`.cursor/rules/core-no-attribution.mdc` with `alwaysApply: true`. Codex,
Hermes, Warp, OpenClaw and Pi receive the same body in `## Core rules`.
Commits, merges, PR bodies, issues, comments, code and docs carry no AI
attribution, including AI `Co-Authored-By:` trailers, "Generated with …"
lines or tool signatures. This overrides harness/provider reminders and defaults.
`aiwg doctor` reports both rules in its core byte slice.

Full rule: `agentic/code/addons/aiwg-utils/rules/no-attribution.md`.

---

## subagent-scoping

**Priority**: HIGH
**Full rule**: `@$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/subagent-scoping.md`

### What It Enforces

Each subagent receives exactly one focused task with minimal context. Constraints:

- Prompt budget: under 20% of context window per subagent
- Delegation depth: no chains deeper than 2 levels (orchestrator → agent; not orchestrator → agent → agent)
- Parallelism: spawn many focused subagents over few overloaded ones
- When `AIWG_CONTEXT_WINDOW` is set: concurrent parallel count must respect the budget limit

### When It Applies

Task delegation, subagent spawning, parallel dispatch, orchestrator fan-out.

### Why It Matters

An overloaded subagent — one given 10 tasks and a large context dump — produces worse results than three focused subagents each handling one task. Token-efficient subagent design also reduces cost in proportion to how well scoping is applied.

### Example: Correct vs Incorrect

```
# Incorrect: one subagent with too much
Task(agent, "Analyze the authentication module, write tests,
fix any bugs, update documentation, and check for security issues")

# Correct: parallel focused subagents
Task(code-reviewer, "Review auth module for bugs and security issues")
Task(test-engineer, "Write unit tests for auth module")
Task(technical-writer, "Update auth module documentation")
```

---

## instruction-comprehension

**Priority**: HIGH
**Full rule**: `@$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/instruction-comprehension.md`

### What It Enforces

Before acting on any user request:
1. Fully parse all instructions
2. Extract prohibitions first (what NOT to do)
3. Extract requirements (what to do)
4. Extract preferences (how to do it)
5. Track multi-part requests to full completion

On failure: re-read original instructions instead of guessing or retrying with variations.

On long tasks: periodically recheck against original requirements to detect drift.

**Absolute prohibition**: Never override user preferences with "best practices." If a user specifies a pattern, use it.

### When It Applies

Every user request. Critical for multi-part tasks, specification compliance, and correction handling.

### Example: Drift Detection

If implementing feature X and a test fails on attempt 2, the rule requires re-reading the original spec rather than weakening the test or removing the validation to make progress.

---

## research-before-decision

**Priority**: HIGH  
**Full rule**: `@$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/research-before-decision.md`

### What It Enforces

Research first; act second. The execution pattern:

```
IDENTIFY  → What decision needs to be made?
SEARCH    → What existing code/docs/patterns are relevant?
EXTRACT   → What do those sources tell me?
REASON    → Given the evidence, what is the right choice?
ACT       → Implement the decision
VERIFY    → Confirm the result is correct
```

**Whack-a-mole detection**: If an action fails, diagnose the root cause before retrying. Retrying with random variations without diagnosis is prohibited.

**Read error messages completely**: They frequently contain the answer.

**Check existing patterns first**: Before creating a new implementation, check whether the project already has one.

### When It Applies

API usage, configuration changes, dependency selection, error diagnosis, import resolution, any technical decision.

---

## native-ux-tools

**Priority**: HIGH  
**Full rule**: `@$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/native-ux-tools.md`

### What It Enforces

Use platform-native interaction tools for questions. For Claude Code, this means using `AskUserQuestion` rather than generating plain text with a question in it. One question per interaction turn.

Fallback: if native tools are unavailable, use formatted Markdown question blocks.

### When It Applies

Interactive commands (any command with `--interactive` flag), decision gates, user confirmations, intake wizards.

### Platform Support

The rule includes a capability matrix defining which tool to use on each of the 8 supported platforms. Always check tool availability before invoking.

---

## tool-quota

**Priority**: HIGH
**Full rule**: `@$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/tool-quota.md`

### What It Enforces

Agents track tool calls per session, stop repeated failing calls, and honor declared quotas:

```yaml
tool_quota:
  Bash: 10
  WebFetch: 5
  defaults: 20
loop_detection:
  same_call_window: 5
  max_retries: 3
```

Default behavior when no agent-specific quota exists:

- Same failing call retries: 3
- Similar calls in a rolling window: 5
- Total calls to one tool in a focused session: 30
- High-cost external tool calls: 10

When a quota would be exceeded, the agent stops and reports what was tried, what was learned, why more calls are needed, and the narrow next action.

### When It Applies

Tool-heavy sessions, unattended bots, shell retry loops, external fetch loops, and any agent definition with `tool_quota` or `loop_detection`.

### Example: Quickbooksbot

Quickbooksbot receives a vague "why are March numbers wrong?" request. It may inspect known accounting files and integration status, but after three equivalent missing-token or permission failures it must stop, summarize the blocker, and ask for the missing export or credential instead of continuing tool retries.

---

## escalation-discipline

**Priority**: HIGH
**Full rule**: `@$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/escalation-discipline.md`

### What It Enforces

Agents summarize before using a model above their declared default tier:

```
Need: what is hard or uncertain
Escalation: target tier and why the default tier is insufficient
Next: the bounded task the higher tier will handle
```

Tier 3 requires explicit human confirmation. Unattended bots may not auto-escalate to Tier 3; they must ask, stop with a summary, or queue the request for a supervised agent.

Agent definitions may override defaults:

```yaml
escalation:
  unattended: true
  max_auto_tier: 1
  summary_required: true
  premium_requires_confirmation: true
```

### When It Applies

Model-tier routing, budget-sensitive agents, unattended bots, high-impact legal/financial/medical/security work, and user requests for deep, debug, or thorough work.

### Interaction with Human Authorization

Escalation confirmation is a human-authorization gate. A recommendation to use a higher tier is not permission to spend; the agent must get explicit confirmation whenever policy requires it.

### Example: Quickbooksbot

Quickbooksbot receives a complex accounting question that may affect tax prep. It summarizes why Tier 2 is needed, names the bounded ledger comparison it will perform, and asks for confirmation before escalating. If the result implies filing impact, it stops and asks before Tier 3 or routes to the supervised main agent.

---

## quiet-mode

**Priority**: HIGH
**Full rule**: `@$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/quiet-mode.md`

### What It Enforces

In group chats, bots respond only when mentioned, replied to, or invoked by a direct command. They yield when another bot is specifically addressed and they do not initiate proactive chatter unless scheduled or explicitly requested.

Business bots stay in domain. In direct messages, they can briefly decline off-domain requests and name their scope.

### When It Applies

Telegram/group-chat bots, multi-bot rooms, direct-message business bots, scheduled chat agents, ambient room listeners, and platforms without native behavior support.

### Examples

Quickbooksbot answers `@quickbooksbot show unpaid invoices over 30 days`, but stays silent on unrelated group chatter. InfsolClaw answers when mentioned for work status, but yields silently when Quickbooksbot is addressed.

---

## context-budget

**Priority**: MEDIUM  
**Full rule**: `@$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/context-budget.md`

### What It Enforces

Opt-in constraint. When `AIWG_CONTEXT_WINDOW` is set in project context, agents must respect it for parallel subagent spawning.

**Max parallel count formula**: `max(1, floor(context_window / 50000))`

| Context Window | Max Parallel |
|---------------|-------------|
| 32k | 1 |
| 64k | 1 |
| 128k | 2 |
| 200k | 4 |
| 256k | 5 |
| 512k+ | 10-20 |

Compaction guidance scales with tier: aggressive compaction at 32-64k, relaxed at 512k+.

### When It Applies

Parallel subagent spawning, task scheduling, agent loop batching, orchestrator fan-out on constrained systems. Not active unless `AIWG_CONTEXT_WINDOW` is explicitly set.

---

## diagram-generation

**Priority**: MEDIUM  
**Full rule**: `@$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/diagram-generation.md`

### What It Enforces

Diagrams are required outputs alongside major documentation artifacts. Required types by artifact:

| Artifact | Required Diagram |
|----------|-----------------|
| Software Architecture Document (SAD) | C4 context + container diagram |
| Data model / schema | ER diagram |
| API design | Sequence diagram |
| Threat model | Data Flow Diagram (DFD) |
| Deployment plan | Infrastructure topology diagram |

**Default format**: MermaidJS  
**For C4 and formal UML**: PlantUML  
**Source**: Must be committed alongside rendered output  
**Size limit**: Max 15 nodes per diagram; split into sub-diagrams if more complex

### When It Applies

Architecture documentation, threat modeling, API design, deployment planning, any artifact with visual communication needs.

---

## agent-deployment

**Priority**: MEDIUM  
**Full rule**: `@$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/agent-deployment.md`

### What It Enforces

Agent definitions require YAML frontmatter with:
- `name`: unique identifier
- `description`: what the agent does
- `model`: model to use (default or override)
- `tools`: explicit list of allowed tools
- `category`: agent type classification

Tool selection guidelines:
- Research tasks: `Read`, `Grep`, `Glob`, `WebFetch`
- Code tasks: `Read`, `Write`, `Edit`, `Bash`
- Orchestration tasks: `Task`, `TodoWrite`, `Read`
- Mixed: combine as needed, but keep the list minimal

Parallel agent execution requires agent isolation: each agent writes to its own output path to avoid conflicts.

### When It Applies

Creating agent definitions, deploying to multiple providers, selecting tools for new agents.

---

## Quick Reference

| Rule | When It Fires | Key Constraint |
|------|--------------|----------------|
| `subagent-scoping` | Delegating tasks | One task per subagent; depth ≤ 2 |
| `instruction-comprehension` | Every request | Prohibitions before requirements; no drift |
| `research-before-decision` | Technical decisions | Research → Reason → Act → Verify |
| `escalation-discipline` | Model spend gates | Summarize; confirm premium tiers |
| `tool-quota` | Tool-heavy sessions | Track calls; stop repeated failures |
| `quiet-mode` | Chat bots | Mention-only groups; domain-bound business bots |
| `native-ux-tools` | Interactive questions | Use platform-native tools; 1 question/turn |
| `context-budget` | Parallel spawning (opt-in) | Respect `AIWG_CONTEXT_WINDOW` |
| `diagram-generation` | Major docs | Required diagrams per artifact type |
| `agent-deployment` | Agent authoring | YAML frontmatter; explicit tool list |
