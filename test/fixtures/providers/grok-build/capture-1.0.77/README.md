# Sanitized Grok Build 1.0.77 structural fixtures

Source: supplied Linux `grok-build-captures-20261109` bundle, 2026-11-09,
README and `cli/version.txt`, `cli/headless-json.out`,
`cli/headless-streaming-json.out`, `cli/inspect-{trusted-project,untrusted-cwd}.txt`.
See [capture review](../../../../../docs/providers/grok-build-evidence/2026-11-09.md).

`snapshot.json` retains only the banner version/revision, observed argv tokens,
JSON top-level keys and event-type set. It is a partial help/schema signature:
no full CLI help or config JSON schema was supplied. It cannot detect arbitrary
new help flags or nested schema changes. Missing evidence is recorded in it.

`result.json` replaces all values with synthetic placeholders; `events.jsonl`
retains only event discriminants. These are schema comparison fixtures, not
valid full parser/health events or end-to-end transcripts. Inspection excerpts
retain only trust, instruction paths relative to the synthetic project, counts
and one AIWG skill. Absolute paths, names, identifiers, prompt/answer content,
configuration and system prompt text were dropped, not copied. No models ran.
