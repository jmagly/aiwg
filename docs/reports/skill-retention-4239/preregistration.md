# #4239 deterministic retention pilot: rerun protocol

This protocol was written before this worker's evaluation runs. It is a
prospective registration of a **rerun**, not a blinded new experiment: commit
`654d5b0046e91d3bd4dc8a9691204978baf722ba` (#4395) already publishes the fixture,
tests, protocol and expected outcomes in `tools/eval/README.md`. No claim of
independent query authorship, independent annotation or confirmatory inference
is made. No external paper was fetched or replicated.

Freeze the byte-identical fixture as `snapshot.json`. Before evaluation, record
its raw SHA-256, the harness's parsed-JSON SHA-256, original identities,
descriptions and executable body hashes, all task queries/oracles/alternative
cases, source revision and source/runtime file digests in
`snapshot-manifest.json`. Use the merged harness without changes.

The snapshot contains four old skills and four incoming skills in JSON/YAML
formatting, text case conversion, numeric ordering and summation families.
This represents confusable **control families**, not a representative sample
of deployed AIWG skills, natural user requests or agent tasks. Twelve tasks
contain four old-only, four new-only and four mixed annotated skill sets.
`mixed-invalid` intentionally supplies numeric input to a text operation.

Arrival sequences are fixed, inherited from the harness:

| Stream | Incoming IDs, in order |
| --- | --- |
| natural-random | sort-descending, yaml-format, sum-alternative, text-lower |
| confusable | yaml-format, text-lower, sort-descending, sum-alternative |

The fixture records seed 4239; the harness does not sample new permutations
from it. These are two fixed orders, not repeated random samples. Checkpoints
0 through 4 include the initial old catalog and every incoming insertion.
Tasks become eligible only when every annotated required identity has arrived.
Eligibility, inputs, queries, oracles and budgets are identical across arms.

Run unchanged metadata, body-only description replay, neighbour-aware
incoming-only replay, and current-discover parity control. Body-only uses
recorded body comment clauses; neighbour-aware sorts recorded clauses by
novelty against **original** descriptions of previously available skills.
Only incoming descriptions change. No new rewrite fixtures are authored.
Bodies, IDs and names remain fixed. Required sets, task inputs and queries
never enter the refinement function. This is procedural withholding; fixture
queries and clauses were published together and are not independent held-out
data. Clause membership rejects unsupported fixture capabilities/exclusions;
it does not validate arbitrary prose semantically.

All arms call the current built `discoverCapability` implementation against
the isolated project metadata index: local backend, project graph, skill type,
offline, noBuild, local resources, display limit 2, context ceiling 4096
characters, execution ceiling 2 steps and model budget 0. No graph-ranking
flag, production catalog, model/provider/embedding call or network is allowed.
Use a fresh temporary HOME and XDG directories, clear external artifact-path
overrides, and let the harness isolate AIWG_ROOT and delete temporary indexes.

Record strict all-required-ID coverage, independently case-validated functional
alternatives and executable task success **separately**, for every checkpoint
and old-only/new-only/mixed stratum. Alternative validation uses the frozen
two cases per task, distinct from its scored execution input, with the same
deterministic executor; this is no independent human adjudication. Execution
chooses the first selected implementation matching each requested operation.
Selection does not entail successful execution.

Primary paired comparison: final checkpoint, each stream separately, each
candidate arm versus unchanged, matched by task ID and stratum. Report wins,
losses, ties, missing/non-comparable rows and mean binary-outcome difference.
Report all-checkpoint pairs separately as dependent descriptive observations.
Report old-only checkpoint-versus-step-0 retention with fixed denominators.
Never count repeated checkpoints or streams as independent sample size.

Uncertainty: retain the harness's descriptive Wilson 95% intervals for each
arm/stratum rate. For each paired difference, exactly enumerate the empirical
paired bootstrap distribution by resampling the n task-level binary deltas
with replacement; use inverse-CDF 2.5% and 97.5% percentiles, without RNG or
pooling streams. Empty comparable sets have null estimates and bounds. These
small-fixture intervals describe sensitivity to empirical task reweighting,
not production confidence or independent-sample hypothesis tests.

Retain every route/error and failed execution in `results.json`; do not discard
partial runs. Repeat the unmodified harness once in a fresh temporary HOME and
retain `repeat-results.json`. Compare all outcomes after excluding only local
timing fields (`refinementMs`, `routingMs`, `executionMs`); report mismatches.
Do not tune descriptions, queries, order or budgets after observing results.

Sum incremental refinement calls/retries/embeddings, recorded model tokens/USD,
context/output characters, routing context characters, execution attempts and
measured local times by arm/stream. Character counts are proxies, not measured
token billing. Fixture authoring, semantic review, model lifecycle and real
agent execution cost remain unmeasured. Zero fixture calls cannot estimate
future model rewrite costs.

Decision rule: **no production change** unless independent production-catalog
and task evidence establishes benefit, fidelity, retention and acceptable
lifecycle cost. Even a positive synthetic result alone cannot pass that gate.
Reversal means removing these optional reports; production metadata, bodies,
router configuration and provider bootstrap stay unchanged. If future adoption
is proposed, require independently reviewed metadata and fixture regressions
before a separately authorized rollout. No model or human study is authorized
or implied by this rerun.
