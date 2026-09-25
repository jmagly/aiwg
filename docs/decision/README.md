# Normalized decisions and rulesets

AIWG reads both `decision.aiwg.io/v1alpha1` and `decision.aiwg.io/v1alpha2` definitions as an opt-in shared runtime. The
same immutable decision definitions, ruleset, workflow input, and consumer can
run through a Jev binding or an ordinary LLM-subagent binding. Only the binding
changes; probabilistic values and confidence scales are not assumed equal.

The public TypeScript entry point is `aiwg/decision`. It provides schema and
semantic validation, RFC 8785-compatible pins, JSON Pointer projection,
three-valued predicates, deterministic composition, bounded retries and
fallback, receipt replay protection, and both adapter implementations. The
`decision-engine` addon packages the `decision-evaluate` dispatcher for
FlowGraph skill nodes.

Existing workflows are unaffected. Evaluation requires an explicit call and
binding; the packaged dispatcher additionally requires
`AIWG_DECISION_ENABLED=1`. Jev network use needs a logical credential mapping.
The standard test suite uses fixtures only. The live Jev smoke is separately
gated by `AIWG_DECISION_JEV_LIVE_SMOKE=1` and
`AIWG_DECISION_JEV_API_KEY`.

Read the [normative specification](specification.md), [architecture](architecture.md),
[implementation and migration plan](implementation-plan.md), and addon
[operations guide](../../agentic/code/addons/decision-engine/docs/operations.md).

Structured entry fields, version migration, and rollback rules are described in
[structured entries](structured-entries.md).
Jev request, retry, cancellation, and egress behavior is documented in the
[transport contract](jev-transport.md). State projection is mandatory for
network-capable adapters; see [state projection](state-projection.md) and the
[threat-control mapping](threat-control-mapping.md).

The [ensemble, champion/challenger and drift-response contracts](ensembles.md)
define versioned D17 schemas and pure validators. Their runtime is experimental
and not implemented.

The [offline pattern playground](pattern-playground.md) provides discoverable,
sanitized examples and a governed authoring checklist without requiring network
access or a provider credential.

Decision results are data, not authority. Any workflow action selected from an
outcome must pass the existing AIWG policy and approval gates independently.
