# Author-controlled writing workflows

These recipes use the existing mode resolver and opt-in writer sidecars. They do not activate a universal provider response filter. Legacy YAML voices remain available; importing an attachment preserves its original format and does not infer or approve preferences.

## Local plan and exact proofreading

Prepare a complete brief using [the writing brief schema](../../../../../docs/voice/writing-briefs.md), including supported propositions, reader task, source hashes and permissions. Import an author-approved sidecar separately:

```sh
aiwg writer-profile import writer.json --revision 0
aiwg writer-profile inspect my-writer
aiwg writing plan --brief brief.json --profile my-writer --channel article
aiwg writing proofread --brief proofread-brief.json --profile my-writer --correction typo-1 --output reviewed.txt
```

Use the actual profile and authorized correction IDs in your files. `plan` writes a structured brief/target artifact; it does not generate article prose. `proofread` requires a `proofread-only` brief and applies exact authorized corrections to its embedded original text. Without `--correction`, all listed authorized corrections are selected. It does not run a model or apply voice transformations. The optional export path must be a new file allowed by project artifact policy. Canonical output and a separate immutable receipt are written first under the configured AIWG artifact root. A failed optional export can leave those canonical artifacts available.

## Selection and effective state

```sh
aiwg output-mode status --output-mode writer-my-writer --output-mode channel-article
aiwg output-mode enable writer-my-writer --scope session
aiwg output-mode enable channel-article --scope project
aiwg output-mode status
aiwg output-mode disable channel-article --scope project
aiwg output-mode clear --scope session
```

The first command inspects an invocation stack; it does not transform text or persist selection. Session and project settings persist at their respective scopes. A different structure mode conflicts with a selected channel pack. Multiple author voices require explicit merge policy; selecting a new voice does not silently replace a conflicting voice. Inspect both project and session state when disabling a profile. Clear only settings the user intended to clear. Empty stacks leave output unchanged.

Selected, delivered, applied, validated and fallback states mean different things. A selection or instruction export is not proof of delivery. A supplied local callback establishes delivery; only retained passes count as applied. Mandatory validator results can establish their declared validation scope, never human authorship or general factual truth. Provider/consumer labels are caller-supplied. JSON, tool and protocol output stay unchanged unless a participating consumer explicitly selects a prose field.

## Participating channel and revision APIs

The `aiwg` package API exports `applyWritingConsumer`, `applyWritingChannel`, `getWritingChannelPack`, and the brief/profile APIs. `applyWritingChannel` takes the ordinary consumer context (`cwd`, `frameworkRoot`, `provider`, `consumer`, `format`, `invocationModes`), a channel and parsed brief. It selects `channel-article`, `channel-social`, `channel-email`, `channel-engineering` or `channel-conversation` through the existing resolver. Add `writer-<id>` to `invocationModes` for the approved profile.

A supplied `transform(content, mode, { pack, brief })` performs the local transformation; preserve protected-literal placeholders. Pass an explicit `runtime.validateFinal` reviewer. Automatic fidelity checks can reject material changes; unresolved changed prose does not become validated merely because a callback produced it. No callback means instruction-export fallback. Samples and brief text are data rather than instructions. See [channel constraints and coverage](../../../../../docs/voice/channels.md), including same-post Telegram/Discord CTA and the external publisher's incompatible two-record contract.

Use `runVoiceRevision` for bounded critique/revision callbacks with explicit token/time limits, cancellation and retained originals. Without an independent reviewer, retain the original and present the candidate for human comparison. `createRevisionReview`, `acceptRevisionEdits` and `undoRevisionReview` support located edits, partial acceptance and exact undo. Human-approved corrections can create a separate `proposeWriterLearning` proposal; `acceptWriterLearning` requires explicit acceptance against the expected profile revision. Generated suggestions do not silently update profiles. See [revision and learning](../../../../../docs/voice/revision.md).

`createWritingReceipt`, `validateWritingReceipt`, `writeWritingReceipt` and `readWritingReceipt` handle closed, versioned provenance artifacts. Record actual reported usage or a labeled reserved bound; do not invent precise model costs. Receipts belong outside publishable prose and omit raw source/sample text. They bind declared inputs/configuration and output hashes, but do not attest to a hosted provider's hidden model version. See [receipts and migration](../../../../../docs/voice/receipts-and-migration.md).

## MCP handoff and rollback

Read `aiwg://writer-profiles/catalog` for scoped identifiers and metadata. An explicit resource read such as `aiwg://writer-profiles/project/my-writer` uses shared export policy; private sample exports are unavailable through that resource. The resource does not select a profile or transform provider output. Use the scoped URI returned by the catalog; a missing project profile never falls through to a user profile.

Disable unwanted session/project mode selections to restore the empty-stack path. Use review undo for text edits and the separate learning undo artifact for accepted preference changes; stale state is rejected. Legacy migrations are dry-run plans followed by explicit application and managed rollback, described in the migration guide. Revocation removes local sample text and dependent inferred preferences, but cannot recall previous exports or remote caches.

Before widening use, consult [qualification gates](../../../../../docs/voice/qualification.md). These recipes describe implemented interfaces; packaged smoke results and real author/model evaluation must be recorded separately.

## Reviewed voice transformation

See the [selected workflow and output impact](voice-output-impact.md) for the development default, neutral profile policy, measured acceptance, fallback behavior and qualification limits.
