/**
 * Type definitions for the Research Framework
 *
 * @module research/types
 */

/**
 * Research paper metadata
 */
export interface ResearchPaper {
  /** Paper identifier (DOI, arXiv ID, etc.) */
  id: string;
  /** Paper title */
  title: string;
  /** List of authors */
  authors: Author[];
  /** Publication year */
  year: number;
  /** Abstract or summary */
  abstract?: string;
  /** DOI if available */
  doi?: string;
  /** Additional DOI identities retained when preprint and publication records merge. */
  alternateDois?: string[];
  /** arXiv ID if available */
  arxivId?: string;
  /** Version returned by arXiv; requested versions stay in the parsed reference. */
  arxivVersion?: number;
  /** Semantic Scholar graph identifier. */
  s2PaperId?: string;
  openReviewId?: string;
  aclId?: string;
  /** ISO publication date (precision may be year or month). */
  publicationDate?: string;
  /** Structured publication venue supplied by Semantic Scholar. */
  publicationVenue?: { id?: string; name?: string; type?: string; url?: string; alternate_names?: string[] };
  /** Publication venue */
  venue?: string;
  /** Citation count */
  citationCount?: number;
  /** PDF URL if available */
  pdfUrl?: string;
  /** Publication type */
  type?: 'journal' | 'conference' | 'preprint' | 'book' | 'thesis' | 'other';
  /** Source of the data */
  source: 'semantic-scholar' | 'crossref' | 'arxiv' | 'unpaywall';
  /** Timestamp when data was retrieved */
  retrievedAt: string;
}

/**
 * Author information
 */
export interface Author {
  /** Author name */
  name: string;
  /** Author ID (if available) */
  id?: string;
  /** Affiliations */
  affiliations?: string[];
}

/**
 * API response for Semantic Scholar
 */
export interface SemanticScholarResponse {
  paperId: string;
  title: string;
  abstract?: string;
  year?: number;
  authors: Array<{
    authorId?: string;
    name: string;
  }>;
  citationCount?: number;
  venue?: string;
  publicationDate?: string | null;
  publicationVenue?: ResearchPaper['publicationVenue'] | null;
  externalIds?: {
    DOI?: string;
    ArXiv?: string;
    ACL?: string;
    OpenReview?: string;
  };
  openAccessPdf?: {
    url: string;
  } | null;
}

/**
 * API response for CrossRef
 */
export interface CrossRefResponse {
  DOI: string;
  title?: string[];
  abstract?: string;
  author?: Array<{
    given?: string;
    family?: string;
    affiliation?: Array<{ name: string }>;
  }>;
  published?: {
    'date-parts': number[][];
  };
  'container-title'?: string[];
  'is-referenced-by-count'?: number;
  type?: string;
}

/**
 * API response for arXiv
 */
export interface ArxivResponse {
  id: string;
  title: string;
  summary: string;
  authors: Array<{ name: string }>;
  published: string;
  updated: string;
  doi?: string;
  'journal-ref'?: string;
  'pdf-url'?: string;
}

/**
 * API response for Unpaywall
 */
export interface UnpaywallResponse {
  doi: string;
  title?: string;
  year?: number;
  journal_name?: string;
  authors?: Array<{
    given?: string;
    family?: string;
  }>;
  best_oa_location?: {
    url_for_pdf?: string;
    url?: string;
  } | null;
}

/**
 * Cache entry structure
 */
export interface CacheEntry<T> {
  /** Cached data */
  data: T;
  /** Timestamp when cached */
  cachedAt: string;
  /** TTL in seconds */
  ttl: number;
  /** Cache key */
  key: string;
}

/**
 * Rate limit configuration
 */
export interface RateLimitConfig {
  /** Maximum tokens */
  maxTokens: number;
  /** Refill rate (tokens per second) */
  refillRate: number;
  /** Current tokens available */
  currentTokens: number;
  /** Last refill timestamp */
  lastRefill: number;
}

/**
 * Retry configuration
 */
export interface RetryConfig {
  /** Maximum retry attempts */
  maxRetries: number;
  /** Initial delay in ms */
  initialDelay: number;
  /** Maximum delay in ms */
  maxDelay: number;
  /** Backoff multiplier */
  backoffMultiplier: number;
}

/**
 * Client configuration
 */
export interface ClientConfig {
  /** Base URL for the API */
  baseUrl: string;
  /** Timeout in ms */
  timeout: number;
  /** Rate limit configuration */
  rateLimit: RateLimitConfig;
  /** Retry configuration */
  retry: RetryConfig;
  /** API key (if required) */
  apiKey?: string;
  /** Email for Unpaywall */
  email?: string;
}

/**
 * Research Framework error codes
 */
export enum ResearchErrorCode {
  // RF-1xx: Client errors
  RF_100 = 'RF-100: Invalid request parameters',
  RF_101 = 'RF-101: Missing required parameter',
  RF_102 = 'RF-102: Invalid API key',
  RF_103 = 'RF-103: Rate limit exceeded',
  RF_104 = 'RF-104: Request timeout',

  // RF-2xx: Server errors
  RF_200 = 'RF-200: API server error',
  RF_201 = 'RF-201: Service unavailable',
  RF_202 = 'RF-202: Gateway timeout',

  // RF-3xx: Data errors
  RF_300 = 'RF-300: Resource not found',
  RF_301 = 'RF-301: Invalid response format',
  RF_302 = 'RF-302: Missing required field',

  // RF-4xx: Cache errors
  RF_400 = 'RF-400: Cache read error',
  RF_401 = 'RF-401: Cache write error',
  RF_402 = 'RF-402: Cache invalidation error',

  // RF-5xx: Network errors
  RF_500 = 'RF-500: Network error',
  RF_501 = 'RF-501: Connection refused',
  RF_502 = 'RF-502: DNS resolution failed',
}

/**
 * Research Framework error
 */
export class ResearchError extends Error {
  /** Server-directed cooldown, shared by all requests through the client limiter. */
  public retryAfterMs?: number;
  constructor(
    public code: ResearchErrorCode,
    message: string,
    public cause?: Error
  ) {
    super(message);
    this.name = 'ResearchError';
  }
}

/**
 * Search options
 */
export interface SearchOptions {
  /** Maximum results to return */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
  /** Fields to include in response */
  fields?: string[];
  /** Whether to use cache */
  useCache?: boolean;
}

/**
 * Search result
 */
export interface SearchResult {
  /** Total results found */
  total: number;
  /** Papers in this page */
  papers: ResearchPaper[];
  /** Offset used */
  offset: number;
  /** Limit used */
  limit: number;
  /** Whether more results are available */
  hasMore: boolean;
}
