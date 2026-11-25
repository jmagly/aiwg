# Structured worker artifact acceptance

> **First time using AIWG?** Begin with [Install, Connect, and Verify](install-connect-verify.md).

In your agent conversation, ask:

> "Check this worker artifact against the independent fixture evidence. Keep the
> evaluator and expected values outside the worker’s writable files, use the
> existing protected verifier, and report field failures and verification evidence.
> Ask before running any provider evaluation."

The existing trusted worker verifier can run a deterministic field scorer as a
conductor-owned `--check`. JSON syntax and schema compatibility are recorded
separately from evidence support and task completion. This is an offline fixture
regression floor for #4241; passing it establishes scorer behavior, not model
reliability, provider compatibility, or deployment readiness.

## Authority and fixture versions

The input contract is
[`schemas/security/worker-acceptance-fixtures.v1.schema.json`](../../schemas/security/worker-acceptance-fixtures.v1.schema.json),
registered in the existing security schema catalog. The evaluator's
[`manifest.v1.json`](../../test/fixtures/worker-acceptance/manifest.v1.json) binds
source bytes/digests, output schemas/digests, independent expected values,
evidence spans, availability, criticality, aliases, units and metric policies.
Its policy version is `REF-3174-v1`; its gold version is
`independent-synthetic-v1`. There are 36 paired corpus cases plus a synthetic
nested executor-receipt control. The original twelve-case JSON is copied
byte-for-byte beside the manifest and bound by its digest.

Provenance: **section9/research-papers**, signed corpus commit
[`7f92a62b99d62d14b9c3a4fe499087d654cf6234`](https://git.integrolabs.net/section9/research-papers/commit/7f92a62b99d62d14b9c3a4fe499087d654cf6234):

- `documentation/analysis/projectfit-2026-11-16/REF-3173-missing-evidence-fixture-suite.md`
- `documentation/analysis/projectfit-2026-11-16/REF-3173-missing-evidence-fixtures.json`
- `documentation/analysis/projectfit-2026-11-16/REF-3174-field-scoring-contract.md`
- `documentation/references/REF-3173-phantomfill-schema-coerced-fabrication.md`
- `documentation/references/REF-3174-extractbench-complex-structured-extraction.md`

These analyses describe preprints with VERY LOW and LOW formal certainty and
proposed local protocols. Their published model rates are not AIWG results.
The copied suite is independently authored synthetic data, not a paper dataset.

## Existing harness integration

Keep the installed scorer, schema, pinned manifest, gold labels and source
receipts outside **all** worker-writable roots. The conductor chooses the
manifest digest and case ID before launch. Protect the scorer code and its
imports through the existing installed/protected-check ownership rules.
Never accept a candidate-supplied digest, policy, check command or gold label.
`candidateInput(fixture)` returns only source, question and schema; do not pass
the evaluator manifest or fixture JSON to a model.

The score instrument is
`tools/ralph-external/lib/structured-artifact-acceptance.mjs`. Supply these
conductor-owned arguments to the already-supported protected Node check:

```json
{
  "id": "independent-fields",
  "command": "/absolute/installed/node",
  "args": [
    "/absolute/installed/aiwg/tools/ralph-external/lib/structured-artifact-acceptance.mjs",
    "/absolute/protected/manifest.v1.json",
    "sha256:<conductor-pinned-manifest-digest>",
    "golden/receipt",
    "/absolute/worker-tree/answer.json"
  ]
}
```

Pass that JSON as the existing `--check` argument to
`aiwg ralph-external --verify-worker`. The verifier still requires a stopped,
owned run, host confinement and protected binaries. No isolation checks or
production schemas/defaults change. The instrument exits zero only if every
field and structural check passes. It writes JSON diagnostics and aggregate
`score`, `pass_count`, `total_count`. When used through `EvalHarness`, only the
existing aggregate allowlist reaches optimizer feedback. A nonzero check exit
maps to that harness's existing `error` status; it never becomes a pass.
Detailed diagnostics, source spans and oracle data stay private to the evaluator.

The verifier's existing digest/tree checks bind the exact candidate bytes and
retain failed worktrees. The scorer never rewrites candidates or repairs them.
Reports retain original bytes as base64 and their SHA-256. `scoreArtifact` can
score explicitly supplied repair bytes with a transformation log in a separate
`repair` result; raw acceptance and raw denominators remain unchanged.

## Scoring and reporting

- Preserve PRESENT, EXPLICIT_NULL, UNKNOWN, KNOWN_EMPTY and output MISSING_KEY.
  Missing keys never count as authorized abstention. Unknown evidence is not
  evidence of an empty collection or proof that a guess is false elsewhere.
- Required-arm absent cases intentionally have no grounded schema-valid answer.
  Record that conflict. Nullable and tagged-unknown escapes are separate arms;
  `{}`, malformed refusals, disclaimers and out-of-schema refusals get no escape
  credit. Present controls fail indiscriminate abstention.
- Reject duplicate keys (including escaped spellings), invalid UTF-8,
  non-finite numbers, comments, trailing commas and type coercion. Exact IDs,
  URLs, enums and counts retain lexical/type identity. Counts require safe JSON
  integers. Descriptive equivalence uses only a declared noncritical alias table.
- Quantities use declared unit conversions and decimal rational comparisons:
  `abs(pred-gold) <= abs_tol + rel_tol*abs(gold)`. At zero, only absolute tolerance
  provides a nonzero allowance. Quotes match pinned spans under exact or
  explicitly declared collapsed whitespace; no other normalization is implicit.
- Array alignment is deterministic, one-to-one and retained with gold/prediction
  indices, misses, spurious items, duplicate indices, TP/FP/FN and precision,
  recall/F1. Match exact item keys when configured; otherwise match exact values
  as a multiset. Ordered policies restrict alignment to the same index. Matched
  attributes still undergo independent field checks. Known-empty/empty scores
  1; unknown arrays have no ordinary recall. Duplicates never disappear in a set.

`scoreFixtureAttempts` schedules every manifest case, including missing outputs.
Repeated attempts need separately identified runs; duplicate/unscheduled IDs
are rejected. The primary denominator is the manifest's declared field-policy
positions (13 in the nested control); array attribute checks inform their parent
position. Expanded gold scalar leaves count null/unknown placeholders as one,
empty collections as zero, and object/array contents recursively. Array items
are counted independently. The nested control has 15 leaves and 2 array items.

Reports show the outcome vector, domain/arm/type/severity strata, domain macro
and field micro rates, absent-case/field fabrication, valid abstention,
present correctness, over-abstention and failed-output counts. Wilson intervals
are descriptive fixture diagnostics; these small correlated synthetic cases do
not estimate model reliability. `fieldPasses` includes supported passes and
valid abstentions; `supportedPasses` counts supported passes alone. Any invalid
or operationally failed output contributes zero end-to-end field passes, while
its raw field diagnostics remain visible. `validOnly` labels its selected
population explicitly. No aggregate overrides `criticalGate` or any failed
required task conclusion. The instrument accepts only complete field success.

## Later limited provider evaluation

No provider evaluation ran for this change. Before a separately authorized
limited evaluation, freeze independently annotated held-out sources, policy,
gold, scorer code, thresholds and resource budgets. Use two blinded annotators
for real-data availability/value labels and retain adjudications. Join execution
or authorization claims to independent executor/transaction receipts.

Preflight present controls against the provider's supported schema subset:
nullable unions, tagged `oneOf`, required fields, closed objects, minimum arrays
and strict numbers may differ across raw API, vendor CLI and constrained decoder
transports. Report these as separate strata. Unsupported schemas, admission
rejections, timeouts, transport errors, empty output, truncation and refusals
remain attempted failures. Never infer truthful refusal from empty output alone.

Pin requested and observed model/version, endpoint, effort, precision, prompt,
schema/source/output hashes, run/repetition IDs, output budget and retry policy.
Randomize arm order; isolate contexts to avoid response leakage. Record latency,
tokens, retries, tool calls and costs. Preregister present correctness, operational
error and resource budgets; critical unsupported accepted values fail the gate.
Compare nullable and tagged escapes separately and expand held-out domains before
any deployment claim. A semantic judge, if later authorized for noncritical
text, requires blinded calibration, a verifiable mapping and unresolved cases
withheld from acceptance. Fixture agreement supplies no such calibration.
