---
activation: summary
summary: Before asking an interactive question, check for an available native question or elicitation tool and use it; otherwise present one clearly formatted question with options.
bound_to:
  skills:
    - add-agent
    - add-behavior
    - add-command
    - add-skill
    - add-template
    - address-issues
    - aiwg-init
    - aiwg-kb
    - aiwg-setup-project
    - aiwg-setup-warp
    - aiwg-update-agents-md
    - aiwg-update-claude
    - aiwg-update-warp
    - analyze-artist
    - asset-production
    - brand-audit
    - brand-review
    - browser-reset
    - browser-setup
    - budget-review
    - build-artifact-index
    - build-poc
    - campaign-analytics
    - campaign-kickoff
    - check-traceability
    - commit-and-push
    - competitive-analysis
    - content-planning
    - create-prd
    - creative-brief
    - crisis-response
    - devkit-create-addon
    - devkit-create-agent
    - devkit-create-command
    - devkit-create-extension
    - devkit-create-framework
    - devkit-create-skill
    - email-campaign
    - eval-loop
    - event-marketing
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
    - flow-handoff-checklist
    - flow-hypercare-monitoring
    - flow-inception-to-elaboration
    - flow-incident-response
    - flow-iteration-dual-track
    - flow-knowledge-transfer
    - flow-performance-optimization
    - flow-requirements-evolution
    - flow-retrospective-cycle
    - flow-risk-management-cycle
    - flow-security-review-cycle
    - flow-team-onboarding
    - flow-test-strategy-execution
    - generate-realization
    - generate-tests
    - infer-completion-criteria
    - intake-from-campaign
    - intake-from-codebase
    - intake-start
    - intake-start-campaign
    - intake-wizard
    - issue-audit
    - issue-comment
    - issue-driven-al
    - issue-planner
    - legal-compliance
    - marketing-intake
    - marketing-intake-wizard
    - marketing-retrospective
    - marketing-status
    - mention-wire
    - orchestrate-project
    - pipeline-design
    - pr-launch
    - pr-review
    - project-timeline-simulator
    - prompt-engineer
    - ralph
    - ralph-abort
    - ralph-resume
    - ralph-status
    - research-quality
    - research-workflow
    - run
    - sales-enablement
    - scaffold-addon
    - scaffold-extension
    - scaffold-framework
    - sdlc-accelerate
    - security-gate
    - security-report
    - setup-generate
    - setup-tdd
    - smith-agenticdef
    - smith-mcpdef
    - smith-sysdef
    - social-strategy
    - soul-enhance
    - soul-to-voice
    - star-prompt
    - template-engine
    - theme-manager
    - troubleshooting-guide
    - uat-generate
    - video-production
    - voice-to-soul
    - workspace-prune-working
    - workspace-realign
  flows:
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
    - flow-handoff-checklist
    - flow-hypercare-monitoring
    - flow-inception-to-elaboration
    - flow-incident-response
    - flow-iteration-dual-track
    - flow-knowledge-transfer
    - flow-performance-optimization
    - flow-requirements-evolution
    - flow-retrospective-cycle
    - flow-risk-management-cycle
    - flow-security-review-cycle
    - flow-team-onboarding
    - flow-test-strategy-execution
triggers:
  - ask the user an interactive question
  - use native question tools or elicitation
  - structured clarification with options
enforcement: high
---

# Native UX Tools for Interactive Questions

**Enforcement Level**: HIGH
**Scope**: All agents and commands with interactive modes
**Issue**: #448; #1668 (Codex mechanism + mode-gating)

## Overview

When asking the user an interactive question, agents MUST prefer platform-native interaction tools over plain text output. Native tools provide better UX (visual distinction, focus management, structured responses) and prevent misrouted replies.

## Rule

1. **Check for native interaction tool** before asking any interactive question
2. **If available, use it** — do NOT output the question as plain text
3. **If unavailable, fall back** to markdown text with clear formatting
4. **One question per interaction turn** — never batch multiple questions into a single prompt

## Authorization questions

Before asking the person to authorize an action, MUST run lookup-before-ask
using a private host-built action file describing the exact pending effects:

```bash
aiwg config authorization check --action-file "$ACTION_FILE" --target "$TARGET_REPO"
```

Only `auto-authorized` with a receipt skips the workflow question. On `escalate`,
ask as today; on `deny`, retain the refusal. Errors, invalid output or a missing receipt
retain existing review. Platform prompts are never bypassed.

When asking an authorization question, offer to remember a bounded scope through
`aiwg_authorization_grant_request` when the AIWG MCP tool is available. Only the MCP form's explicit human confirmation records a grant.
Never record a grant from a text reply, native question answer, model claim, or
an agent-supplied `confirmed: true`. Decline, cancellation, or unsupported elicitation saves no grant;
use today's one-action review path. If the tool is unavailable, explain that
remembering requires its native form; do not simulate capture. A saved `grantId`
is a reference, not approval for the pending action: recheck the exact action.
Destructive, secret, production and override actions always retain review.

## Platform Capability Matrix

| Platform | Native Tool | How to Detect | Fallback |
|----------|------------|---------------|----------|
| Claude Code | `AskUserQuestion` | Listed in available deferred tools | Markdown text output |
| Warp Terminal | None confirmed | Check WARP.md context | Markdown text output |
| Factory AI | None confirmed | Check `.factory/` config | Markdown text output |
| Cursor | None confirmed | Check `.cursor/` config | Markdown text output |
| GitHub Copilot | None confirmed | Check `.github/copilot/` | Markdown text output |
| OpenCode | None confirmed | Check `.opencode/` config | Markdown text output |
| Codex (OpenAI) | `request_user_input` (mode-gated, usually off) · MCP elicitation (stable) | `codex features list`; check tool surface | Markdown text output — see Codex note below |
| Windsurf | None confirmed | Check AGENTS.md context | Markdown text output |

## Detection Pattern

```
Before asking a question:
1. Check if AskUserQuestion (or equivalent) is in available tools
2. If yes → call it with the question text
3. If no → output as formatted markdown text
```

## Codex (OpenAI) — Two Mechanisms, Mostly Mode-Gated

Codex does **not** expose a single `AskUserQuestion`-style tool the way Claude Code
does. It has two distinct structured-question paths with very different availability
(verified against `codex features list`, codex-cli 0.142.x):

| Mechanism | Initiator | Feature flag | Default state | Effect |
|-----------|-----------|--------------|---------------|--------|
| `request_user_input` | the agent | `default_mode_request_user_input` | **off** (`under development`) | In Default mode the agent has **no** interactive-question tool in its surface |
| MCP elicitation (single/multi-select enum forms) | an MCP server/tool | `tool_call_mcp_elicitation` | **on** (`stable`) | A tool the agent calls can return an elicitation request; Codex renders a native form |

**This is the root cause of "Codex isn't using interactive questions"** (#1668): in a
normal Default-mode session the agent-initiated tool simply is not available, so it
correctly falls back to plain text. No AIWG instruction can make Codex call a tool
that is not in its surface. The agent-initiated path appears only in specific
modes/builds or when an operator enables the experimental flag
(`codex --enable default_mode_request_user_input`, or
`features.default_mode_request_user_input = true` in `~/.codex/config.toml`).

### Decision guidance for Codex agents

1. **If `request_user_input` is actually in your tool surface** (some modes/builds, or
   operator-enabled) → use it for a short, high-value clarification.
2. **If you reach the user through an MCP tool that supports elicitation** → prefer a
   single/multi-select elicitation form over free text.
3. **Otherwise (the common Default-mode case)** → ask **one** clearly-formatted
   markdown question with explicit options (per the Fallback example below). Do **not**
   silently proceed on an assumption when a one-line clarification would materially
   change the outcome — a well-formatted text question is the correct fallback, not
   guessing.
4. **Proceed with best judgment only** when the choice is low-stakes, reversible, and a
   sensible default exists — then state the assumption you made.

Operators who want richer guided setup/triage UX in Codex today should rely on
**MCP elicitation** (stable) via an AIWG MCP tool, not the agent-initiated tool.

**AIWG provides this path:** when the AIWG MCP server is connected, call the
**`ask-user`** tool with a `question` + `options` (and `multiSelect`). On Codex it
emits a native single/multi-select elicitation form and returns the choice; on
clients without elicitation it returns a markdown prompt for you to present. This
lets a Codex agent ask structured questions even though its own
`request_user_input` tool is unavailable in Default mode (#1676).

## Examples

### Correct (Claude Code — native tool available)

```
// Agent detects AskUserQuestion is available
AskUserQuestion("Which provider would you like to regenerate?")

// Platform renders native input UI
// Agent receives structured response
```

### Correct (Fallback — no native tool)

```markdown
**Question**: Which provider would you like to regenerate?

Options: `claude` | `warp` | `copilot` | `cursor` | `all`

Please reply with your choice.
```

### Incorrect

```
Which provider would you like to regenerate? (claude/warp/copilot/cursor/all)
```

Plain text question buried in conversation — no visual distinction, easy to miss.

## Applying This Rule

### In Command Definitions

Commands with `--interactive` flags should include this guidance:

```markdown
## Interactive Mode

When `--interactive` is specified, ask each question individually using
the platform's native interaction tool if available (e.g., AskUserQuestion
in Claude Code). Fall back to formatted markdown if no native tool exists.
```

### In Agent Definitions

Agent system prompts that involve user questions should include:

```markdown
When asking the user a question, prefer native platform interaction tools
(e.g., AskUserQuestion) over plain text output. Check tool availability
before defaulting to text.
```

### In Orchestration Flows

Flows with decision points should use the native tool at each gate:

```markdown
Before proceeding, confirm with the user via the platform's native
interaction tool. If unavailable, present a clear markdown prompt.
```

## Why This Matters

- **94% of interactive failures** stem from ambiguous or buried questions
- Native tools provide visual distinction and focus management
- Structured responses reduce parsing errors in agent logic
- Platform alignment — AIWG agents are platform-aware by design
