# Composition policy evaluation

This harness is the release-claim gate for composition policy documentation.
It measures one fixed task suite under one fixed settings envelope and reports
requested and realized resources separately. Complexity is never treated as
evidence of quality or efficiency.

The benchmark manifest, raw evidence, and summary use
`flow.aiwg.io/v1alpha1` with the distinct kinds
`CompositionPolicyBenchmark`, `CompositionPolicyBenchmarkRawEvidence`, and
`CompositionPolicyBenchmarkSummary`. Artifact identity belongs in `kind`, not
in an additional DNS label.

The harness extends the existing orchestration-topology-lab aggregation surface
through `summarizeEvaluationRuns()`. It does not create a second topology
evaluator. Composition execution remains `flow.aiwg.io/v1alpha1` `FlowGraph`.

## Reproduce the shipped conformance report

~~~bash
aiwg composition benchmark \
  agentic/code/addons/composition-engine/benchmarks/composition-policy-benchmark.v1.json \
  --raw-out /tmp/composition-policy.raw.json \
  --summary-out /tmp/composition-policy.summary.json
~~~

Byte-stable output follows from fixed tasks, fixture settings, seed, budgets,
policy profiles, metric definitions, thresholds, ablations, and failure cases.
The committed evidence files are the expected output. Their evidence mode is
`synthetic-conformance`: they test the harness and do not measure a real model.

## Fixed comparison

Every policy runs the same six task identities and fixture-model settings:

- technical debugging;
- conceptual explanation;
- practical planning;
- theoretical comparison;
- an agent plus read-only repository fixture; and
- an agent plus a sandboxed side-effect fixture.

The compared policies are single-pass, generate-evaluate-refine, parallel
candidates with best-output selection, strict 4/5 LCM, adaptive convergence,
and budget-gated partial synthesis. Single-pass is the baseline for every
reported delta. Strict LCM and adaptive convergence also receive a direct delta
record for quality, success, tokens, latency, activations, and failure rate.

## Measurement contract

Raw records include:

- task success, independent quality, constraint satisfaction, calibration
  error, self-judge score, independent score, and human-preference state;
- requested and realized tokens, tool calls, cost, latency, activations, and
  retries;
- budget adherence and utilization;
- convergence reason, HITL burden, observability, and recovery behavior; and
- evaluation provenance without drafts or private chain-of-thought.

Efficiency is always conditioned on accepted outcomes. A cheaper rejected run
does not count as an efficiency improvement. Speed-of-accuracy curves report
success rate, latency, and tokens at multiple independent-quality thresholds.
Budget adherence and budget utilization are distinct: early cutoff can satisfy
a cap while producing an unacceptable answer.

The self-judge is a calibration probe. An independent deterministic rubric is
the conformance scorer, and self-judge bias is reported as the score delta.
Blinded human preference is declared `NOT RUN`; empirical quality or preference
claims remain blocked until that path or another independent path is actually
executed.

## Ablations and failure injection

The manifest fixes ablation variants for track count, evaluator identity,
shared versus independent models, join policy, and budget. Provider-backed runs
must materialize each selected variant as raw records rather than silently
changing the base policy.

The conformance suite injects evaluator error, non-convergence, prompt
injection, denied tools, duplicate retry, and exhausted budget. Each case has an
expected terminal outcome and recovery action. Injection records are excluded
from normal-policy means and retained in the raw evidence stream.

Every benchmark must also declare at least one **negative control**. A negative
control keeps the task, model settings, metrics, thresholds, and evaluation
instrument fixed while applying a deliberately wrong policy patch. Choose a
mutation that targets the rule being compared—not an unrelated rule or a
different application. If the unchanged instrument accepts that control, or
the observed outcome differs from its expectation, the summary reports
`measurement_valid: false`, explains the invalid measurement, and the CLI exits
non-zero. Candidate policy runs and control records are reported separately.

## Composition versus alternative control structures

| Structure | Appropriate baseline | What must be measured |
|---|---|---|
| Plain Flow DAG / Airflow-style subset | Acyclic dependencies and fixed ordering | scheduler overhead, retry behavior, audit clarity |
| Graph-profile Flow | conditional routes, fanout/fanin, approvals, typed joins, bounded cycles | routing correctness, join failures, recovery, observability |
| Ralph-style loop | repeated improvement toward a verifier | convergence, regression, duplicate work, stop safety |
| RLM fanout/task tree | context decomposition and bounded recursive work | aggregation quality, context cost, subtree failure recovery |
| Provider-native workflow | provider-managed orchestration | portability loss, native observability, cost, failure semantics |
| Durable application code | stable high-volume business logic | implementation/operations cost, deterministic recovery, change rate |

Graph-profile Flow is not a general upgrade over these choices. The supported
position is narrower: a graph is useful when dependencies, conditional routing,
fanout/fanin, approvals, retries, audit, or multi-agent boundaries must be
explicit. A plain DAG should remain the baseline when the work is acyclic; a
loop should remain the baseline when recurrence is the essential structure;
durable code should remain the baseline for stable production logic.

All comparisons must report quality or success alongside latency, cost,
retries, HITL burden, observability, recovery, and failure rate. A leaderboard
that omits operational burden cannot open the release-claim gate.

## Claim gate

The shipped summary intentionally reports `BLOCKED`. Opening the gate requires:

1. repeated trusted provider runs with immutable model and prompt identity;
2. independent or blinded human evaluation rather than self-judge-only scores;
3. confidence intervals and replication across task families;
4. integrity-reviewed raw records, including failed and partial runs; and
5. a documentation audit that scopes each claim to the tested tasks, models,
   budgets, and control structures.

Until then, public text must not claim that composition graphs, strict LCM, or
adaptive stopping are inherently smarter, faster, cheaper, more accurate, or
more usable.

## Offline H1/H2 pilot

The existing eval runner now has an offline fixture pilot with 48 frozen tasks,
12 development / 36 held-out, H1 configuration arms and H2 control structures.
H2 uses this addon's FlowGraph runtime through a local fixture adapter, including
conditional routes, a constrained join and a weakened-join negative control.
This extends the eval dataset/result contracts; it does not change the six-task
synthetic benchmark above or supply model effectiveness evidence.

Run `node --import tsx tools/eval/src/index.ts offline-fixture --output markdown`
from the repository root. See [the eval README](../../../tools/eval/README.md)
and [schema brief](../../contracts/eval-pilot.v1.md). Reports retain failures and
partials, blinded executable-adjudication records, pinned resources, held-out
paired bootstrap intervals and success per total tokens. Human evaluation is
`NOT RUN`, H3-H6 are deferred, and the empirical claim gate stays `BLOCKED`.
