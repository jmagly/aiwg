---
namespace: aiwg
name: ai-pattern-detection
description: Review editorial phrase patterns and suggest contextual alternatives; legacy name does not imply authorship detection. Use when reviewing or editing content, or when the user mentions authenticity or natural voice.
version: 1.0.0
platforms: [all]

---

# AI Pattern Detection Skill

## Purpose

Review phrase patterns and suggest edits that fit the author’s intent and audience. This skill does not detect authorship or certify naturalness.

These are editorial preferences, not evidence of human or AI authorship. Apply only the requirements chosen by the author or project; other phrase and structure suggestions are advisory. Preserve quotations, code, literal terms, inventories, checklists, questionnaires, intentional punctuation, necessary uncertainty and domain terminology. A flagged phrase can be retained with a reason. Zero highlights and numeric scores are not publication gates. Never invent metrics, experiences, opinions or failures to satisfy a style marker.

## When This Skill Applies

- Generating any prose, documentation, or written content
- Reviewing or editing existing documents
- User mentions "AI detection", "writing quality", "authentic voice"
- User asks to "make it sound more natural" or "less robotic"
- Creating marketing copy, documentation, or communications

## Detection Categories

### Legacy High-Priority Patterns (Review in Context)

These phrases can be uninformative in some contexts; none identifies content as AI-generated:

1. **Corporate Buzzwords**: "seamlessly integrates", "cutting-edge", "revolutionary", "next-generation", "comprehensive solution"
2. **Vague Intensifiers**: "dramatically improves", "significantly enhances", "vastly superior"
3. **Formulaic Transitions**: "Moreover,", "Furthermore,", "Additionally,", "In conclusion,"
4. **Performative Language**: "aims to provide", "strives to achieve", "designed to enhance"
5. **Academic Passive**: "It has been observed that...", "It can be argued that..."

### Current Local Patterns

The scanners detect local contrasts (`not … but`, `X, not Y`, `rather than`),
negated evidence/proof/substitute assertions, listed antonym pairs, significance
labels and asides, empty openers, and generic engagement prompts. Findings are
editing guidance with rule IDs, tiers and suggested changes. Numeric comparisons
are suppressed when both operands have numbers within six tokens of the divider.
Reasons (`because`, `while`) and correction cues suppress a match only inside it
or within four tokens, without crossing a semicolon/colon. An unrelated date does
not suppress “It is not just the score in 2026.” Proximity remains a heuristic.

The dated `references/current-patterns.json` list requires two lexical markers in
one paragraph or four in a file; lone leverage/enhance are ignored. Spectral-only
clusters use watch tier. All three surfaces recognize a narrow rhetorical
adjective triad with or without the Oxford comma: `three_item_list` in Python,
`struct_three_items` in validation and diagnostics (watch tier). Inventories remain valid.

Front matter, headings, image alt text, code, quotations, comments, tables and
inventory lines are protected. Passive voice and standalone punctuation are not
findings.

### Structural and Campaign Checks

Paragraph-final explicit moral/lesson openers (3–10 words) are cut tier; generic
subjects alone never trigger a closer finding. Numbers, identifiers and protected
spans suppress moral findings. Adjacent sentences sharing the first two tokens
must have parallel predicates with an aligned polarity flip or one listed antonym
(cut). Different predicates sharing a negated opener are insufficient. Four
consecutive statements of 1–4 words in one paragraph form a check-tier fragment
run. Questions and identical-sentence-only runs are excluded. Headings, blank
lines and protected whole lines break sequences; wrapped prose lines do not.

Colon reveals are watch tier only for a short setup that withholds a complement
and a short sentence-final punchline. Mere colon frequency and neighboring
findings never suffice. Lists, definitions, digits/citations, code and quotation
introductions are excluded. Ambiguous technical introductions remain unflagged.

Use one campaign set for cross-document comparison:

```bash
aiwg writing --cross --json linkedin.md telegram.md x-thread.md
python3 -I scripts/pattern_scanner.py --cross campaign/
python3 -I scripts/pattern_scanner.py --cross --report campaign/
```

The existing `aiwg writing` entry point emits a readable report by default and
JSON with `--json`; Python emits JSON by default and readable output with
`--report`. Each finding includes a tier, source location and suggested fix.
Campaign rules detect six-word repeated sentences (cut), eight-word runs shared
by at least three documents (check), and three-word opening/closing skeletons
shared by at least three documents (check). Numbers and versions normalize only
for skeletons; phrase runs exclude sentences already reported as repeated.
Every affected occurrence is reported, with related document locations.

The APIs are `diagnoseWritingBatch(documents, { cross: true })` and
`engine.validateBatch(files, context, { cross: true })`. IDs must be unique;
missing campaign files fail the scan. Sets over 200 documents fail with an
explicit size error; split larger sets. Related-location output can still grow
with repetition inside an allowed set. A single-document campaign may report
repeated sentences; phrases and skeletons require distinct documents.

These checks are heuristic. Short generic statements and factual technical
negations remain residuals for review; explicit moral openers can be useful
instructions. The original #4138 paragraph has only two short trailing sentences,
so it does not meet the four-sentence fragment threshold. Its colon introduces a
conditional/list and its moral contains a protected quotation, so these are
explicitly scoped out. Its mirrored comma pair is detected as `antithesis-pair`.
A standalone “it doesn't anymore” is a factual correction rather than a sufficient
negate/assert trigger. The reproduction still flags the aside, antonym pair,
negated evidence and negated alternative on all three surfaces.

### Contextual Patterns (Check Frequency)

Review frequency in the document and language; there is no universal acceptable ratio for these words:
- manifest, revolutionary, next-generation
- robust, scalable, comprehensive
- synergy, leverage, utilize

## Replacement Guidelines

| Instead of | Use |
|-----------|-----|
| "plays a crucial role" | "handles" / "manages" / "does" |
| "seamlessly integrates" | "works with" / "connects to" |
| "cutting-edge" | "new" / "recent" / specific tech name |
| "Moreover," | [just start the next sentence] |
| "comprehensive solution" | [specific description of what it does] |
| "dramatically improves" | [specific metric: "reduces latency by 40%"] |
| "robust" | "handles X requests/second" / "99.9% uptime" |

## Editorial Features to Consider

Use these only when relevant and supported by the supplied material:

1. **Specific opinions**: "I prefer X because..." not "X is preferred"
2. **Acknowledged trade-offs**: "This approach sacrifices Y for Z"
3. **Real-world constraints**: "Budget limited us to..."
4. **Uncertainty where appropriate**: "We're not sure yet whether..."
5. **Varied sentence structure**: Mix short and long, different openings
6. **Domain-specific vocabulary**: Use actual technical terms, not generic descriptions

## Application Process

When generating or reviewing content:

1. **Scan** for phrase patterns and explicitly mandated style rules
2. **Count** contextual pattern frequency
3. **Check** structural variety
4. **Suggest** edits grounded in the source; retain intentional phrasing with a reason
5. **Verify** facts, author intent, uncertainty and protected content survive the edit

## Examples

### Before (Generic Wording)
> The platform seamlessly integrates cutting-edge technology to dramatically improve workflow efficiency. Moreover, it plays a crucial role in enabling next-generation solutions. In conclusion, this comprehensive approach transforms how teams collaborate.

### After (Specific Wording; Requires Supporting Facts)
> The platform connects to existing tools through standard APIs. Initial tests show 40% faster task completion. Teams report fewer context switches between applications.

## Script Reference

The Python `scripts/pattern_scanner.py` is a **legacy regex scanner**, not the contextual diagnostic implementation. It:
- Counts pattern frequencies
- Labels matches with pattern IDs, tiers, source line/column and legacy severity categories; these are advisory absent a user rule
- Generates replacement suggestions for local, structural and campaign patterns
- Preserves the deprecated numeric `authenticity_score` (0–100) and `grade` for compatibility, with prose-rate penalties and a deprecation notice; neither measures authorship or publication readiness

For contextual programmatic review, use `WritingValidationEngine.diagnose(content, options)` or the exported `diagnoseWriting` API. Results include UTF-16 spans, context, explanations and reasoned exceptions. They carry `publicationGate: false`. The Python scanner does not implement these context or exception fields.

Python `position` counts Unicode code points from zero; its `column` counts code
points from one. Validation `location.start/end` and diagnostic `start/end` count
UTF-16 code units from zero, with exclusive ends; validation `column` counts
UTF-16 units from one. Lines start at one on every surface. These units also apply to structural and
campaign findings and their related source lines. ASCII offsets agree.
For `🧵 Thoughts?`, Python gives position 2 and column 3; TypeScript gives start 3
and validation column 4, because the astral character occupies two UTF-16 units.

## Integration

This skill works with:
- `/writing-validator` command for explicit validation
- `writing-validator` agent for deep analysis
- Content tasks when this skill is invoked; invocation is not proof of runtime integration

## References

- @$AIWG_ROOT/agentic/code/addons/voice-framework/README.md — Voice framework for target style profiles
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/instruction-comprehension.md — Parsing content requirements accurately
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/README.md — SDLC framework context for documentation quality
- @$AIWG_ROOT/docs/cli-reference.md — CLI reference for writing-related commands
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/research-before-decision.md — Research patterns before making writing recommendations
