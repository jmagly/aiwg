# Contextual writing diagnostics

> "Show contextual findings in this text and retain the phrases I deliberately chose."

Your assistant can use the diagnostics API to return located findings and record author-reviewed span exceptions.

## Shared structural editing rules

Profiles inherit the [shared structural rules](https://github.com/jmagly/aiwg/blob/main/agentic/code/addons/writing-quality/patterns/common-ai-tells.md)
and [review checklist](https://github.com/jmagly/aiwg/blob/main/agentic/code/addons/writing-quality/validation/banned-patterns.md).
Review negate-then-assert frames, mirrored pairs, moral endings, labelled
significance, asserted importance and definition openings, effect triads,
summary closers, colon reveals, fragment runs, faux-casual quips,
throat-clearing and engagement bait in context. Tiers prioritize edits; they
are not authorship detection or automatic publication gates.

Campaign review covers thesis lines across channels, release openers and
closers, recycled jokes and signature moves used as lede formulas. The substance
requirement for articles and how-tos asks for a usable configuration, command,
prompt, script or result. Never invent missing supporting material.
These general guidelines require editorial judgment beyond scanner coverage.

The diagnostics include local contrasts and significance labels, adjacent
mirrored sentences, explicit moral endings, fragment runs and colon reveals.
`diagnoseWritingBatch(documents, { cross: true })` adds repeated sentences,
phrases and opening/closing skeletons across a supplied campaign. See the
[scanner coverage and limits](https://github.com/jmagly/aiwg/blob/main/agentic/code/addons/writing-quality/README.md#current-scanner-coverage-november-2026)
for thresholds and known residuals. Keep factual negations and useful summaries
when they serve the reader. Em dashes, colons, semicolons, passive voice, plain
transitions and real lists are not problems on their own. The existing
[dated lexical catalogue](https://github.com/jmagly/aiwg/blob/main/agentic/code/addons/writing-quality/skills/ai-pattern-detection/references/current-patterns.json)
is reviewed quarterly; word choice alone does not establish quality.

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
semantic redundancy or detect all sentence skeletons. Use `repetition:word`
and `repetition:paragraph` overrides or reasoned span exceptions to retain
intentional repetition. Batch results are keyed by unique document ID and use
the same located-finding/exception contract. Do not put personal content in IDs;
cross-document explanations include the relevant ID.

## Optional model-assisted structural review

`await diagnoseWritingAssisted(content, options)` and
`await diagnoseWritingBatchAssisted(documents, options)` add a bounded judgment
pass for loose mirrored predicates, colon reveals and three short fragments.
The existing synchronous APIs remain deterministic. Validation and
`aiwg writing --cross` use the asynchronous path. The Python scanner uses the
same questions through `aiwg decision ask`.

The existing decision opt-in, sampling defaults and fallback policy apply; no
writing configuration is added. Only an answered yes with finite confidence at
least 0.8 becomes a finding, with
`confidence: { kind: 'model-assisted', value, calibrated: false }`.
These are advisory editing signals; exceptions, protected contexts, disabled
rules and author decisions still apply. Section headings accompany the masked
paragraph so a judgment can distinguish prose beats from runbook statuses.

Decision ask off, unavailable or below threshold retains deterministic output.
The corpus remains at 49/56 with it off and reaches 56/56 with an offline stub;
both have zero findings on the 22 wholly negative files. Stub coverage is not a
live accuracy result. See the [scanner documentation](https://github.com/jmagly/aiwg/blob/main/agentic/code/addons/writing-quality/README.md#optional-structural-judgment)
for labels, the Python CLI dependency and data handling.

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
