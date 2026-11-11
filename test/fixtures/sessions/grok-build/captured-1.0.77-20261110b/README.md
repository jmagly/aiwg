# Grok Build 1.0.77 TUI capture projection (2026-11-10, set b)

Sanitized projection of the operator-supplied interactive TUI capture: remember
TULIP, `/compact`, then recall TULIP. Only the two prompts appear in updates;
there is no `/compact` user-message update. Do not invent that turn.

The raw summary omits `session_kind` (reported as null in the capture notes).
The fixture preserves absence; tests also exercise explicit null. Both mean
unknown, never inferred `interactive`.

Chat history contains two `compaction_meta` records and the surviving recall
turn. Updates retain the original prompt/OK, `compaction_checkpoint` with
`prompt_index_at_compaction: 1`, `auto_compact_completed`, and recall/TULIP.
Checkpoint filenames are references only; checkpoint and compaction files are
not acquired. IDs and cwd are synthetic. System, reminder, compaction-context
and reasoning text are replaced; host/user context and fingerprints are removed.
Timestamps, token counts, ordering and text-turn structure are retained.

Tests mutate this projection for corrupt, partial and changed-prefix cases;
those mutations are not live captures. No model or network calls are needed.

The separate headless `--prompt-json` image attempt in set b did not store an
image block in `chat_history.jsonl` and the model did not see the image. There
is no headless attachment record to qualify in 1.0.77. TUI attachments and
snapshot ownership remain deferred.
