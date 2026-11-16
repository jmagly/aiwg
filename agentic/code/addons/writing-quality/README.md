# Writing Quality Addon

Evidence status: design intent.

**Type**: Addon (standalone utility)
**Version**: 1.1.0
**Framework Dependency**: None (works with any framework or standalone)

## Overview

The Writing Quality addon provides content validation and writing improvement capabilities. It works alongside the Voice Framework to review clarity and fit to your intended voice.

> **Recommended**: Use the **[Voice Framework](../voice-framework/README.md)** addon for positive voice definition. The Voice Framework provides voice profiles that define the voice you *want*—the preferred approach for consistent writing.

## Diagnostic and Compatibility Boundaries

These are editorial preferences, not evidence of human or AI authorship. Apply only the requirements chosen by the author or project; other phrase and structure suggestions are advisory. Preserve quotations, code, literal terms, inventories, checklists, questionnaires, intentional punctuation, necessary uncertainty and domain terminology. A flagged phrase can be retained with a reason. Zero highlights and numeric scores are not publication gates. Never invent metrics, experiences, opinions or failures to satisfy a style marker.

`WritingValidationEngine.diagnose(content, options)` and the exported `diagnoseWriting` API return contextual diagnostics with UTF-16 spans, explanations and reasoned exceptions, with `publicationGate: false`. The Python scanner in `skills/ai-pattern-detection/scripts/` does not implement that API. Its `authenticity_score` and `grade`, and the legacy validator’s `score`, `authenticityScore` and `aiPatternScore`, are deprecated heuristic compatibility output. Numeric fields remain available; they are not human-authorship probabilities or quality guarantees.

## Current Scanner Coverage (November 2026)

The Python scanner, validation engine and contextual diagnostics detect local
`not … but`, `X, not Y`, `rather than`, negated evidence/proof/substitute assertions,
listed antonym pairs across a comma, significance labels and self-explaining
asides, empty openers, and generic engagement questions. New findings carry
canonical rule IDs and cut/check/watch tiers (critical/warning/info in validation).
They are editing suggestions. Sentence-sequence checks cover adjacent parallel
predicates with the same first two words and either a polarity flip or one listed
antonym (cut), paragraph-final explicit moral/lesson openers of 3–10 words (cut),
and four consecutive sentences of 1–4 words (check). Generic factual closers are
not detected. Moral candidates containing protected spans, numbers or identifiers
are excluded. Colon reveals are watch tier: a short setup withholds its complement,
then supplies a short sentence-final punchline. Frequency never triggers a colon
finding. Lists, definitions, digits/citations, code and quotation introductions
are excluded; ambiguous technical introductions remain unflagged.

Fragment review excludes questions and runs made entirely of one identical
sentence; exact repetition is handled by campaign comparison. This preserves
questionnaire punctuation and keeps repetition distinct from staccato rhythm.

Campaign mode compares repeated sentences of six or more words (cut), eight-word
runs shared by three documents (check), and opening/closing three-word skeletons
shared by three documents (check). Numbers and versions normalize only for
skeletons. Repeated sentences suppress overlapping phrase findings; findings
identify every affected document, including the first. Compare one campaign at a
time; unrelated campaigns can share legitimate vocabulary. Campaigns are capped
at 200 documents; split larger sets before scanning. This bounds document count,
not the number of findings or related occurrences in a repetitive campaign.

```bash
aiwg writing --cross linkedin.md telegram.md x-thread.md
aiwg writing --cross --json campaign/
python3 -I skills/ai-pattern-detection/scripts/pattern_scanner.py --cross --report campaign/
```

Python defaults to JSON; omit `--report` for structured campaign output.
Programmatic callers use `diagnoseWritingBatch(documents, { cross: true })` or
`engine.validateBatch(files, context, { cross: true })`. Defaults preserve existing
single-document checks and exact paragraph repetition in contextual batches.
These are heuristics: short generic statements and factual technical negations
remain residuals for author review. Explicit moral openers can carry useful
instructions; the scanner cannot judge meaning. Mirroring requires an aligned
predicate contrast; sharing an opener and negation with different verbs is
insufficient.
Sentence boundaries handle common abbreviations and versions but cannot parse
all prose. These checks do not identify authorship.

The shared [dated catalogue](skills/ai-pattern-detection/references/current-patterns.json)
contains the 2023, 2024–25, 2026, copula and spectral lexical sets; next review is
2027-02-12. Two markers in a paragraph or four in a file trigger a lexical finding
per affected paragraph. Spectral-only clusters are watch tier. Lone leverage and
enhance do not trigger findings. Contextual diagnostics retain the existing single
delve and figurative rich-tapestry prompts when no cluster replaces them; explicit
author phrase rules and exceptions still apply. Literal textile descriptions are
exempt from the default rich-tapestry prompt.

All three surfaces protect front matter, headings (including Setext), image alt
text, fenced/inline/indented code, quoted passages, tables, comments and inventory
lines before matching. Offsets still refer to the original source. Local contrasts
are suppressed when both operands contain numbers within six tokens of the
comparison divider, or a reason (`because`, `while`) or correction cue occurs
inside or within four tokens of the match without a semicolon/colon boundary.
A date elsewhere in a sentence does not exempt it: “It is not just the score in
2026.” still produces a finding. These are proximity heuristics, not semantic proof.
Precise passives and standalone em dashes, colons and semicolons produce no finding.
All three surfaces recognize a narrow rhetorical adjective triad with either
comma style; real inventories remain unflagged. Python calls it `three_item_list`;
validation and contextual diagnostics call it `struct_three_items` (watch tier).

Python `position` is a zero-based Unicode code-point offset and `column` is a
one-based code-point column. Validation `location.start/end` and contextual
diagnostic `start/end` are zero-based UTF-16 code-unit offsets (end exclusive);
validation `column` is a one-based UTF-16 column. All source lines are one-based. These units apply to local, structural and
campaign findings, including related source lines.
ASCII positions agree across surfaces. In `🧵 Thoughts?`, Python reports position
2, column 3; both TypeScript surfaces start at 3 and validation reports column 4.
The astral character occupies one Python code point and two UTF-16 code units.

Compatibility penalties use prose rates rather than raw document counts. Python
deductions are per 100 prose words. Validation severity deductions and its
phrase-density component use rates per 50 prose words. Repeating
the same prose in additional paragraphs does not increase those penalties merely
because the document is longer. The contextual API has no score.

## Components

### Agents (3)

| Agent | Purpose |
|-------|---------|
| `writing-validator` | Reviews editorial patterns and author requirements without certifying authorship |
| `prompt-optimizer` | Enhances prompts using AIWG principles |
| `content-diversifier` | Generates varied examples and perspectives |

### Content Directories

| Directory | Contents |
|-----------|----------|
| `core/` | Philosophy and sophistication principles |
| `validation/` | Writing quality guidelines and markers |
| `examples/` | Before/after rewrites demonstrating improvements |
| `context/` | Quick-reference guides for different voices |
| `patterns/` | Pattern JSON files for programmatic validation |

## Installation

```bash
# Deploy writing addon only
aiwg -deploy-agents --mode writing

# Deploy with all frameworks
aiwg -deploy-agents --mode all
```

## Usage

### Validate Content

```bash
# Using the writing-validator agent
"Check this document for AI patterns: docs/readme.md"
```

### Optimize Prompts

```bash
# Using the prompt-optimizer agent
"Optimize this prompt for better output: [your prompt]"
```

### Generate Variations

```bash
# Using the content-diversifier agent
"Generate 5 variations of this concept: [your concept]"
```

## Quality Checks

The addon validates content across 6 categories:

1. **Specificity** - Concrete details vs. vague claims
2. **Voice consistency** - Matching the intended tone throughout
3. **Precision** - Accurate quantifiers and metrics
4. **Active voice** - Strong, direct sentence construction
5. **Appropriate modifiers** - Meaningful intensifiers
6. **Natural structure** - Varied, authentic sentence patterns

## Integration with Frameworks

The Writing Quality addon works seamlessly with:

- **SDLC Complete**: Validate documentation, README files, architecture docs
- **Media/Marketing Kit**: Validate marketing copy, blog posts, social content
- **Voice Framework**: Combine quality validation with positive voice definition
- **Standalone**: Use independently for any content improvement task

## Voice Framework Integration

For the best writing experience, combine Writing Quality with the Voice Framework:

```bash
# Deploy both addons
aiwg use writing           # Includes Writing Quality + Voice Framework
```

**Complementary approaches:**

| Approach | Writing Quality | Voice Framework |
|----------|----------------|-----------------|
| **Method** | Quality validation | Voice profiles (define) |
| **Focus** | Content consistency | Voice definition |
| **Output** | Quality assessment | Transformed content |
| **Use Case** | Validation | Generation |

**Recommended workflow:**
1. Define voice profile for your project
2. Generate content using voice profiles
3. Validate output with Writing Quality for edge cases

## Related ADRs

- ADR-008: Plugin Type Taxonomy (defines addon classification)

## License

MIT License - See repository root for details.
