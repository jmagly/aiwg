# LLM Model Archive Templates

Inventory, report, and per-model record shapes used by the LLM Model Archivist
agent (`agents/llm-model-archivist.md`). The tools under
`tools/media-curator/` render and lint these; the fields below are the contract
they enforce.

## Inventory entry (`inventory.json`)

> "Validate my model inventory and render it for review."

Your assistant uses the inventory validator and renderer with the entry contract below.

### Command reference

One entry per evaluated model. `status` moves `candidate` → `archived` once
`fixity verify` passes, or → `flagged-quantized-only` / `rejected`.

```json
{
  "model_id": "example-org/example-8b",
  "revision": "0123456789abcdef0123456789abcdef01234567",
  "precision": "bf16",
  "parameter_count": "8B",
  "license": "apache-2.0",
  "downloads": { "count": 1234567, "captured_at": "2026-09-13" },
  "benchmarks": [
    { "name": "MMLU", "score": 66.1, "source_url": "https://huggingface.co/example-org/example-8b", "date": "2026-09-13" },
    { "name": "GSM8K", "score": 79.4, "source_url": "https://example.org/paper", "date": "2026-08-01" }
  ],
  "archive_path": "/archive/llm/example-org__example-8b/0123456789abcdef0123456789abcdef01234567",
  "files": [
    { "path": "model-00001-of-00002.safetensors", "sha256": "…64 hex…" },
    { "path": "config.json", "sha256": "…64 hex…" }
  ],
  "status": "archived"
}
```

| Field | Required | Notes |
|---|---|---|
| `model_id` | yes | `<org>/<name>` as on the hub |
| `revision` | yes | Hub commit SHA or revision inspected and archived |
| `precision` | yes | `fp32`, `fp16`, `bf16`; quantized labels allowed only for flagged entries |
| `parameter_count` | yes | String such as `8B` |
| `license` | yes | SPDX id or hub license label |
| `downloads` | yes | `count` plus `captured_at` (`YYYY-MM-DD`); popularity without a date is not evidence |
| `benchmarks` | yes (may be empty) | Each needs `name`, `score`, `source_url`, `date` |
| `archive_path` | yes | Final revision directory |
| `files` | yes | `path` + `sha256` per archived file; `archived` entries need at least one |
| `status` | yes | `candidate`, `archived`, `flagged-quantized-only`, `rejected` |
| `explicitly_requested` | no | `true` permits archiving a non-original precision |

```bash
node tools/media-curator/llm-model-report.mjs inventory validate inventory.json
node tools/media-curator/llm-model-report.mjs inventory render inventory.json > inventory.md
```

## Report (`report.json` → `report.md`)

> "Render my model archive report and check its evidence citations."

Your assistant renders the report and runs the report linter for missing evidence and credential exposure.

### Command reference

```json
{
  "title": "Open-weight 8-9B archival candidates",
  "criteria": "7-9B text-generation models with original-precision safetensors; ranked 50/50 popularity and benchmark mean.",
  "candidates": [ "<inventory entries, ranked>" ],
  "flagged": [ { "model_id": "example-org/example-8b-gguf", "precision": "Q4_K_M", "reason": "publishes GGUF only" } ],
  "recommendations": [ "Archive example-org/example-8b at the inspected revision." ],
  "sources": [ "https://huggingface.co/open-llm-leaderboard" ]
}
```

Rendered sections: Criteria, Ranked candidates, Flagged: quantized-only,
Recommendations, Evidence quality, Sources.

```bash
node tools/media-curator/llm-model-report.mjs report render report.json > report.md
node tools/media-curator/llm-model-report.mjs report lint report.md
```

The lint fails (`exit 1`) on a benchmark figure with no source URL or capture
date on its line and on any hub credential (`hf_…`, bearer header, `HF_TOKEN=`);
it warns on overclaiming language (`proves`, `conclusively`) per the
`citation-policy` rule.

## Per-model records

> "Write and verify fixity records for this archived model revision, then write its provenance."

Your assistant uses the archive tools to create the checksum manifest and provenance record beside the weights.

### Command reference

Written into the revision directory beside the weights:

- `CHECKSUMS.sha256` — self-verifying manifest (`# MANIFEST_HASH` header over
  the body), one `sha256  ./path` line per file, the same shape
  `integrity-verification` and `verify-archive` produce.
- `PROVENANCE.jsonld` — PROV-O + PREMIS record: the model collection entity
  (with `premis:hasFixity` carrying the manifest hash), the hub source entity
  it `prov:wasDerivedFrom`, the archive activity, and the software agent.

```bash
node tools/media-curator/llm-model-archive.mjs fixity write <model-dir>
node tools/media-curator/llm-model-archive.mjs fixity verify <model-dir>
node tools/media-curator/llm-model-archive.mjs provenance write <model-dir> --spec spec.json
```

`spec.json` requires `modelId`, `revision`, `precision`, `parameterCount`,
`license`, `sourceUrl`, `archivePath`; optional `downloads { count, capturedAt }`,
`agent { name, version }`, `startedAt`, `endedAt`. When `fixity` is omitted the
tool reads it from the directory's `CHECKSUMS.sha256`.
