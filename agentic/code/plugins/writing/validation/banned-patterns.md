# Structural pattern review checklist

This legacy filename is retained for callers. These are editing guidelines,
not authorship detection. Review the [shared structural rules](../patterns/common-ai-tells.md)
for context, exceptions and full fixes. A tier sets review priority, not a ban
on individual words or a publication gate. Author requirements remain explicit.

## Review patterns

| Pattern | Tier | Example | Fix |
|---------|------|---------|-----|
| Negate-then-assert | cut | “It isn't about speed. It's about trust.” | State the supported claim directly; retain factual corrections. Narrow negated assertions use check in the scanner. |
| Mirrored pairs | cut | “The demo is simple. The deployment is complex.” | Explain the deployment requirements that create the difference. |
| Moral endings | cut | “The lesson is simple: always test the edges.” | End with the specific result, action or unresolved constraint. |
| Labelled significance | cut | “Why this matters: retries have a limit.” | Connect the limit to the outcome the reader needs to understand. |
| Asserted importance openings | check | “Reliable backups are essential today.” | Begin with the actual task and show its supported consequence. |
| Definition openings | watch | “A backup is a copy of stored data.” | Open with the reader's task; retain definitions where readers need them. |
| Effect triads | watch | “Faster, easier, and better.” | Name supported effects; retain real enumerations of any length. |
| Summary closers | check | “In summary, this improves the workflow.” | End at the last useful fact; keep summaries that aid navigation. |
| Colon reveals | watch | “It had one hidden weakness: nobody owned the queue.” | Explain the cause and consequence in a direct sentence. |
| Fragment runs | check | “One queue. Two workers. No owner. Nothing moved.” | Join related facts so their causal relationship is clear. |
| Faux-casual quips | check | “Yeah, that happened. Classic. You're welcome.” | Describe the event in the author's voice without manufactured banter. |
| Throat-clearing | cut | “Here's the thing. Let's dive in.” | Start with the information the reader came for. |
| Engagement bait | cut | “Thoughts? Agree? Comment below.” | Ask a concrete answerable question or finish with useful information. |

## Campaign checks

Do not copy a thesis line across channels. Rotate release-post openers and closers.
Never reuse a joke or line in a later post. Do not use a signature move as a lede formula.
Compare earlier posts as well as the current release. Preserve required notices,
commands and literal names. Use `aiwg writing --cross` for supplied campaign
files; semantic reuse and jokes still require an editor's judgment.

## Substance check

Articles and how-tos require a usable configuration, command, prompt, script or
result tied to the central claim. Explain its use or significance. Never invent
facts, metrics or personal experience to satisfy this requirement. Report missing
source material as an editorial gap.

## Lexical review

Use the existing [dated rotating catalogue](../skills/ai-pattern-detection/references/current-patterns.json)
for lexical candidates. It was reviewed 2026-11-12; the next quarterly review is
2027-02-12. Reassess clusters against current drafts and accepted examples;
retire stale words and update both dates and runtime copies. Do not restore a
static phrase blacklist here or replace structural edits with synonym swaps.

## False positives and review outcome

Em dashes, colons, semicolons, passive voice, plain transitions and real lists
are not patterns on their own. Headings, front matter, alt text, code,
quotations, technical terms, inventories and necessary uncertainty remain valid.
Factual technical negations and short generic statements need contextual review.
Record intentional exceptions with reasons. Preserve facts and evidence strength;
never manufacture errors, casualness or opinions to satisfy a voice preference.

The scanner covers a subset of these rules. Broad effect triads, opening quality,
faux-casual quips, substantive content and semantic campaign reuse need editorial
review. No findings and legacy numeric grades do not certify writing quality.
