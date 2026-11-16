# Contextual writing diagnostics

> "Show contextual findings in this text and retain the phrases I deliberately chose."

Your assistant can use the diagnostics API to return located findings and record author-reviewed span exceptions.

## Command reference

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
semantic redundancy or detect all sentence skeletons by default. Use `repetition:word`
and `repetition:paragraph` overrides or reasoned span exceptions to retain
intentional repetition. Batch results are keyed by unique document ID and use
the same located-finding/exception contract. Do not put personal content in IDs;
cross-document explanations include the relevant ID.

## Structural and campaign review

All three shipped surfaces (Python scanner, validation and contextual diagnostics)
share the corpus contract for moral endings, colon reveals, fragment runs and
mirrored sentences. The [addon catalogue](../../../agentic/code/addons/writing-quality/skills/ai-pattern-detection/references/current-patterns.json)
records thresholds and tiers. These run on masked prose and retain source offsets:
TypeScript spans are UTF-16 code units, Python positions and columns count Unicode
code points; positions start at zero and columns/lines at one. The same units
apply to structural/campaign findings and related source lines.

```js
const results = diagnoseWritingBatch([
  { id: 'linkedin', content: linkedinText },
  { id: 'telegram', content: telegramText },
  { id: 'x-thread', content: threadText },
], { cross: true });
```

Campaign mode reports six-word repeated sentences, eight-word phrase runs shared
by three documents, and three-word opening/closing forms shared by three documents.
Only skeleton comparison normalizes numbers and versions. Findings include
`scope: "cross"` and `related` document IDs/lines; every affected occurrence is
reported. Existing overrides and reasoned exceptions apply by rule ID and span.
Explicit protected context spans also apply before comparison. Campaign IDs are
caller-provided labels and should not contain private content.

Fragment review excludes questions and runs made entirely of one identical
sentence; exact repetition is handled by campaign comparison. This preserves
questionnaire punctuation and keeps repetition distinct from staccato rhythm.

Use `aiwg writing --cross [--json] <file-or-dir>...` for the same review, or
`WritingValidationEngine.validateBatch(files, context, { cross: true })` for legacy
validation output with campaign findings included in issue summaries. The Python
scanner supports `--cross [--report] <file-or-dir>...` (JSON by default).
Directory scans include Markdown files recursively. Supply a single campaign;
unrelated releases can repeat legitimate phrases. Sets over 200 documents fail
with a clear size error; split larger sets. Related-location output can grow with
repetition even within this limit.

Moral detection requires explicit moral/lesson openers of 3–10 words, excluding
numbers, identifiers and protected spans. Generic closers are not detected.
Short generic statements and factual technical negations remain residuals; useful
instructions beginning with “always” or “never” still need author judgment.
Mirroring requires a parallel predicate with an aligned polarity flip or one
listed antonym, plus the same first two words. Different verbs with the same
negated opener are insufficient. Colon reveals require a short withheld
complement and short final punchline; frequency alone never suffices. Lists,
definitions, digits/citations and protected material are excluded.
Sentence splitting handles common abbreviations and versions, not every language
convention. Fragment runs require four consecutive short statements in one
paragraph; the original #4138 paragraph contains only two. Its colon introduces a
conditional/list and its moral embeds a protected quotation; both remain unflagged.

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

The [evidence ledger](https://github.com/jmagly/aiwg/blob/main/agentic/code/addons/voice-framework/docs/natural-voice/evidence-ledger.v1.json) records the basis
and limits of this policy. These diagnostics do not complete semantic fidelity,
author profiles, revision, consumer application or human quality qualification.
