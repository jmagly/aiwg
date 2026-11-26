# Discovery graph research design (#3319)

Status: offline research acceptance; retain the default lexical ranking. The
approved surface shipped in `d88473750` (#4391): `aiwg discover
--experimental-graph` and optional `DiscoverParams.experimentalGraph`. No new
command, configuration root, service or schema family is proposed here.

## Implementation and boundaries

The source owners are `src/artifacts/discovery-graph.ts`,
`discovery-graph-communities.ts`, `discovery-graph-loader.ts` and
`query-engine-discover.ts`. The optional input belongs to the existing index's
`metadata.json.experimentalGraph`. Index rebuilds do not preserve observations.
Only supplied local fixtures provide co-use counts, similarities and timestamps;
the experiment neither learns edges from relevance labels nor calls embeddings.

| Stage | Implemented experiment | Limit / production prerequisite |
|---|---|---|
| Nodes | Active skills, rules and memories, keyed by entry path | Other discover types retain lexical candidates; this is not a general graph of all capabilities |
| Co-use | Positive `ln(pair_count × windows / (left_count × right_count))` | Synthetic counts in sample; real window collection and consent are outside this experiment |
| Proximity | Positive supplied similarities, guarded by shared top-k neighbours | No measured embeddings, mutual-kNN or Pathfinder implementation; synthetic similarities are not semantic evidence |
| Communities | Deterministic modularity moves, refinement and aggregation; extractive summaries capped at 2,048 characters | In-house Leiden prototype, without reference-library parity or Leiden theorem claims; summaries are retrieval seeds, not injected system instructions |
| Retrieval | Lexical top-50 seeds plus summary overlap seeds; PPR restart 0.2, at most 80 whole-graph iterations, delta < 1e-10 | This is bounded-iteration global PPR, **not** bounded forward local-push or streaming block retrieval |
| Fusion | Lexical + up to 0.25 normalized PPR + up to 0.05 sigmoid ACT-R prior | Fixed exploratory weights; no tuning on the reported outcomes |
| Decay | `ln(sum(max(1, age_seconds)^-0.5))`, supplied fixed clock | No autonomous collection, promotion or eviction policy is validated |
| Controls | Three fixed seeds (3319, 4239, 1819); degree-preserving double-edge swaps and label permutation; recompute summaries | Degree matching preserves unweighted degree, not weighted strength; bounded swaps do not guarantee uniform mixing |
| Source preservation | Immutable source files with SHA-256 references in the downstream sample | A summary may be stale; only inspected raw sources can support compiler values |

The implementation sums co-use and similarity weights for a node pair. It does
not preserve edge families in the resulting graph. Semantic proximity and
co-use are therefore hypotheses for retrieval, never validated invocation or
composition dependencies. A future persisted representation must preserve typed
provenance and validated composition edges separately, using existing owners and
contracts. No rollback-safe structural skill transformation was tested.

Flag-off discovery never consumes experimental observations. Flag-on discovery
reads cached local indices, rejects web/auto resources and does not build them.
With no edges, results and scores fall back exactly to lexical selection. Tests
cover these boundaries. Turning off the flag is the rollback mechanism; no
production ranking or persistent operator data changes in this study.

## Evaluation protocol

`tools/benchmarks/discovery-research.mjs` runs using local Node and tsx. It
isolates HOME, XDG directories, configuration and caches beneath `os.tmpdir()`;
all derived caches are removed afterward. Fetch is replaced with a failing
function. It builds today's framework index once and replays an unchanged copy
through the existing cached-local discovery API with per-query type filters and
limit 10. This measures ranking without index reconciliation or provider access.

The original 80 queries are recovered **byte-for-byte** from
`5e8940b81:test/fixtures/artifacts/discovery-relevance.jsonl`, the source named
by the [July 25 report](../reports/discovery-relevance-decision-2026-07-25.md).
Their checked-in copy is `test/fixtures/artifacts/discovery-relevance-80.jsonl`:
SHA-256 `dbffb0e626ae37c89f082a6eaf5a7924331fa676a4d65414b088162ee23bd7c5`.
The current 145-query fixture is left intact. The eight historical types each
have ten queries. Types absent from a fixture report per-type recall as null.
This is a development set against a changing corpus, not held-out evaluation or
a reproduction of the July corpus and its metrics.

The matrix uses the public default and flag-on ranking owners, with identical
read-only local settings. It records Hit@1/3/5, reciprocal rank, hard-negative
intrusion, result JSON bytes, per-query identity and latency. Empty-edge controls
reuse lexical results and timing; they are explicitly degenerate. Nonempty
controls run in the separate downstream sample. Control rankings start from
full, six-decimal JSON lexical scores and a prepared graph, so their timings
must not be compared with public flag-on calls.

The downstream sample has 16 synthetic documents and 12 tasks: four complete
configuration compilations, four contradictory-source cases and four missing
field cases. Expected answers and required-source labels are used only by the
scorer. Every strategy shares ceilings of one search, three document reads,
4,096 source bytes and one deterministic compiler pass. The compiler emits a
configuration only when every requested field has exactly one distinct value
in inspected raw sources; otherwise it abstains. Success requires the full
expected object or an expected abstention. Reports separate source retrieval,
source inspection, locally unsupported values, compilation and abstention.
Abstention can dominate aggregate accuracy, so positive compilations are shown
separately. This is an executable configuration task, not model reasoning or
coding-agent success.

Baselines are no memory, insertion-order raw retrieval, existing lexical,
source-linked ordinary-document organization, graph and seeded controls. Raw
retrieval is deliberately weak and order sensitive. Organization follows the
retrieved documents' immutable source pointers within the same three-read
ceiling; it does not substitute summaries for evidence. Organization time and
link storage are charged separately. The fixture is immutable, so maintenance
and staged atomic update performance are **not measured**. A full link rebuild
is the maintenance fallback, not evidence for continuous maintenance costs.

These controls carry forward the marginal-value questions in REF-3090 RawRAG,
REF-3091 Memory Tax, REF-3164 DISCERN and the supplied REF-3181/3182 issue
comment. The bibliography and author-reported research figures in #3319 are
motivation supplied by the issue, not independently re-read sources or newly
measured AIWG results in this offline study.

## CPU and memory budget

Carry forward the prototype targets: warm flag-on p95 ≤250 ms, serialized graph
plus lexical index ≤2× lexical storage, and sampled incremental process RSS
≤64 MiB after lexical warm-up. These are falsifiable experiment ceilings, not
production guarantees or test assertions. Graph construction is charged
separately; metadata and all generated lexical sidecars are in the denominator.
The downstream storage calculation also charges supplied graph input bytes.

Report absolute RSS as well as delta. The matrix's RSS includes all runs,
controls, JSON allocation and allocator/GC effects after index construction; it
cannot attribute all growth to graph nodes. A miss remains a miss. Fresh Node
processes measure total wall time, operation time, CPU usage and OS high-water
RSS for three distinct queries per strategy. They include tsx/module startup
and warm filesystem caches, so they are neither cold-disk latency nor compiled
CLI performance. No cold p95 is estimated from three observations.

The operator's on-demand tier correction remains binding: entry-level work must
open files, answer and exit without a vector server. The present whole-index
JSON parsing and whole-graph algorithm do not establish corpus-independent
memory bounds. Static postings/block files and bounded local-push remain future
work; embedded ANN and pgvector are optional higher tiers, not prerequisites.
No new storage service or dependency is justified by this study.

## Decision gate

Keep the feature default-off. Adoption requires no per-type Hit@3 regression,
a positive paired confidence-bounded retrieval change, downstream positive-task
improvement with the cheaper organization control, and passing CPU/storage/RSS
budgets on representative on-demand hosts. Current empty-edge parity cannot
establish a graph advantage. Synthetic source inspection cannot establish
current-model task success. Real composition validation, dynamic maintenance,
real co-use/embedding inputs, human calibration and representative multi-host
measurements require separate evidence and authorization where applicable.

Measured results and reproducible commands are in the
[research results](../reports/discovery-graph-research-2026-11-25.md).
