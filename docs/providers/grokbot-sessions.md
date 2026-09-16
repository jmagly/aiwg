# Grok Bot session ingestion

AIWG registers `grokbot` as a **manual-export** session provider. Auto-discover of
Grok Bot desktop session stores is **unsupported** until a verified native
filesystem or API locator exists. AIWG will not scrape invented `~/.grokbot`,
`~/grokbot-skills`, or Cursor session paths for this provider.

## How to import

1. Export or copy an authorized session transcript into the AIWG generic session
   interchange format (`type: aiwg.session-interchange`, schema major `1`).
2. Pass that file explicitly to `aiwg sessions import` with provider `grokbot`
   and locator class `manual-export`.
3. Keep the export under an authorized workspace root.

Inspect and stream succeed only for that authorized file. Discovery throws
`UNSUPPORTED_OPERATION` with remediation to select a file explicitly.

## Evidence gaps

As of 2026-09-15 there is no verified Grok Bot session store layout, Gateway
DB path, or export command comparable to Hermes/OpenHuman JSONL or Warp
`/export-to-file`. Cursor session locators must not be reused for Grok Bot
fleets.

When product evidence lands, a follow-on change may add a native locator class
without flipping this experimental provider to stable (#210).

## Tested contract

AIWG adapter contract: `1.0.0`. Synthetic fixtures cover:

- authorized generic interchange import (`valid-v1.jsonl`)
- malformed opaque input (`opaque-input.jsonl` → `MALFORMED_SOURCE`)
- unknown schema major (`unknown-major-v2.jsonl` → `UNKNOWN_SCHEMA_MAJOR`)
- rejection of non-`manual-export` locator classes
- discover unsupported without filesystem probes
