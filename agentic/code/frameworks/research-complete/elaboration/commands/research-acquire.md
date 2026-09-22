---
description: Acquire research papers from acquisition queue, download PDFs, validate integrity, and organize artifacts
category: research-management
argument-hint: [--queue <file>] [--doi <identifier>] [--all] [--validate-only]
allowed-tools: Bash, Read, Write, Grep, Glob
model: claude-sonnet-5
---

# Research Acquisition Command

## Task

Download and validate research papers from acquisition queue. Retrieves PDFs from open access sources, institutional repositories, or DOI resolvers. Validates file integrity and organizes artifacts for documentation.

When invoked with `/research-acquire [options]`:

1. **Load** acquisition queue (from discovery or manual DOI list)
2. **Resolve** DOI URLs to PDF download locations
3. **Download** PDFs with retry logic and validation
4. **Verify** file integrity (checksum, PDF validity)
5. **Organize** files in `.aiwg/research/papers/`
6. **Update** acquisition status and metadata

## Parameters

- **`--queue <file>`** (optional): Custom acquisition queue (default: `.aiwg/research/discovery/acquisition-queue.json`)
- **`--doi <identifier>`** (optional): Acquire single paper by DOI (e.g., `10.1145/example`)
- **`--all`** (optional): Acquire all papers in queue (no confirmation)
- **`--validate-only`** (optional): Validate existing downloads without re-downloading

## Inputs

- **Acquisition queue**: `.aiwg/research/discovery/acquisition-queue.json`
- **Configuration**: `.aiwg/research/config.yaml` (download settings, retry limits)
- **Manual DOI** (if --doi): User-provided DOI identifier

## Outputs

- **Downloaded PDFs**: `.aiwg/research/papers/{paper-id}.pdf`
- **Metadata files**: `.aiwg/research/papers/{paper-id}.json`
- **Acquisition log**: `.aiwg/research/logs/acquisition-{timestamp}.log`
- **Updated queue**: Marks papers as `acquired`, `failed`, or `pending`

## Workflow

### Step 1: Load Acquisition Queue

```bash
# Read queue from discovery or custom file
QUEUE_FILE="${1:-.aiwg/research/discovery/acquisition-queue.json}"

if [ ! -f "$QUEUE_FILE" ]; then
  echo "Error: Acquisition queue not found: $QUEUE_FILE"
  echo "Run /research-discover first to create queue"
  exit 1
fi

# Parse paper list
PAPERS=$(jq -r '.papers[] | select(.status == "pending") | .paper_id' "$QUEUE_FILE")
TOTAL=$(echo "$PAPERS" | wc -l)

echo "Acquisition queue: $TOTAL papers pending"
```

### Step 2: Resolve DOI to PDF

```typescript
// DOI resolution strategy (priority order)
async function resolveDOI(doi: string): Promise<string> {
  // 1. Check Unpaywall API for open access PDFs
  const unpaywall = await fetchUnpaywall(doi);
  if (unpaywall.bestOaLocation?.pdfUrl) {
    return unpaywall.bestOaLocation.pdfUrl;
  }

  // 2. Try DOI.org resolver (may redirect to publisher)
  const doiUrl = `https://doi.org/${doi}`;
  const response = await fetch(doiUrl, { redirect: 'follow' });
  if (response.ok && isPDF(response)) {
    return response.url;
  }

  // 3. Check arXiv if paper has arXiv ID
  const arxivId = extractArxivId(doi);
  if (arxivId) {
    return `https://arxiv.org/pdf/${arxivId}.pdf`;
  }

  // 4. Check institutional repositories (if configured)
  const institutional = await checkInstitutionalRepos(doi);
  if (institutional) {
    return institutional;
  }

  throw new Error(`No open access PDF found for DOI: ${doi}`);
}
```

### Step 3: Download PDF with Validation

**Security Note**: Download URLs from trusted sources only (Unpaywall, arXiv, DOI.org). Validate file integrity.

```bash
bash <<'EOF'
# Download paper PDF
DOI="10.1145/example"
PAPER_ID="abc123def456"
PDF_URL=$(resolve_doi "$DOI")

# Download with retry
for i in {1..3}; do
  curl -L -o ".aiwg/research/papers/${PAPER_ID}.pdf" "$PDF_URL" && break
  echo "Download failed, retry $i/3..."
  sleep 5
done

# Validate PDF integrity
if ! file ".aiwg/research/papers/${PAPER_ID}.pdf" | grep -q "PDF"; then
  echo "Error: Downloaded file is not a valid PDF"
  rm ".aiwg/research/papers/${PAPER_ID}.pdf"
  exit 1
fi

# Compute checksum
sha256sum ".aiwg/research/papers/${PAPER_ID}.pdf" > ".aiwg/research/papers/${PAPER_ID}.sha256"

echo "✓ Acquired: ${PAPER_ID}.pdf"
EOF
```

### Step 4: Save Metadata

```json
{
  "paper_id": "abc123def456",
  "doi": "10.1145/example",
  "title": "OAuth 2.0 Security Best Practices",
  "authors": ["Smith, J.", "Doe, A."],
  "year": 2023,
  "venue": "ACM CCS",
  "acquired_date": "2026-01-25T10:30:00Z",
  "source_url": "https://doi.org/10.1145/example",
  "pdf_path": ".aiwg/research/papers/abc123def456.pdf",
  "checksum_sha256": "abc123...",
  "file_size_bytes": 2048576,
  "status": "acquired"
}
```

### Step 5: Update Acquisition Queue

```typescript
// Mark paper as acquired in queue
function updateQueue(paperId: string, status: 'acquired' | 'failed') {
  const queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf-8'));
  const paper = queue.papers.find(p => p.paper_id === paperId);

  if (paper) {
    paper.status = status;
    paper.acquired_date = new Date().toISOString();
  }

  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
}
```

## Examples

### Acquire All Papers in Queue

```bash
# Download all pending papers
aiwg research acquire --all
```

**Output**:
```
Acquisition queue: 10 papers pending

Acquiring papers...
✓ [1/10] abc123def456 - OAuth 2.0 Security Best Practices
✓ [2/10] def456ghi789 - Token Refresh Vulnerabilities
✗ [3/10] ghi789jkl012 - No open access PDF found
✓ [4/10] jkl012mno345 - PKCE Extension for OAuth 2.0
...

Summary:
  Acquired: 8 papers
  Failed: 2 papers (no open access)
  Total size: 45.2 MB

Failed papers:
  - ghi789jkl012: No open access PDF
  - xyz789abc123: Publisher paywall

Next steps:
  - Review acquired papers: ls .aiwg/research/papers/
  - Document papers: /research-document
```

### Acquire Single Paper by DOI

```bash
# Download specific paper
aiwg research acquire --doi 10.1145/3491102.3501874
```

**Output**:
```
Resolving DOI: 10.1145/3491102.3501874
✓ Found open access PDF via Unpaywall
✓ Downloaded: abc123def456.pdf (2.1 MB)
✓ Validated: PDF integrity confirmed
✓ Metadata saved: abc123def456.json

Paper details:
  Title: OAuth 2.0 Security Best Practices
  Authors: Smith, J., Doe, A.
  Year: 2023
  Venue: ACM CCS
  Path: .aiwg/research/papers/abc123def456.pdf
```

### Validate Existing Downloads

```bash
# Check integrity of downloaded papers
aiwg research acquire --validate-only
```

**Output**:
```
Validating 8 downloaded papers...

✓ abc123def456.pdf - Valid (checksum matches)
✓ def456ghi789.pdf - Valid (checksum matches)
✗ jkl012mno345.pdf - Corrupted (checksum mismatch)
...

Summary:
  Valid: 7 papers
  Corrupted: 1 paper
  Missing metadata: 0 papers

Recommendations:
  - Re-download corrupted paper: aiwg research acquire --doi 10.1145/jkl012
```

## Related Agents

- **Acquisition Agent** (@$AIWG_ROOT/agentic/code/frameworks/research-complete/elaboration/agents/acquisition-agent-spec.md): Primary agent executing this command
- **Quality Agent** (@$AIWG_ROOT/agentic/code/frameworks/research-complete/elaboration/agents/quality-agent-spec.md): Validates file integrity
- **Documentation Agent** (@$AIWG_ROOT/agentic/code/frameworks/research-complete/elaboration/agents/documentation-agent-spec.md): Next step after acquisition

## Skill Definition (Natural Language Triggers)

**Skill Name**: Research Acquisition

**Natural Language Patterns**:

- "Download the papers"
- "Acquire research papers"
- "Get PDFs for selected papers"
- "Download paper {DOI}"
- "Fetch research sources"

**Example Invocations**:

```
User: "Download the papers from the queue"
Agent: Executing /research-acquire --all

User: "Get the PDF for 10.1145/3491102.3501874"
Agent: Executing /research-acquire --doi 10.1145/3491102.3501874
```

## Success Criteria

- [ ] All pending papers processed (acquired or failed status)
- [ ] PDFs validated as genuine PDF files
- [ ] Checksums computed and stored
- [ ] Metadata saved for each paper
- [ ] Acquisition queue updated with status
- [ ] User can proceed to `/research-document` (UC-RF-003)

## Error Handling

### No Open Access PDF Found

```
Warning: No open access PDF for DOI: 10.1145/example

Options:
1. Check institutional access (if configured)
2. Request via inter-library loan
3. Contact authors directly
4. Mark as "manual acquisition required"

Continuing with next paper...
```

### Download Failed (Network Error)

```
Error: Download failed for abc123def456
Retrying... (Attempt 2/3)
✓ Retry successful
```

### PDF Validation Failed

```
Error: Downloaded file is not a valid PDF
File type: text/html (likely publisher paywall page)

Deleting invalid file...
Marking paper as "failed - paywall"
```

## Best Practices

1. **Prefer open access**: Use Unpaywall API to find free PDFs
2. **Validate integrity**: Always compute checksums for downloaded files
3. **Respect rate limits**: Space downloads to avoid throttling
4. **Batch acquisition**: Use `--all` for efficient bulk downloads
5. **Manual fallback**: Document papers requiring institutional access

## References

- @$AIWG_ROOT/agentic/code/frameworks/research-complete/elaboration/use-cases/UC-RF-002-acquire-research-source.md - Use case specification
- @$AIWG_ROOT/agentic/code/frameworks/research-complete/elaboration/agents/acquisition-agent-spec.md - Acquisition Agent
- [Unpaywall API](https://unpaywall.org/products/api) - Open access discovery
- [DOI System](https://www.doi.org/) - Digital Object Identifier resolution

## Security Notes

- Download URLs from trusted sources only (Unpaywall, arXiv, DOI.org)
- Validate file integrity with checksums
- No API keys hardcoded (loaded from config.yaml)
- Avoid executing downloaded content (PDFs are data, not code)

---

**Status**: DRAFT
**Created**: 2026-01-25
**Owner**: Acquisition Agent Designer
**UC Mapping**: UC-RF-002 (Acquire Research Source)
