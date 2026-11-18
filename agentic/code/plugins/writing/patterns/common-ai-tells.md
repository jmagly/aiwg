# Structural editing patterns

Reviewed 2026-11-17. These are editing guidelines, not authorship detection.
The legacy filename remains for existing links. Review what a sentence carries
for its reader; a pattern match does not establish who wrote it. Apply author
and project requirements, and record reasons for deliberate exceptions.

## Review tiers

| Tier | Editorial action |
|------|------------------|
| cut | Usually remove the rhetorical frame and state the useful claim directly. |
| check | Inspect the context and revise if the frame adds no information. |
| watch | Review a possible habit; retain it when it serves the reader. |

Tiers prioritize review, not automatic deletion or publication decisions.
These examples are invented editing exercises, not evidence of authorship.

## Structural patterns

### Negate-then-assert
**Tier: cut**

**Example:** “This isn't about speed. It's about trust.”
**Fix:** Name the actual change: “The audit log records who approved each update.” Retain negation when correcting a stated misconception or documenting a factual limitation. Scanner variants such as `not … but` and `X, not Y` are cut; the narrower `negate-then-assert` and `rather-than` checks use check tier.

### Mirrored pairs
**Tier: cut**

**Example:** “The demo is simple. The deployment is complex.”
**Fix:** Explain the difference: “Deployment requires a database and a separate worker.” Keep parallel clauses when the comparison itself conveys needed information.

### Moral endings
**Tier: cut**

**Example:** “The lesson is simple: always test the edges.”
**Fix:** End on the specific result or unresolved constraint: “The new test covers a missing switch.” A useful instruction can remain; an unsupported moral adds no evidence.

### Labelled significance
**Tier: cut**

**Example:** “Why this matters: the retry has a limit.”
**Fix:** Connect the circumstance to its consequence: “After three failed attempts, the worker returns the error.” Removing only the label leaves the explanation unfinished.

### Asserted importance openings
**Tier: check**

**Example:** “Reliable backups are essential in today's world.”
**Fix:** Open with the actual task or incident: “The restore job failed when the archive was empty.” Explain importance through consequences supported by the source.

### Definition openings
**Tier: watch**

**Example:** “A backup is a copy of stored data.”
**Fix:** Start a how-to with the reader's task: “Restore the archive into an empty directory.” Retain definitions in glossaries and when readers need the term before proceeding.

### Effect triads
**Tier: watch**

**Example:** “The update makes work faster, easier, and better.”
**Fix:** Name a supported effect: “The update removes the manual export step.” Keep three real effects when each has evidence; do not change list length just to avoid three.

### Summary closers
**Tier: check**

**Example:** “In summary, this approach improves the whole workflow.”
**Fix:** End on the last useful result, required action or limitation. Retain summaries that help readers navigate a long document or make a decision.

### Colon reveals
**Tier: watch**

**Example:** “The system had one hidden weakness: nobody owned the queue.”
**Fix:** State subject and consequence together: “The queue stalled because no worker was assigned.” A colon introducing a real list, definition or command needs no repair.

### Fragment runs
**Tier: check**

**Example:** “One queue. Two workers. No owner. Nothing moved.”
**Fix:** Join the facts to explain the result: “Neither worker owned the queue, so both waited.” Keep concise runbook steps; avoid manufacturing staccato rhythm through isolated paragraphs.

### Faux-casual quips
**Tier: check**

**Example:** “Yeah, that happened. Classic. You're welcome.”
**Fix:** Describe the event in the author's established voice. Remove stage-managed banter; never manufacture errors, jokes, experiences or a gruff persona to sound natural.

### Throat-clearing
**Tier: cut**

**Example:** “Here's the thing. Let's dive in.”
**Fix:** Start with the information the reader came for: “Set the timeout before starting the worker.” Preserve context that changes how the instruction should be used.

### Engagement bait
**Tier: cut**

**Example:** “Thoughts? Agree? Drop a comment below.”
**Fix:** End with the information, or ask an answerable question: “Which restore step failed, and what error did it return?”

## Campaign review

Do not copy a thesis line across channels. Rotate release-post openers and closers.
Never reuse a joke or line in a later post. Do not use a signature move as a lede formula.
Write each post around its reader's task and the relevant release facts; changing
synonyms around an identical sentence skeleton does not create a new post.
Keep product names, commands, required notices and deliberate quotations stable.

Compare the current campaign with earlier posts during editorial review. The
existing `aiwg writing --cross --json campaign/` checks repeated sentences,
phrases and opening/closing skeletons within the supplied set. It cannot judge
semantic thesis reuse, identify jokes reliably or remember posts not supplied.

## Substance for articles and how-tos

Articles and how-tos need at least one usable configuration, command, prompt,
script or result relevant to their central claim. Explain how to use it or what
it demonstrates. A rhetorical promise or ungrounded benefit is insufficient.
Never invent metrics, experiments or examples presented as actual results.
When supporting material is missing, report the gap and request the needed input.

## Rotating lexical review

The word list lives in the existing [dated catalogue](../skills/ai-pattern-detection/references/current-patterns.json),
with `reviewed: 2026-11-12` and `nextReview: 2027-02-12`. Review it quarterly:
compare current drafts with accepted examples, retire stale entries and record
the new dates. Keep runtime catalogue copies synchronized. Word-level preferences
rotate; replacing each word with a synonym does not repair a structural habit.
Lexical clusters are review prompts; a single word is not proof of poor writing.

## False positives and limits

Em dashes, colons, semicolons, passive voice, plain transitions and real lists
are not patterns on their own. Keep punctuation that clarifies meaning, passive
voice that puts the relevant subject first, and transitions that connect ideas.
Preserve headings, front matter, alt text, code, quotations, terminology,
inventories and necessary uncertainty. Do not rewrite protected material to
satisfy a prose heuristic.

Factual technical negations (“is not a supported alias”) and short generic
statements can resemble rhetorical contrasts or aphorisms. Review their meaning.
Definition openings, broad assertions of importance, general effect triads,
faux-casual quips and the substance requirement need editorial judgment; the
scanner's narrow rhetorical adjective triad is only a partial aid. The scanner
does not implement every guideline here. Zero findings is not a quality guarantee.
