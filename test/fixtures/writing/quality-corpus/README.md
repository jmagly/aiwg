# Annotated writing-quality corpus

Offline editorial regression corpus for #4142, the first part of #4137. It supplies
examples for #4138 (missed patterns), #4139 (false positives), #4140 (structural
and campaign checks), and #4141 (guidance). No scanner implementation is copied or
changed here. These labels concern editing choices and make no authorship claim.

Short November 2026 excerpts are reused with operator permission from the strategy
repository's voice-quality fixtures at commit `4a2f318`. `source` and `notes` name
reused files or issue reproductions; remaining cases are synthetic. Reference
heuristic residuals are not automatically treated as correct editorial labels.

## Annotation format

`expected.json` version 1 contains `files` keyed by fixture-relative Markdown path
and `groups` keyed by campaign ID. Every file is scanned, including those with an
empty `labels` array. Unannotated findings anywhere in a fixture are unexpected.
Each file records `source`, an editorial explanation in `notes`, and `labels`:

```json
{
  "pattern": "contrast-not-but",
  "tier": "cut",
  "line": 1,
  "quote": "The file was not stale, but the cache was.",
  "expected": true,
  "scope": "file"
}
```

- `pattern` uses the reference catalogue's stable rule IDs.
- `tier` is `cut` (rewrite), `check` (inspect the context), or `watch` (clustered
  signal). A true negative uses `expected: false` and `tier: null`.
- `line` is the one-based source line containing `quote`. Quotes are checked
  against source text. Findings match by pattern, tier, line and scope as a
  **multiset**, preserving multiple occurrences on one line. Columns are not part
  of this contract; a detector may highlight a clause or its triggering token.
- `scope` is `file` or `cross`. Optional file-level `group` identifies a campaign.
  Groups are scanned independently, never merged into one corpus-wide campaign.
- Negative labels are targeted near misses for the named pattern. A file with no
  positive labels is wholly negative: any emitted finding counts as a false flag.

Annotations retain the reference catalogue tiers and original examples. D3
deliberately narrows structural checks for precision: colon reveals remain watch
tier but require a reveal shape, and fragment runs require four statements.
Lexical markers require two in a paragraph or four in a file. Lexical negatives live in separate files to test isolated markers.
Campaign positives cover a shared thesis sentence, opening/closing skeletons,
and an eight-word run inside otherwise different sentences. Campaign negatives
are distinct releases. Three channel locations count as three examples of a
cross pattern; they are one group, not three independent campaign samples.

## Coverage and initial baseline

The table counts annotated source locations, including protected-region negative
labels. All eight #4140 categories have at least three positives and negatives;
contrast variants and both throat-clearing/engagement checks are listed separately.
The #4138 negate/assert, mirrored antonym and aside cases are included too.

| Pattern | TP labels | TN labels | Python TP recall | Validation TP recall | Diagnostics TP recall | TN flags (all surfaces) |
|---|---:|---:|---|---|---|---:|
| `antithesis-pair` | 3 | 3 | 0/3 (0%) | 0/3 (0%) | 0/3 (0%) | 0 |
| `aphorism-ending` | 4 | 3 | 0/4 (0%) | 0/4 (0%) | 0/4 (0%) | 0 |
| `colon-reveal` | 4 | 3 | 0/4 (0%) | 0/4 (0%) | 0/4 (0%) | 0 |
| `contrast-not-but` | 3 | 4 | 0/3 (0%) | 0/3 (0%) | 0/3 (0%) | 0 |
| `contrast-x-not-y` | 3 | 4 | 0/3 (0%) | 0/3 (0%) | 0/3 (0%) | 0 |
| `engagement-bait` | 3 | 4 | 0/3 (0%) | 0/3 (0%) | 0/3 (0%) | 0 |
| `fragment-run` | 3 | 3 | 0/3 (0%) | 0/3 (0%) | 0/3 (0%) | 0 |
| `labelled-significance` | 6 | 4 | 0/6 (0%) | 0/6 (0%) | 0/6 (0%) | 0 |
| `lexical-cluster` | 3 | 3 | 0/3 (0%) | 0/3 (0%) | 0/3 (0%) | 0 |
| `mirrored-sentences` | 3 | 3 | 0/3 (0%) | 0/3 (0%) | 0/3 (0%) | 0 |
| `negate-then-assert` | 3 | 3 | 0/3 (0%) | 0/3 (0%) | 0/3 (0%) | 0 |
| `rather-than` | 3 | 4 | 0/3 (0%) | 0/3 (0%) | 0/3 (0%) | 0 |
| `repeated-phrase` | 3 | 3 | 0/3 (0%) | 0/3 (0%) | 0/3 (0%) | 0 |
| `repeated-sentence` | 3 | 3 | 0/3 (0%) | 0/3 (0%) | 0/3 (0%) | 0 |
| `shared-skeleton` | 6 | 3 | 0/6 (0%) | 0/6 (0%) | 0/6 (0%) | 0 |
| `throat-clearing` | 3 | 4 | 0/3 (0%) | 0/3 (0%) | 0/3 (0%) | 0 |

Existing scanners use different legacy IDs. These additional TN false positives
are counted under the actual emitted pattern, rather than relabelled as a correct
structural detection:

| Surface | Actual pattern ID | TN false-positive count |
|---|---|---:|
| diagnostics | `phrase:rich-tapestry` | 1 |
| python | `\bleverag(e\|ing)\b` | 6 |
| python | `em_dash_overuse` | 4 |
| python | `passive_voice` | 6 |
| validation | `banned_phrase_leverage_leveraging` | 6 |
| validation | `struct_three_items` | 2 |

Baseline totals (misses / unexpected findings / TN false positives):

- python: 56 / 17 / 16.
- validation: 56 / 9 / 8.
- diagnostics: 56 / 3 / 1.

Unexpected phrase-level findings on positive lexical fixtures are also baselined,
but excluded from the TN counts. Recall requires the annotated structural pattern
and tier, not merely any overlapping vocabulary flag. These are fixture metrics,
not population estimates. The test prints current per-pattern metrics on every run.

Negatives include real inventories, Oxford and non-Oxford list punctuation, a colon
before a Markdown list, code fences/inline/indented code, headers, YAML front matter,
image alt text, quoted tool output, a literal textile metaphor, precise passives,
times, and legitimate corrections (including “not 2026.11.3; the release notes say
2026.11.4”). `legacy-regions.md` and `passives.md` reach the old scanner's reporting
thresholds, so exclusions are measured even before new structural checks arrive.

## Scanner adapters and shrinking gaps

### D2 results (#4138 / #4139, historical)

Each cell shows initial → current recall. Fixtures and editorial labels are
unchanged. All three surfaces now recover 30/56 locations (53.6%), with zero
findings on wholly negative files (previously Python 16, validation 8, diagnostics
1). This is a fixture result, not an estimate of real-world recall or precision.

| Pattern | Python | Validation | Diagnostics |
|---|---|---|---|
| `antithesis-pair` | 0/3 → 3/3 | 0/3 → 3/3 | 0/3 → 3/3 |
| `aphorism-ending` | 0/4 → 0/4 | 0/4 → 0/4 | 0/4 → 0/4 |
| `colon-reveal` | 0/4 → 0/4 | 0/4 → 0/4 | 0/4 → 0/4 |
| `contrast-not-but` | 0/3 → 3/3 | 0/3 → 3/3 | 0/3 → 3/3 |
| `contrast-x-not-y` | 0/3 → 3/3 | 0/3 → 3/3 | 0/3 → 3/3 |
| `engagement-bait` | 0/3 → 3/3 | 0/3 → 3/3 | 0/3 → 3/3 |
| `fragment-run` | 0/3 → 0/3 | 0/3 → 0/3 | 0/3 → 0/3 |
| `labelled-significance` | 0/6 → 6/6 | 0/6 → 6/6 | 0/6 → 6/6 |
| `lexical-cluster` | 0/3 → 3/3 | 0/3 → 3/3 | 0/3 → 3/3 |
| `mirrored-sentences` | 0/3 → 0/3 | 0/3 → 0/3 | 0/3 → 0/3 |
| `negate-then-assert` | 0/3 → 3/3 | 0/3 → 3/3 | 0/3 → 3/3 |
| `rather-than` | 0/3 → 3/3 | 0/3 → 3/3 | 0/3 → 3/3 |
| `repeated-phrase` | 0/3 → 0/3 | 0/3 → 0/3 | 0/3 → 0/3 |
| `repeated-sentence` | 0/3 → 0/3 | 0/3 → 0/3 | 0/3 → 0/3 |
| `shared-skeleton` | 0/6 → 0/6 | 0/6 → 0/6 | 0/6 → 0/6 |
| `throat-clearing` | 0/3 → 3/3 | 0/3 → 3/3 | 0/3 → 3/3 |

D2 reduced the gap multiset from 197 to 78: 90 recovered locations and all 29
#4139 unexpected-finding allowances were removed, with no added allowance.

### D3 results (#4138 / #4140)

D3 recovered **46/56 annotated locations (82.1%)**, with zero
findings on wholly negative corpus files. Round 1 recovered 56/56 but overflagged
ordinary technical prose. Round 2 keeps precision constraints and retains 30
existing misses (10 per surface), each with a reason in `known-gaps.json`. These
are retained origin/main entries, not new allowances. No fixtures or labels change.

| Pattern | D2 recall (each surface) | Round 1 | Round 2 |
|---|---:|---:|---:|
| `aphorism-ending` | 0/4 | 4/4 | 4/4 |
| `colon-reveal` | 0/4 | 4/4 | 0/4 |
| `fragment-run` | 0/3 | 3/3 | 0/3 |
| `mirrored-sentences` | 0/3 | 3/3 | 0/3 |
| `repeated-phrase` | 0/3 | 3/3 | 3/3 |
| `repeated-sentence` | 0/3 | 3/3 | 3/3 |
| `shared-skeleton` | 0/6 | 6/6 | 6/6 |
| `antithesis-pair` | 3/3 | 3/3 | 3/3 |
| `contrast-not-but` | 3/3 | 3/3 | 3/3 |
| `contrast-x-not-y` | 3/3 | 3/3 | 3/3 |
| `engagement-bait` | 3/3 | 3/3 | 3/3 |
| `labelled-significance` | 6/6 | 6/6 | 6/6 |
| `lexical-cluster` | 3/3 | 3/3 | 3/3 |
| `negate-then-assert` | 3/3 | 3/3 | 3/3 |
| `rather-than` | 3/3 | 3/3 | 3/3 |
| `throat-clearing` | 3/3 | 3/3 | 3/3 |

Remaining gaps are deliberate precision limits:

- `positives/mirrored.md`, lines 1/3/5: predicates differ without an aligned
  polarity flip or a listed antonym. A shared opener and negation alone cannot
  distinguish factual pairs. Parallel predicate contrasts have separate tests.
- `positives/colons.md`, lines 1 (two annotations), 3 and 5: protected quotation,
  no unambiguous withheld complement, or a command introduction. Frequency and
  neighboring patterns no longer turn technical colons into reveals.
- `positives/fragments.md`, lines 3/5: three generic short statements; four are
  required to protect runbook staccato. The consequence/repair/moral on line 1
  is now detected under #4138; its three surface-specific gap entries were removed.

### #4138 acceptance disposition

The reproduction now detects every requested category on all three surfaces:
self-explaining aside, comma antonym pair, negated evidence and alternative,
short “it doesn't anymore” correction, conditional defect reveal, a
consequence/repair/moral fragment run, and the moral containing a quoted
scenario name. Positive and negative regression cases exercise each category.
The release changelog records the fix.

Current corpus recall is **47/56 (83.9%) per surface**, with zero findings on
wholly negative files and 27 retained misses (nine per surface). Fixtures and
labels are unchanged. The fragment on `positives/fragments.md` line 1 is the
only newly recovered annotated location; other residual gaps stay documented.

Short generic statements and factual technical negations remain heuristic
residuals. Only explicit moral/lesson openers trigger closers; quoted scenario
names within the author's moral are allowed, while whole quotes and code stay
protected. Mirroring requires aligned predicate contrast. Colon reveals require
a withheld complement and a short final punchline or a conditional defect and
consequence; lists, definitions, digits/citations and protected material are
excluded. Generic fragment runs still require four statements; a short
consequence, one-word repair and explicit moral also qualify. These rules cannot
judge semantic contribution.
Campaign comparisons require six-word repeated sentences, eight-word runs in
three documents, or three-word boundary skeletons in three documents. Only
skeletons normalize numbers and versions. Campaign size is capped at 200 documents;
records are indexed once per document, and grouping appends without copying prior
occurrences. A 200-document synthetic test covers both scanners with a generous
ten-second bound per scanner. Validation explicitly masks prose before comparison.

TypeScript structural and campaign spans count UTF-16 code units; Python positions
and columns count Unicode code points. Positions start at zero, columns and source
lines at one. Related locations contain one-based source lines. These conventions
match the D2 local rules; ASCII positions agree across surfaces.

`test/unit/writing/quality-corpus.test.ts` runs in the default Vitest lane through
`config/vitest.config.js`; no new lane or registration is needed. It exercises:

1. The shipped Python `scan_text` and `scan_campaign`, in an isolated Python
   process, reading public JSON including native pattern IDs and scopes.
2. `WritingValidationEngine.validate` with rules loaded from this repository,
   including its existing markdown rules. The generic `missing_authenticity`
   specificity notice is excluded because it is not a pattern finding. Other
   findings retain their rule ID, or use `unidentified:<type>` if an ID is absent.
3. `diagnoseWritingBatch`, one isolated campaign or standalone file at a time.

Legacy severities map mechanically: critical → cut, warning → check, info → watch.
Contextual diagnostics expose tiers for current patterns; legacy advisory findings
without a tier map to check. Native rule IDs are retained. The adapter reads
scanner-owned tiers; it implements no missing detectors.
Campaign adapters call Python `scan_campaign`, validation
`validateBatch(files, context, { cross: true })`, and diagnostics
`diagnoseWritingBatch(documents, { cross: true })`. Each group is isolated; default
single-file scans do not compare unrelated fixtures. No detector from the reference is used as an
oracle, and neither a model nor a network call is involved. Python 3 is required.

`known-gaps.json` version 1 stores an explicit multiset of deviations. Each entry
has `surface`, `fixture`, `kind` (`miss` or `flag`), `pattern`, `tier`, `line`,
`scope`, and the originating `issue` (#4138, #4139 or #4140). Optional `plannedBy`
names the planned fixer without removing the originating issue's open gap.
Repeated entries represent
distinct occurrences on the same line, including six legitimate passive statements.
A `miss` is an annotated TP the scanner failed to return. A `flag` is any unexpected
finding; the baseline does not pretend these are desired editorial annotations.

The test subtracts the baseline from observed deviations in both directions:
any added deviation fails, and any listed deviation that disappeared also fails.
A moved finding or wrong tier fails too. Thus a fixed gap requires deleting its
entry, and the checked-in baseline only shrinks for this corpus. Never regenerate
or expand it to bless a regression. New fixtures need separately reviewed labels
and any initial gaps; existing allowances must retain their specificity.

To add a case, write the excerpt and annotations from the editorial rule first,
then run the scanner test and inspect differences. To fix a detector, leave these
fixtures and annotations intact, remove only the closed gap entries, and rescan.

```bash
nice -n 19 npx vitest run --config config/vitest.config.js test/unit/writing
```

Regression demonstration: removing the validation allowance for
`positives/contrast.md` line 1 produces a failing fixture comparison with an added
`contrast-not-but` miss. The entry was restored. Adding a stale allowance likewise
fails. The suite also checks the comparator against a new negative flag and a
fixed-but-listed gap. Remaining misses retain their original issue tags and have
explicit precision reasons; new unexpected findings remain disallowed.
