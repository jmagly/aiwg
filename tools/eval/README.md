# AIWG Model Evaluation Suite

Evaluate local and cloud models for AIWG compatibility across 6 dimensions.

## Quick Start

```bash
cd tools/eval
npm install
npx tsx src/index.ts hermes3:latest --verbose
```

## Dependencies

`tools/eval` depends on `@matric/eval-client` from the private Gitea npm registry. The `.npmrc` in this directory configures the `@matric` scope automatically — `npm install` picks it up without extra setup.

`@matric/eval-client` is a TypeScript client for the Python [matric-eval](https://git.integrolabs.net/roctinam/matric-eval) framework. When the `matric-eval` binary is installed and on `$PATH`, standard benchmark scores (HumanEval, GSM8K, ARC, etc.) can be included alongside AIWG-specific dimension scores.

## Dimensions

| Dimension | Weight | What it tests |
|-----------|--------|---------------|
| Tool Use | 25% | Correct tool selection and parameter formatting |
| Instruction Following | 25% | Constraint adherence, multi-part requests |
| Coding | 20% | Code generation quality and correctness |
| Structured Output | 15% | JSON/YAML/Markdown generation |
| Reasoning | 10% | Task decomposition and planning |
| Context Handling | 5% | Long-context accuracy |

## Scoring

- **90-100**: opus tier — fully compatible
- **70-89**: sonnet tier — good with minor limitations
- **50-69**: haiku tier — partial compatibility
- **Below 50**: not recommended

## CLI Options

```bash
npx tsx src/index.ts <model-id> [options]

Options:
  --backend <type>      ollama or api (default: ollama)
  --dimensions <list>   Comma-separated dimensions to evaluate
  --output <format>     json or markdown (default: markdown)
  --ollama-url <url>    Ollama API URL (default: http://localhost:11434)
  --integrity-mode <m>  standard, fresh, locked, or full-locked
  --fresh-workspace-required
                        Hold promotion unless workspace freshness is verified
  --fresh-workspace-verified
                        Record runtime evidence that workspace freshness was checked
  --baseline-score <n>  Add a paired overall-score baseline
  --baseline-label <s>  Label for the paired baseline
  --verbose             Show detailed progress
```

## Evaluation Integrity and Release Gates

Every runner-produced JSON and Markdown report includes:

- `sample_n` and a 95% Wilson uncertainty interval
- `paired_baseline` when a baseline score is supplied
- `integrity_state` and `trusted_score_source`
- explicit `fresh_workspace_required` and `fresh_workspace_verified` evidence
- `compromise_labels` using `test_edit`, `scorer_edit`, `fixture_edit`,
  `metric_leakage`, or `unknown`
- `weak_signal_reason`
- a calibrated `PROMOTE`, `HOLD`, or `ROLLBACK` release-gate decision

`standard` mode preserves the historical execution path, but labels its scores
as unverified smoke diagnostics and holds release promotion. `locked` snapshots
the datasets and scoring implementation before the run and detects changes.
`fresh` additionally requires caller-provided workspace-freshness evidence, and
`full-locked` combines both expectations. A freshness declaration is evidence
provenance, not a substitute for an isolated workspace created by the caller.

Example:

```bash
npx tsx src/index.ts hermes3:latest \
  --integrity-mode full-locked \
  --fresh-workspace-required \
  --fresh-workspace-verified \
  --baseline-score 78 \
  --baseline-label previous-release
```

Dimension scores are smoke diagnostics unless integrity and uncertainty fields
are present. A high score cannot override detected fixture/scorer/test edits or
an unverified freshness requirement.

## Adding Test Cases

Test cases live in `datasets/<dimension>/` as YAML files:

```yaml
id: unique-test-id
dimension: tool-use
difficulty: basic
prompt: |
  The prompt sent to the model...
expected:
  tool_calls:
    - tool: Read
      params_contain: { file_path: "example.ts" }
  contains: ["keyword"]
  must_not_contain: ["forbidden"]
  valid_json: true
scoring:
  correct_tool: 0.4
  correct_params: 0.4
  no_hallucination: 0.2
```

## Offline skill metadata retention pilot (#4239)

The optional pilot extends discovery evaluation without changing the production
router, catalog, bodies, provider bootstraps, or public configuration. Build the
CLI first, then run from the repository root with an isolated HOME and project
artifact environment (no model calls, downloads, credentials, or paid runs):

```bash
study_home=$(mktemp -d)
HOME="$study_home" XDG_DATA_HOME="$study_home/data" \
  AIWG_ARTIFACTS_PATH= AIWG_PROJECT_ARTIFACTS_PATH= AIWG_PROJECT_AIWG_DIR= \
  node tools/eval/skill-retention.mjs \
  test/fixtures/artifacts/skill-retention.json /tmp/skill-retention-report.json
```

`skill-retention.json` preregisters eight synthetic skills in four operation
families, twelve held-out queries and executable oracles, initial old/new cohorts,
required identities, alternative candidates, a fixed random permutation and a
pair-adjacent confusable stream. Its digest is pinned by the regression test.
This is a representative **control fixture**, not a representative sample of the
AIWG catalog. Original names/descriptions and SHA-256 executable body hashes are
retained in every run. Queries and execution oracles never enter refinement.

All four arms use the shipped local discover implementation, the same index
fields, display limit, context-character ceiling, execution-step ceiling and
zero model budget. Unchanged metadata and current-discover are intentional parity
controls. "Body-only rewriting" means description rewriting from incoming-body
clauses; executable bodies stay byte-identical. Neighbour-aware incoming-only
refinement orders supported clauses by novelty relative to **original** prior
metadata; it never rewrites older descriptions. Candidates are authored fixture
clauses, not model generations. Exact comment-clause support rejects unsupported
capabilities and misleading exclusions for this controlled vocabulary. It is not
a semantic fidelity validator for arbitrary natural-language descriptions.

Each insertion retains raw selections, errors and failed execution outcomes.
Only tasks whose required skills have arrived are eligible, identically across
arms. The report separates old-only/new-only/mixed strict full identity coverage,
functional coverage after independent executable alternative checks, and task
success under a deterministic executor. Mixed tasks require all steps to work;
a deliberately invalid-input task prevents equating selection with success.
Paired arm comparisons keep every eligible query, including failed routes marked
non-comparable. Initial and later insertion reports permit old-task retention
comparisons without changing denominators. Wilson intervals are descriptive;
repeated tasks/streams are dependent and provide no population-level inference.

Costs include zero calls/retries/embeddings/model tokens/USD, measured local
routing/execution/refinement time, refinement comparison/output characters, routing metadata
and query characters, and execution attempts. Refinement costs are incremental per insertion (not
cumulative across checkpoints). Character counts are proxies, not
billed token counts; fixture authoring effort and model lifecycle costs are
unmeasured. Frozen descriptions are a replay, not evidence that a model can
produce faithful refinements at that cost.

**Recommendation: no change.** Synthetic retrieval gains cannot establish agent
task improvement or justify production metadata changes or graph retrieval.
Keep the catalog/router unchanged; removing the optional pilot reverses this
addition. A production recommendation needs a separately approved, independent
catalog sample, semantic fidelity review, paired agent executions, and full cost
measurement. No model study or external research replication is claimed here.

In the frozen pilot, at the final insertion both streams give the unchanged and
current-discover controls 4/4 old-only and 4/4 new-only executable successes,
with 3/4 mixed strict coverage and 2/4 mixed executable successes. Both rewrite
arms retain 4/4 old-only and 4/4 new-only successes but fall to 0/4 mixed coverage
and executable successes. Accurate exclusions can mention a neighbour's keywords
and still interfere with lexical selection. These small, dependent observations
support the no-change decision for this pilot; they do not estimate production
benefit or reproduce the cited paper. The JSON report retains every insertion,
query, paired delta, descriptive interval and failure for inspection.

## Offline H1/H2 fixture pilot

From the repository root, using its existing development dependencies:

```bash
node --import tsx tools/eval/src/index.ts offline-fixture --output markdown
```

The reserved `offline-fixture` model identity selects the fixture path before any
model client is created. It runs 48 frozen tasks (16 corpus verification, 16 coding
repairs, 16 mixed security/testing; 12 development and 36 held-out) across four H1
configuration tapes and four H2 FlowGraph controls. It uses no HTTP, model CLI,
paid evaluator or human labels. H1's discover/expert selections are frozen fixture
contexts, not fresh discovery or expert decisions. H2 invokes the existing Flow
runtime with a local adapter and includes a weakened-join negative control.

The existing runner also exposes
`AiwgEvalRunner.runOfflinePilot(datasetPath, fixtureRoot)` for callers that need
JSON results without CLI output. The frozen manifest lives in
`datasets/composition-pilot.json`; synthetic replay tapes, context, graphs and
hidden vectors live in `test/fixtures/eval-pilot/`. The returned EvalReport's
optional `pilot` projection retains every EvalResult, check outcome, failed and
partial run, resource observation and blinded executable-adjudication entry.
Human adjudication is `NOT RUN`. Resources are fixture observations, and context
tokens use `ceil(UTF-8 bytes / 4)` rather than a model tokenizer.

Held-out comparisons use paired task bootstrap intervals (2,000 resamples, seed
3315) and success per total tokens, charging failed and partial runs. Development
summaries remain separate. Fixture replay never opens the empirical claim gate:
it remains **BLOCKED** until real, trusted runs and independent adjudication exist.
See [the contract brief](../../docs/contracts/eval-pilot.v1.md) for authority,
compatibility, hidden-check boundaries and deferred H3-H6 work. To freeze a new
revision, review changes to the manifest and referenced file digests explicitly;
the runner never rewrites its commitments.

The offline pilot also emits the frozen criterion-calibration recommendation for
#4240. Corpus, coding and security checks keep authority. Q1–Q6 are
non-executable. The report makes no empirical reliability claim: judge and human
labels remain NOT RUN, acceptance thresholds are not predeclared, and the claim
gate remains BLOCKED. See
[criterion calibration](../../docs/decision/criterion-calibration.md) for the
versioned rubric, family split, receipt bindings, abstention denominators,
statistics, annotation protocol and limitations.
