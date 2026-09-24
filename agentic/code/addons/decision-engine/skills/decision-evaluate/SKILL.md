---
namespace: aiwg
name: decision-evaluate
platforms: [all]
description: Evaluate a pinned normalized decision ruleset through an explicitly configured Jev or LLM-subagent binding
requires:
  - feature-enabled: AIWG_DECISION_ENABLED=1
  - request: dispatcher request JSON with authored artifact paths and runtime adapter configuration
ensures:
  - normalized-result: returns a decision.aiwg.io/v1alpha1 RulesetResult
  - backend-boundary: definitions and rulesets contain no vendor request payloads or credentials
script:
  entrypoint: scripts/decision-evaluate.mjs
  runtime: node
  cwd: project-root
  argsHint: "--request <dispatcher-request.json>"
---

# Decision Evaluate

Evaluate one pinned `DecisionRuleset` with one `DecisionBinding`. The dispatcher
validates pins, input, capabilities, typed outputs, retry/fallback budgets, and
composition before returning an outcome as data. It never authorizes or
executes the outcome.

The request document is runtime configuration, not a portable decision
artifact. It names `rulesetPath`, `bindingPath`, `definitionPaths`, `inputPath`,
`runId`, `invocationId`, optional `receiptDirectory` (which requires
`receiptIntegrityKeyRef`; see `docs/operations.md`), `credentials` mappings
from logical reference to environment-variable name, and optional
`adapterModules` for configured worker transports. Credential values are read
only at adapter call time and never written to results.

Set `AIWG_DECISION_ENABLED=1` explicitly. Existing workflows remain unchanged
when the flag is absent.

The deployed script loads the compiled runtime from the installed `aiwg`
package through `scripts/runtime-root.mjs`: `AIWG_ROOT` when it names a built
package, then a project `node_modules/aiwg`, then the `aiwg` executable on
`PATH`.
