# Applying voice: selected workflow and output impact

## Selected development default

Use requested `gpt-6-astra`, medium reasoning, one initial draw, primary-session criticism, at most one same-model correction, full primary-session recheck, then production revision replay. Keep an initial joint pass unchanged; correct only failures with returned responses. Preserve the original when no candidate qualifies or no valid review exists. Do not silently substitute a model or reviewer. Additional planned voices are paused.

The packaged [flow](../flows/voice-critique-correction.flow.yaml) is the complete repeatable protocol. It is agent-interpreted AIWG metalanguage, not an unattended CLI model runner. The protocol fields describe obligations beyond schema validation. This is an opt-in development workflow, not automatic interception of provider outputs or completed channel qualification.

Use opaque profile IDs, analytical descriptions of cadence and rhetorical organization, and attributable authentic examples. Exclude target names, aliases, biographies and attribution paths from both generation and correction packets, including feedback. Keep identity mappings and source hashes in private provenance. Recognizable excerpts can still reveal their source; removing labels establishes neither anonymity nor a measured refusal reduction. No refusal was observed in these trials.

## Measured impact

Joint acceptance requires an applicable proposal, exact protected literals and multiplicities, complete factual fidelity, and cadence 2/2. Cadence measures sentence movement and rhetorical organization, not punctuation preferences or authorship probability.

| Development experiment | Joint accepted | Richer text | Short technical text |
|---|---:|---:|---:|
| Astra, initial generation | 4/15 | 4/9 | 0/6 |
| Astra, one broad-criticism correction | 9/15 | 9/9 | 0/6 |
| Sol, initial generation | 3/15 | 3/9 | 0/6 |
| Sol, one broad-criticism correction | 4/15 | 4/9 | 0/6 |
| Astra, precise-feedback correction | 8/15 | 8/9 | 0/6 |
| Astra, neutral profiles, generation only | 2/9 | 2/3 | 0/6 |

The historical Astra correction workflow rescued 5 of 11 initial failures, raising acceptance from 26.7% to 60% (+33.3 percentage points). Six of fifteen cases retained their originals. Its eleven corrections all passed applicability, literal and fidelity checks; six still lacked sufficient voice. Function-selected examples alone and with precise feedback each yielded 0/6 technical joint passes. Those experiments do not justify replacing the broad-feedback workflow.

The selected workflow now requires neutral profiles. That exact neutral-profile-plus-correction combination has **not been measured**. The 9/15 historical score used author-labelled packets. Neutral generation achieved 9/9 applicability, literal and fidelity passes, but only 2/9 joint passes. Names, generic guidance and fact-ledger wording changed together, so the fidelity improvement cannot be attributed to label removal.

These are development judgments by one primary session on three public source profiles and two source texts. Six technical cells reuse the same 59-word source; they are not six independent topics. Richer cases use a 198-word fictional source. Mechanisms and draw counts vary between experiments. There is no heldout author/reader validation, no statistical causal claim, no demonstrated JDS or full-inventory score, and no 10/10 qualification. Short-text calibration accepted 5/6 authentic excerpts and 0/6 paraphrases, but familiarity compromised blinding; one authentic short passage lacked distinguishable cadence under this rubric.

## What applying voice may change

Voice can change clause arrangement, transitions, emphasis, paragraph movement, word choice and rhythm within the requested edit permissions. It must preserve propositions, actors, quantities, chronology, uncertainty, scope, attribution, unresolved work and the requested action. Literal checks alone cannot establish these properties.

For example, the richer fixture says missing-charger reports declined from 12 to 3 during a six-week pilot. Moving 12 to before the pilot changes chronology even if both numbers survive. Dating the decision to keep the checklist to April 12 confuses the end-of-pilot decision with subsequent adoption. Adding an instruction for a volunteer to record checks changes that actor's task. Each is a fidelity failure, regardless of cadence. The successful neutral richer cases preserved these relationships; a third preserved them but remained a generic paraphrase and was rejected for voice.

Early fact-ledger experiments exposed a harness defect: commentary that a date was not supplied entered generated prose, and ambiguous before/after count keys encouraged incorrect timing. The original run had 0/9 joint passes; a partial ledger repair had 0/3. Preserve those records as setup failures, not clean measurements of model ability. Explicit event relations and removal of metadata from prose inputs matter alongside model choice.

For the technical fixture, exact commands, provider identifiers, operator responsibilities, runtime limitations and the question at the end consume much of the available text. Reorganizing those facts often remained ordinary technical prose. The observed 0/6 cadence acceptance does not mean the faithful original needs embellishment; preserving it is the appropriate fallback.

## Rendering choices retain the core voice

Simulated actual preserves supported register and surface habits without arbitrary inserted errors. Cleaned fixes requested mechanics while retaining phrasing and cadence. Formal changes register locally; it does not authorize stronger claims, generic essay structure or larger rewrites. Concise removes redundancy before paraphrasing and may retain already concise text. Accessible and technical adaptations remain constrained by the reader task and factual ledger. These are separate choices from channel and edit intensity; the complete selectable-mode integration and cross-mode qualification remain pending.

Do not insert catchphrases, first-person experiences, examples, opinions or numbers merely because a profile suggests them. Generated outputs never become authentic source evidence automatically. No blanket ban on punctuation or familiar phrases substitutes for contextual review.

## Receipts and evaluation

Retain original and candidate hashes, profile version, selected mode/channel, exact prompts, literal policy, edit budget, raw outputs, requested and resolved model, review, criticism, recheck, selection and replay. Report attempted changes separately from retained changes, with a source-to-selected diff and rejection reasons. Explain substantive changes outside the user's prose. No-review replay must retain the original. Passing initial candidates skip correction; skips are not measured pass-to-pass corrections.

One correction adds at most one generation request per eligible case and another full review. Native resolved model, tokens, price and reliable per-stage latency were unavailable in these runs; leave them unknown rather than estimating savings. Best-of-three, extra corrections and different correctors require separate manifests and results. Do not reroll failures out of denominators.

All raw evidence and reports belong in the configured remote AIWG artifact repository. The implementation belongs in packaged `agentic/code/`, `src/`, and tests where applicable. Provider deployment directories and `.aiwg` are not distribution source. This document is a presentation export of the canonical impact report; the private run records remain authoritative.

Evidence IDs: `harness-models-01`, `harness-correction-01`, `frontier-feedback-ablation-01`, `short-calibration-01`, `fresh-facts-01`, `fresh-facts-clean-ledger-02`, `neutral-profile-01`, under the configured artifact root's `working/voice-2292/`. Historical frozen paths resolve through its `storage-migration.json`. The selected configuration is recorded in `selected-workflow.json`.
