# Media Curator Framework Overview

The Media Curator framework enables AI agents to build, curate, and maintain
comprehensive media collections. It handles the full lifecycle from
type-flexible assessment through acquisition, organization, verification,
transcription where needed, research handoff, and multi-platform export.

## Common Use Cases

- Audit an existing archive, identify missing metadata, and create a cleanup plan.
- Research an artist, venue, creator, or event series before acquiring material.
- Acquire media from approved sources, then tag and verify the collection.
- Prepare transcripts, playlists, exports, or research handoffs from a curated archive.

## Design Philosophy

### Issue-Driven Development

This framework emerged from a real prototype: cataloging a large artist discography with mixed official, unofficial,
live, and archival material. The agents, commands, and skills reflect patterns from that field test.

### Quality Over Quantity

Not all media is worth collecting. The framework applies multi-dimensional quality scoring (audio, video, uniqueness) with configurable thresholds. Phone recordings are rejected by default, but "legendary" content (historically significant, only known recording) bypasses quality gates.

### Classification by Production Context

A key field-test learning: classify media by how it was produced (studio, live, broadcast), not how it sounds (acoustic, electric). A stripped-down studio recording is still a studio recording.

### Type-Flexible Entry

Unknown or mixed media starts with assess-and-plan rather than an audio-only
path. The framework selects music/discography handling only when the request,
metadata, filenames, or sources show that the archive is music-centered. See
`type-flexible-curation.md` for the recorded routing decision.

### Integrity First

Every archive includes self-verifying SHA-256 checksums and W3C PROV-compliant provenance tracking. Bit rot detection is built in, not bolted on.

## Framework Components

### Agents

| Agent | Purpose |
|-------|---------|
| Discography Analyst | Research eras, map catalog structure |
| Source Discoverer | Find content across platforms |
| Acquisition Manager | Orchestrate downloads |
| Quality Assessor | Score and filter content |
| Metadata Curator | Tag, name, organize |
| Completeness Tracker | Gap analysis and prioritization |
| LLM Model Archivist | Discover, rank, and preserve open-weight language models with fixity and provenance |

### Commands

| Command | Purpose |
|---------|---------|
| `/curate` | End-to-end orchestration |
| `/analyze-artist` | Discography analysis |
| `/find-sources` | Source discovery |
| `/acquire` | Download management |
| `/tag-collection` | Metadata application |
| `/check-completeness` | Gap analysis |
| `/assemble` | Narrative/playlist assembly |
| `/export` | Multi-platform output |
| `/verify-archive` | Integrity verification |

### Skills

| Skill | Purpose |
|-------|---------|
| YouTube Acquisition | yt-dlp patterns |
| Archive Acquisition | Internet Archive patterns |
| Audio Extraction | ffmpeg audio extraction |
| Metadata Tagging | opustags/ffmpeg tagging |
| Quality Filtering | Accept/reject logic |
| Cover Art Embedding | Artwork embedding |
| Integrity Verification | SHA-256 manifests |
| Transcribe Media | Timestamped transcript sidecars |
| Curate | Assess-and-plan for arbitrary or mixed media |
| Gap Documentation | GAP-NOTE.md pattern |
| Provenance Tracking | W3C PROV-O for media |

## Pipeline Overview

```
analyze-artist → find-sources → acquire → tag-collection → verify-archive → check-completeness
                                                                              ↓
                                                                    assemble / export
```

## Tools Required

| Tool | Purpose | Required |
|------|---------|----------|
| yt-dlp | Video/audio download | Yes |
| ffmpeg/ffprobe | Transcoding, extraction, analysis | Yes |
| opustags | Opus metadata tagging | Yes |
| sha256sum | Integrity checksums | Yes (GNU coreutils) |
| wget/curl | Direct file download | Yes |

## Archive Structure

```
{artist}/
├── albums/{album_name}/
│   ├── audio/
│   └── video/
├── singles/
├── sessions/
│   ├── radio/
│   ├── interviews/
│   └── tv/
├── unofficial/
│   ├── live-performances/
│   └── rare-versions/
├── artwork/
│   ├── albums/
│   ├── artists/
│   ├── live/
│   ├── logos/
│   └── promotional/
├── lyrics/
├── .curator/
│   ├── manifest.json
│   ├── sources.json
│   └── gaps.json
├── CHECKSUMS.sha256
├── VERIFY.md
└── PROVENANCE.jsonld
```

## Related

- Epic issue: #75
- Prototype: large artist collection field test
- Standards: ID3v2.4, SHA-256, PREMIS 3.0, W3C PROV-O, ISO 8601

## Next Step

Deploy the framework with `aiwg use media-curator`, then ask your assistant to assess one existing media folder and
produce an acquisition, metadata, and verification plan before downloading or rewriting files.
