# Decision backend-swap examples

`dispatcher-request-llm.json` exercises the packaged dispatcher and actual
`LlmSubagentDecisionAdapter` against a deterministic terminal worker fixture.
It is offline conformance evidence, not a live provider claim:

From a source checkout:

```bash
npm run build:cli
AIWG_DECISION_ENABLED=1 node \
  agentic/code/addons/decision-engine/skills/decision-evaluate/scripts/decision-evaluate.mjs \
  --request agentic/code/addons/decision-engine/examples/dispatcher-request-llm.json
```

From an installed package, after `aiwg use decision-engine`, run the deployed
script (for example `.claude/.aiwg/skills/decision-evaluate/scripts/decision-evaluate.mjs`)
with `--request node_modules/aiwg/agentic/code/addons/decision-engine/examples/dispatcher-request-llm.json`.
Relative paths in the request resolve against the request file, so the examples
run in place without copying.

`dispatcher-request-jev.json` runs the same ruleset through the Jev binding.
It names `projection-policy-jev.json`, which projects only `/message` as
untrusted internal state for `jev-latest` at `https://api.typesafe.ai`. Replace
`operator-declared-region` in both files with your recorded deployment region
before a live run; the evaluator denies an undeclared or `unknown` region, and
the dispatcher refuses the Jev adapter without a projection policy. The LLM
fixture adapter declares `egress: { mode: 'none' }`, so it needs no policy.

The Jev and LLM bindings pin the same `ruleset.json` and definitions. A backend
swap changes only `bindingPath` (and runtime credential/worker configuration),
not the ruleset, decisions, input, or outcome consumer.
