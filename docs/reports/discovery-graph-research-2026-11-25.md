# Offline discovery graph research results (#3319)

Measured on 2026-11-25 against source HEAD `03b42c06bc4c722f0767f437942e6f6484a74fff` plus this
worktree's evaluation changes. **Retain default lexical discovery and keep the
graph flag off.** The offline research deliverables are complete; adoption gates
fail and no current-model or human task-success claim is supported.

The [design note](../architecture/discovery-graph-research.md) specifies the
algorithm, source-preservation control, cost accounting and future boundaries.
[Machine-readable results](discovery-graph-research-2026-11-25.json) contain every
query ranking, source digest, configuration output, abstention and measurement.

## Reproduction and provenance

```bash
npm run typecheck
npm run build:cli
nice -n 19 node --import tsx tools/benchmarks/discovery-research.mjs
```

The runner creates private temporary HOME/config/cache directories and removes
them afterward. It uses no providers or network. The default result path is
`.worker/evidence/discovery-research.json`; an explicit worktree-local output
path is accepted. The checked-in result preserves this run, not an expected
performance snapshot for tests.

The historical fixture is the exact 80-line blob recovered from
`5e8940b81:test/fixtures/artifacts/discovery-relevance.jsonl` with digest
`sha256:dbffb0e626ae37c89f082a6eaf5a7924331fa676a4d65414b088162ee23bd7c5`. This is the eight-type set behind the July 25
report, rather than the first 80 rows of today's expanded 145-query set. The
expanded fixture remains unchanged. Corpus metadata has 4,238 entries;
its digest is `sha256:50fddc1c59153e59633fb42cbe74fc1af6c6d686f933df34754dbe3ad236ef1c`. The runner records all
lexical sidecar sizes/digests. Build timestamps may change their digests on a
repeat; the ordered ranking/metric digest matched across two completed runs:
`sha256:8d7463c21c58e8ec6da9cd6fbd2f1f8c8385e49f11776a36d04c15aebbcf7515`.

Host: linux x64,
AMD Ryzen 7 6800H with Radeon Graphics, Node v24.22.1. Measurements used
`nice -n 19` on a shared host with concurrent work, without CPU pinning,
page-cache eviction or forced garbage collection. Timing and RSS are observations,
not deterministic assertions. No assertion was relaxed to pass a budget.

## Existing 80-query set

| Strategy | Hit@1 | Hit@3 | Hit@5 | MRR | Hard-negative intrusion@5 | Warm p95 ms |
|---|---:|---:|---:|---:|---:|---:|
| Default lexical, cached local | 0.9125 | 0.9125 | 0.9250 | 0.916875 | 0.1875 | 88.714 |
| `--experimental-graph`, cached local | 0.9125 | 0.9125 | 0.9250 | 0.916875 | 0.1875 | 120.763 |
| Degree-matched / shuffled, all 3 seeds | 0.9125 | 0.9125 | 0.9250 | 0.916875 | 0.1875 | Reused lexical timing |

All **80/80** ordered result lists and scores match, including zero paired
reciprocal-rank differences. An interval for these identical observed differences
would collapse to zero; it would say nothing about graph benefit. The framework
has 749 eligible graph nodes and **zero supplied edges**.
Each node is an isolated community. The controls are degenerate and cannot
establish that graph topology improves retrieval. Counts/similarities were not
invented to fill the missing real observations.

Per-type Hit@3 is skill 0.9, agent 1, command 1, rule 0.5, flow 1, runbook 1,
template 0.9, behavior 1. `skill-04` ranks 4; `template-02` ranks 10;
`rule-02/04/06/08/10` have no relevant result in the first ten. These are
observations against the current index, not proven defects or graph regressions.
The July result (Hit@3 1.0, MRR 0.9875) used an older corpus/runtime; its numbers
are not carried forward as current success. The five newer types are absent
from this fixture and report null recall.

Mean top-ten retrieval result JSON size is
808.0 UTF-8 bytes
for both paths. This includes ranked identity/type/name/score only, not full
source context or token counts. Both paths use `noBuild=true`, local resources,
per-query type filters and limit 10; this is default **ranking**, not a complete
default CLI startup/reconciliation measurement.

## Downstream executable sample

Sixteen authored documents supply 16 nonempty synthetic graph edges. Twelve
tasks ask a deterministic compiler to produce four complete configurations,
abstain on four raw-source conflicts and abstain on four missing fields.
Raw evidence overrides stale derived summaries. Only inspected, hash-verified
raw documents can supply output values. Labels never seed retrieval or edges.

| Strategy | Total success | Positive configurations | Correct abstentions | Locally unsupported outputs | Reads | Source bytes |
|---|---:|---:|---:|---:|---:|---:|
| no-memory | 8/12 | 0/4 | 8/8 | 0 | 0 | 0 |
| raw-retrieval | 9/12 | 1/4 | 8/8 | 0 | 36 | 4488 |
| lexical | 8/12 | 0/4 | 8/8 | 0 | 36 | 5478 |
| organized-document | 12/12 | 4/4 | 8/8 | 0 | 36 | 4506 |
| graph | 8/12 | 0/4 | 8/8 | 0 | 36 | 5478 |
| degree-matched-random:3319 | 8/12 | 0/4 | 8/8 | 0 | 36 | 5472 |
| shuffled-graph:3319 | 8/12 | 0/4 | 8/8 | 0 | 36 | 5094 |
| degree-matched-random:4239 | 8/12 | 0/4 | 8/8 | 0 | 36 | 5472 |
| shuffled-graph:4239 | 8/12 | 0/4 | 8/8 | 0 | 36 | 4710 |
| degree-matched-random:1819 | 8/12 | 0/4 | 8/8 | 0 | 36 | 5472 |
| shuffled-graph:1819 | 8/12 | 0/4 | 8/8 | 0 | 36 | 3942 |

Every task shares ceilings of one search, three reads, 4,096 source bytes and
one compiler pass; no-memory uses zero searches/reads. The two source-linked
raw documents fit in the organized-document budget. The third read can inspect
the stale summary without trusting its facts. Graph/lexical inspect none of
the task-required raw sources in this sample; raw retrieval inspects 25% on
average, organization 100% (excluding missing-source cases with no available
required-source target). Source retrieval and inspection fractions are stored
per task separately from final success. Zero locally unsupported outputs means
all emitted fields have inspected raw support; it is not a factual-truth claim.

Aggregate 8/12 for no memory, lexical and graph consists entirely of correct
abstentions. It must not be presented as successful positive task execution.
Raw retrieval is a deliberately weak insertion-order baseline, succeeding on
the first domain's configuration only. Graph and lexical each compile **0/4**;
organization compiles **4/4**. The sample is small, authored and deliberately
source-link-friendly; it establishes this compiler's behavior, not human or
LLM effectiveness. No significance or generalization claim is made.

Nonempty controls changed 12/15, 14/14 and 12/15 edges (degree-matched/shuffled)
for seeds 3319, 4239, 1819 respectively. Their quality remains 8/12. Bounded
swaps preserve degree, without uniform-mixing or weighted-strength guarantees.
Controls use prepared graphs and rounded full lexical scores, so their timing
and retrieval-row context bytes are not directly comparable to public graph
calls. All final source-read budgets remain identical.

## CPU, storage and memory

| Measurement | Current 80-query corpus | Nonempty downstream fixture | Ceiling |
|---|---:|---:|---:|
| Warm graph p95 ms | 120.763 | 26.836 | ≤250 |
| Graph construction ms | 4.338 | 1.798 | Separately charged |
| Lexical index bytes | 9,709,817 | 5,943 | Denominator |
| Serialized graph bytes | 233,168 | 3,208 | Added storage |
| Supplied graph input bytes | 0 | 3,022 | Added storage |
| Storage ratio | 1.0240× | 2.0483× | ≤2× |
| Sampled RSS baseline MiB | 475.80 | 519.29 | Report absolute usage |
| Sampled RSS peak MiB | 598.49 | 538.04 | Report absolute usage |
| Sampled incremental RSS MiB | 122.69 | 18.75 | ≤64 |

**Current corpus misses RSS; nonempty downstream misses storage.** Construction,
queries, output allocations and all controls contribute to sampled RSS, which
is not graph-attributable retained heap. The prior completed matrix observed
228.81 MiB
incremental RSS, also failing; allocator/GC variability is material. The current
run builds its full lexical index in 5165.5 ms.
Index construction is outside warm query latency and is not free maintenance.

Organization constructs 611 bytes of source
links in 0.050 ms. Full rebuild is the
maintenance fallback; no changing-document or incremental maintenance workload
was run. Source bytes and returned metadata JSON bytes are recorded separately
per task, without an inferred token or model cost.

Fresh-process observations include Node/tsx/module startup and use warm disk
cache. Three distinct queries per strategy give ranges, **not cold p95**:

| Strategy | Process wall ms range | Operation ms range | OS high-water RSS MiB range |
|---|---:|---:|---:|
| lexical | 848.7–914.5 | 95.1–148.4 | 192.9–203.8 |
| graph | 932.0–963.3 | 120.1–176.1 | 202.8–215.9 |

These absolute RSS measurements are fresh processes and therefore avoid the
parent's index-build allocations; they still do not validate a streaming,
corpus-independent memory bound. Whole-index JSON and whole-graph PPR remain
limitations of this prototype.

## Disposition and remaining evidence

Research-phase design, original-query replay, executable downstream sample and
CPU/storage/RSS measurements are delivered. No production retrieval change is
justified. A useful follow-up needs independent task authors/human calibration,
real documented graph observations, current-agent execution with equal budgets,
source contradictions and atomic-update maintenance cases, and representative
on-demand CPU hosts. Live providers/paid runs are outside this offline brief;
no particular login or paid service is necessary for the delivered acceptance
artifacts. Keep raw sources available and compare ordinary source-linked
organization before expanding infrastructure.
