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

Tiers and cluster thresholds follow the reference catalogue: colon reveals are
watch tier with four in one file; lexical markers require two in a paragraph or
four in a file. Lexical negatives live in separate files to test isolated markers.
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

`test/unit/writing/quality-corpus.test.ts` runs in the default Vitest lane through
`config/vitest.config.js`; no new lane or registration is needed. It exercises:

1. The shipped Python `scan_text`, in an isolated Python process. A constructor
   observer retains pattern IDs omitted by its legacy public JSON; matching,
   frequency thresholds and returned findings remain the scanner's own behavior.
2. `WritingValidationEngine.validate` with rules loaded from this repository,
   including its existing markdown rules. The generic `missing_authenticity`
   specificity notice is excluded because it is not a pattern finding. Other
   findings retain their rule ID, or use `unidentified:<type>` if an ID is absent.
3. `diagnoseWritingBatch`, one isolated campaign or standalone file at a time.

Legacy severities map mechanically: critical → cut, warning → check, info → watch.
Contextual diagnostics currently expose no tier, so their advisory findings map to
check. Native rule IDs are retained. Later scanner changes should expose canonical
IDs and tiers through these adapters; do not implement missing detectors in tests.
The engine and Python scanner currently offer no structural campaign API, so those
expected findings remain misses. Their adapters must call the shipped campaign
entry point when #4140 introduces it. No detector from the reference is used as an
oracle, and neither a model nor a network call is involved. Python 3 is required.

`known-gaps.json` version 1 stores an explicit multiset of deviations. Each entry
has `surface`, `fixture`, `kind` (`miss` or `flag`), `pattern`, `tier`, `line`,
`scope`, and the closing `issue` (#4138, #4139 or #4140). Repeated entries represent
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
fixed-but-listed gap. Scanner logic and existing tests remain unchanged.
