/**
 * Read-only, bounded, paginated Gitea/GitHub REST reads for tracker effect
 * verifiers (#2719).
 *
 * This is the TypeScript port of the forge layer in
 * `tools/security/pr-evidence-forge.mjs` (bounded bodies, header-driven
 * pagination, provider-specific auth headers), plus the reads the verifiers
 * need: issue state, one page of issue comments, PR merge state and a commit
 * message. Two transports share one parser: HTTP (`fetch`) and the forge CLI
 * (`gh api --include`).
 *
 * Every failure is a `ForgeReadError` with a fixed message and a classified
 * `code`. Access material stays inside the transport: it is never part of an
 * error, a result or a log line.
 */

import { spawn } from 'node:child_process';

export type ForgeProvider = 'gitea' | 'github';

/** Classified failure of one forge read. */
export type ForgeReadFailure =
  | 'auth-denied'
  | 'not-found'
  | 'rate-limited'
  | 'server-error'
  | 'network-error'
  | 'timeout'
  | 'oversized'
  | 'malformed'
  | 'unexpected-status';

export class ForgeReadError extends Error {
  constructor(readonly code: ForgeReadFailure, readonly status?: number) {
    super(`Forge read failed: ${code}${status ? ` (HTTP ${status})` : ''}`);
    this.name = 'ForgeReadError';
  }
}

/** One raw response. Header names are lower case. */
export interface ForgeRawResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

/** Performs one authenticated GET of an API path (`/repos/...?page=1`). */
export type ForgeTransport = (path: string, signal?: AbortSignal) => Promise<ForgeRawResponse>;

export const FORGE_MAX_RESPONSE_BYTES = 2_000_000;

const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;
const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

async function boundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ForgeReadError('oversized');
  }
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new ForgeReadError('oversized');
    return bytes;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ForgeReadError('oversized');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

const aborted = (signal?: AbortSignal) => signal?.aborted === true;

export interface HttpTransportOptions {
  provider: ForgeProvider;
  /** Trusted API base, e.g. `https://forge.example/api/v1` or `https://api.github.com`. */
  apiBaseUrl: string;
  /** Access material from the tracker access path. Sent only as the Authorization header. */
  token: string;
  fetchImpl?: typeof fetch;
  maxResponseBytes?: number;
}

/** HTTP transport over `fetch`, with the provider's auth header and a response bound. */
export function httpForgeTransport(options: HttpTransportOptions): ForgeTransport {
  if (!/^https?:\/\//.test(options.apiBaseUrl ?? '')) throw new TypeError('A trusted API base URL is required');
  const base = options.apiBaseUrl.replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = options.maxResponseBytes ?? FORGE_MAX_RESPONSE_BYTES;
  const authorization = options.provider === 'github' ? `Bearer ${options.token}` : `token ${options.token}`;
  return async (path, signal) => {
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method: 'GET',
        headers: { accept: 'application/json', authorization },
        redirect: 'error',
        ...(signal ? { signal } : {}),
      });
    } catch {
      throw new ForgeReadError(aborted(signal) ? 'timeout' : 'network-error');
    }
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => { headers[name.toLowerCase()] = value; });
    let body: Uint8Array;
    try {
      body = await boundedBody(response, maxBytes);
    } catch (error) {
      if (error instanceof ForgeReadError) throw error;
      throw new ForgeReadError(aborted(signal) ? 'timeout' : 'network-error');
    }
    return { status: response.status, headers, body };
  };
}

/** Runs the forge CLI and resolves its stdout bytes and exit code. Rejects when it cannot start. */
export type ForgeCliRunner = (args: string[], signal?: AbortSignal) => Promise<{ stdout: Uint8Array; exitCode: number }>;

export interface CliTransportOptions {
  provider: ForgeProvider;
  /** Forge host of the selected tracker remote, passed as `--hostname`. */
  hostname: string;
  /** Test seam; defaults to spawning `gh`. */
  runner?: ForgeCliRunner;
  binary?: string;
  maxResponseBytes?: number;
}

function spawnCliRunner(binary: string, maxBytes: number): ForgeCliRunner {
  return (args, signal) => new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, ...(signal ? { signal } : {}),
      env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1' },
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let oversized = false;
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes + 65_536) { oversized = true; child.kill(); } else chunks.push(chunk);
    });
    child.once('error', () => reject(new ForgeReadError(aborted(signal) ? 'timeout' : 'network-error')));
    child.once('close', code => {
      if (oversized) reject(new ForgeReadError('oversized'));
      else resolve({ stdout: new Uint8Array(Buffer.concat(chunks)), exitCode: code ?? 1 });
    });
  });
}

/** Split `gh api --include` output into status, headers and body. */
export function parseIncludedResponse(output: Uint8Array): ForgeRawResponse {
  const text = Buffer.from(output);
  let split = text.indexOf('\r\n\r\n');
  let gap = 4;
  if (split < 0) { split = text.indexOf('\n\n'); gap = 2; }
  if (split < 0) throw new ForgeReadError('malformed');
  const head = text.subarray(0, split).toString('latin1').split(/\r?\n/);
  const status = /^HTTP\/[0-9.]+ ([0-9]{3})\b/.exec(head[0] ?? '');
  if (!status) throw new ForgeReadError('malformed');
  const headers: Record<string, string> = {};
  for (const line of head.slice(1)) {
    const colon = line.indexOf(':');
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { status: Number(status[1]), headers, body: new Uint8Array(text.subarray(split + gap)) };
}

/**
 * CLI transport: `gh api --include --hostname <host> <path>`. The CLI holds
 * its own credentials. Gitea has no CLI with a raw read API (`tea` has no
 * `api` command), so only GitHub is supported.
 */
export function cliForgeTransport(options: CliTransportOptions): ForgeTransport {
  if (options.provider !== 'github') throw new TypeError('The forge CLI transport supports GitHub only');
  if (!/^[A-Za-z0-9.-]+(?::[0-9]+)?$/.test(options.hostname ?? '')) throw new TypeError('A forge hostname is required');
  const maxBytes = options.maxResponseBytes ?? FORGE_MAX_RESPONSE_BYTES;
  const runner = options.runner ?? spawnCliRunner(options.binary ?? 'gh', maxBytes);
  return async (path, signal) => {
    if (!path.startsWith('/')) throw new ForgeReadError('malformed');
    const { stdout, exitCode } = await runner(['api', '--include', '--method', 'GET', '--hostname', options.hostname, path.slice(1)], signal)
      .catch((error: unknown) => {
        if (error instanceof ForgeReadError) throw error;
        throw new ForgeReadError(aborted(signal) ? 'timeout' : 'network-error');
      });
    // `gh api --include` prints the status line even for a non-2xx exit. With
    // nothing on stdout the CLI never reached the API: exit 4 is gh's
    // "authentication required".
    if (stdout.length === 0 && exitCode !== 0) throw new ForgeReadError(exitCode === 4 ? 'auth-denied' : 'network-error');
    const parsed = parseIncludedResponse(stdout);
    if (parsed.body.length > maxBytes) throw new ForgeReadError('oversized');
    return parsed;
  };
}

/** Classify a non-2xx response. A GitHub 403 with an exhausted quota is a rate limit, not an auth failure. */
export function classifyStatus(response: ForgeRawResponse): ForgeReadFailure | null {
  const { status, headers } = response;
  if (status >= 200 && status < 300) return null;
  if (status === 429) return 'rate-limited';
  if (status === 403 && (headers['x-ratelimit-remaining'] === '0' || headers['retry-after'] !== undefined)) return 'rate-limited';
  if (status === 401 || status === 403) return 'auth-denied';
  if (status === 404 || status === 410) return 'not-found';
  if (status >= 500) return 'server-error';
  return 'unexpected-status';
}

function parseJson(response: ForgeRawResponse): unknown {
  const failure = classifyStatus(response);
  if (failure) throw new ForgeReadError(failure, response.status);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.body));
  } catch {
    throw new ForgeReadError('malformed');
  }
}

export interface ForgePage<T> {
  items: T[];
  nextPage: number | null;
  /** True when this page provably ends the collection (no next page, totals agree). */
  complete: boolean;
  totalCount?: number;
}

/**
 * Pagination from the provider headers (`x-hasmore`, `link rel="next"`,
 * `x-total-count` / `x-total`). A full page with no pagination signal is
 * ambiguous and never complete.
 */
export function forgePagination<T>(headers: Record<string, string>, items: T[], page: number, pageSize: number): ForgePage<T> {
  const totalHeader = headers['x-total-count'] ?? headers['x-total'];
  const total = totalHeader !== undefined && /^[0-9]+$/.test(totalHeader) ? Number(totalHeader) : undefined;
  const hasMore = headers['x-hasmore'];
  if (items.length > pageSize) {
    // The server ignored the page size and returned the whole collection at once.
    const whole = page === 1 && hasMore !== 'true' && (total === undefined || total === items.length);
    return { items, nextPage: null, complete: whole, ...(total !== undefined ? { totalCount: total } : {}) };
  }
  const linkedNext = /<[^>]+[?&]page=(\d+)[^>]*>;\s*rel="next"/.exec(headers.link ?? '');
  const nextPage = hasMore === 'true' ? page + 1
    : hasMore === 'false' ? null
      : linkedNext ? Number(linkedNext[1])
        : total !== undefined && items.length === pageSize && page * pageSize < total ? page + 1 : null;
  const ambiguous = hasMore === undefined && !linkedNext && total === undefined && items.length === pageSize;
  const totalsAgree = total === undefined || total === (page - 1) * pageSize + items.length;
  return { items, nextPage, complete: !ambiguous && nextPage === null && totalsAgree, ...(total !== undefined ? { totalCount: total } : {}) };
}

export interface ForgeIssueState { number: number; state: 'open' | 'closed'; closedAt: string | null; isPullRequest: boolean }
export interface ForgeComment { id: number; author: string | null; body: string; createdAt: string | null }
export interface ForgePullState {
  number: number;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  /** Only set for a merged PR; GitHub reports a test-merge SHA for unmerged PRs, which is ignored. */
  mergeCommitSha: string | null;
  baseRef: string | null;
  baseSha: string | null;
  headSha: string | null;
}

export interface ForgeReader {
  readonly provider: ForgeProvider;
  getIssue(repository: string, number: number, signal?: AbortSignal): Promise<ForgeIssueState>;
  listIssueComments(repository: string, number: number, page: number, signal?: AbortSignal): Promise<ForgePage<ForgeComment>>;
  getPullState(repository: string, number: number, signal?: AbortSignal): Promise<ForgePullState>;
  /** Full commit message, or null when the forge does not return one. */
  getCommitMessage(repository: string, sha: string, signal?: AbortSignal): Promise<string | null>;
  readonly pageSize: number;
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const login = (user: unknown): string | null => {
  if (!user || typeof user !== 'object') return null;
  const value = user as { login?: unknown; username?: unknown };
  return str(value.login) ?? str(value.username);
};

function repoPath(repository: string, number?: number): string {
  if (!REPOSITORY.test(repository) || repository.split('/').some(part => part === '.' || part === '..')) throw new ForgeReadError('malformed');
  if (number !== undefined && (!Number.isSafeInteger(number) || number < 1)) throw new ForgeReadError('malformed');
  return `/repos/${repository.split('/').map(encodeURIComponent).join('/')}`;
}

/** Build the read-only reader over one transport. */
export function createForgeReader(provider: ForgeProvider, transport: ForgeTransport, options: { pageSize?: number } = {}): ForgeReader {
  const pageSize = options.pageSize ?? (provider === 'github' ? 100 : 50);
  const get = async (path: string, signal?: AbortSignal) => {
    if (aborted(signal)) throw new ForgeReadError('timeout');
    return transport(path, signal);
  };
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ForgeReadError('malformed');
    return value as Record<string, unknown>;
  };
  return {
    provider,
    pageSize,
    async getIssue(repository, number, signal) {
      const issue = object(parseJson(await get(`${repoPath(repository, number)}/issues/${number}`, signal)));
      const state = issue.state;
      if (state !== 'open' && state !== 'closed') throw new ForgeReadError('malformed');
      const found = issue.number ?? issue.index;
      if (found !== undefined && found !== number) throw new ForgeReadError('malformed');
      return { number, state, closedAt: str(issue.closed_at), isPullRequest: Boolean(issue.pull_request) };
    },
    async listIssueComments(repository, number, page, signal) {
      if (!Number.isSafeInteger(page) || page < 1) throw new ForgeReadError('malformed');
      const sizeParam = provider === 'github' ? 'per_page' : 'limit';
      const response = await get(`${repoPath(repository, number)}/issues/${number}/comments?page=${page}&${sizeParam}=${pageSize}`, signal);
      const raw = parseJson(response);
      if (!Array.isArray(raw)) throw new ForgeReadError('malformed');
      const items = raw.map((entry): ForgeComment => {
        const item = object(entry);
        if (typeof item.id !== 'number') throw new ForgeReadError('malformed');
        return { id: item.id, author: login(item.user) ?? login(item.poster), body: str(item.body) ?? '', createdAt: str(item.created_at) };
      });
      return forgePagination(response.headers, items, page, pageSize);
    },
    async getPullState(repository, number, signal) {
      const pr = object(parseJson(await get(`${repoPath(repository, number)}/pulls/${number}`, signal)));
      const state = pr.state;
      if (state !== 'open' && state !== 'closed') throw new ForgeReadError('malformed');
      if (typeof pr.merged !== 'boolean') throw new ForgeReadError('malformed');
      const base = pr.base && typeof pr.base === 'object' ? pr.base as Record<string, unknown> : {};
      const head = pr.head && typeof pr.head === 'object' ? pr.head as Record<string, unknown> : {};
      const mergeSha = str(pr.merge_commit_sha);
      return {
        number,
        state,
        merged: pr.merged,
        mergedAt: str(pr.merged_at),
        mergeCommitSha: pr.merged && mergeSha && OBJECT_ID.test(mergeSha) ? mergeSha : null,
        baseRef: str(base.ref),
        baseSha: str(base.sha),
        headSha: str(head.sha),
      };
    },
    async getCommitMessage(repository, sha, signal) {
      if (!OBJECT_ID.test(sha)) throw new ForgeReadError('malformed');
      const path = provider === 'github' ? `${repoPath(repository)}/commits/${sha}` : `${repoPath(repository)}/git/commits/${sha}`;
      const commit = object(parseJson(await get(path, signal)));
      const inner = commit.commit && typeof commit.commit === 'object' ? commit.commit as Record<string, unknown> : commit;
      return str(inner.message);
    },
  };
}

/**
 * Derive the REST API base from a tracker remote URL (`git@host:o/r.git`,
 * `ssh://git@host:2222/o/r.git`, `https://host/prefix/o/r.git`). Returns the
 * host, the `owner/repo` path and the API base, or null when the URL cannot
 * be parsed. No host is assumed: the base always comes from the remote.
 */
export function forgeEndpointFromRemote(provider: ForgeProvider, remoteUrl: string | undefined): { host: string; repository: string; apiBaseUrl: string } | null {
  if (!remoteUrl) return null;
  let origin: string;
  let host: string;
  let path: string;
  const scp = /^[\w.-]+@([A-Za-z0-9.-]+):(?!\/)(.+)$/.exec(remoteUrl);
  if (scp) {
    host = scp[1];
    origin = `https://${host}`;
    path = scp[2];
  } else {
    let url: URL;
    try { url = new URL(remoteUrl); } catch { return null; }
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol) || !url.hostname) return null;
    host = url.hostname;
    const web = url.protocol === 'https:' || url.protocol === 'http:';
    origin = web ? `${url.protocol}//${url.host}` : `https://${host}`;
    path = url.pathname.replace(/^\/+/, '');
  }
  const parts = path.replace(/\.git$/, '').replace(/\/+$/, '').split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const repository = parts.slice(-2).join('/');
  if (!REPOSITORY.test(repository)) return null;
  const prefix = parts.slice(0, -2).join('/');
  const webBase = prefix ? `${origin}/${prefix}` : origin;
  const apiBaseUrl = provider === 'github'
    ? (host.toLowerCase() === 'github.com' ? 'https://api.github.com' : `${webBase}/api/v3`)
    : `${webBase}/api/v1`;
  return { host: host.toLowerCase(), repository, apiBaseUrl };
}
