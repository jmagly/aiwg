# API Integration Specifications

**Document Type**: Technical Specification
**Phase**: Elaboration
**Status**: Draft
**Version**: 1.0.0
**Last Updated**: 2026-01-25

## 1. API Overview

### 1.1 Purpose

Define integration patterns, data contracts, and operational requirements for external APIs used in the AIWG Research Framework.

### 1.2 Scope

This specification covers:

- **Research APIs**: Semantic Scholar, CrossRef, arXiv, Unpaywall
- **LLM APIs**: Claude (Anthropic), OpenAI
- **Optional Integrations**: Zotero, Neo4j, Obsidian

### 1.3 Integration Approach

**Architecture Pattern**: Service adapter layer with unified interface

```
┌─────────────────┐
│  CLI/MCP Server │
└────────┬────────┘
         │
┌────────▼────────────────┐
│  Research Service Layer │
└────────┬────────────────┘
         │
    ┌────┴─────┬──────────┬──────────┬───────────┐
    │          │          │          │           │
┌───▼───┐  ┌──▼──┐   ┌───▼───┐  ┌───▼────┐  ┌──▼───┐
│ S2 API│  │ CREF│   │ arXiv │  │Unpaywall│ │ LLM  │
└───────┘  └─────┘   └───────┘  └────────┘  └──────┘
```

**Key Principles**:
- Adapter pattern for each external API
- Unified error handling across all integrations
- Comprehensive caching to minimize API calls
- Rate limit awareness and compliance
- Graceful degradation when services unavailable

---

## 2. Semantic Scholar API

### 2.1 Overview

**Base URL**: `https://api.semanticscholar.org/graph/v1`
**Documentation**: https://api.semanticscholar.org/api-docs/
**Authentication**: Optional API key (recommended for production)

### 2.2 Endpoints

#### 2.2.1 Paper Search

**Endpoint**: `GET /paper/search`

**Query Parameters**:
```typescript
interface SearchParams {
  query: string;              // Search query
  limit?: number;             // Max results (default: 10, max: 100)
  offset?: number;            // Pagination offset
  fields?: string;            // Comma-separated field list
  publicationTypes?: string;  // Filter by type (JournalArticle, Conference, etc.)
  year?: string;              // Filter by year range (e.g., "2020-2023")
  minCitationCount?: number;  // Minimum citations
  venue?: string;             // Filter by venue/journal
  openAccessPdf?: boolean;    // Only papers with free PDFs
}
```

**Response Schema**:
```typescript
interface SearchResponse {
  total: number;
  offset: number;
  next?: number;
  data: Paper[];
}

interface Paper {
  paperId: string;
  externalIds?: {
    DOI?: string;
    ArXiv?: string;
    MAG?: string;
    CorpusId?: number;
  };
  title: string;
  abstract?: string;
  venue?: string;
  year?: number;
  citationCount?: number;
  influentialCitationCount?: number;
  isOpenAccess?: boolean;
  openAccessPdf?: {
    url: string;
    status: string;
  };
  authors?: Author[];
  publicationTypes?: string[];
  publicationDate?: string;
  journal?: {
    name?: string;
    pages?: string;
    volume?: string;
  };
  fieldsOfStudy?: string[];
}

interface Author {
  authorId: string;
  name: string;
}
```

**Example Request**:
```bash
curl -H "x-api-key: ${S2_API_KEY}" \
  "https://api.semanticscholar.org/graph/v1/paper/search?query=chain+of+thought+prompting&fields=title,abstract,authors,year,citationCount,openAccessPdf&limit=20"
```

#### 2.2.2 Paper Details

**Endpoint**: `GET /paper/{paper_id}`

**Path Parameters**:
- `paper_id`: Semantic Scholar ID, DOI, or ArXiv ID

**Query Parameters**:
```typescript
interface DetailsParams {
  fields?: string;  // Comma-separated field list
}
```

**Response Schema**: Same as `Paper` interface above

**Example Request**:
```bash
# By DOI
curl -H "x-api-key: ${S2_API_KEY}" \
  "https://api.semanticscholar.org/graph/v1/paper/DOI:10.1234/example?fields=title,abstract,citations,references"

# By ArXiv ID
curl -H "x-api-key: ${S2_API_KEY}" \
  "https://api.semanticscholar.org/graph/v1/paper/ARXIV:2301.12345?fields=title,abstract"
```

#### 2.2.3 Citations

**Endpoint**: `GET /paper/{paper_id}/citations`

**Query Parameters**:
```typescript
interface CitationsParams {
  fields?: string;
  limit?: number;   // Max: 1000
  offset?: number;
}
```

**Response Schema**:
```typescript
interface CitationsResponse {
  offset: number;
  next?: number;
  data: {
    contexts: string[];        // Citation context snippets
    intents: string[];         // Citation intent (background, methodology, result)
    isInfluential: boolean;
    citingPaper: Paper;
  }[];
}
```

#### 2.2.4 Recommendations

**Endpoint**: `GET /paper/{paper_id}/recommendations`

**Query Parameters**:
```typescript
interface RecommendationsParams {
  fields?: string;
  limit?: number;   // Max: 500
}
```

**Response Schema**:
```typescript
interface RecommendationsResponse {
  recommendedPapers: Paper[];
}
```

### 2.3 Rate Limits

| Tier | Rate Limit | Authentication |
|------|------------|----------------|
| Public | 100 requests/second | None |
| Authenticated | 1000 requests/second | API key required |

**Rate Limit Headers**:
```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1234567890
```

**Implementation Strategy**:
- Token bucket algorithm with per-second refill
- Exponential backoff on 429 responses
- Queue requests when approaching limit

### 2.4 Error Handling

**HTTP Status Codes**:

| Code | Meaning | Action |
|------|---------|--------|
| 200 | Success | Process response |
| 400 | Bad request | Validate query parameters |
| 404 | Paper not found | Try alternative IDs (DOI → ArXiv) |
| 429 | Rate limit exceeded | Exponential backoff, retry |
| 500 | Server error | Retry with exponential backoff (max 3 attempts) |
| 503 | Service unavailable | Retry after 5s, 10s, 30s |

**Error Response Schema**:
```typescript
interface ErrorResponse {
  error: string;
  message: string;
}
```

**Retry Policy**:
```typescript
const retryConfig = {
  maxAttempts: 3,
  backoffMultiplier: 2,
  initialDelay: 1000,  // 1s
  maxDelay: 30000,     // 30s
  retryableStatuses: [429, 500, 502, 503, 504]
};
```

---

## 3. CrossRef API

### 3.1 Overview

**Base URL**: `https://api.crossref.org`
**Documentation**: https://api.crossref.org/swagger-ui/
**Authentication**: None required (polite pool encouraged)

### 3.2 Endpoints

#### 3.2.1 Metadata Lookup by DOI

**Endpoint**: `GET /works/{doi}`

**Headers**:
```
User-Agent: AIWG-Research/1.0 (mailto:your-email@example.com)
```

**Response Schema**:
```typescript
interface CrossRefWork {
  status: "ok";
  message: {
    DOI: string;
    title: string[];
    author?: {
      given?: string;
      family: string;
      ORCID?: string;
    }[];
    "published-print"?: { "date-parts": number[][] };
    "published-online"?: { "date-parts": number[][] };
    "container-title"?: string[];
    volume?: string;
    issue?: string;
    page?: string;
    publisher?: string;
    type?: string;  // journal-article, proceedings-article, etc.
    abstract?: string;
    "is-referenced-by-count"?: number;  // Citation count
    reference?: {
      key: string;
      DOI?: string;
      "article-title"?: string;
    }[];
  };
}
```

**Example Request**:
```bash
curl -H "User-Agent: AIWG-Research/1.0 (mailto:your@email.com)" \
  "https://api.crossref.org/works/10.1145/3491102.3517582"
```

#### 3.2.2 Work Search

**Endpoint**: `GET /works`

**Query Parameters**:
```typescript
interface WorkSearchParams {
  "query.title"?: string;
  "query.author"?: string;
  "query.bibliographic"?: string;  // General search
  filter?: string;  // e.g., "from-pub-date:2020,until-pub-date:2023"
  rows?: number;    // Results per page (max: 1000)
  offset?: number;
  sort?: string;    // relevance, published, is-referenced-by-count
  order?: "asc" | "desc";
}
```

**Response Schema**:
```typescript
interface WorkSearchResponse {
  status: "ok";
  "message-type": "work-list";
  message: {
    "total-results": number;
    items: CrossRefWork["message"][];
  };
}
```

### 3.3 Rate Limits

| Pool | Rate Limit | Requirements |
|------|------------|--------------|
| Standard | ~50 req/sec | None |
| Polite | Higher priority | User-Agent with email |
| Plus | No limit | Subscription |

**Polite Pool Requirements**:
- Include `User-Agent` header with email: `AIWG-Research/1.0 (mailto:your@email.com)`
- Better response times and priority

### 3.4 Error Handling

**HTTP Status Codes**:

| Code | Meaning | Action |
|------|---------|--------|
| 200 | Success | Process response |
| 404 | DOI not found | Log and skip |
| 429 | Rate limited | Exponential backoff |
| 503 | Temporary unavailable | Retry after delay |

**Fallback Strategy**:
- If CrossRef fails, attempt Semantic Scholar lookup by DOI
- Cache successful responses aggressively (TTL: 7 days)

---

## 4. arXiv API

### 4.1 Overview

**Base URL**: `http://export.arxiv.org/api/query`
**Documentation**: https://arxiv.org/help/api/
**Authentication**: None required

### 4.2 Endpoints

#### 4.2.1 Paper Search

**Endpoint**: `GET /api/query`

**Query Parameters**:
```typescript
interface ArXivSearchParams {
  search_query: string;    // e.g., "all:transformer" or "ti:attention"
  start?: number;          // Pagination start index
  max_results?: number;    // Max: 30000 per query
  sortBy?: "relevance" | "lastUpdatedDate" | "submittedDate";
  sortOrder?: "ascending" | "descending";
}
```

**Search Query Syntax**:
```
ti:    Title
au:    Author
abs:   Abstract
cat:   Category (e.g., cs.AI, cs.CL)
all:   All fields

Examples:
- "ti:neural+architecture+search"
- "au:lecun+AND+cat:cs.CV"
- "abs:reinforcement+learning+AND+submittedDate:[202001010000+TO+202312312359]"
```

**Response Schema** (Atom XML):
```xml
<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>ArXiv Query: search_query=all:transformer</title>
  <opensearch:totalResults>15234</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <opensearch:itemsPerPage>10</opensearch:itemsPerPage>
  <entry>
    <id>http://arxiv.org/abs/1706.03762v7</id>
    <title>Attention Is All You Need</title>
    <summary>Abstract text...</summary>
    <author>
      <name>Ashish Vaswani</name>
    </author>
    <published>2017-06-12T17:57:34Z</published>
    <updated>2023-08-02T11:01:03Z</updated>
    <link href="http://arxiv.org/abs/1706.03762v7" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/1706.03762v7" rel="related" type="application/pdf"/>
    <arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="cs.CL"/>
    <category term="cs.CL" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.LG" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
</feed>
```

**TypeScript Interface** (after parsing):
```typescript
interface ArXivPaper {
  id: string;           // arXiv ID (e.g., "1706.03762v7")
  title: string;
  summary: string;      // Abstract
  authors: string[];
  published: string;    // ISO 8601
  updated: string;
  pdfUrl: string;
  categories: string[]; // e.g., ["cs.CL", "cs.LG"]
  primaryCategory: string;
}

interface ArXivSearchResponse {
  totalResults: number;
  startIndex: number;
  itemsPerPage: number;
  entries: ArXivPaper[];
}
```

**Example Request**:
```bash
curl "http://export.arxiv.org/api/query?search_query=all:chain+of+thought&start=0&max_results=10&sortBy=submittedDate&sortOrder=descending"
```

#### 4.2.2 Paper Download

**PDF URL Pattern**: `http://arxiv.org/pdf/{arxiv_id}.pdf`

**Example**:
```bash
curl -o paper.pdf "http://arxiv.org/pdf/1706.03762.pdf"
```

### 4.3 Rate Limits

**Official Limits**:
- Max 1 request per 3 seconds
- Bulk downloads discouraged (use S3 instead)

**Implementation**:
```typescript
const ARXIV_DELAY_MS = 3000;

class ArXivClient {
  private lastRequestTime = 0;

  async search(params: ArXivSearchParams): Promise<ArXivSearchResponse> {
    await this.respectRateLimit();
    // ... make request
  }

  private async respectRateLimit() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < ARXIV_DELAY_MS) {
      await sleep(ARXIV_DELAY_MS - timeSinceLastRequest);
    }
    this.lastRequestTime = Date.now();
  }
}
```

### 4.4 Error Handling

**HTTP Status Codes**:

| Code | Meaning | Action |
|------|---------|--------|
| 200 | Success | Parse Atom XML |
| 400 | Malformed query | Validate and fix query syntax |
| 503 | Service unavailable | Retry after 30s |

**XML Parsing Errors**:
- Use robust XML parser (e.g., `fast-xml-parser`)
- Handle malformed feeds gracefully
- Log parsing errors with original XML

---

## 5. Unpaywall API

### 5.1 Overview

**Base URL**: `https://api.unpaywall.org/v2`
**Documentation**: https://unpaywall.org/products/api
**Authentication**: Email required (append `?email=your@email.com`)

### 5.2 Endpoints

#### 5.2.1 DOI Lookup

**Endpoint**: `GET /v2/{doi}`

**Query Parameters**:
```typescript
interface UnpaywallParams {
  email: string;  // Required
}
```

**Response Schema**:
```typescript
interface UnpaywallResponse {
  doi: string;
  doi_url: string;
  title: string;
  is_oa: boolean;  // Is open access?
  oa_status: "gold" | "green" | "hybrid" | "bronze" | "closed";
  best_oa_location?: {
    url: string;
    url_for_pdf?: string;
    url_for_landing_page: string;
    version: "publishedVersion" | "acceptedVersion" | "submittedVersion";
    license?: string;
    host_type: "publisher" | "repository";
  };
  oa_locations: {
    url: string;
    url_for_pdf?: string;
    version: string;
    license?: string;
    host_type: string;
  }[];
  published_date?: string;
  year?: number;
  journal_name?: string;
  journal_issns?: string;
  publisher?: string;
  authors?: string;
}
```

**Example Request**:
```bash
curl "https://api.unpaywall.org/v2/10.1038/nature12373?email=your@email.com"
```

### 5.3 Rate Limits

**Official Limits**: 100,000 requests per day

**Implementation**:
- No per-second limit specified
- Reasonable delay (500ms) between requests
- Cache responses aggressively (TTL: 30 days - OA status rarely changes)

### 5.4 Integration with Acquisition

**Workflow**:
1. After paper discovered via Semantic Scholar/arXiv
2. If DOI available and no PDF yet, query Unpaywall
3. If `is_oa: true` and `best_oa_location.url_for_pdf` exists:
   - Download PDF from `url_for_pdf`
   - Store in `.aiwg/research/pdfs/{paper_id}.pdf`
   - Record license info in metadata

**Error Handling**:

| Scenario | Action |
|----------|--------|
| DOI not found (404) | Skip, not all papers indexed |
| No OA version | Mark as "access restricted" in metadata |
| PDF download fails | Retry once, then mark as "download failed" |

---

## 6. LLM Integration

### 6.1 Overview

**Purpose**: Summarization, synthesis, concept extraction from research papers

**Supported Providers**:
- Anthropic Claude (primary)
- OpenAI GPT-4 (fallback)

### 6.2 Claude API

**Base URL**: `https://api.anthropic.com/v1`
**Documentation**: https://docs.anthropic.com/claude/reference/
**Authentication**: API key in header `x-api-key`

#### 6.2.1 Messages Endpoint

**Endpoint**: `POST /v1/messages`

**Request Schema**:
```typescript
interface ClaudeRequest {
  model: string;  // "claude-opus-5" or "claude-sonnet-5"
  max_tokens: number;
  messages: {
    role: "user" | "assistant";
    content: string;
  }[];
  system?: string;  // System prompt
  temperature?: number;  // 0.0 - 1.0
}
```

**Response Schema**:
```typescript
interface ClaudeResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: {
    type: "text";
    text: string;
  }[];
  model: string;
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence";
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}
```

**Example Request**:
```bash
curl -X POST https://api.anthropic.com/v1/messages \
  -H "x-api-key: ${ANTHROPIC_API_KEY}" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-sonnet-5",
    "max_tokens": 2048,
    "messages": [{
      "role": "user",
      "content": "Summarize this paper abstract in 3 bullet points:\n\n{abstract}"
    }]
  }'
```

#### 6.2.2 Rate Limits

**Tier-based** (varies by subscription):
- Free tier: ~5 req/min
- Pro: ~50 req/min
- Enterprise: Custom

**Token Limits**:
- Opus 4.5: 200K input, 16K output
- Sonnet 4.5: 200K input, 16K output

**Cost** (as of Jan 2025):
- Opus 4.5: $15/MTok input, $75/MTok output
- Sonnet 4.5: $3/MTok input, $15/MTok output

#### 6.2.3 Summarization Prompt Templates

**Abstract Summary** (3-bullet format):
```typescript
const ABSTRACT_SUMMARY_PROMPT = `
Summarize this research paper abstract in exactly 3 bullet points.
Each bullet should be one concise sentence capturing key contributions.

Abstract:
{abstract}

Format:
- First key point
- Second key point
- Third key point
`.trim();
```

**Full Paper Summary** (with sections):
```typescript
const FULL_PAPER_SUMMARY_PROMPT = `
Summarize this research paper with the following structure:

1. Core Contribution (1 sentence)
2. Key Findings (3 bullet points)
3. Methodology (2-3 sentences)
4. Implications (2-3 sentences)

Paper text:
{paper_text}
`.trim();
```

**Concept Extraction**:
```typescript
const CONCEPT_EXTRACTION_PROMPT = `
Extract key concepts, methods, and terminology from this paper.

Return as JSON:
{
  "core_concepts": ["concept1", "concept2", ...],
  "methods": ["method1", "method2", ...],
  "datasets": ["dataset1", ...],
  "metrics": ["metric1", ...]
}

Paper abstract:
{abstract}
`.trim();
```

### 6.3 RAG Pattern for Grounding

**Purpose**: Prevent hallucination, ensure summaries accurate to source text

**Implementation**:
```typescript
interface RAGContext {
  paperTitle: string;
  paperAbstract: string;
  paperSections?: {
    title: string;
    content: string;
  }[];
  citationCount?: number;
  year?: number;
}

function buildRAGPrompt(context: RAGContext, task: string): string {
  return `
You are summarizing academic research. Stay strictly faithful to the source text.
Do not infer, speculate, or add information not present in the text.

Paper: ${context.paperTitle}
Year: ${context.year || "Unknown"}
Citations: ${context.citationCount || "Unknown"}

Abstract:
${context.paperAbstract}

${context.paperSections ? `
Full Text Sections:
${context.paperSections.map(s => `## ${s.title}\n${s.content}`).join("\n\n")}
` : ""}

Task: ${task}

Requirements:
- Use only information from the text above
- Cite specific claims if asked
- If information is unclear or missing, say so explicitly
`.trim();
}
```

### 6.4 OpenAI Fallback

**Base URL**: `https://api.openai.com/v1`
**Authentication**: `Authorization: Bearer {api_key}`

**Model**: `gpt-4-turbo` or `gpt-4o`

**Request Schema**:
```typescript
interface OpenAIRequest {
  model: string;
  messages: {
    role: "system" | "user" | "assistant";
    content: string;
  }[];
  max_tokens?: number;
  temperature?: number;
}
```

**Rate Limits**: Tier-based (similar to Claude)

**Cost** (as of Jan 2025):
- GPT-4 Turbo: $10/MTok input, $30/MTok output
- GPT-4o: $5/MTok input, $15/MTok output

**Fallback Strategy**:
1. Primary: Claude Sonnet 4.5 (lower cost)
2. Fallback: OpenAI GPT-4o (if Claude unavailable/rate limited)
3. Ultimate fallback: Local model (if privacy required)

### 6.5 Token Management

**Estimation**:
```typescript
function estimateTokens(text: string): number {
  // Rough estimate: 1 token ≈ 4 characters
  return Math.ceil(text.length / 4);
}

function truncateToTokenLimit(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 100) + "\n\n[Truncated...]";
}
```

**Cost Tracking**:
```typescript
interface UsageMetrics {
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  model: string;
  timestamp: string;
}

// Store in .aiwg/research/cache/llm-usage.jsonl
```

### 6.6 Error Handling

**Common Errors**:

| Error | Action |
|-------|--------|
| Rate limit (429) | Exponential backoff, switch to fallback provider |
| Token limit exceeded | Truncate input, summarize in chunks |
| API key invalid (401) | Fail fast, prompt user to check config |
| Service unavailable (503) | Retry 3x with backoff, then fail gracefully |

---

## 7. Caching Strategy

### 7.1 Overview

**Purpose**: Minimize API calls, reduce costs, improve performance

**Storage Location**: `.aiwg/research/cache/`

**Structure**:
```
.aiwg/research/cache/
├── semantic-scholar/
│   ├── papers/          # {paper_id}.json
│   ├── citations/       # {paper_id}-citations.json
│   └── recommendations/ # {paper_id}-recs.json
├── crossref/
│   └── works/           # {doi_encoded}.json
├── arxiv/
│   └── papers/          # {arxiv_id}.json
├── unpaywall/
│   └── oa-status/       # {doi_encoded}.json
├── llm/
│   ├── summaries/       # {paper_id}-{hash}.json
│   └── usage.jsonl      # Cost tracking
└── metadata.json        # Cache metadata
```

### 7.2 Cache TTLs by Endpoint

| API | Endpoint | TTL | Rationale |
|-----|----------|-----|-----------|
| Semantic Scholar | Paper details | 7 days | Metadata rarely changes |
| Semantic Scholar | Citations | 1 day | Citation counts update frequently |
| Semantic Scholar | Recommendations | 7 days | Recommendations stable |
| CrossRef | Work metadata | 30 days | DOI metadata immutable |
| arXiv | Paper metadata | 30 days | arXiv IDs immutable |
| Unpaywall | OA status | 30 days | OA status rarely changes |
| LLM | Summaries | 90 days | Content deterministic given input |

### 7.3 Cache Key Generation

```typescript
function generateCacheKey(api: string, endpoint: string, params: Record<string, any>): string {
  const normalized = JSON.stringify(params, Object.keys(params).sort());
  const hash = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return `${api}/${endpoint}/${hash}.json`;
}

// Example: semantic-scholar/papers/a1b2c3d4e5f6g7h8.json
```

### 7.4 Cache Invalidation

**Manual Invalidation**:
```bash
# CLI command
aiwg research cache-clear --api semantic-scholar --older-than 7d
```

**Automatic Invalidation**:
```typescript
interface CacheEntry {
  data: any;
  timestamp: string;
  ttl: number;  // seconds
}

function isCacheValid(entry: CacheEntry): boolean {
  const age = Date.now() - new Date(entry.timestamp).getTime();
  return age < entry.ttl * 1000;
}
```

### 7.5 Cache Metadata

**`.aiwg/research/cache/metadata.json`**:
```json
{
  "version": "1.0.0",
  "lastCleanup": "2026-01-25T12:00:00Z",
  "stats": {
    "totalEntries": 1234,
    "totalSizeBytes": 52428800,
    "hitRate": 0.87,
    "apis": {
      "semantic-scholar": {
        "entries": 800,
        "sizeBytes": 35000000,
        "hits": 1500,
        "misses": 200
      }
    }
  }
}
```

---

## 8. Error Handling

### 8.1 Unified Error Types

```typescript
enum ErrorType {
  RATE_LIMIT = "RATE_LIMIT",
  NOT_FOUND = "NOT_FOUND",
  INVALID_REQUEST = "INVALID_REQUEST",
  SERVICE_UNAVAILABLE = "SERVICE_UNAVAILABLE",
  AUTHENTICATION = "AUTHENTICATION",
  NETWORK = "NETWORK",
  PARSE_ERROR = "PARSE_ERROR",
  UNKNOWN = "UNKNOWN"
}

interface APIError {
  type: ErrorType;
  message: string;
  api: string;
  endpoint: string;
  statusCode?: number;
  retryable: boolean;
  originalError?: Error;
}
```

### 8.2 Retry Policies

```typescript
interface RetryPolicy {
  maxAttempts: number;
  backoffMultiplier: number;
  initialDelayMs: number;
  maxDelayMs: number;
  retryableErrors: ErrorType[];
}

const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  backoffMultiplier: 2,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  retryableErrors: [
    ErrorType.RATE_LIMIT,
    ErrorType.SERVICE_UNAVAILABLE,
    ErrorType.NETWORK
  ]
};

async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY
): Promise<T> {
  let lastError: APIError;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as APIError;
      if (!policy.retryableErrors.includes(lastError.type)) {
        throw error;
      }
      if (attempt < policy.maxAttempts) {
        const delay = Math.min(
          policy.initialDelayMs * Math.pow(policy.backoffMultiplier, attempt - 1),
          policy.maxDelayMs
        );
        await sleep(delay);
      }
    }
  }
  throw lastError!;
}
```

### 8.3 Fallback Strategies

**Multi-Provider Fallback**:
```typescript
async function fetchPaperMetadata(doi: string): Promise<PaperMetadata> {
  const strategies = [
    () => semanticScholarClient.getPaperByDOI(doi),
    () => crossRefClient.getWork(doi),
    () => cache.get(`fallback/${doi}`)  // Stale cache as last resort
  ];

  let lastError: APIError;
  for (const strategy of strategies) {
    try {
      return await strategy();
    } catch (error) {
      lastError = error as APIError;
      console.warn(`Strategy failed: ${lastError.message}`);
    }
  }

  throw new Error(`All fallback strategies exhausted for DOI: ${doi}`);
}
```

**Graceful Degradation**:
```typescript
interface EnrichedPaper {
  core: PaperMetadata;      // Required
  citations?: Citation[];   // Optional
  recommendations?: Paper[]; // Optional
  summary?: Summary;        // Optional
  oaStatus?: OAStatus;      // Optional
}

async function enrichPaper(paper: PaperMetadata): Promise<EnrichedPaper> {
  const enriched: EnrichedPaper = { core: paper };

  // Add optional enrichments, continue on failure
  try {
    enriched.citations = await getCitations(paper.id);
  } catch (error) {
    console.warn(`Failed to fetch citations: ${error.message}`);
  }

  try {
    enriched.recommendations = await getRecommendations(paper.id);
  } catch (error) {
    console.warn(`Failed to fetch recommendations: ${error.message}`);
  }

  // ... etc

  return enriched;
}
```

### 8.4 User-Facing Error Messages

```typescript
function formatUserError(error: APIError): string {
  switch (error.type) {
    case ErrorType.RATE_LIMIT:
      return `Rate limit exceeded for ${error.api}. Please wait and try again.`;
    case ErrorType.NOT_FOUND:
      return `Resource not found. Please check the paper ID or DOI.`;
    case ErrorType.AUTHENTICATION:
      return `Authentication failed for ${error.api}. Please check your API key in config.`;
    case ErrorType.SERVICE_UNAVAILABLE:
      return `${error.api} is temporarily unavailable. Trying fallback...`;
    default:
      return `An error occurred: ${error.message}`;
  }
}
```

---

## 9. Security Considerations

### 9.1 API Key Storage

**NEVER hard-code API keys in source code.**

**Recommended Approaches**:

1. **Environment Variables** (for development):
   ```bash
   export ANTHROPIC_API_KEY="sk-ant-..."
   export OPENAI_API_KEY="sk-..."
   export SEMANTIC_SCHOLAR_API_KEY="..."
   ```

2. **Config File** (for deployment):
   ```yaml
   # .aiwg/research/config.yml (add to .gitignore!)
   apis:
     semantic_scholar:
       api_key: "..."
     anthropic:
       api_key: "sk-ant-..."
     openai:
       api_key: "sk-..."
   ```

3. **Secure Token Load Pattern**:
   ```bash
   # Load from secure file (mode 600)
   bash <<'EOF'
   API_KEY=$(cat ~/.config/aiwg/semantic-scholar-key)
   curl -H "x-api-key: ${API_KEY}" "..."
   EOF
   ```

**Validation**:
```typescript
function loadAPIKey(provider: string): string {
  const key = process.env[`${provider.toUpperCase()}_API_KEY`];
  if (!key) {
    throw new Error(
      `API key for ${provider} not found. Set ${provider.toUpperCase()}_API_KEY environment variable.`
    );
  }
  return key;
}
```

### 9.2 Request Sanitization

**Input Validation**:
```typescript
function sanitizeSearchQuery(query: string): string {
  // Remove control characters
  let sanitized = query.replace(/[\x00-\x1F\x7F-\x9F]/g, "");

  // Limit length
  if (sanitized.length > 500) {
    sanitized = sanitized.slice(0, 500);
  }

  // URL encode for API
  return encodeURIComponent(sanitized);
}
```

**DOI Validation**:
```typescript
function isValidDOI(doi: string): boolean {
  // DOI format: 10.XXXX/...
  return /^10\.\d{4,}(\.\d+)*\/[^\s]+$/.test(doi);
}
```

**ArXiv ID Validation**:
```typescript
function isValidArXivID(id: string): boolean {
  // Old format: archive/YYMMNNN or archive/YYMMNNNvN
  // New format: YYMM.NNNNN or YYMM.NNNNNvN
  return /^(\w+\/\d{7}|\d{4}\.\d{4,5})(v\d+)?$/.test(id);
}
```

### 9.3 Rate Limit Compliance

**Token Bucket Implementation**:
```typescript
class RateLimiter {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private maxTokens: number,
    private refillRate: number  // tokens per second
  ) {
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }

  async acquire(): Promise<void> {
    this.refill();
    while (this.tokens < 1) {
      await sleep(100);
      this.refill();
    }
    this.tokens -= 1;
  }

  private refill() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(
      this.maxTokens,
      this.tokens + elapsed * this.refillRate
    );
    this.lastRefill = now;
  }
}

// Usage
const s2Limiter = new RateLimiter(100, 100);  // 100 req/sec
await s2Limiter.acquire();
// ... make request
```

### 9.4 Data Privacy

**Sensitive Data**:
- User emails (for Unpaywall, CrossRef)
- Search queries (may contain proprietary info)
- Downloaded PDFs (copyright considerations)

**Recommendations**:
1. **Do not log** API keys, full queries, or user emails
2. **Redact** sensitive fields in logs:
   ```typescript
   function redactForLogging(url: string): string {
     return url.replace(/([?&]email=)[^&]+/, "$1REDACTED");
   }
   ```
3. **Respect copyright**: Only download OA papers, check licenses
4. **Cache carefully**: Ensure cached data doesn't violate API ToS

### 9.5 HTTPS Enforcement

**Always use HTTPS** for API calls:
```typescript
function validateAPIURL(url: string): void {
  if (!url.startsWith("https://")) {
    throw new Error("API URLs must use HTTPS");
  }
}
```

**Exception**: arXiv API uses HTTP, but transitioning to HTTPS. Support both:
```typescript
const ARXIV_BASE_URL = "https://export.arxiv.org/api/query";  // Prefer HTTPS
// Fallback to HTTP if HTTPS unavailable
```

---

## 10. Testing Approach

### 10.1 Mock Endpoints

**Strategy**: Use mock servers for unit/integration tests to avoid hitting real APIs

**Tools**:
- `nock` (Node.js HTTP mocking)
- `msw` (Mock Service Worker)

**Example with nock**:
```typescript
import nock from "nock";

describe("SemanticScholarClient", () => {
  beforeEach(() => {
    nock("https://api.semanticscholar.org")
      .get("/graph/v1/paper/search")
      .query({ query: "transformer", limit: 10 })
      .reply(200, {
        total: 1,
        offset: 0,
        data: [{
          paperId: "abc123",
          title: "Attention Is All You Need",
          abstract: "The dominant sequence transduction models...",
          year: 2017,
          citationCount: 50000
        }]
      });
  });

  it("should fetch papers by search query", async () => {
    const client = new SemanticScholarClient();
    const results = await client.search("transformer", { limit: 10 });
    expect(results.data).toHaveLength(1);
    expect(results.data[0].title).toBe("Attention Is All You Need");
  });
});
```

### 10.2 Integration Test Fixtures

**Location**: `test/fixtures/api-responses/`

**Structure**:
```
test/fixtures/api-responses/
├── semantic-scholar/
│   ├── paper-search-transformers.json
│   ├── paper-details-1706.03762.json
│   └── citations-abc123.json
├── crossref/
│   └── work-10.1145.3491102.3517582.json
├── arxiv/
│   └── search-chain-of-thought.xml
└── unpaywall/
    └── oa-status-10.1038.nature12373.json
```

**Loading Fixtures**:
```typescript
import fs from "fs/promises";
import path from "path";

async function loadFixture(name: string): Promise<any> {
  const filePath = path.join(__dirname, "../fixtures/api-responses", name);
  const content = await fs.readFile(filePath, "utf-8");
  return name.endsWith(".xml") ? content : JSON.parse(content);
}

// Usage in tests
const mockResponse = await loadFixture("semantic-scholar/paper-search-transformers.json");
```

### 10.3 Contract Testing

**Purpose**: Ensure our code matches actual API schemas

**Approach**: Record real API responses, validate against schemas

**Example with Zod**:
```typescript
import { z } from "zod";

const PaperSchema = z.object({
  paperId: z.string(),
  title: z.string(),
  abstract: z.string().optional(),
  year: z.number().optional(),
  citationCount: z.number().optional(),
  authors: z.array(z.object({
    authorId: z.string(),
    name: z.string()
  })).optional()
});

describe("Semantic Scholar API contract", () => {
  it("should match expected schema", async () => {
    const response = await fetch("https://api.semanticscholar.org/graph/v1/paper/abc123");
    const data = await response.json();

    // Throws if schema doesn't match
    const parsed = PaperSchema.parse(data);
    expect(parsed.paperId).toBe("abc123");
  });
});
```

### 10.4 Rate Limit Testing

**Mock rate limit headers**:
```typescript
nock("https://api.semanticscholar.org")
  .get("/graph/v1/paper/search")
  .reply(429, { error: "Rate limit exceeded" }, {
    "X-RateLimit-Limit": "100",
    "X-RateLimit-Remaining": "0",
    "X-RateLimit-Reset": String(Date.now() + 5000)
  });
```

**Test retry logic**:
```typescript
it("should retry on 429 with exponential backoff", async () => {
  nock("https://api.semanticscholar.org")
    .get("/graph/v1/paper/search")
    .reply(429)
    .get("/graph/v1/paper/search")
    .reply(200, { data: [] });

  const client = new SemanticScholarClient();
  const start = Date.now();
  await client.search("test");
  const elapsed = Date.now() - start;

  // Should have waited ~1s before retry
  expect(elapsed).toBeGreaterThan(900);
});
```

### 10.5 Error Scenario Coverage

**Test matrix**:

| Scenario | HTTP Code | Expected Behavior |
|----------|-----------|-------------------|
| Success | 200 | Return parsed data |
| Not found | 404 | Throw NOT_FOUND error |
| Rate limit | 429 | Retry with backoff |
| Server error | 500 | Retry 3x, then throw |
| Network timeout | - | Retry 3x, then throw NETWORK error |
| Invalid JSON | 200 | Throw PARSE_ERROR |

**Example test**:
```typescript
describe("Error handling", () => {
  it("should throw NOT_FOUND on 404", async () => {
    nock("https://api.semanticscholar.org")
      .get("/graph/v1/paper/invalid")
      .reply(404);

    const client = new SemanticScholarClient();
    await expect(client.getPaper("invalid")).rejects.toThrow("NOT_FOUND");
  });
});
```

---

## References

- @$AIWG_ROOT/agentic/code/frameworks/research-complete/inception/solution-profile.md - Overall research framework design
- @$AIWG_ROOT/agentic/code/frameworks/research-complete/inception/use-cases.md - Research workflow use cases
- @$AIWG_ROOT/agentic/code/frameworks/research-complete/elaboration/data-model.md - Paper metadata schema
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/token-security.md - Secure token handling patterns
- [Semantic Scholar API Docs](https://api.semanticscholar.org/api-docs/)
- [CrossRef API Docs](https://api.crossref.org/swagger-ui/)
- [arXiv API Docs](https://arxiv.org/help/api/)
- [Unpaywall API Docs](https://unpaywall.org/products/api)
- [Anthropic API Docs](https://docs.anthropic.com/claude/reference/)
- [OpenAI API Docs](https://platform.openai.com/docs/api-reference)

---

**Document Status**: Draft
**Next Steps**:
1. Review with System Analyst and Architecture Designer
2. Validate against research workflow use cases
3. Create TypeScript interfaces in codebase
4. Implement adapter layer with caching
5. Write integration tests with fixtures
6. Document configuration setup in README

---

**Metadata**:
- **Created**: 2026-01-25
- **Author**: API Designer (Claude Code)
- **Phase**: Elaboration
- **Artifact Type**: Technical Specification
- **Related Use Cases**: UC-001, UC-002, UC-003, UC-004
- **Related Architecture**: @$AIWG_ROOT/agentic/code/frameworks/research-complete/elaboration/data-model.md
