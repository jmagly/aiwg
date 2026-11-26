---
enforcement: high
activation: bound
summary: "Use the cheapest capable worker tier; summarize escalation, confirm premium and require flagship election."
bound_to:
  agents: [fleet-quiet-bot, fleet-business-bot, concierge, aiwg-model-efficiency-worker, aiwg-model-coding-worker, aiwg-model-reasoning-worker, aiwg-steward]
  skills: [steward]
triggers:
  - "should I use a stronger model"
  - "is this worth escalating"
  - "model tier"
---

# Escalation Discipline

**Enforcement Level**: HIGH
**Scope**: All agents with model tier, budget, or supervised-escalation policy
**Addon**: aiwg-utils (core, universal)
**Issue**: #1186

## Overview

Escalation is a spending and authorization decision. Agents running in a fleet may have a cheap default model for routine work, a capable model for complex reasoning, and a premium supervised tier for high-impact tasks. Moving above the declared default tier must be deliberate, summarized, and confirmed when policy requires it.

This rule is prompt-level. It shapes agent behavior across providers today and pairs with model-tier declarations when they are available. It does not require runtime model switching or provider-specific harness enforcement.

## Tier Vocabulary

Use this vocabulary when an agent, workspace, or fleet policy defines model tiers:

| Tier | Meaning | Default Behavior |
|------|---------|------------------|
| 0 | No model call: script, cached result, deterministic tool, or existing answer | Prefer when enough information is already available |
| 1 | Cheap/default model for simple routing, summaries, and routine answers | Safe unattended default |
| 2 | Capable work model for debugging, multi-step reasoning, code, or nuanced analysis | Requires summary before use when above default |
| 3 | Premium/supervised model for high-impact, expensive, or ambiguous work | Requires explicit human confirmation |

If no tier is declared, use the cheapest capable tier under the merged `defaults.workerSelection.strategy` (`cost-effective` guidance default) and `maxAutoTier`; role floors and task mappings remain in `roleGuidance` / `taskClasses`. See `subagent-scoping` Rule 4a, “Delegate by default”. Never derive a worker tier from the session model. Strategies do not authorize premium spend or bypass eligibility.

### Flagship election
AIWG never auto-escalates to flagship (Tier 4). Flagship requires explicit user election or an explicitly authorized capability allowlist. A flagship session elects the session only, not its workers.

Worked example: a flagship session delegates bounded inventory to `aiwg-model-explorer` at economy and implementation to `aiwg-model-coding-worker` at standard. No flagship workers are selected; a failed standard verification may justify a summarized premium request, never a jump to flagship.

## Mandatory Rules

### Rule 1: Summarize Before Escalating

Before invoking any model above the agent's declared default tier, the agent must summarize in at most three short lines:

```
Need: what is hard or uncertain
Escalation: target tier and why the default tier is insufficient
Next: the bounded task the higher tier will handle
```

Do not bury the summary inside a long plan. It is a decision gate.

### Rule 2: Confirm Tier 3

Tier 3 requires explicit human confirmation before use.

**FORBIDDEN**:
```
This is complex, so I am switching to Tier 3 now.
```

**REQUIRED**:
```
Need: This may affect tax filings and requires careful accounting reasoning.
Escalation: Tier 3 because this is high-impact financial analysis.
Next: review the exported ledger for inconsistencies only.
Question: Should I escalate to Tier 3 for that bounded review?
```

If native interaction tools are available, use them for the confirmation. If not, ask one clear markdown question.

### Rule 3: Never Auto-Escalate Unattended Bots to Tier 3

Unattended bots must not auto-escalate to Tier 3. They may:

- Answer at default tier
- Ask the user to confirm escalation
- Summarize the blocker and stop
- Queue the request for a supervised agent

They must not silently spend premium tokens because the task appears important.

### Rule 4: Honor Agent Escalation Policy

Agent definitions may override defaults:

```yaml
escalation:
  unattended: true
  max_auto_tier: 1
  summary_required: true
  premium_requires_confirmation: true
```

Interpretation:

- `unattended: true` means no Tier 3 auto-escalation.
- `max_auto_tier` is the highest tier the agent may use without confirmation.
- `summary_required: true` forces the three-line summary for any escalation.
- `premium_requires_confirmation: true` means Tier 3 waits for explicit approval even in supervised sessions.

Use the most restrictive applicable policy from agent, workspace, provider, and this rule.

### Rule 5: Confirmation Is Human Authorization

Escalation confirmation is a specific form of human authorization. A finding that a higher tier would help is only a recommendation, not permission to spend.

Correct sequence:

```
discover need -> summarize escalation -> ask/confirm if policy requires -> escalate -> report result
```

This inherits the `human-authorization` principle: a recommendation is not authorization to act.

## Detection Patterns

| Pattern | Detection | Required Response |
|---------|-----------|-------------------|
| Silent model upgrade | Agent changes to stronger/premium model without summary | Stop and provide the escalation summary first |
| Vague escalation | "This needs more reasoning" with no bounded task | Name the uncertainty and next bounded task |
| Unattended premium spend | Bot escalates to Tier 3 in a group, cron, or webhook context | Stop, summarize, and queue/ask for approval |
| Repeated cheap-tier failure | Default tier cannot resolve after a bounded attempt | Summarize why Tier 2 is needed before continuing |
| High-impact domain | Legal, financial, medical, security, destructive ops, shared infra | Treat as Tier 3 unless policy says otherwise |
| User explicitly asks for deep/debug/thorough work | Request implies higher reasoning budget | Summarize target tier and proceed only within policy |

## Worked Example: Quickbooksbot

Quickbooksbot runs unattended in Telegram with a cheap default:

```yaml
tier:
  default: 1
  escalate_to: 2
escalation:
  unattended: true
  max_auto_tier: 1
  summary_required: true
  premium_requires_confirmation: true
```

User asks in a group chat:

```
Why are our March reconciliation numbers off? This may affect tax prep.
```

Correct behavior:

```
Need: March reconciliation is a complex accounting question and may affect filings.
Escalation: Tier 2 can inspect the exported ledger; Tier 3 would need explicit confirmation.
Next: compare March bank export totals against ledger categories only.

Do you want me to escalate to Tier 2 for that bounded comparison?
```

If the user confirms Tier 2, Quickbooksbot handles only the bounded comparison. If the result indicates tax filing impact, it stops and asks before Tier 3 or routes to the supervised main agent.

Incorrect behavior:

```
This sounds important. Escalating to the premium model and reviewing everything now.
```

That spends premium budget without an authorization gate and expands scope beyond the user's confirmed task.

## Runtime and Provider Notes

This rule is intentionally provider-neutral:

- Providers with native model routing should map tiers to concrete model IDs.
- Providers without routing should still apply the summary and confirmation behavior before recommending a stronger model/session.
- Workspace-level tier maps, when present, define concrete model names; this rule defines the behavioral gate.

Runtime model switching is out of scope for this rule. The agent may instead ask the user to restart, route, or delegate the bounded task to the configured higher-tier agent.

## Integration with Other Rules

- **human-authorization**: escalation confirmation is authorization to spend or route, not just a recommendation.
- **native-ux-tools**: use platform-native interaction tools for confirmation when available.
- **tool-quota**: escalating because tools are looping is valid only after summarizing the failed attempts and bounded next action.
- **research-before-decision**: a higher tier still must research before deciding; escalation is not permission to guess.
- **vague-discretion**: escalation triggers need concrete thresholds, not "seems hard."

## Checklist

Before escalating, verify:

- [ ] Is this above the declared default tier?
- [ ] Did I summarize need, target tier, and bounded next task in <=3 lines?
- [ ] Does agent/workspace policy permit auto-escalation to this tier?
- [ ] If Tier 3, did I receive explicit human confirmation?
- [ ] If unattended, am I stopping or asking instead of silently spending premium tokens?
- [ ] Is the higher-tier task bounded enough to avoid scope creep?

## References

- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/human-authorization.md
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/native-ux-tools.md
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/tool-quota.md
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/research-before-decision.md
- Parent fleet-ops epic: #1184
- Model-tier routing primitive: #1185

---

**Rule Status**: ACTIVE
**Last Updated**: 2026-05-17
