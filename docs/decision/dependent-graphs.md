# Dependent decision graphs (experimental)

`DecisionGraph.v1.schema.json` and `planDecisionGraph` provide an opt-in, versioned DAG contract. Existing independent rulesets are unchanged. Validation precedes Flow compilation, adapter resolution, and any transport. A trusted caller supplies resolved definition/binding digests; model evidence cannot alter the graph, pins, permissions, or output projections. The graph has one entry, stage-ordered edges, named inputs/outputs, and declared terminals. A node with only guarded outgoing edges may also be terminal. Missing pins, duplicate IDs, cycles, ambiguous inputs, unreachable nodes, illegal projections and unsafe budgets fail closed.

## Flow-hosted execution

`decisionGraphToFlow` compiles stages into existing FlowGraph `skill` nodes whose `ref` is the host-authorized stable ID of the shipped `decision-evaluate` skill. There is no new Flow node kind or separate workflow executor. Flow owns run/node/activation/invocation identities, checkpointing, trace correlation, permissions and approval; node retry is zero. The model never supplies artifacts, transport configuration or permissions. Decision receipt-store replay precedes another backend call. Downstream actions still require separate authorization.

Two host bridges answer Flow's skill invocations; both pass only a node's declared predecessor evidence and map the result through a host-owned output projector:

- `decisionEvaluateSkillFlowInvoker` runs the skill itself. `resolveDecisionEvaluateSkill` resolves `decision-evaluate` through the capability catalog, which yields both the Flow `ref` (its stable catalog ID) and the script entrypoint declared in its `SKILL.md`. For each invocation the bridge writes a private dispatcher request (the documented `rulesetPath`/`bindingPath`/`definitionPaths`/`inputPath` contract, with Flow's run ID and invocation key), runs the script with a minimal environment (PATH, the opt-in flag and host-listed variables only), and accepts only a `RulesetResult` for the same run, invocation and binding pin. Request paths must be absolute and host-authored. The per-invocation directory is removed after the call and the skill's stderr is never copied into graph errors.
- `decisionRulesetFlowInvoker` is for embedded hosts: it calls the same `evaluateDecisionRuleset` that the skill script wraps, in process, with host-resolved artifacts and adapters.

`approvalStages` puts every node of the named stages behind an existing Flow `gate` node. The gate has the node's predecessors and guarded routes, so approval is requested only for a node that would otherwise run. Flow pauses with `APPROVAL_REQUIRED` until the host approves the gate (`approvedGates`), and resuming from Flow's checkpoint does not re-dispatch completed stages. A cancelled gate ends the run as `cancelled`. `admittedDecisionFlowAdapter` answers an approved gate without a transport call or budget charge. `finalizeDecisionGraphRun` must be given the same approval stages: it refuses a paused run, rejects a gated node that completed without its gate, and records each approval with its Flow node-run identity. Each approval wave adds one Flow activation to the compiled ceiling; it spends no decision attempt.

A fixed boolean `when` guard on an edge becomes a Flow state/route predicate. Flow v1alpha1 currently reports guarded-off nodes as `NO_RUNNABLE_NODES` rather than skipped. `finalizeDecisionGraphRun` accepts that condition only if every missing node has an explicitly inactive route trace (or descends from one), retains the original Flow status, and rejects unrelated failure or tampered outputs. It chooses the deepest completed declared terminal, breaking ties by stable ID. Its canonical graph receipt records stage, node, batch candidate/execution, attempt, approval, Flow identity, result digest, exact predecessor projection, and all resource usage. Completed speculative branches outside the selected terminal's evidence ancestry are marked unused but still charged. No result is exposed for incomplete, failed, exhausted or cancelled graphs. `FileGraphRunReceiptStore` writes private create-once receipts; its unkeyed checksum detects accidental edits, **not** malicious replacement. Flow checkpoints and decision receipts retain separate ownership and must be persisted by the host.

## Outcomes

A graph outcome is `complete` only when a declared terminal completed with its full evidence ancestry; only then is `value` non-null. A node that abstains or lacks a capability returns `status: 'abstained'` or `'unsupported'` with no outputs. Its attempt stays charged, its Flow node fails so no dependent runs on the missing result, and nodes it prevented are recorded as skipped with zero usage. The receipt keeps that earliest explicit cause as the outcome. The bridges' default classification (`decisionResultNodeStatus`) treats an `unsupported-capability` result, or one where every evaluation is unsupported or every evaluation abstained, as such a node; hosts with a ruleset-specific policy supply `status`. Other outcomes are `error`, `cancelled` (which dominates), `incomplete-evidence`, `budget-exhausted` and `empty-shortlist`.

## Budgets and scheduling

Graph/caller/workspace/provider limits narrow to their minimum. Optional `stageBudgets` further narrow a stage. `GraphBudgetLedger` synchronously reserves conservative full-attempt/token/priced-cost estimates before calls and bounds stage/cumulative deadlines, concurrency and usage. Unknown cost requires a host-provided bound; overrun cancels subsequent calls but cannot undo a remote charge. `admittedDecisionFlowAdapter` attaches the ledger to Flow's `invokeNode` seam and requires actual attempt/resource accounting. Backend retries/fallback consume the reserved attempts; Flow retries remain disabled. Callers must not describe post-hoc usage alone as pre-dispatch admission.

Compatible same-subject nodes are only **candidates** for native batching if target, model, state, egress, pins and predecessor projection agree. `decisionGraphParallelDispatch` additionally requires identical runtime inputs and authenticated host confirmation of native transport capability. It reserves every group member atomically, correlates responses by stable question ID regardless of arrival order, and never retries an uncertain batch as individual calls. An abstention inside a native batch fails the whole batch closed. Different subjects fan out separately within Flow concurrency limits. The decision dispatcher continues to own native batching *inside* each ruleset; this bridge does not introduce another transport.

## Patterns and evidence

`shortlistRerankTemplate`, `taxonomyBeamTemplate` and `extractorVerifierFallbackTemplate` provide pinned fixed topologies; they embed no application authorization policy. The shortlist guards reranking on a declared `has-candidates` boolean, which the host projector derives from the shortlist it projects; an empty shortlist never reaches reranking and ends as `empty-shortlist`. An optional taxonomy detail stage is pruned by `graphBeamFlowInvoker`, a deterministic host-side selector at Flow's existing skill invocation seam. Scores must be finite; width narrows through caller/stage/graph ceilings, with candidate ID as an explicit stable tie-break. This selector performs no inference and cannot create a candidate. The fallback template guards the ordinary-LLM branch on a declared verifier boolean; the verifier itself is terminal when no fallback is needed. These patterns can multiply calls and amplify early errors: they are not exact constraint solving.

## Offline evidence and its limits

Seeded property tests (the repository's linear congruential generator, no extra dependency) generate 120 random valid DAGs and check that the plan is identical under shuffled node, edge, terminal, input and output order, that stage/batch invariants hold, that evidence receipts are identical for any observation order, and that Flow-hosted receipts do not depend on the order in which parallel calls complete. A failing case reports its seed.

The paired benchmark runs 24 seeded tasks per pattern through the compiled graph (host admission, local beam selector, receipt finalization) and through an independently authored explicit FlowGraph with the same scripted provider. The provider answers are imperfect and task-dependent, and include empty shortlists and fallback branches. The benchmark compares accuracy against fixed labels, provider calls, tokens, priced cost and logical critical-path latency (each Flow activation waits for its slowest node's provider-reported duration); the DAG layer must change none of them. Host orchestration time is measured and reported (`AIWG_GRAPH_BENCHMARK_REPORT=1`) but not asserted. What this cannot show: real-provider accuracy, billable price, network or queueing latency, or whether a pattern beats a differently shaped workflow. Those need live providers and are tracked in #2686 with G5/G6 qualification. This capability is experimental and excluded from comprehensive-release claims until those gates pass.

The #2127 graph profile projects onto this same FlowGraph substrate. The skill-bridge suite reproduces its `success-path`, `hitl-blocked`, `hitl-denial`, `checkpoint-replay`, `runtime-failure` and `budget-limit` cases through the decision bridge, including the real skill script with the example fixture adapter (no provider or network). Decision stages keep Flow retry at zero and delegate retry/fallback to the dispatcher, so the profile's Flow-level `retry-exhaustion-fallback` case has no decision-stage equivalent.

## Acceptance traceability

Test IDs are unique across `test/conformance/decision-v1/graph-*.test.ts` (enforced by DAG-058).

| Criterion | Evidence |
|---|---|
| AC1 | Schema and model: DAG-001, DAG-005b, DAG-032 |
| AC2 | DAG-002, DAG-003, DAG-004, DAG-004b, DAG-005, DAG-006, DAG-042 |
| AC3 | DAG-001, DAG-005b, DAG-007, DAG-055, DAG-056, DAG-057 |
| AC4 | DAG-001, DAG-002, DAG-002b, DAG-036, DAG-037, DAG-038, DAG-055 |
| AC5 | DAG-007, DAG-025, DAG-028, DAG-040, DAG-050 |
| AC6 | DAG-008, DAG-011, DAG-019, DAG-020, DAG-021, DAG-023, DAG-024, DAG-043, DAG-053 |
| AC7 | DAG-007, DAG-008, DAG-014, DAG-028, DAG-034, DAG-036 |
| AC8 | DAG-016, DAG-034, DAG-035, DAG-044 |
| AC9 | DAG-008, DAG-009, DAG-010, DAG-011, DAG-030, DAG-046, DAG-047, DAG-048, DAG-052 |
| AC10 | DAG-013, DAG-014, DAG-017, DAG-026, DAG-032, DAG-033, DAG-034, DAG-040 |
| AC11 | Graph modules are separate and opt-in; the decision suites run unchanged |
| AC12 | This document |
| AC13 | DAG-012, DAG-013, DAG-022, DAG-026, DAG-049, DAG-050, DAG-051, DAG-052, DAG-053, DAG-054 |
| TV-22 | Vendor vector cited by the issue test gates; pattern and tie coverage: DAG-017, DAG-032, DAG-033, DAG-034, DAG-045, DAG-048 |
| Evidence plan | Barrier/fake-transport: DAG-021, DAG-024, DAG-036, DAG-037; adversarial: DAG-006, DAG-009, DAG-017; benchmark: DAG-018, DAG-045 |
