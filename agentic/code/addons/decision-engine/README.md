# Decision Engine

The Decision Engine packages AIWG's normalized `decision.aiwg.io/v1alpha1`
contracts and the `decision-evaluate` dispatcher. A workflow pins a ruleset and
binding; changing only the binding selects Jev or an ordinary LLM subagent.

The `decision-playground` skill lists the installed decision pattern packs and
runs their offline recorded fixtures through the same evaluator, with no
credential or network access. See
[the pattern playground guide](../../../../docs/decision/pattern-playground.md).

The addon is opt-in. Installing it does not enable inference, migrate existing
workflows, or grant the resulting outcome authority to perform an action.
See [the operator guide](docs/operations.md) and the repository-level
[decision specification](../../../../docs/decision/specification.md).
