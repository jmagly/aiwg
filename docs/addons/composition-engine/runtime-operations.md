# FlowGraph runtime operations

## Ownership boundary

The FlowGraph runtime is a deterministic planner/executor beneath the existing
mission layer. It decides the runnable set, freezes activation inputs, applies
reducers in manifest order, evaluates routes and joins, and enforces graph
authority and ceilings. MissionConductor remains the durable owner of the
activity ledger, provenance, aggregate cost, best-output decision, and crash
checkpoint. Integrations persist the runtime's event and checkpoint projections
through **onEvent** and **saveCheckpoint** callbacks.

Every event includes **graphId** and **runId**. Node events add **nodeId** and
**nodeRunId**; route and join events add stable edge identities. These fields
can be projected into A2A, Sandbox, Cockpit, or provider messages without
changing those protocols.

## Adapter contract

An adapter module exports an object with this minimum shape:

~~~javascript
export default {
  id: 'sandbox-v1',
  async invokeNode(request) {
    return {
      outputs: { result: 'typed value' },
      usage: { tokens: 120, costUsd: 0.003, timeMs: 420 },
      score: 0.91,
      citations: ['artifact://evidence/42'],
    };
  },
};
~~~

Requests contain the authorized node, immutable inputs and state snapshots,
activation and node-run identities, one stable invocation key, and requested
resource ceilings. Adapters must return every declared output and non-negative
realized usage. They must pass the invocation key unchanged to mutating tools.

Eligible side-effect-free nodes can be delegated through
**parallelDispatch(requests, invokeNode)**. The adapter returns results in
request order; the runtime commits reducers and trace events in stable manifest
order even when workers finish in another order.

## Retry and mutations

An idempotent or exactly-once node receives the same invocation key across
bounded retries. Successful receipts are checkpointed and replayed without a
second adapter call. Approval-required work cannot be retried automatically,
and a gate needs explicit host approval or a signed authorization receipt before execution. The runtime
never prompts on its own: without approval it emits `run-paused`, persists the
checkpoint, and returns `status: paused` before invoking the gated node. Resume
with that checkpoint and `approvedGates`; a cancelled gate returns
`status: cancelled`, while adapter failure after approval follows the declared
node failure policy. `operatorAction: stop` cancels before another node starts.

A gate may declare an optional `hitlAction` in the host-authored flow definition:

~~~json
{
  "category": "repo.read", "repo": "example/repo", "target": "repo:example/repo",
  "environment": "local", "resources": ["src/index.ts"], "verb": "read",
  "reversible": true, "impact": "low"
}
~~~

The host must classify the exact pending execution plan. Never copy descriptors
from node inputs, worker output, issue content or model text, or infer effects
from a gate's description. Unknown effects keep human review. `target` and
`verb` default to `repo:<repo>` and the category's final component; `repo.edit`
also needs the host's `actor` and exact `inputDigest` binding.

Before an unapproved gate or its `approval-required` dependent runs, Flow lazily
calls `checkHitlAuthorization` with that captured descriptor. Programmatic hosts
pass `projectDir` (default: process cwd); `composition run` binds it to its host
cwd. Only `auto-authorized` with a receipt containing `file` and `effectId` adds
the gate to this run's approved set. Reports and checkpoints preserve the receipt,
provenance and optional grant link in `evidence.nodes[gateId].authorization`.
Gates without descriptors and any unavailable, failed or non-authorizing check
retain `APPROVAL_REQUIRED`. Cancellation overrides both automatic and explicit
approval. Resuming does a fresh lookup when approval is needed; checkpoint
evidence and adapter outputs never supply approval. Capability, permission,
budget and decision admission checks remain independent.

Exactly-once is reported as observed behavior, not inferred from declaration.
Per-node evidence counts attempts, duplicate detections, and receipt-based
suppressions. Public invocation keys contain digests of declared idempotency
material; the declared key itself is never emitted.

Authority is intersected at runtime. **allowedCapabilities** and
**allowedPermissions** may narrow the graph declaration but never widen it.
Denial occurs before the adapter is called.

## Ceilings, joins, and failures

Activation, token, cost, and time ceilings are independent. Adapter usage that
would exceed a ceiling is rejected before its result is committed. LCM joins
advance a deterministic activation clock; periods four and five therefore meet
at activation 20. Converged and budget joins always stop at their declared
iteration or resource boundary even if a predicate never succeeds.

A feedback route may declare `progress: { state, direction: decrease }` for an
initialized integer state using the `replace` reducer. Every active feedback
edge must then observe a strict decrease. Flat or increasing state stops with
`CYCLE_PROGRESS_STALLED` before the broader `maxIterations` or graph ceiling;
the hard bounds remain mandatory as an independent safety control.

Failure policy selects fail-fast, continue, optional-skip, fallback, or typed
partial synthesis. A typed-terminal-failure output returns a stable error
object. Final-only mode emits no draft to the CLI; approved progress and
terminal errors remain available through the event callback.

## Checkpoint and replay

Use **--checkpoint** to atomically persist the latest projection and **--resume**
to continue it. Keep the same run ID and adapter contract. Completed nodes are
not called again. The checkpoint records only public execution metadata,
declared state/results, resource usage, and mutation receipts—not private
chain-of-thought.

## Outcome evidence and observation limits

Nodes can declare exact file/resource scope and adapters can return normalized
`observedTouches` arrays plus `observationComplete`. Reports compare declared
and observed sets and classify coverage as `empty`, `reduced`, `complete`, or
`divergent`; undeclared and unobserved entries remain directly queryable for
policy assertions. Only string identifiers are retained—tool payloads,
credentials, and file contents are not evidence fields.

Resource evidence attributes adapter-reported tokens, cost, and elapsed
`timeMs` to nodes and tracks (branches), and snapshots source totals at joins.
These are additive work totals, not wall-clock critical-path duration. Complete
touch observation depends on the adapter/platform: runtimes without filesystem
or resource telemetry must return `observationComplete: false`, and consumers
must not interpret an empty set as proof that nothing was touched.

## Trace safety

Metadata traces contain identities and digests. Binding traces add declared
binding names. Full-I/O traces include declared inputs and outputs after JSON
Pointer redaction. Configure redaction for every sensitive field and verify the
captured trace before enabling full-I/O in production.
