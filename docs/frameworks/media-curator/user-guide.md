# Media Curator User Guide

## Getting Started

### Prerequisites

Install required tools:

```bash
# yt-dlp (video/audio downloader)
pip install yt-dlp

# ffmpeg (transcoding, extraction)
# Ubuntu/Debian
sudo apt install ffmpeg

# macOS
brew install ffmpeg

# opustags (Opus metadata)
# Ubuntu/Debian
sudo apt install opustags

# macOS
brew install opustags
```

### Deploy the Framework

```bash
aiwg use media-curator
```

## Quick Start: Complete Collection

The simplest way to use Media Curator is the `/curate` command:

```bash
/curate "Twenty One Pilots" --output ~/music/twenty-one-pilots
```

This runs the full pipeline: analyze → discover → acquire → tag → verify → report.

## Step-by-Step Workflow

### Step 1: Analyze the Artist

```bash
/analyze-artist "Twenty One Pilots" --depth thorough
```

Output: structured era breakdown, catalog structure, special collections.

### Step 2: Discover Sources

```bash
/find-sources "Twenty One Pilots" --scope complete --output sources.yaml
```

Output: ranked source list per track/album with quality scores.

### Step 3: Acquire Content

```bash
/acquire --plan sources.yaml --output ~/music/twenty-one-pilots --parallel 3
```

Downloads content with format selection, quality filtering, and progress tracking.

### Step 4: Tag and Organize

```bash
/tag-collection ~/music/twenty-one-pilots --artist "Twenty One Pilots"
```

Applies metadata tags, embeds artwork, enforces naming conventions.

### Step 5: Verify Integrity

```bash
/verify-archive ~/music/twenty-one-pilots --generate --provenance
```

Generates CHECKSUMS.sha256, VERIFY.md, and PROVENANCE.jsonld.

### Step 6: Check Completeness

```bash
/check-completeness "Twenty One Pilots" --collection ~/music/twenty-one-pilots
```

Shows what you have, what's missing, and what to prioritize.

## Targeted Workflows

### Specific Era

```bash
/curate "Twenty One Pilots" --scope era:trench --output ~/music/top-trench
```

### Specific Style

```bash
/curate "Twenty One Pilots" --scope style:acoustic --output ~/music/top-acoustic
```

### Single Track/Album

```bash
/find-sources "Twenty One Pilots" --scope track:"Car Radio"
/acquire --url "https://youtube.com/watch?v=..." --format audio --output ~/music/
```

### Open-Weight Model Archival

> "Find the current best uncompressed models in the 8-9B range and start Phase 1 archival into /archive/llm."

Your assistant uses the LLM Model Archivist workflow to assess candidates and verify their archival records.

#### Command reference

The same discipline applies to open-weight language models: discover
candidates, rank them on sourced evidence, archive original-precision weights,
and verify them with a checksum manifest and a PROV record.

```text
"Find the current best uncompressed models in the 8-9B range and start
 Phase 1 archival into /archive/llm."
```

The `llm-model-archivist` agent reuses `find-sources`, `acquire`,
`integrity-verification`, `verify-archive`, `provenance-tracking`, and
`check-completeness`, and renders its inventory and report with:

```bash
node tools/media-curator/llm-model-report.mjs inventory render inventory.json > inventory.md
node tools/media-curator/llm-model-report.mjs report lint report.md     # fails on unsourced numbers
node tools/media-curator/llm-model-archive.mjs fixity verify <model-dir> # fails on a missing or corrupted shard
```

Quantized-only models are flagged in the report, not archived, unless you ask
for them explicitly. Hub tokens are read at the point of use and never written
into the inventory or report. Field reference:
[LLM model archive templates](llm-model-archive-templates.md).

## Assembly and Export

### Create a Narrative Compilation

```bash
/assemble --type narrative --name "DEMA Saga" --collection ~/music/twenty-one-pilots
```

### Create a Playlist

```bash
/assemble --type playlist --name "Best of Vessel Era" --collection ~/music/twenty-one-pilots
```

### Export for Plex

```bash
/export --profile plex ~/music/twenty-one-pilots ~/plex/music/twenty-one-pilots
```

### Export for Mobile (Size-Budgeted)

```bash
/export --profile mobile --max-size 8 ~/music/twenty-one-pilots ~/phone/music/
```

## Quality Control

### Default Behavior

- Quality threshold: 6.0/10
- Phone recordings: rejected
- Pro-shot content: accepted
- Legendary content: accepted regardless of quality

### Adjust Quality

```bash
# Accept everything
/curate "Artist" --quality 3

# Only the best
/curate "Artist" --quality 8
```

## Archive Maintenance

### Verify After Copy/Transfer

```bash
/verify-archive ~/music/twenty-one-pilots --verify
```

### Regenerate After Adding Files

```bash
/verify-archive ~/music/twenty-one-pilots --fix
```

### Periodic Bit Rot Check (cron)

```bash
# Add to crontab - weekly verification
0 3 * * 0 cd ~/music/twenty-one-pilots && tail -n +4 CHECKSUMS.sha256 | sha256sum -c --quiet
```

## Network Storage Rules

When working with archives on NAS/CIFS mounts:

1. **Never** do bulk operations directly on network mounts
2. **Always** pull to local storage first
3. Process locally (NVMe speed)
4. Push back when done

```bash
rsync -avh /nas/archive/ ~/local/working/
# ... all processing happens locally ...
rsync -avh --delete ~/local/working/ /nas/archive/
```

## Troubleshooting

### yt-dlp 403 Errors

YouTube's SABR streaming causes HTTP 403 with specific format selectors on newer videos:

```bash
# FAILS on newer videos:
yt-dlp -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]" URL

# WORKS: use generic selector
yt-dlp -f "best[ext=mp4]/best" URL
```

### MusicBrainz Rate Limiting

MusicBrainz allows 1 request per second. The framework handles this automatically, but if you see 503 errors, add delays between lookups.

### opustags Not Found

```bash
# Ubuntu/Debian
sudo apt install opustags

# If not in repos, build from source:
# https://github.com/fmang/opustags
```

### Large Archive Performance

For archives with 1000+ files, use `--parallel` flag for batch operations and avoid running verification on network mounts.
