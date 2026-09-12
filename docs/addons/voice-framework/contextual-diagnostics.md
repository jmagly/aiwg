# Contextual writing diagnostics

The JavaScript package exports `diagnoseWriting`, `diagnoseWritingBatch` and
`writingContentHash`. `WritingValidationEngine.diagnose` uses the same implementation.
These are editorial review APIs: they return located findings and never rewrite
the input, infer authorship or certify publication readiness.

```js
import { diagnoseWriting, writingContentHash } from 'aiwg';

const content = 'Delve into the details.';
const first = diagnoseWriting(content, { language: 'en' });
const finding = first.diagnostics[0];
const reviewed = diagnoseWriting(content, {
  exceptions: [{
    ruleId: finding.ruleId,
    start: finding.start,
    end: finding.end,
    contentHash: writingContentHash(content),
    reason: 'The author deliberately chose this phrase.',
  }],
});
```

Version 1 returns `schemaVersion`, a content hash, language, UTF-16 offset
encoding, diagnostics and notices. `content.slice(start, end)` retrieves a
finding's exact original text, including Unicode. Findings retain overlapping
rules independently; each has an explanation, suggestion, advisory/user
authority, uncalibrated heuristic confidence and review/retained resolution.
An exception applies only to the same hash, rule and span. After content changes
it becomes a stale notice and must be reviewed again. No automatic learning
occurs from retaining a phrase.

The small built-in English phrase set is an editorial policy baseline. Other
languages receive an explicit limitation notice and may supply literal phrase
rules. This is not multilingual quality qualification. `rules` adds/replaces
rules by ID; `overrides` takes final precedence and `enabled: false` disables
the corresponding rule. User patterns are literal strings, not executable
regular expressions. Code and quotations remain protected even from explicit
user rules. Advisory phrase matches also respect inventories, checklists,
explicit questionnaire/literal context spans and `terminology` exemptions.
Intentional punctuation and necessary uncertainty are not banned patterns.

Repetition review covers adjacent duplicate words, separated identical
paragraphs and identical paragraphs across documents. It does not establish
semantic redundancy or detect all sentence skeletons. Use `repetition:word`
and `repetition:paragraph` overrides or reasoned span exceptions to retain
intentional repetition. Batch results are keyed by unique document ID and use
the same located-finding/exception contract. Do not put personal content in IDs;
cross-document explanations include the relevant ID.

## Compatibility

`WritingValidationEngine.validate` retains its numeric legacy fields and adds
`scoreSemantics: "deprecated-uncalibrated-heuristic"` and `contextualDiagnostics`.
Existing numeric values, CLI threshold options and exit behavior are preserved
for compatibility. `score`, `authenticityScore`, `aiPatternScore`, `humanMarkers`
and `aiTells` are deprecated heuristic names; none measures the probability of
human authorship. Migrate new callers to contextual findings and author review.
Legacy thresholds are not publication gates, and zero highlights is not one
either. The Python scanner is still a legacy adapter; it does not implement
this contextual API.

The [evidence ledger](natural-voice/evidence-ledger.v1.json) records the basis
and limits of this policy. These diagnostics do not complete semantic fidelity,
author profiles, revision, consumer application or human quality qualification.
