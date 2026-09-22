---
description: Discover research papers via semantic search with automated gap analysis and PRISMA-compliant documentation
category: research-management
argument-hint: <query> [--preregister] [--citation-network] [--refine-from <session>] [--limit <count>]
allowed-tools: Bash, Read, Write, Grep, Glob
model: claude-sonnet-5
---

# Research Discovery Command

## Task

Execute semantic search for research papers, perform automated gap analysis, and generate PRISMA-compliant search strategies. Connects to Semantic Scholar API to find, rank, and analyze academic papers relevant to user query.

When invoked with `/research-discover <query> [options]`:

1. **Validate** search query and parameters
2. **Construct** Semantic Scholar API query with filters
3. **Execute** API search with rate limiting and error handling
4. **Rank** results by relevance, citations, venue tier, and recency
5. **Analyze** gaps in research coverage
6. **Generate** PRISMA-compliant search strategy
7. **Save** results and create acquisition queue

## Parameters

- **`<query>`** (required): Research topic or question (natural language, 3-200 characters)
- **`--preregister`** (optional): Generate PRISMA preregistration protocol for systematic reviews
- **`--citation-network`** (optional): Enable citation chaining (forward and backward)
- **`--refine-from <session>`** (optional): Refine previous search (e.g., `--refine-from last`)
- **`--limit <count>`** (optional): Number of results (default: 100, max: 500)
- **`--year-range <YYYY-YYYY>`** (optional): Publication year filter (e.g., `--year-range 2020-2024`)
- **`--venue <type>`** (optional): Filter by venue type (`conference`, `journal`, `all`)

## Inputs

- **Search query**: User-provided research question
- **Configuration**: `.aiwg/research/config.yaml` (API keys, rate limits, ranking weights)
- **Previous search** (if --refine-from): `.aiwg/research/discovery/search-results-{session}.json`

## Outputs

- **Search results**: `.aiwg/research/discovery/search-results-{timestamp}.json`
- **Search summary**: `.aiwg/research/discovery/search-summary-{timestamp}.md`
- **Search strategy**: `.aiwg/research/discovery/search-strategy.md` (PRISMA-compliant)
- **Gap analysis**: `.aiwg/research/analysis/gap-report-{timestamp}.md`
- **Acquisition queue**: `.aiwg/research/discovery/acquisition-queue.json`

## Workflow

### Step 1: Validate Query

```bash
# Check query length and format
QUERY="$1"
if [ -z "$QUERY" ]; then
  echo "Error: Query cannot be empty"
  echo "Usage: aiwg research discover \"your research topic\""
  exit 1
fi

# Warn if query too broad
WORD_COUNT=$(echo "$QUERY" | wc -w)
if [ "$WORD_COUNT" -lt 3 ]; then
  echo "Warning: Query may be too broad. Consider adding specificity."
  echo "Example: 'OAuth2 security best practices' instead of 'OAuth'"
fi
```

### Step 2: Construct API Query

Build Semantic Scholar API request:

```typescript
// API query construction
const apiQuery = {
  query: sanitizeQuery(userQuery),
  limit: options.limit || 100,
  fields: [
    'paperId',
    'title',
    'authors',
    'year',
    'venue',
    'citationCount',
    'doi',
    'abstract',
    'url',
    'isOpenAccess'
  ],
  sort: 'relevance',
  ...(options.yearRange && {
    yearRange: parseYearRange(options.yearRange)
  }),
  ...(options.venue && {
    venue: options.venue
  })
};
```

### Step 3: Execute Search with Rate Limiting

**Security Note**: API keys must be loaded from environment variables or secure configuration files, never hardcoded.

```bash
bash <<'EOF'
# Load API configuration
API_KEY=$(grep 'semantic_scholar_api_key' .aiwg/research/config.yaml | awk '{print $2}')

# Construct API request
QUERY="OAuth2 security best practices"
LIMIT=100

# Execute with rate limiting (100 req/5 min)
curl -s \
  -H "x-api-key: ${API_KEY}" \
  "https://api.semanticscholar.org/graph/v1/paper/search?query=${QUERY}&limit=${LIMIT}&fields=paperId,title,authors,year,venue,citationCount,doi,abstract,url" \
  | jq . > .aiwg/research/discovery/search-results-$(date +%s).json
EOF
```

**Error Handling**:

- **429 Rate Limit**: Wait 60 seconds, retry (3 attempts max)
- **500 Network Error**: Exponential backoff (5s, 10s, 20s), retry
- **0 Results**: Suggest query refinement, broader terms, spelling corrections
- **Disk Full**: Abort, display clear error with `df -h` suggestion

### Step 4: Rank Results

Apply ranking algorithm (per BR-RF-D-002):

```typescript
// Ranking weights
const WEIGHTS = {
  relevance: 0.40,    // Semantic similarity to query
  citations: 0.30,    // Impact proxy (log-scaled)
  venueTier: 0.20,    // A*/A/B/C conference/journal ranking
  recency: 0.10       // Publication year (configurable)
};

// Compute composite score
function rankPaper(paper, query) {
  const relevanceScore = computeSemanticSimilarity(paper, query);
  const citationScore = Math.log10(paper.citationCount + 1) / Math.log10(1000); // Normalize
  const venueScore = getVenueTier(paper.venue); // A*=1.0, A=0.8, B=0.6, C=0.4
  const recencyScore = (paper.year - 1990) / (new Date().getFullYear() - 1990);

  return (
    relevanceScore * WEIGHTS.relevance +
    citationScore * WEIGHTS.citations +
    venueScore * WEIGHTS.venueTier +
    recencyScore * WEIGHTS.recency
  );
}
```

### Step 5: Gap Analysis

Identify under-researched topics (per BR-RF-D-003):

```typescript
// Gap detection algorithm
function detectGaps(papers) {
  // Cluster papers by topic using citation relationships
  const clusters = clusterByCitations(papers);

  // Identify sparse clusters (<5 papers)
  const underResearched = clusters.filter(c => c.papers.length < 5);

  // Flag contradictory findings (>50% disagreement)
  const contradictory = findContradictions(papers);

  // Suggest missing integrations (concepts never co-occurring)
  const missingIntegrations = findMissingCombinations(papers);

  return {
    underResearchedTopics: underResearched.map(c => c.topic),
    contradictoryFindings: contradictory,
    missingIntegrations
  };
}
```

### Step 6: Generate PRISMA Strategy

Create search strategy document:

```markdown
# Search Strategy

**Query**: "{user query}"
**Database**: Semantic Scholar
**Date**: {timestamp}
**API Version**: semantic-scholar-v1

## Boolean Search String

```
(OAuth OR "OAuth2" OR "OAuth 2.0") AND (security OR "best practices" OR vulnerabilities)
```

## Inclusion Criteria

- Publication year: 2020-2024
- Venue type: Conference or Journal
- Minimum citations: 10
- Language: English
- Open access preferred

## Exclusion Criteria

- Preprints without peer review
- Duplicate studies
- Non-empirical papers (opinion pieces)

## Screening Workflow

1. **Title/Abstract Screening**: Reviewers independently screen titles and abstracts
2. **Full-Text Review**: Selected papers reviewed in full
3. **Quality Assessment**: Papers assessed using quality checklist
4. **Data Extraction**: Relevant data extracted into evidence tables

## Results

- Total retrieved: 100 papers
- After title/abstract screening: 50 papers
- After full-text review: 20 papers
- Included in review: 15 papers

## Reproducibility

- API version: semantic-scholar-v1
- Timestamp: 2026-01-25T10:30:00Z
- Rate limit: 100 req/5 min
- Query hash: abc123def456
```

### Step 7: Create Acquisition Queue

Save selected papers for acquisition:

```json
{
  "created": "2026-01-25T10:30:00Z",
  "query": "OAuth2 security best practices",
  "total_results": 100,
  "selected_count": 10,
  "papers": [
    {
      "paper_id": "abc123def456",
      "title": "OAuth 2.0 Security Best Practices",
      "doi": "10.1145/example",
      "url": "https://www.semanticscholar.org/paper/abc123def456",
      "status": "pending",
      "priority": 1
    }
  ]
}
```

## Examples

### Basic Semantic Search

```bash
# Discover papers on OAuth2 security
aiwg research discover "OAuth2 security best practices"
```

**Output**:
```
Searching Semantic Scholar...
✓ Found 100 papers in 8 seconds
✓ Gap analysis completed (3 under-researched topics identified)
✓ Search strategy saved: .aiwg/research/discovery/search-strategy.md

Top 5 Results:
1. [95%] OAuth 2.0 Security Best Practices (Smith et al., 2023) - 42 citations
2. [92%] Token Refresh Vulnerabilities in OAuth (Doe et al., 2022) - 35 citations
3. [88%] PKCE Extension for OAuth 2.0 (Johnson et al., 2024) - 18 citations
...

Gap Analysis:
- Under-researched: Token refresh security, OAuth PKCE adoption
- Contradictory: Token rotation effectiveness disputed
- Missing: OAuth + WebAuthn integration

Select papers for acquisition:
  aiwg research select 1 2 3 5 7
  aiwg research select --top 10
```

### PRISMA Preregistration

```bash
# Start systematic review with preregistration
aiwg research discover --preregister

# Agent prompts for PICO elements
# Population: Web applications using OAuth2
# Intervention: Security best practices
# Comparison: Standard OAuth2 implementations
# Outcome: Vulnerability reduction

# Generates preregistration protocol
✓ Protocol saved: .aiwg/research/discovery/preregistration/2026-01-25-protocol.md
```

### Citation Network Traversal

```bash
# Explore citation relationships
aiwg research discover "deep Q-learning" --citation-network
```

**Output**:
```
Searching Semantic Scholar...
✓ Found 50 papers via keywords
✓ Discovered 25 additional papers via citation chaining
✓ Total: 75 papers

Citation Network:
  Deep Q-Learning (Mnih et al., 2015) [1,200 citations]
    ├─ Backward: DQN Extensions (van Hasselt et al., 2016)
    ├─ Forward: Rainbow (Hessel et al., 2017)
    └─ Forward: Prioritized Experience Replay (Schaul et al., 2015)
```

### Query Refinement

```bash
# Initial search too broad
aiwg research discover "machine learning"
# Returns 500 papers, too general

# Refine search
aiwg research discover "machine learning LLM caching" --refine-from last
```

**Output**:
```
Loading previous search context...
✓ Refined query: "machine learning LLM caching"
✓ Found 35 papers (more focused)

Refinement improved relevance:
  Previous: 40% relevant (user reported)
  Current: 85% relevant (user reported)
```

## Related Agents

- **Discovery Agent** (@$AIWG_ROOT/agentic/code/frameworks/research-complete/elaboration/agents/discovery-agent-spec.md): Primary agent executing this command
- **Quality Agent** (@$AIWG_ROOT/agentic/code/frameworks/research-complete/elaboration/agents/quality-agent-spec.md): Validates search quality
- **Acquisition Agent** (@$AIWG_ROOT/agentic/code/frameworks/research-complete/elaboration/agents/acquisition-agent-spec.md): Next step after discovery

## Skill Definition (Natural Language Triggers)

**Skill Name**: Research Discovery

**Natural Language Patterns**:

- "Find papers on {topic}"
- "Search for research about {query}"
- "Discover literature on {subject}"
- "I need papers about {topic}"
- "What research exists on {query}?"
- "Run a systematic review on {topic}"

**Example Invocations**:

```
User: "Find papers on OAuth2 security"
Agent: Executing /research-discover "OAuth2 security"

User: "I need research about LLM evaluation methods"
Agent: Executing /research-discover "LLM evaluation methods"

User: "Run a systematic review on reinforcement learning"
Agent: Executing /research-discover "reinforcement learning" --preregister
```

**Skill Parameters Extracted**:

- `{topic}`, `{query}`, `{subject}` → `<query>` argument
- "systematic review" → `--preregister` flag
- "citation network" or "related papers" → `--citation-network` flag

## Success Criteria

This command succeeds when:

- [ ] Search completes in <10 seconds (95th percentile)
- [ ] 100+ results returned and ranked by relevance
- [ ] Gap analysis generated in <30 seconds
- [ ] PRISMA-compliant search strategy saved
- [ ] Acquisition queue created with selected papers
- [ ] User can proceed to `/research-acquire` (UC-RF-002)

## Error Handling

### Rate Limit Exceeded (429)

```
Error: Semantic Scholar rate limit exceeded
Retrying in 60 seconds... (Attempt 1/3)
✓ Retry successful
```

### API Unavailable (500)

```
Error: Semantic Scholar API unavailable
Check network: ping api.semanticscholar.org

Fallback: Manual search at https://www.semanticscholar.org/search?q={query}
```

### No Results Found

```
Warning: No results found for 'very obscure topic'

Suggestions:
- Try broader terms: "obscure" → "niche research area"
- Remove year filter: Expand to all years
- Check spelling: Did you mean "obscured"?
```

## Best Practices

1. **Query formulation**: Use 3-10 words for semantic search (vs. 1-2 word keywords)
2. **Iterative refinement**: Start broad, refine based on results
3. **Citation network**: Enable for comprehensive systematic reviews
4. **PRISMA compliance**: Use --preregister for reproducible systematic reviews
5. **Quality thresholds**: Filter by minimum citations (10+) and venue tier (A*/A)

## References

- @$AIWG_ROOT/agentic/code/frameworks/research-complete/elaboration/use-cases/UC-RF-001-discover-research-papers.md - Use case specification
- @$AIWG_ROOT/agentic/code/frameworks/research-complete/elaboration/agents/discovery-agent-spec.md - Discovery Agent
- [Semantic Scholar API](https://www.semanticscholar.org/product/api) - API documentation
- [PRISMA Statement](https://www.prisma-statement.org/) - Systematic review guidelines

## Security Notes

- API keys loaded from `.aiwg/research/config.yaml`, never hardcoded
- Query sanitized to prevent injection attacks
- Rate limiting strictly enforced (100 req/5 min)
- No sensitive data logged (query strings anonymized in logs)

---

**Status**: DRAFT
**Created**: 2026-01-25
**Owner**: Discovery Agent Designer
**UC Mapping**: UC-RF-001 (Discover Research Papers)
