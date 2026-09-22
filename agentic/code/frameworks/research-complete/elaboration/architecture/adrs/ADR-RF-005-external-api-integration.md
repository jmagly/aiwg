# ADR-RF-005: External API Integration Strategy

## Metadata

- **ID**: ADR-RF-005
- **Title**: External API Integration Strategy for Research Framework
- **Status**: Accepted
- **Created**: 2026-01-25
- **Updated**: 2026-01-25
- **Decision Makers**: Research Framework Architecture Team
- **Related ADRs**: ADR-RF-001 (Agent Orchestration), ADR-RF-002 (Provenance Storage)

## Context

The Research Framework relies on external APIs for core functionality:

1. **Semantic Scholar API**: Paper discovery, citation data, author information (200M+ papers)
2. **CrossRef API**: DOI resolution, metadata verification
3. **Unpaywall API**: Open access PDF locations
4. **LLM APIs**: Claude for summarization, extraction, quality analysis
5. **Optional**: Scite API (citation context), ORCID API (author verification)

These integrations introduce challenges:

- **Rate Limiting**: APIs enforce request limits (Semantic Scholar: 100 requests/5 min)
- **Availability**: External services may be unavailable
- **Data Freshness**: How long to cache results
- **Error Handling**: Graceful degradation when APIs fail
- **Cost**: LLM APIs have usage-based pricing
- **Offline Support**: NFR-RF-X-001 requires core functionality offline

### Decision Drivers

1. **Reliability**: NFR-RF-R-001 requires automatic retry with exponential backoff
2. **Performance**: NFR-RF-P-001 requires <10s search response time
3. **Offline Operation**: Core functionality must work without internet
4. **Cost Efficiency**: Minimize unnecessary API calls
5. **Reproducibility**: API results must be traceable for provenance
6. **Simplicity**: Avoid over-engineering for solo developer context

### Current API Characteristics

| API | Rate Limit | Cacheability | Offline Impact |
|-----|-----------|--------------|----------------|
| Semantic Scholar | 100/5min (free), 1/sec | High (papers don't change often) | Discovery blocked |
| CrossRef | 50/sec | Very High (DOIs are stable) | Metadata verification blocked |
| Unpaywall | 100K/day | High (OA status stable) | PDF acquisition limited |
| Claude API | Token-based | Medium (prompts vary) | Summarization blocked |
| Scite | Varies | Medium (context evolves) | Citation context blocked |

## Decision

**Adopt a Layered API Abstraction with Aggressive Caching and Graceful Degradation.**

### Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                        Research Agents                          │
│    (Discovery, Acquisition, Documentation, Quality, etc.)       │
└────────────────────────────┬───────────────────────────────────┘
                             │
                             ▼
┌────────────────────────────────────────────────────────────────┐
│                     API Abstraction Layer                       │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────────┐│
│  │   Caching    │ │ Rate Limiter │ │     Error Handler        ││
│  │   (Local)    │ │  (Per-API)   │ │ (Retry/Fallback/Degrade) ││
│  └──────────────┘ └──────────────┘ └──────────────────────────┘│
└────────────────────────────┬───────────────────────────────────┘
                             │
         ┌───────────────────┼───────────────────┐
         │                   │                   │
         ▼                   ▼                   ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│ Semantic Scholar│ │    CrossRef     │ │    Claude API   │
│      API        │ │      API        │ │                 │
└─────────────────┘ └─────────────────┘ └─────────────────┘
```

### Key Components

#### 1. API Abstraction Layer

All external API calls go through a unified abstraction that provides:

```typescript
interface APIClient {
  // Execute request with caching, rate limiting, retry
  request<T>(endpoint: string, options: RequestOptions): Promise<T>;

  // Check if API is available (health check)
  isAvailable(): Promise<boolean>;

  // Get cached result if available
  getCached<T>(key: string): T | null;

  // Clear cache (for refresh)
  clearCache(pattern?: string): void;
}
```

#### 2. Caching Strategy

**Cache Location**: `.aiwg/research/.cache/` (gitignored)

**Cache Policies**:

| API | TTL | Strategy |
|-----|-----|----------|
| Semantic Scholar (search) | 24 hours | Results may change with new papers |
| Semantic Scholar (paper) | 30 days | Paper metadata stable |
| CrossRef | 90 days | DOI data very stable |
| Unpaywall | 7 days | OA status can change |
| LLM responses | Permanent | Deterministic for same input |

**Cache Key Format**:
```
{api}-{operation}-{hash(params)}
e.g., semantic-scholar-paper-sha256:a1b2c3...
```

#### 3. Rate Limiting

**Token Bucket Algorithm** per API:

```typescript
interface RateLimiter {
  tokens: number;           // Current tokens
  maxTokens: number;        // Bucket size
  refillRate: number;       // Tokens per second
  lastRefill: number;       // Last refill timestamp

  acquire(): Promise<void>; // Wait for token
  tryAcquire(): boolean;    // Non-blocking check
}
```

**Configured Limits**:

| API | Max Tokens | Refill Rate | Burst |
|-----|-----------|-------------|-------|
| Semantic Scholar | 100 | 20/min | 10 |
| CrossRef | 50 | 50/sec | 50 |
| Claude | 10 | 1/sec | 5 |

#### 4. Error Handling and Retry

**Retry Policy**:
- 3 attempts with exponential backoff (1s, 2s, 4s)
- Jitter to prevent thundering herd
- Circuit breaker after 5 consecutive failures

**Error Classification**:

| Error Type | Action | User Message |
|------------|--------|--------------|
| 429 Rate Limit | Wait and retry | "Rate limit reached, waiting..." |
| 503 Unavailable | Retry with backoff | "Service temporarily unavailable, retrying..." |
| 401 Unauthorized | Fail fast | "API key invalid. Check configuration." |
| 404 Not Found | Return null | "Resource not found." |
| Timeout | Retry once | "Request timed out, retrying..." |
| Network Error | Check offline | "Network unavailable. Working offline." |

#### 5. Graceful Degradation

When APIs are unavailable, framework degrades gracefully:

| Feature | Online | Offline | Degraded |
|---------|--------|---------|----------|
| Discovery (search) | Full | Cached only | Partial results |
| Acquisition (PDF) | Full | Blocked | Manual download |
| Metadata lookup | Full | Cached | User input |
| Summarization | Full | Blocked | Manual summary |
| Citation network | Full | Cached | Stale data |
| Quality scoring | Full | Partial (no external signals) | Limited accuracy |

### Offline Operation Support

Per NFR-RF-X-001, core functionality works offline:

**Offline-Capable**:
- Metadata management (edit existing)
- Note-taking (literature/permanent notes)
- Local search (index.json)
- Bibliography generation (from cache)
- Quality scoring (without citation count)

**Online-Required**:
- New paper discovery
- PDF acquisition
- LLM summarization
- Citation network updates
- Gap analysis (requires fresh data)

**Offline Indicator**:
```bash
$ aiwg research status
Research Framework Status:
  Offline Mode: ACTIVE
  Cached Sources: 45
  Last Sync: 2026-01-25T10:00:00Z

  Available: Metadata, Notes, Search (cached), Export
  Unavailable: Discovery, Acquisition, Summarization
```

## Consequences

### Positive

1. **Reliability**: Retry logic and caching ensure resilience to transient failures
2. **Performance**: Aggressive caching reduces API calls and improves response time
3. **Cost Control**: Caching LLM responses prevents duplicate API spend
4. **Offline Support**: Core workflows continue without internet
5. **Transparency**: Clear feedback when operating in degraded mode
6. **Maintainability**: Unified abstraction simplifies API changes

### Negative

1. **Stale Data**: Cached results may be outdated (mitigated by TTL)
2. **Cache Size**: Large corpora may accumulate significant cache (mitigated by TTL expiry)
3. **Complexity**: Abstraction layer adds code to maintain
4. **Debugging**: Cached responses can mask API issues

### Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| API deprecation | Low | High | Abstract API clients, monitor deprecation notices |
| Rate limit changes | Medium | Medium | Configurable rate limits, adaptive throttling |
| Cache corruption | Low | Medium | Validate cache entries, rebuild on corruption |
| API key exposure | Low | High | Follow token security rules, environment variables |
| Cost overruns (LLM) | Medium | Medium | Usage tracking, budget alerts, batch processing |

## Alternatives Considered

### Option A: Direct API Calls

**Description**: Call APIs directly from agents without abstraction layer.

**Example**:
```typescript
// In Discovery Agent
const results = await fetch(`https://api.semanticscholar.org/graph/v1/paper/search?query=${query}`);
```

**Pros**:
- Simple implementation
- No abstraction overhead
- Direct control

**Cons**:
- Rate limiting logic duplicated across agents
- No caching benefits
- Harder to test (mock each API)
- No graceful degradation
- Fragile to API changes

**Decision**: Rejected. Benefits of abstraction outweigh simplicity gains.

### Option B: External Caching Service

**Description**: Use Redis or similar for API response caching.

**Pros**:
- Proven caching infrastructure
- Cross-process cache sharing
- Sophisticated eviction policies

**Cons**:
- External dependency (Redis)
- Infrastructure overhead
- Violates offline-first principle
- Overkill for solo developer

**Decision**: Rejected. File-based cache sufficient for target scale.

### Option C: Background Sync Service

**Description**: Background process that pre-fetches and syncs API data.

**Example**:
```
[Background Worker] ---> [API] ---> [Local Database]
[Research Agents] ---> [Local Database]
```

**Pros**:
- Agents always have local data
- No API calls during user workflows
- True offline-first

**Cons**:
- Complex architecture (worker process)
- Storage overhead (pre-fetch everything)
- Stale data risk
- Hard to know what to pre-fetch

**Decision**: Rejected. On-demand caching simpler and more efficient.

### Option D: API Gateway/Proxy

**Description**: Route all API calls through local gateway that handles caching/rate-limiting.

**Pros**:
- Language-agnostic
- Centralized API management
- Could add authentication, logging

**Cons**:
- Additional process to run
- Network hop overhead
- Overkill for single-user tool
- Infrastructure complexity

**Decision**: Rejected. In-process abstraction sufficient for CLI tool.

## Implementation Notes

### Cache File Structure

```
.aiwg/research/.cache/
├── semantic-scholar/
│   ├── search/                 # Search result caches
│   │   └── {hash}.json
│   └── paper/                  # Paper metadata caches
│       └── {paperId}.json
├── crossref/
│   └── {doi-encoded}.json
├── unpaywall/
│   └── {doi-encoded}.json
├── llm/
│   └── {prompt-hash}.json
└── meta.json                   # Cache statistics
```

### API Client Configuration

`.aiwg/research/config/api-config.yaml`:

```yaml
semantic_scholar:
  base_url: "https://api.semanticscholar.org/graph/v1"
  rate_limit:
    requests_per_minute: 100
    burst: 10
  cache:
    search_ttl: 86400      # 24 hours
    paper_ttl: 2592000     # 30 days
  retry:
    max_attempts: 3
    backoff_base: 1000     # ms

crossref:
  base_url: "https://api.crossref.org/works"
  rate_limit:
    requests_per_second: 50
  cache:
    ttl: 7776000           # 90 days

claude:
  # Key loaded from environment: ANTHROPIC_API_KEY
  model: "claude-opus-5"
  rate_limit:
    requests_per_second: 1
  cache:
    ttl: -1                # Permanent (deterministic)
```

### Provenance for API Calls

All API calls logged for reproducibility:

```json
{
  "activity": {
    "aiwg:api-call-001": {
      "prov:type": "aiwg:APICall",
      "aiwg:api": "semantic-scholar",
      "aiwg:endpoint": "/paper/search",
      "aiwg:params": { "query": "oauth security" },
      "aiwg:cached": false,
      "aiwg:response_hash": "sha256:abc123...",
      "prov:startTime": "2026-01-25T10:00:00Z"
    }
  }
}
```

### Health Check Command

```bash
$ aiwg research health
API Health Status:
  Semantic Scholar: OK (latency: 145ms)
  CrossRef: OK (latency: 89ms)
  Unpaywall: OK (latency: 112ms)
  Claude API: OK (latency: 234ms)

Cache Status:
  Total Size: 45MB
  Entries: 1,234
  Hit Rate (24h): 78%
```

### Token Security

Per @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/token-security.md:

```typescript
// Load API keys securely
const semanticScholarKey = process.env.SEMANTIC_SCHOLAR_API_KEY
  || await readFile('~/.aiwg/config/api-keys.env', 'utf8')
       .then(parse)
       .catch(() => null);

// Never log API keys
logger.info('API configured', { api: 'semantic-scholar', hasKey: !!semanticScholarKey });
```

## References

- @$AIWG_ROOT/agentic/code/frameworks/research-complete/elaboration/nfr/NFR-RF-specifications.md - NFR-RF-R-001 (Retry), NFR-RF-P-001 (Performance), NFR-RF-X-001 (Offline)
- @$AIWG_ROOT/agentic/code/frameworks/research-complete/elaboration/use-cases/UC-RF-001-discover-research-papers.md - Discovery use case
- @$AIWG_ROOT/agentic/code/frameworks/research-complete/elaboration/use-cases/UC-RF-002-acquire-research-source.md - Acquisition use case
- @$AIWG_ROOT/agentic/code/frameworks/research-complete/inception/initial-risk-assessment.md - Risk T-02 (API Rate Limits)
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/token-security.md - API key security patterns
- [Semantic Scholar API](https://api.semanticscholar.org/api-docs/) - API documentation
- [CrossRef API](https://api.crossref.org/) - DOI resolution

---

**Document Status**: Accepted
**Review Date**: 2026-01-25
**Next Review**: End of Construction Phase
