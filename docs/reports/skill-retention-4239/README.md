# #4239 retention pilot report

**Decision: no production change.** The merged #4395 harness reproduced its
previously published synthetic outcome. Both deterministic description rewrite
arms reduced mixed-task coverage and executable success. They provided no
observed retention benefit on old-only tasks. This pilot supplies no evidence
for a catalog rewrite, model-based refinement or a different retrieval design.

Source revision: `10625c1bd0a99a9af2c00bb2e6cefad702076504`.
Harness commit: `654d5b0046e91d3bd4dc8a9691204978baf722ba`.
Snapshot frozen at `2026-11-26T02:32:14.937Z` (UTC; November 25 locally).
Node `v24.22.1`, Linux x64, npm `11.11.0`.

## Registration and preserved artifacts

[Preregistration](preregistration.md) was written before this rerun and
explicitly discloses the published prior outcomes. It is not a new blinded
study. [Snapshot](snapshot.json) is byte-identical to the existing fixture:
`sha256:11d6b9b56d7b1895d534981b81a3c4d182c4f3ac054f4191e613c7eee20ad200`.
[Snapshot manifest](snapshot-manifest.json) freezes both sequence orders,
all original skill names/descriptions/body hashes, tasks, budgets, source
revision and protocol digest. [Runtime manifest](runtime-manifest.json)
records 5,349 built runtime file digests before evaluation.

[Primary raw report](results.json) and [repeat raw report](repeat-results.json)
each preserve 40 checkpoints, 308 eligible query observations, 231 paired
comparisons and 54 execution failures. Neither has a partial routing run or
non-comparable pair. The repeat had zero outcome differences after excluding
only three local timing fields. There are **12 unique tasks**, not 308
independent trials; arrival orders and repeated checkpoints are dependent.

[Paired summary](paired-summary.json) contains every checkpoint's comparisons,
old-only retention against checkpoint 0, failure rows and incremental cost
totals. [Analysis script](summarize.py) regenerates it without packages, models
or random sampling. It checks four known uncertainty distributions, frozen
digests, body hashes, original-neighbour membership, control parity and exact
repeat outcomes. [Artifact checksums](checksums.json) cover this report package
except the checksum file itself.

## Final checkpoint results

Each stream independently produced the following counts. Do not combine the
two streams to double the sample size. Strict means all annotated identities
are selected within limit 2; functional permits only the case-validated sum
alternative. Success means the deterministic executor produced the oracle
output for that task input. These are different measurements.

| Arm | Old-only strict / functional / success | New-only strict / functional / success | Mixed strict / functional / success |
| --- | --- | --- | --- |
| unchanged | 4/4 / 4/4 / 4/4 | 4/4 / 4/4 / 4/4 | 3/4 / 3/4 / 2/4 |
| current-discover | 4/4 / 4/4 / 4/4 | 4/4 / 4/4 / 4/4 | 3/4 / 3/4 / 2/4 |
| body-only fixture replay | 4/4 / 4/4 / 4/4 | 4/4 / 4/4 / 4/4 | 0/4 / 0/4 / 0/4 |
| neighbour-aware fixture replay | 4/4 / 4/4 / 4/4 | 4/4 / 4/4 / 4/4 | 0/4 / 0/4 / 0/4 |

Unchanged and current-discover are intentional parity controls using the same
current discover engine and original metadata. Every checkpoint had identical
query outcomes between these controls. Body-only and neighbour-aware arms also
had identical query outcomes at each matched checkpoint; this fixture cannot
establish a distinct benefit from neighbour-aware ordering.

All four old-only tasks retained strict, functional and execution success at
every insertion in both streams and all arms: checkpoint-0 to checkpoint-4
retention is 4/4, with zero wins or losses. One-skill tasks at limit 2 permit
both confusable skills to be selected, limiting sensitivity to interference.

## Paired uncertainty

Differences below are candidate minus unchanged, **per stream**, final
checkpoint; there are four matched tasks per stratum. Bounds are descriptive
95% percentile intervals from exact enumeration of empirical paired bootstrap
resamples, as registered. This tests sensitivity to weighting these four
observed tasks; it is no production confidence interval or significance claim.

| Candidate(s) | Stratum and metric | Wins / losses / ties | Difference (percentage points) | Descriptive 95% bounds (points) |
| --- | --- | --- | --- | --- |
| both rewrite arms | mixed strict | 0 / 3 / 1 | -75 | [-100, -25] |
| both rewrite arms | mixed functional | 0 / 3 / 1 | -75 | [-100, -25] |
| both rewrite arms | mixed success | 0 / 2 / 2 | -50 | [-100, 0] |
| both rewrite arms | old-only, every metric | 0 / 0 / 4 | 0 | [0, 0] |
| both rewrite arms | new-only, every metric | 0 / 0 / 4 | 0 | [0, 0] |
| current-discover | every stratum and metric | 0 / 0 / 4 | 0 | [0, 0] |

Degenerate all-tie intervals reflect this empirical distribution and do not
rule out effects on unseen tasks. Raw per-arm Wilson 95% intervals are also
retained: 4/4 gives [51.0%, 100%], 3/4 gives [30.1%, 95.4%], 2/4 gives
[15.0%, 85.0%], and 0/4 gives [0%, 49.0%]. No pooled-stream test is reported.

## Execution failures and interpretation

At the final checkpoint, the unchanged router selects `sort-descending` and
`sort-ascending` for `mixed-sort-json`, omitting `json-format`. That task fails
execution. It selects both required identities for `mixed-invalid`, but
`toLowerCase` rejects the numeric input; strict retrieval success therefore
does not imply task success.

With either rewrite, `mixed-lower-json` selects `text-lower` and `yaml-format`;
`mixed-sum-json` selects `sum-alternative` and `yaml-format`. Both omit
`json-format` and fail. The supported YAML description includes the exclusion
"Does not emit JSON objects." Its JSON keyword is a plausible lexical
interference mechanism, consistent with the selections; this was not isolated
by an ablation. Literal body support alone does not make an exclusion helpful
to this router. All failed executions remain in the reported denominators.

The sum implementations passed separate validation inputs for `old-sum`,
`new-sum` and `mixed-sum-json`. Functional coverage nevertheless equals strict
coverage in the observed real-router runs. The existing regression suite
separately exercises a replacement-only selection where these metrics differ.
No independent human semantic-equivalence judgment or agent execution occurred.

## Incremental accounting

Across all checkpoints in each arm/stream, the harness recorded zero
refinement calls, retries, embeddings, model tokens and USD. Both runs used a
network/subprocess refusal guard; it recorded zero attempted calls. All
refinements replay the pre-existing supported clauses; no model was invoked.
Routing characters count the harness's ID/description metadata plus each query,
not an actual rendered model context or billed tokens.

| Stream | Arm | Query/execution attempts | Routing characters | Refinement context / output characters | Local routing / execution / refinement ms |
| --- | --- | --- | --- | --- | --- |
| natural-random | unchanged | 38 | 16,569 | 0 / 0 | 164.75 / 0.90 / 0 |
| natural-random | current-discover | 38 | 16,569 | 0 / 0 | 60.34 / 0.51 / 0 |
| natural-random | body-only | 38 | 21,456 | 658 / 275 | 62.02 / 0.57 / 0.083 |
| natural-random | neighbour-aware | 38 | 19,749 | 4,254 / 204 | 60.16 / 0.52 / 0.135 |
| confusable | unchanged | 39 | 16,899 | 0 / 0 | 62.75 / 0.61 / 0 |
| confusable | current-discover | 39 | 16,899 | 0 / 0 | 61.40 / 0.53 / 0 |
| confusable | body-only | 39 | 22,141 | 658 / 275 | 60.37 / 0.66 / 0.044 |
| confusable | neighbour-aware | 39 | 20,407 | 4,218 / 204 | 62.43 / 0.73 / 0.088 |

These are primary-run local measurements; fixed arm order and cold imports
make timing comparisons unsuitable as efficiency estimates. Costs are summed
once per insertion, not repeatedly from accumulated refinement histories.
The context ceiling of 4096 applies to each route, not these aggregate totals
or refinement input. All routes stayed within budget. Fixture authoring, model
generation/retries, semantic review and downstream agent lifecycle costs are
unmeasured, not inferred free from fixture replay.

## Reversible recommendation and unresolved scope

Keep production skill metadata, bodies, router configuration and provider
bootstrap unchanged. This report does not justify #3319 graph retrieval
either. The explicit no-change outcome requires no migration, feature flag,
configuration addition or rollout. Removing this optional report directory
reverses this delivery without changing runtime behavior. No adoption is
proposed, so no adoption-specific fixture regression is needed; the seven
existing retention tests remain unchanged.

A subsequent study would need an independent production-catalog/task sample,
more arrival orders and limits, independent fidelity/alternative annotations,
and separately authorized paired agent executions with full lifecycle costs.
Those require human annotators and, for real agent/model arms, explicit
operator authorization plus a configured provider; paid spend and provider
login are neither requested nor assumed. Deterministic replay of the two
rewrite arms is complete; actual model-generated rewrite arms and agent
success are **not run**. The public fixture's query/description overlap,
small sample, comment-only fidelity checks and simplified executor prevent
generalizing these findings to production or to REF-3178.

## Reproduction and verification

The executed commands and receipts, including disposable HOME/XDG isolation,
are in the worker [criterion report](../../../.worker/report.md). To reproduce
the raw pilot using only existing dependencies from the repository root:

```bash
npm run typecheck
npm run build:cli
python3 - <<'PY'
import os, subprocess, tempfile
from pathlib import Path
with tempfile.TemporaryDirectory(prefix='aiwg-retention-replay-') as scratch:
    env = {key: value for key, value in os.environ.items()
           if not key.startswith('AIWG_') and key != 'NODE_OPTIONS'}
    env.update(HOME=scratch, XDG_DATA_HOME=scratch + '/data',
               XDG_CONFIG_HOME=scratch + '/config', XDG_CACHE_HOME=scratch + '/cache')
    output = str(Path(scratch) / 'report.json')
    subprocess.run(['nice', '-n', '19', 'node', 'tools/eval/skill-retention.mjs',
                    'docs/reports/skill-retention-4239/snapshot.json', output],
                   env=env, check=True)
    print(Path(output).read_text())
PY
python3 docs/reports/skill-retention-4239/summarize.py
```

The last command regenerates the archived pair summary from the two archived
raw reports, checks their repeat parity and validates the frozen protocol.
The rerun above prints a fresh raw report before removing its temporary files;
timings will differ. If the runtime has changed, compare it with the recorded
revision and manifests before interpreting differences.

Local verification passed: typecheck 1/1; CLI build 1/1; schema lint 258
registered schemas plus 35 executor definitions compiled, 9 fixtures inspected,
0 errors and 2 existing fixture-marker warnings; orchestration lint 23 packs
registered, 0 errors (managed/release qualification remains partial);
tools-area unit tests 298/298 in 21/21 files, including retention 7/7;
pilot and repeat 2/2 exits successful; paired analysis 1/1.
No schemas, runtime source, catalog entries or `CHANGELOG.md` were edited.
