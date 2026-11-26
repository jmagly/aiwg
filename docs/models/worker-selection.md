# Worker selection foundation (#2642)

Schema brief, reviewed against the operator decision of 2026-11-24.
Canonical authority: `schemas/models/model-config-compatibility.v1.schema.json`,
ID `https://aiwg.io/schemas/models/model-config-compatibility.v1.schema.json`.
Catalog identity: `schemas.models.model.config.compatibility.v1` in
`schemas/catalog/domains/repository-json-schemas.json`; owner: `schema-models`.
Consumers: `ConfigLoader`, `WorkerSelectionPolicySchema`, and `resolveWorkerPlan`.
The TypeScript interface and Zod validator are projections of this authority.

```json
{
  "defaults": {
    "workerSelection": {
      "strategy": "cost-effective",
      "maxAutoTier": "standard"
    }
  }
}
```

Both fields are optional. Keeping them at workerSelection scope establishes a
single automatic ceiling across roles and constrained aliases. Role guidance
continues to own groups, role tier and effort ladders. No delegation root is added.

`strategy` ranks eligible tuples only. `cost-effective` sorts observed
economy/standard/premium pricing classes ascending; `quality` sorts descending;
`balanced` preserves configured group order, member priority/declaration order,
then effort order. Unknown pricing uses the role tier. Stable ties preserve that
configured order. Pricing classes are proxies, not measured quality or dollar
estimates. Exact pins, substitutions, and conductor choices retain their existing
eligibility requirements. Strategies never grant authority or change effort.
Omitting strategy preserves legacy configured ordering, as does `balanced`.

`maxAutoTier` applies only when explicitly configured, using `src/models/tiers.ts` names:
economy, standard, premium, flagship, and the max-quality compatibility alias for
flagship. Candidate tier is at least the role tier, raised by observed pricing
class or recognized flagship identity. Unknown pricing retains the role tier.
Candidates above the ceiling are visibly excluded; no silent tier substitution
occurs. Explicit human premium authorization or flagship election can exceed an
automatic ceiling, subject to all existing request authority checks. A pin,
conductor choice, quality strategy, or higher request maxAutoTier alone cannot.
Premium still requires confirmation and flagship still requires user election,
even when the configured automatic ceiling permits them.

Merge order remains builtin → user → project. Strategy uses ordinary leaf
precedence. The first explicit ceiling establishes the restriction; later
explicit ceilings may only narrow it. Widening emits OG_POLICY_RELAXATION,
retains the inherited ceiling and both raw contributions with source digests,
and makes ConfigLoader reject the candidate. Alias tier spellings compare by
normalized tier. Cache and replay digests continue to include the full policy
and each input config; these fields have no separate digest authority.

Compatibility: backward-compatible optional schema additions; legacy inputs
remain valid. Omitting strategy preserves configured member ordering; omitting
the ceiling adds no exclusions or diagnostics. Premium authorization and flagship
election retain their existing gates. Runtime numeric routing tiers are unchanged.
Valid/invalid fixtures live in `test/fixtures/models/worker-selection/`.
`worker-selection-foundation.test.ts` checks strict schema compilation, Zod
projection parity, defaults, merge origins/digests, loader rejection/cache
behavior, ranking, authority, and ceiling exclusions. The frozen #2876 fragment
is amended additively with its manifest digest; exact-match assertions remain.
`worker-selection-resolve.test.ts` loads policy files through source and freshly
built resolvers, freezes legacy members/exclusions/diagnostics, verifies explicit
ceiling narrowing, and checks the independent recovery
fixture's strict validator. That mirror accepts the same optional fields through
an explicit schema-only amendment in its refresh script; recovery behavior and
installation ownership remain pinned to the original baseline.

## Rules and generated context follow-up (#2644–#2646)

The existing policy now also accepts `mode` (`default`, `advisory`, `off`) and a
positive integer `returnBudgetTokens`. Prompt defaults are advisory and 2000;
the measurement gate still controls any scaffold flip. These fields merge as
ordinary leaves through ConfigLoader and never authorize a launch. The compact
template is always emitted, including without aiwg.config. Context guidance
uses cost-effective / premium when fields are omitted while explicitly retaining
the legacy resolver behavior described above. Set strategy and ceiling explicitly
for enforceable ranking/exclusion; no implicit ranking or authority migration is
performed. `aiwg config get --project defaults.workerSelection --origins` reads the merged
policy. Project `config set/reset` rejects every model-owned defaults subtree;
updates use the existing reviewed worker policy proposal/apply path with merged
candidate validation, so attempts to widen a user ceiling fail atomically.

Role floors and task adjustments remain `roleGuidance` / `taskClasses`, and
premium confirmation / flagship election remain the existing authority surfaces;
no separate min/orchestrator tier or flagship config namespace is added. Doctor
warns if a ceiling names flagship or its compatibility alias: a ceiling alone is
not election. Ralph's former `opus` fallbacks are gone: Ralph workers
resolve through this tier policy (#2648), with an explicit `--model` treated as an operator pin. MC's legacy Sonnet estimate is a labeled cache-cost
floor, not a model selector; managed worker launch and accounting already use
resolved invocation observations. Remaining end-to-end orchestration routing is
owned by #2648, and actual cost/accepted-task measurement by #2651. No live model
or human evaluation result is claimed by this follow-up.

The lightweight CLI ships the existing models-v2 defaults and compact rubric
template as runtime assets. A cold install can merge project workerSelection
preferences, including mode off, without installing the full framework corpus.

Native and qualified orchestration wiring is documented separately in
[Orchestration worker selection (#2648)](orchestration-worker-selection.md).
