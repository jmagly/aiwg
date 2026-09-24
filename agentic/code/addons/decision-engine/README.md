# Decision Engine

The Decision Engine packages AIWG's normalized `decision.aiwg.io/v1alpha1`
contracts and the `decision-evaluate` dispatcher. A workflow pins a ruleset and
binding; changing only the binding selects Jev or an ordinary LLM subagent.

The addon is opt-in at two levels. It is deployed only when named:

```bash
aiwg use decision-engine                     # default provider
aiwg use decision-engine --provider codex    # any supported provider
```

Bulk deploys (`aiwg use all`, including `--copy-all`, and framework deploys
such as `aiwg use sdlc`) do not include it. Its manifest sets
`"explicitInstall": true`. A copy deployed earlier stays in place until you
remove it. Once installed, the dispatcher still refuses to run unless
`AIWG_DECISION_ENABLED=1` is set. Installing it does not enable inference,
migrate existing workflows, or give any outcome the authority to perform an
action.

Runnable offline examples ship with the addon in [`examples/`](examples/README.md).
They are included in the npm package at
`node_modules/aiwg/agentic/code/addons/decision-engine/examples/`.

See [the operator guide](docs/operations.md) and the repository-level
[decision specification](../../../../docs/decision/specification.md).
