# Contextual diagnostics fixture evaluation

This is a developer-labeled deterministic regression evaluation for #2297. The cases deliberately cover specified behaviors and counterexamples. They are not a random or representative sample of writing, an independent author/reader study, an estimate of population error rates, or human voice qualification. No generation model, provider or detector was used to produce these measurements.

The versioned fixture is `test/fixtures/writing/contextual-diagnostics.v1.json`. Each case records language, context stratum, original content, explicit options and labels with rule ID, exact UTF-16 start/end offsets, literal text, expected diagnostic presence and expected review/retention state. Labels were authored as editorial regression expectations before comparison with runtime output. An intentional retained phrase remains a correctly detected finding, with `retained` resolution; it is not a false positive simply because the author keeps it.

## Reproduce

Run:

```sh
npx vitest run --config config/vitest.config.js test/unit/writing/contextual-diagnostics-evaluation.test.ts
```

The test emits a `CONTEXTUAL_DIAGNOSTIC_FIXTURE_METRICS` JSON line with aggregate, language, context and language/context strata. It also checks exact returned text offsets, duplicate findings, exception resolution, French limitation notices and absence of a publication gate. Batch fixtures run their prior documents before evaluating the labeled target document.

A true positive matches a positive label's rule ID and exact span. An unmatched emitted finding is a false positive; an unmatched positive label is a false negative. A partial span therefore counts as both a false positive and a false negative. Precision is `TP / (TP + FP)` and recall is `TP / (TP + FN)`. Undefined denominators are `null`, including all-negative strata without any emitted findings. Negative labels count deliberate counterexamples; there is no claim to enumerate every possible true-negative span in free text. Case strata describe the intended context being exercised, rather than inferring population context prevalence from returned diagnostics.

## Recorded run

Measured on 2026-09-06, Node 24.12.0, Vitest 4.1.10: both evaluation tests passed. The 32 cases contain 15 positive labels and 17 negative labels. Exact-span results follow; `1` means all expected findings in this finite fixture matched, not a population guarantee.

| Stratum | Cases | Positive labels | Negative labels | TP | FP | FN | Precision | Recall |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| All | 32 | 15 | 17 | 15 | 0 | 0 | 1 | 1 |
| English | 26 | 12 | 15 | 12 | 0 | 0 | 1 | 1 |
| French | 6 | 3 | 2 | 3 | 0 | 0 | 1 | 1 |
| Prose, all languages | 20 | 14 | 3 | 14 | 0 | 0 | 1 | 1 |
| Code, English | 4 | 0 | 5 | 0 | 0 | 0 | null | null |
| Quote, all languages | 3 | 0 | 4 | 0 | 0 | 0 | null | null |
| Literal, English | 1 | 0 | 1 | 0 | 0 | 0 | null | null |
| Inventory, English | 2 | 1 | 2 | 1 | 0 | 0 | 1 | 1 |
| Checklist, English | 1 | 0 | 1 | 0 | 0 | 0 | null | null |
| Questionnaire, English | 1 | 0 | 1 | 0 | 0 | 0 | null | null |
| English/prose | 15 | 11 | 2 | 11 | 0 | 0 | 1 | 1 |
| French/prose | 5 | 3 | 1 | 3 | 0 | 0 | 1 | 1 |
| English/quote | 2 | 0 | 3 | 0 | 0 | 0 | null | null |
| French/quote | 1 | 0 | 1 | 0 | 0 | 0 | null | null |

The French accent-initial regression expects the full `été été` span, preventing recurrence of an internal-word partial match. Negative fixtures include zero-output cases, so perfect precision alone should not be read as coverage of all contexts. Context strata with no positive examples provide no recall estimate.

SHA-256 anchors for this measured run:

- `test/fixtures/writing/contextual-diagnostics.v1.json`: `179a54c637e2526b863b79afd6063564f9d3893f72a04fd8be40298e373300cd`
- `src/writing/contextual-diagnostics.ts`: `4eda6746eff88132216880fe3f2ed5490adee32243b02cec9facbc9f64591976`
- `test/unit/writing/contextual-diagnostics-evaluation.test.ts`: `e72c50f1cd5b1aa62d6dcc8a87f0ba2e981aa5bae8e29f1d6272bc8c7e5ab03e`

## Coverage and limits

English cases include advisory prose, Unicode offsets, overlapping explicit rules, disabled defaults, quoted and fenced/inline code, unclosed fences, literal textile terminology, inventories, checklists, supplied questionnaire context, intentional punctuation, uncertainty, domain terminology, explicit user rules, retained phrases, adjacent words, separated paragraphs and cross-document repetition. French cases include unsupported English defaults, explicit French rules, quoted rules, accented word repetition and uncertainty.

Contextual labels for literal descriptions and questionnaires are supplied to the API. These cases demonstrate honoring supplied context, not automatic semantic recognition of those contexts. A phrase checklist cannot detect all empty prose or semantic repetition. The fixture does not establish diagnostic performance in other languages, genre distributions, author groups or unseen user preferences. Independent labeled writing samples and blinded author/reader assessment remain separate qualification work. No numeric release threshold follows from these cases or from practitioner anecdotes.
