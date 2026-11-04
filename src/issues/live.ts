import type { ExternalIssueProvider, LocalIssueCommentIdMapping } from './types.js';
import type { ExternalIssueCommentSnapshot, ExternalIssueSnapshot, LocalIssueExportSnapshot } from './sync.js';
import { resolveSensitiveInput, type SensitiveInputDependencies, type SensitiveInputOptions } from '../auth/sensitive-input.js';
import type { TrackerActorConfig } from '../config/aiwg-config.js';
import { checkTrackerActor } from './tracker-policy.js';
import { isInteractive } from '../cli/env.js';

export interface LiveIssueClientOptions {
  provider: ExternalIssueProvider;
  repo: string;
  apiUrl?: string;
  token?: string;
  actor?: TrackerActorConfig;
  fetchFn?: typeof fetch;
}

export interface LiveIssueMutationResult {
  snapshot: ExternalIssueSnapshot;
  commentMappings: LocalIssueCommentIdMapping[];
}

interface ProviderIssueResponse {
  id?: number | string;
  number?: number;
  index?: number;
  html_url?: string;
  title?: string;
  body?: string | null;
  state?: string;
  labels?: Array<string | { name?: string }>;
  created_at?: string;
  updated_at?: string;
  user?: { login?: string; username?: string };
  poster?: { login?: string; username?: string };
}

interface ProviderCommentResponse {
  id?: number | string;
  html_url?: string;
  body?: string | null;
  created_at?: string;
  updated_at?: string;
  user?: { login?: string; username?: string };
  poster?: { login?: string; username?: string };
}

export class LiveIssueClient {
  private readonly baseUrl: string;
  private readonly owner: string;
  private readonly name: string;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: LiveIssueClientOptions) {
    const [owner, name] = options.repo.split('/');
    if (!owner || !name || options.repo.split('/').length !== 2) {
      throw new Error('--repo must be in owner/name form');
    }
    this.owner = owner;
    this.name = name;
    this.baseUrl = normalizeApiUrl(options.apiUrl ?? defaultApiUrl(options.provider));
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async fetchIssue(externalId: string): Promise<ExternalIssueSnapshot> {
    const issue = await this.request<ProviderIssueResponse>('GET', this.issuePath(externalId));
    const comments = await this.fetchComments(externalId);
    return normalizeIssue(this.options.provider, issue, comments);
  }

  async importIssue(externalId: string): Promise<ExternalIssueSnapshot> {
    return this.fetchIssue(externalId);
  }

  async exportIssue(snapshot: LocalIssueExportSnapshot): Promise<LiveIssueMutationResult> {
    const hasExternalId = snapshot.external_id.length > 0;
    const issue = hasExternalId
      ? await this.request<ProviderIssueResponse>('PATCH', this.issuePath(snapshot.external_id), issueMutationBody(this.options.provider, snapshot))
      : await this.request<ProviderIssueResponse>('POST', this.issuesPath(), issueMutationBody(this.options.provider, snapshot));
    const externalId = issueNumber(issue);
    const commentMappings: LocalIssueCommentIdMapping[] = [];

    for (const comment of snapshot.comments) {
      if (comment.external_id) continue;
      const posted = await this.request<ProviderCommentResponse>(
        'POST',
        this.commentsPath(externalId),
        { body: comment.body }
      );
      const externalCommentId = requireId(posted.id, 'comment id');
      commentMappings.push({ local_event_id: comment.local_event_id, external_comment_id: externalCommentId });
    }

    return {
      snapshot: await this.fetchIssue(externalId),
      commentMappings,
    };
  }

  private async fetchComments(externalId: string): Promise<ExternalIssueCommentSnapshot[]> {
    const comments = await this.request<ProviderCommentResponse[]>('GET', this.commentsPath(externalId));
    return comments.map((comment) => normalizeComment(comment));
  }

  get provider(): ExternalIssueProvider { return this.options.provider; }

  repositoryRequest<T>(method: string, suffix: string, body?: unknown): Promise<T> {
    return this.request<T>(method, `${this.issuesPath().replace(/\/issues$/, '')}${suffix}`, body);
  }

  private issuesPath(): string {
    return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.name)}/issues`;
  }

  private issuePath(externalId: string): string {
    return `${this.issuesPath()}/${encodeURIComponent(externalId)}`;
  }

  private commentsPath(externalId: string): string {
    return `${this.issuePath(externalId)}/comments`;
  }

  async verifyActor(): Promise<void> {
    if (!this.options.actor) return;
    const user = await this.request<{ login?: string }>('GET', '/user');
    checkTrackerActor(this.options.actor, user.login);
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (method !== 'GET') await this.verifyActor();
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.options.token) headers.Authorization = `Bearer ${this.options.token}`;
    try {
      const response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        redirect: 'error',
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`${this.options.provider} issue API ${method} ${path} failed: ${response.status}${text ? ` ${redactSecrets(text, this.options.token)}` : ''}`);
      }
      // Native HTTP responses may be empty (for example Gitea merge success).
      // Preserve the injected fetch contract used by existing in-process clients.
      const payload = typeof response.text === 'function' ? await response.text() : undefined;
      const result = (payload === undefined ? await response.json() : payload.trim() ? JSON.parse(payload) : {}) as T;
      // A server can reflect request credentials in issue fields or comments.
      // Scrub them before they reach local storage or CLI output.
      if (!this.options.token) return result;
      const encodedToken = JSON.stringify(this.options.token).slice(1, -1);
      return JSON.parse(JSON.stringify(result).split(encodedToken).join('[REDACTED]')) as T;
    } catch (error) {
      throw new Error(redactSecrets(error instanceof Error ? error.message : 'Live issue request failed', this.options.token));
    }
  }
}

export function createLiveIssueClient(options: LiveIssueClientOptions & { tokenEnv?: NodeJS.ProcessEnv }): LiveIssueClient {
  return new LiveIssueClient({
    ...options,
    token: options.token ?? resolveToken(options.provider, options.tokenEnv ?? process.env),
  });
}

/** CLI source selection; the synchronous client factory remains available to callers. */
export async function resolveLiveIssueToken(
  provider: ExternalIssueProvider,
  source: SensitiveInputOptions = {},
  dependencies: SensitiveInputDependencies = {},
): Promise<string | undefined> {
  const environment = dependencies.environment ?? process.env;
  const isTTY = dependencies.isTTY ?? isInteractive();
  const selected = { ...source, prefix: 'token' };
  const hasSource = selected.interactive || selected.stdin || selected.file !== undefined || selected.store !== undefined || selected.env !== undefined;
  if (!hasSource) {
    // Established behavior: use the provider variable when set, otherwise make
    // unauthenticated requests (public repositories). Prompt only on request.
    const names = provider === 'gitea' ? ['AIWG_GITEA_TOKEN', 'GITEA_TOKEN'] : ['AIWG_GITHUB_TOKEN', 'GITHUB_TOKEN'];
    selected.env = names.find(name => environment[name] !== undefined);
    if (selected.env === undefined) return undefined;
  }
  return resolveSensitiveInput(selected, { ...dependencies, environment, isTTY });
}

export function resolveToken(provider: ExternalIssueProvider, env: NodeJS.ProcessEnv): string | undefined {
  if (provider === 'gitea') return env.AIWG_GITEA_TOKEN ?? env.GITEA_TOKEN;
  return env.AIWG_GITHUB_TOKEN ?? env.GITHUB_TOKEN;
}

function defaultApiUrl(provider: ExternalIssueProvider): string {
  if (provider === 'github') return 'https://api.github.com';
  return process.env.AIWG_GITEA_API_URL ?? process.env.GITEA_API_URL ?? 'https://git.integrolabs.net/api/v1';
}

function normalizeApiUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function issueMutationBody(provider: ExternalIssueProvider, snapshot: LocalIssueExportSnapshot): Record<string, unknown> {
  const body: Record<string, unknown> = {
    title: snapshot.title,
    body: snapshot.body,
    labels: snapshot.labels,
  };
  if (snapshot.status === 'closed') body.state = 'closed';
  if (provider === 'gitea' && snapshot.status !== 'closed') body.state = 'open';
  return body;
}

function normalizeIssue(
  provider: ExternalIssueProvider,
  issue: ProviderIssueResponse,
  comments: ExternalIssueCommentSnapshot[]
): ExternalIssueSnapshot {
  const updatedAt = requireString(issue.updated_at, 'updated_at');
  return {
    provider,
    external_id: issueNumber(issue),
    external_url: issue.html_url ?? null,
    title: requireString(issue.title, 'title'),
    body: issue.body ?? '',
    status: issue.state === 'closed' ? 'closed' : 'open',
    labels: normalizeLabels(issue.labels ?? []),
    created_at: issue.created_at,
    updated_at: updatedAt,
    comments,
  };
}

function normalizeComment(comment: ProviderCommentResponse): ExternalIssueCommentSnapshot {
  return {
    external_id: requireId(comment.id, 'comment id'),
    author: comment.user?.login ?? comment.user?.username ?? comment.poster?.login ?? comment.poster?.username ?? 'unknown',
    body: comment.body ?? '',
    created_at: requireString(comment.created_at, 'comment created_at'),
    updated_at: comment.updated_at,
  };
}

function normalizeLabels(labels: Array<string | { name?: string }>): string[] {
  return labels.map((label) => typeof label === 'string' ? label : label.name).filter((label): label is string => Boolean(label));
}

function issueNumber(issue: ProviderIssueResponse): string {
  return requireId(issue.number ?? issue.index ?? issue.id, 'issue number');
}

function requireId(value: unknown, field: string): string {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string' && value.length > 0) return value;
  throw new Error(`live issue response missing ${field}`);
}

function requireString(value: unknown, field: string): string {
  if (typeof value === 'string') return value;
  throw new Error(`live issue response missing ${field}`);
}

function redactSecrets(value: string, token?: string): string {
  const redacted = token ? value.split(token).join('[REDACTED]') : value;
  return redacted
    .replace(/Bearer\s+[^\s"',}]+/gi, 'Bearer [REDACTED]')
    .replace(/(token|authorization|password|secret)["':=\s]+[^\s"',}]+/gi, '$1=[REDACTED]');
}
