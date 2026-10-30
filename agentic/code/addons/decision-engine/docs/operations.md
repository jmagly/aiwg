# Decision Engine operations

Decision evaluation is disabled unless `AIWG_DECISION_ENABLED=1`. Install the
addon, author immutable definitions/rulesets/bindings under an authorized
artifact root, and invoke `decision-evaluate` with runtime configuration kept
outside those portable artifacts.

## Install

> "Install the Decision Engine addon for Claude in this project."

Your assistant explicitly deploys the addon to the requested provider.

### Command reference

Deploy the addon by name to each provider that should see the skill:

```bash
aiwg use decision-engine --provider claude
```

`aiwg use all` does not include the addon, with or without `--copy-all`, and
neither do framework deploys such as `aiwg use sdlc`. The manifest's
`"explicitInstall": true` keeps it out of every bulk deploy. A copy deployed
earlier by a bulk deploy is left in place.

The deployed `decision-evaluate` script loads the compiled runtime from the
installed `aiwg` package, not from the project. It checks these locations in
order: `AIWG_ROOT` when it names a built package, an `aiwg` in a
`node_modules` directory above the script or the working directory, and then
the `aiwg` executable on `PATH`. If none is found, it exits with status 2 and
says how to fix it.

## Examples

> "Run the packaged Decision Engine example with its deterministic fixture worker."

Your assistant uses the offline example request with the deployed skill script.

### Command reference

The addon ships an offline example set in `examples/`. It includes a ruleset,
definitions, Jev and LLM-subagent bindings, and a deterministic fixture worker.
From an installed package:

```bash
AIWG_DECISION_ENABLED=1 node \
  .claude/.aiwg/skills/decision-evaluate/scripts/decision-evaluate.mjs \
  --request node_modules/aiwg/agentic/code/addons/decision-engine/examples/dispatcher-request-llm.json
```

Use the deployed script path for your provider. For a global install, the
examples are under `$(npm root -g)/aiwg/agentic/code/addons/decision-engine/examples/`.

## Backends and evaluation

> "Review this decision binding and dispatcher request before evaluation."

Your assistant checks the backend pin, projection policy, retry limits and independent action gates described below.

### Command reference

Jev uses `https://api.typesafe.ai/v1/systemone` with bearer authentication. A
binding stores only a logical `credentialRef`; the dispatcher request maps it
to an operator-provided environment-variable name. Production deployments
should provide that variable through their scoped secret reader. Logs and
receipts contain neither the value nor its private locator.

State projection is mandatory for network egress. Configure
`projectionPolicyPath` in the dispatcher request and declare the deployment
region in `adapterOptions.jev.region`; the dispatcher refuses network-capable
adapters without a policy, and the evaluator denies a policy whose origin or
region does not match the adapter. The region is the operator's recorded
deployment attribute. It is not enforced by the transport and does not certify
provider residency. Egress denials follow `RUN-JEV-EGRESS-v1` in
[the operations runbook](https://github.com/jmagly/aiwg/blob/main/docs/decision/operations/README.md). The live smoke additionally requires
`AIWG_DECISION_JEV_REGION` and runs through the same projection boundary.

An LLM binding pins a subagent. The runtime adapter module must resolve that
exact pin and execute a bounded, tool-free structured-output task. A plan-only
route, missing terminal event, prose wrapper, or schema-invalid object fails
closed.

Timeouts and retries are bounded twice: by each target and by the binding's
total deadline/attempt ceiling. The dispatcher is the retry owner; FlowGraph
nodes invoking it must set graph-level retries to zero. A backend swap creates
a new binding pin and invocation. Existing receipts are never reinterpreted.

Outcomes are data. Any downstream action goes through the ordinary AIWG policy
and authorization gates independently.

Single-question offload through `aiwg decision ask` is enabled by
`aiwg decision setup jev` and governed for agents by the `decision-offload`
rule. See the [Jev quickstart](https://github.com/jmagly/aiwg/blob/main/docs/decision/jev-quickstart.md).

To explicitly upgrade a string-only definition, build the package and run
`node agentic/code/addons/decision-engine/skills/decision-evaluate/scripts/decision-convert-definition.mjs <old.json> <new.json>`.
The command refuses to overwrite an existing output, prints the old/new digests,
and leaves ruleset pin updates to the author. Structured fields require
`decision.aiwg.io/v1alpha2`; historical v1alpha1 artifacts remain readable.

## Durable receipts

> "Configure durable decision receipts using a host-managed integrity key."

Your assistant configures logical key references and receipt storage without putting key values into portable artifacts.

### Command reference

Set `receiptDirectory` in the dispatcher request to keep durable,
HMAC-protected invocation receipts. The directory is resolved relative to the
request file. Receipts make a repeated `invocationId` replay the stored outcome;
the same `invocationId` with different request content fails `replay-mismatch`.

The integrity key comes from host configuration, never from the request or any
portable artifact. Name a logical reference with `receiptIntegrityKeyRef` and
map it to an operator-provided environment variable in `credentials`, the same
way a Jev `credentialRef` is mapped:

```json
{
  "receiptDirectory": ".decision-receipts",
  "receiptIntegrityKeyRef": "decision-receipt-key",
  "receiptIntegrityKeyEncoding": "hex",
  "credentials": { "decision-receipt-key": "AIWG_DECISION_RECEIPT_KEY" }
}
```

The variable holds at least 32 random bytes, encoded as `hex` (the default) or
`base64` (for example `openssl rand -hex 32`). Keep it stable for the life of
the receipt directory: receipts written under one key fail integrity checks
under another.

The dispatcher fails closed before evaluation and writes no receipt when the
key is not usable. It exits with status 2 and prints one JSON line to stderr:

| `error` | Cause |
|---|---|
| `receipt-integrity-key-missing` | No `receiptIntegrityKeyRef`, no `credentials` mapping for it, or the mapped variable is unset or empty |
| `receipt-integrity-key-invalid` | Unknown encoding, a value that is not valid for the declared encoding, or fewer than 32 decoded bytes |

Messages name the logical reference and the variable name only. The key value
never appears in results, receipts, or diagnostics. The receipt key's logical
reference is reserved: a binding that names it as a backend `credentialRef` is
refused, so the key cannot be sent to a remote backend.

## Held-out study collection

> "Review the synthetic held-out study setup and its approval requirements."

Your assistant uses the source-checkout guides to distinguish preparation and dry-run from separately approved collection.

### Command reference

Source-checkout operators can use the experimental, default-off
[shared held-out collector](https://github.com/jmagly/aiwg/blob/main/docs/decision/heldout-collector.md)
for synthetic D17/D29 study modules. Preparation and dry-run use source directly;
collection needs a separate priced, digest-bound approval and explicit env gate.
The collector does not promote models or establish study quality.

The [D29 v6 study](https://github.com/jmagly/aiwg/blob/main/docs/decision/d29-heldout-study.md) adds balanced
inventory facts, replacement-slot screening-control cases and explicit provider
labeling conventions. Passage baseline v2 is primary; unchanged passage v1 and
the original baseline remain secondary. Development and public-test audits cover
structural and claim-relative single/pairwise rules and an informational tree.
The public `d29-study-v6` demo is rejected for paid collection. Live observations,
reviewed calibration and completed human assessments remain pending.

Jev collection requires attested free output and reserves request bytes plus a
preregistered provider overhead allowance (default 512 tokens). Preserve the
separate spend counter, head and baseline files under the canonical artifact
root; deleting run directories does not restore spend allowance. The first
approval pins each study's budget in its baseline. Every mode and resume keeps
that budget and subtracts cumulative USD, calls and reserved tokens; changed
budgets are refused before credentials. Baselines missing this required budget
and damaged counters require operator reconciliation before further collection. See the
collector guide for the input-overrun assumption and repair requirements.
