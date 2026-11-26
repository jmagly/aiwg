# Orchestration worker selection (#2648)

The 2026-11-24 decision for #2642 remains binding: configuration extends
`models.json.defaults.workerSelection`; there is no new delegation config root.
`ConfigLoader` merges builtin → user → project and rejects a project that widens
an inherited automatic ceiling. See [the foundation contract](worker-selection.md).

`src/models/delegation.ts` supplies `resolveDelegation()` for native orchestration
launches. It reads current config on each resolution, chooses the task/agent role,
applies role guidance and agent minimums, resolves the tier to a provider model,
and builds the existing wrapper envelope. Explicit agent/provider pins survive.
Recognized premium/flagship identities and aliases cannot hide under a cheap
tier label. A placeholder stops the work unit. An exact native CLI pin can be
passed when agent frontmatter cannot enforce it; the surface warning is retained.
The caller must send the resolved model to the launch seam.

Native workers default to coding/standard; inventory maps to efficiency/economy.
An explicit economy tier without a role also selects efficiency. A configured
role remains a capability floor. The native default ceiling is standard, premium
requires explicit human authorization, and flagship requires `election: user`.
An exact pin alone does not elect flagship. A session model is never a worker
input. Native bindings provide one model per tier; strategy cannot invent extra
candidates. Qualified dispatch retains the shared resolver's existing strategy
ranking over eligible model tuples, observed pricing classes and all eligibility,
freshness, data-policy, permission, budget and admission checks.

## Launch inventory

| Path | Owner / behavior |
| --- | --- |
| Mission skill | `agentic/code/addons/aiwg-utils/skills/aiwg-mission/SKILL.md`: assign wrapper and tier during decomposition; resolve before native or external launch. |
| Mission conductor | `src/serve/mission-conductor.ts` → `cycle-delegation.ts`: sends explicit model and routing record to `RunWorker`; logs the record. Recovered effects and plan-only cycles do not launch. |
| Fleet conductor | `src/serve/fleet-mission-conductor.ts`: same selection before each `RunFleetWorker`; an unsupported runtime fails that child. |
| MC native | `src/cli/handlers/mc-run.ts`: resolve eligible queued work before admission/cost warning, pass tier to Ralph, log routing in `mission_started`. |
| MC managed | `mc-worker.ts`: retain `resolveWorkerInvocation()` and project worker authority; project its qualified selection into the same routing record. Explicit tiers must match the resolved tier. |
| Flow managed | `createMcFlowAdapter()` in `mc-worker.ts`: retain shared resolver/admission, pass routing in `context.prepared.routing`. Generic composition adapters execute host-supplied operations; no new transport is added. |
| Five native flow skills | Delegation reference: explorer for artifact reading, verifier for gate checks, specialist frontmatter as requirements. Resolve with `aiwg models resolve` before invocation; record common fields. |
| Ralph native | `tools/ralph-external/lib/ralph-cycle-launch.mjs` → `ralph-delegation.mjs`: resolve before every cycle, pass explicit model to session launcher, persist `routing.json` beside the attempt. |
| Ralph group | `lib/ralph-group-cycle.mjs`: existing invocation resolver and shared admission; persist the qualified selection as `routing.json`. |
| Team OMP | `tools/providers/omp-teams.mjs`: resolve all leaf assignments before creating clients, pin coordinator and child, persist routing in task results. No `@task`/`@slow`/`@smol` fallback. |
| Team Claude | `team.ts` / `team-delegation.ts`: resolve every member before printing explicit native wrapper/model instructions. This CLI prints instructions; it does not invoke Claude's in-session team tool. |
| Other team providers | Warn that this command has no native per-worker control; forward `--worker-tier` on the existing MC handoff. |

Ralph's parser, orchestrator and state manager no longer supply a model fallback.
Explicit `--model` elects that operator pin at the CLI boundary; new loop state
persists the election. Old saved model defaults do not become user elections
when resumed. OMP library callers must supply `election: 'user'` for flagship;
public `--model` supplies it explicitly. Premium authorization remains separate.

## Preview and records

```bash
aiwg mc start --name inventory
aiwg mc dispatch <session-id> "Inventory bounded inputs" --completion "inventory saved" --worker-tier economy
aiwg mc run <session-id> --dry-run --json
aiwg team run <team> --provider claude --worker-tier standard
aiwg ralph "Bounded implementation" --completion "trusted checks pass" --worker-tier standard
```

`mc start` creates an empty session; it does not have workers to preview. Use
`mc run --dry-run --json` on a queued session to inspect `.workers[].tier`.
Preview performs resolution but does not launch workers or persist session edits.

Every routing record has the same fields:

```json
{
  "version": 1,
  "orchestrator": "mc",
  "workerId": "bounded-worker",
  "role": "efficiency",
  "requested_tier": "economy",
  "resolved_tier": "economy",
  "resolved_model": "claude-haiku-4-5",
  "wrapper": "aiwg-model-efficiency-worker",
  "strategy": "cost-effective",
  "max_auto_tier": "standard",
  "election": null,
  "warnings": []
}
```

`requested_tier: null` means role policy supplied the tier. Qualified legacy
dispatch preserves omitted strategy as balanced/configured ordering and an
omitted ceiling as `max_auto_tier: null`; native defaults are stated above.
Warnings preserve catalog and model-surface limitations. These are requested
launch facts, not observed backend model attestations or accepted worker claims.

MC cost planning uses a tier coefficient per iteration (economy 0.20, standard
1.60, premium 3.90, flagship 8.00 USD). These are heuristic planning numbers,
not measured provider prices. The standard coefficient preserves the previous
Sonnet assumption. Declared spend ceilings reduce estimates only for providers
whose spend is observable; unobservable ceilings still cannot lower the warning.

## Offline boundaries

Synthetic tests prove resolver calls, refusal paths, records, exact launch options
and cost variation. They do not prove a live account accepted the model or that
a native team tool consumed printed instructions. Those checks need a provider
login and an operator-authorized model call; no such calls were made for #2648.
CLI subprocess fixtures also require a host that permits process execution;
the worker sandbox can reject those with `spawnSync ... EPERM`.

The five named flow skills are updated. The remaining flows are tracked on
issue #2648 with the checklist below.

## Flow rollout checklist

- [ ] `flow-architecture-evolution`
- [ ] `flow-change-control`
- [ ] `flow-compliance-validation`
- [ ] `flow-concept-to-inception`
- [ ] `flow-construction-to-transition`
- [ ] `flow-cross-team-sync`
- [x] `flow-delivery-track`
- [ ] `flow-deploy-to-production`
- [ ] `flow-discovery-track`
- [ ] `flow-elaboration-to-construction`
- [x] `flow-gate-check`
- [x] `flow-guided-implementation`
- [ ] `flow-handoff-checklist`
- [ ] `flow-hypercare-monitoring`
- [ ] `flow-inception-to-elaboration`
- [ ] `flow-incident-response`
- [ ] `flow-iteration-dual-track`
- [ ] `flow-knowledge-transfer`
- [ ] `flow-performance-optimization`
- [ ] `flow-release`
- [ ] `flow-requirements-evolution`
- [ ] `flow-retrospective-cycle`
- [ ] `flow-risk-management-cycle`
- [x] `flow-security-review-cycle`
- [ ] `flow-team-onboarding`
- [x] `flow-test-strategy-execution`
