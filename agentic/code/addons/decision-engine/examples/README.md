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

The Jev and LLM bindings pin the same `ruleset.json` and definitions. A backend
swap changes only `bindingPath` (and runtime credential/worker configuration),
not the ruleset, decisions, input, or outcome consumer.
