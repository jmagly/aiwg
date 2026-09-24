# Muse Code session ingestion

AIWG registers `muse` as a **manual-export** session provider. The adapter
ingests only explicit `muse export` trajectory JSON documents supplied by the
operator, gated on the document's `export_schema_version` major (currently
`1`); unknown majors fail closed with `UNKNOWN_SCHEMA_MAJOR`, as with peer
native-export adapters. Auto-discovery is unsupported until a verified native
session root is evidenced on disk; AIWG does not scrape home directories or
invent session roots for this provider.

## How to import

1. Export the session from Muse Code. On an interactive terminal, `muse
   export` opens the same session picker as `muse resume`; `--last`,
   `--session`, and `--out` skip the picker:
   - `muse export --last`
   - `muse export --session <session-uuid> --out trajectory.json`
   - `muse export --redacted --out share.json` for the share-safe variant
     (payload strings run through redaction rules before they leave the
     trust boundary).
2. Pass the exported file explicitly to `aiwg sessions import` with provider
   `muse` and locator class `manual-export`.
3. Keep the export under an authorized workspace root.

Inspect and stream succeed only for that authorized file. Discovery throws
`UNSUPPORTED_OPERATION` with remediation to select a file explicitly.

## Trajectory shape

The adapter follows the documented export format from the Meta [audit agent
sessions recipe](https://dev.meta.ai/docs/cookbook/audit-agent-sessions) and
does not invent fields the docs don't show:

- Top level: `export_schema_version` (integer), `redaction`, `exporter_version`
  / `session_build` (`display` strings), `session_terminated_abnormally`
  (boolean), per-stream `sessions` summaries (`session_id`, `turn_count`,
  `step_count`, `session_end`), ordered `events`, and `diagnostics` counters.
- Each event is an envelope `{sequence, recorded_at, record_type, durability,
  payload_type, payload}`; the effective event kind is
  `payload.event.kind`, falling back to `payload_type` (a stream fact such as
  `approval_wait.effect.started`).
- All events in one document are attributed to the first stream summary
  (`sessions[0].session_id`), matching the single-session export contract.

## Preserved provenance

Approvals, tool runs, and model-lifecycle facts are preserved under
`extensions["native.muse"]` with provenance fields, including:

- `side_effect_intent`: `operation` (`tool:<name>`), `policy_decision`
  (e.g. `allow:policy`, `allow:llm_judge`).
- `decision_applied`: `decision`, `policy_result`, `decision_source`
  (`kind`, e.g. `llm_judge`, with `prompt_version`, `params_version`,
  `context_digest`).
- `approval_wait.effect.terminal`: `outcome`.
- Document-level provenance: `exportSchemaVersion`, `redaction`,
  `exporterVersion`, `sessionBuild`, `terminatedAbnormally`, `diagnostics`.

A trajectory whose log recorded no orderly `session.end`
(`session_terminated_abnormally: true`) inspects as `provisional`; an
orderly export inspects as `complete`.

## Evidence gaps

The Meta recipe documents a candidate native log path of
`$XDG_DATA_HOME/muse/sessions/YYYY/MM/DD/<session-id>/session.jsonl`
(default `~/.local/share/muse/sessions`), but no native root has been
verified on disk by AIWG, so no discover path and no `~/.muse` (or similar)
root is assumed. A future evidence-gated `--muse-root` discover path,
analogous to `--codex-root`, remains the route to native discovery (#222
PR B). A multi-stream export's later streams have no documented per-event
session association yet; events are attributed to the first stream summary
until product evidence says otherwise.

## Tested contract

AIWG adapter contract: `1.0.0`. Synthetic fixtures cover:

- authorized export trajectory import (`valid-v1.json`) — approvals, tool
  runs, and lifecycle events preserved with provenance
- malformed opaque input (`malformed.json` → `MALFORMED_SOURCE`)
- unknown schema major (`unknown-major.json` → `UNKNOWN_SCHEMA_MAJOR`)
- rejection of non-`manual-export` locator classes
- discover unsupported without filesystem probes
- cursor-based resume across streamed events

No live Muse Code sessions, log files, or credentials were used: fixtures
are synthetic records of the documented trajectory shape only.
