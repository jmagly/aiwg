import { constants } from 'fs';
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, join, relative, resolve, sep } from 'path';
import { hostname } from 'os';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { projectAiwgPath } from '../config/project-artifacts.js';
import type {
  CreateLocalIssueInput,
  GetLocalIssueOptions,
  ImportLocalIssueInput,
  LocalIssueCommentIdMapping,
  ListLocalIssuesOptions,
  ListLocalIssuesResult,
  LocalIssueConfig,
  LocalIssueEvent,
  LocalIssueEventType,
  LocalIssueEventWithBody,
  LocalIssueFields,
  LocalIssueFilter,
  LocalIssueIndex,
  LocalIssueIndexEntry,
  LocalIssuePriority,
  LocalIssueProvider,
  LocalIssueRecord,
  LocalIssueStatus,
  LocalIssueType,
  UpdateLocalIssueFieldsInput,
} from './types.js';

const DEFAULT_PREFIX = 'ISSUE';
const DEFAULT_PADDING = 4;
const VALID_STATUSES = new Set<LocalIssueStatus>(['open', 'closed', 'archived']);
const VALID_TYPES = new Set<LocalIssueType>(['bug', 'feature', 'research', 'task', 'epic']);
const VALID_PRIORITIES = new Set<LocalIssuePriority>(['P0', 'P1', 'P2', 'P3']);
const VALID_EVENT_TYPES = new Set<LocalIssueEventType>([
  'created',
  'comment',
  'status_changed',
  'label_added',
  'label_removed',
  'linked',
  'cycle_status',
  'closed',
]);

export class LocalIssueProviderError extends Error {}
export class LocalIssueLockError extends LocalIssueProviderError {}

export class LocalIssueLockManager {
  private readonly locksDir: string;
  private readonly waitMs: number;
  private readonly pollMs: number;

  constructor(root: string, options: { waitMs?: number; pollMs?: number } = {}) {
    this.locksDir = join(resolve(root), 'locks');
    this.waitMs = options.waitMs ?? 2000;
    this.pollMs = options.pollMs ?? 10;
  }

  async withIssueLock<T>(issueId: string, operation: string, fn: () => Promise<T>): Promise<T> {
    return this.withLock(issueId + '.lock', operation, fn);
  }

  async withIdLock<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    return this.withLock('next-id.lock', operation, fn);
  }

  async withIndexLock<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    return this.withLock('index.lock', operation, fn);
  }

  private async withLock<T>(name: string, operation: string, fn: () => Promise<T>): Promise<T> {
    await mkdir(this.locksDir, { recursive: true });
    const lockPath = join(this.locksDir, name);
    const payload = {
      pid: process.pid,
      hostname: hostname(),
      created_at: new Date().toISOString(),
      operation,
    };
    const handle = await this.acquire(lockPath, payload);

    try {
      return await fn();
    } finally {
      await handle.close();
      await unlink(lockPath).catch(() => undefined);
    }
  }

  private async acquire(lockPath: string, payload: object): Promise<Awaited<ReturnType<typeof open>>> {
    const started = Date.now();
    let existing = '';
    while (true) {
      try {
        const handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
        await handle.writeFile(JSON.stringify(payload, null, 2));
        await handle.sync();
        return handle;
      } catch (error: unknown) {
        if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
        existing = await readFile(lockPath, 'utf-8').catch(() => '');
        if (Date.now() - started >= this.waitMs) {
          throw new LocalIssueLockError('local issue lock already exists at ' + lockPath + (existing ? ': ' + existing : ''));
        }
        await sleep(this.pollMs);
      }
    }
  }
}

export class LocalIssueProviderCore implements LocalIssueProvider {
  private readonly root: string;
  private readonly lockManager: LocalIssueLockManager;

  constructor(root: string) {
    this.root = resolve(root);
    this.lockManager = new LocalIssueLockManager(this.root);
  }

  async requireInitialized(): Promise<void> {
    await this.readConfig();
  }

  async init(options: { prefix?: string; padding?: number } = {}): Promise<LocalIssueConfig> {
    await this.ensureLayout();
    const existing = await this.readConfigIfExists();
    if (existing) return existing;

    const config: LocalIssueConfig = {
      provider: 'local',
      issue_key: {
        prefix: normalizePrefix(options.prefix ?? (await suggestLocalIssuePrefix(this.projectRoot()))?.prefix ?? DEFAULT_PREFIX),
        padding: options.padding ?? DEFAULT_PADDING,
        next: 1,
      },
    };
    validateConfig(config);
    await atomicWrite(this.path('config.json'), `${JSON.stringify(config, null, 2)}\n`);
    await atomicWrite(this.path('next-id'), '1\n');
    await this.rebuildIssueIndex();
    return config;
  }

  async createIssue(input: CreateLocalIssueInput): Promise<LocalIssueRecord> {
    await this.init();
    const id = await this.allocateIssueId();
    const now = new Date().toISOString();
    const fields: LocalIssueFields = {
      id,
      status: 'open',
      title: requireNonEmpty(input.title, 'title'),
      type: input.type ?? 'task',
      priority: input.priority ?? 'P2',
      labels: normalizeStringArray(input.labels ?? []),
      assignees: normalizeStringArray(input.assignees ?? []),
      created_at: now,
      updated_at: now,
      closed_at: null,
      links: { external: [], parent: null, children: [], related: [] },
      source: { provider: 'local', external_id: null, external_url: null },
    };
    validateIssueFields(fields);
    const record = { fields, body: input.body ?? '' };

    await this.lockManager.withIssueLock(id, 'create issue', async () => {
      await atomicWrite(this.itemPath(id), serializeIssueMarkdown(record));
      await this.appendEventUnlocked(id, {
        type: 'created',
        author: input.author ?? 'operator',
        body: input.body,
      });
    });
    await this.rebuildIssueIndex();
    return record;
  }

  async importIssue(input: ImportLocalIssueInput): Promise<LocalIssueRecord & { events: LocalIssueEventWithBody[] }> {
    await this.init();
    const id = await this.allocateIssueId();
    const now = new Date().toISOString();
    const createdAt = input.created_at ?? input.updated_at ?? now;
    const updatedAt = input.updated_at ?? createdAt;
    const status = input.status === 'closed' ? 'closed' : 'open';
    const fields: LocalIssueFields = {
      id,
      status,
      title: requireNonEmpty(input.title, 'title'),
      type: 'task',
      priority: 'P2',
      labels: normalizeStringArray(input.labels ?? []),
      assignees: normalizeStringArray(input.assignees ?? []),
      created_at: createdAt,
      updated_at: updatedAt,
      closed_at: status === 'closed' ? updatedAt : null,
      links: { external: input.external_url ? [input.external_url] : [], parent: null, children: [], related: [] },
      source: { provider: input.provider, external_id: requireNonEmpty(input.external_id, 'external id'), external_url: input.external_url ?? null },
    };
    validateIssueFields(fields);
    const record: LocalIssueRecord = { fields, body: input.body ?? '' };

    await this.lockManager.withIssueLock(id, 'import external issue', async () => {
      await atomicWrite(this.itemPath(id), serializeIssueMarkdown(record));
      await this.appendEventUnlocked(id, {
        type: 'created',
        author: input.provider,
        created_at: createdAt,
        body: input.body,
        data: { external_id: input.external_id, external_url: input.external_url ?? null, provider: input.provider },
      });
      for (const comment of input.comments ?? []) {
        await this.appendEventUnlocked(id, {
          type: 'comment',
          author: comment.author,
          created_at: comment.created_at,
          body: comment.body,
          data: {
            ...(comment.external_id ? { external_comment_id: comment.external_id } : {}),
            ...(comment.updated_at ? { external_updated_at: comment.updated_at } : {}),
            provider: input.provider,
          },
        });
      }
    });
    await this.rebuildIssueIndex();
    return this.getIssue(id, { body: true, comments: 'all' });
  }

  async applyCommentIdMappings(id: string, mappings: LocalIssueCommentIdMapping[]): Promise<LocalIssueEventWithBody[]> {
    const normalized = normalizeIssueId(id);
    const byEventId = new Map(mappings.map((mapping) => [mapping.local_event_id, mapping.external_comment_id]));
    await this.lockManager.withIssueLock(normalized, 'apply external comment id mappings', async () => {
      await this.readIssue(normalized);
      const raw = await readFile(this.eventPath(normalized), 'utf-8').catch((error: unknown) => {
        if (isNodeError(error) && error.code === 'ENOENT') return '';
        throw error;
      });
      const events = raw
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as LocalIssueEvent);
      let changed = false;
      const updated = events.map((event) => {
        const externalCommentId = byEventId.get(event.event_id);
        if (!externalCommentId) return event;
        changed = true;
        return {
          ...event,
          data: {
            ...(event.data ?? {}),
            external_comment_id: externalCommentId,
          },
        };
      });
      if (changed) {
        await atomicWrite(this.eventPath(normalized), updated.map((event) => JSON.stringify(event)).join('\n') + '\n');
      }
    });
    return this.readEvents(normalized, 'all');
  }

  async getIssue(
    id: string,
    options: GetLocalIssueOptions = { body: true, comments: 'all' }
  ): Promise<LocalIssueRecord & { events: LocalIssueEventWithBody[] }> {
    const normalized = normalizeIssueId(id);
    const record = await this.readIssue(normalized);
    const events = await this.readEvents(normalized, options.comments ?? 'all');
    return {
      fields: record.fields,
      body: options.body === false ? '' : record.body,
      events,
    };
  }

  async listIssues(options: ListLocalIssuesOptions = {}): Promise<ListLocalIssuesResult> {
    await this.requireInitialized();
    const index = await this.readIndexOrRebuild();
    const offset = options.cursor ? Number.parseInt(options.cursor, 10) : 0;
    const limit = options.limit ?? 50;
    if (!Number.isInteger(offset) || offset < 0) {
      throw new LocalIssueProviderError(`invalid issue list cursor: ${options.cursor}`);
    }
    const filtered = index.issues.filter((issue) => matchesFilter(issue, options.filter));
    const issues = filtered.slice(offset, offset + limit);
    const nextOffset = offset + issues.length;
    return {
      issues,
      nextCursor: nextOffset < filtered.length ? String(nextOffset) : null,
    };
  }

  async updateIssueFields(id: string, patch: UpdateLocalIssueFieldsInput): Promise<LocalIssueRecord> {
    const normalized = normalizeIssueId(id);
    const updated = await this.lockManager.withIssueLock(normalized, 'update issue fields', async () => {
      const current = await this.readIssue(normalized);
      const nextFields: LocalIssueFields = {
        ...current.fields,
        ...patch,
        updated_at: new Date().toISOString(),
      };
      if (patch.status === 'closed' && !nextFields.closed_at) {
        nextFields.closed_at = nextFields.updated_at;
      }
      if (patch.status && patch.status !== 'closed') {
        nextFields.closed_at = null;
      }
      validateIssueFields(nextFields);
      const next = { fields: nextFields, body: current.body };
      await atomicWrite(this.itemPath(normalized), serializeIssueMarkdown(next));
      if (patch.status && patch.status !== current.fields.status) {
        await this.appendEventUnlocked(normalized, {
          type: 'status_changed',
          author: 'operator',
          data: { from: current.fields.status, to: patch.status },
        });
      }
      return next;
    });
    await this.rebuildIssueIndex();
    return updated;
  }

  async appendIssueEvent(
    id: string,
    event: Omit<LocalIssueEvent, 'event_id' | 'issue_id' | 'created_at'> & { created_at?: string; body?: string }
  ): Promise<LocalIssueEvent> {
    const normalized = normalizeIssueId(id);
    const appended = await this.lockManager.withIssueLock(normalized, `append ${event.type} event`, async () => {
      await this.readIssue(normalized);
      const result = await this.appendEventUnlocked(normalized, event);
      await this.touchIssueUpdatedAt(normalized, result.created_at);
      return result;
    });
    await this.rebuildIssueIndex();
    return appended;
  }

  async commentIssue(id: string, body: string, options: { author?: string; type?: 'comment' | 'cycle_status' } = {}): Promise<LocalIssueEvent> {
    return this.appendIssueEvent(id, {
      type: options.type ?? 'comment',
      author: options.author ?? 'operator',
      body,
    });
  }

  async closeIssue(id: string, options: { author?: string; reason?: string } = {}): Promise<LocalIssueRecord> {
    const normalized = normalizeIssueId(id);
    const closed = await this.lockManager.withIssueLock(normalized, 'close issue', async () => {
      const current = await this.readIssue(normalized);
      const now = new Date().toISOString();
      const next: LocalIssueRecord = {
        fields: {
          ...current.fields,
          status: 'closed',
          updated_at: now,
          closed_at: now,
        },
        body: current.body,
      };
      await atomicWrite(this.itemPath(normalized), serializeIssueMarkdown(next));
      await this.appendEventUnlocked(normalized, {
        type: 'closed',
        author: options.author ?? 'operator',
        body: options.reason,
      });
      return next;
    });
    await this.rebuildIssueIndex();
    return closed;
  }

  async getIssueThreadSince(id: string, since: string): Promise<LocalIssueEventWithBody[]> {
    const events = await this.readEvents(normalizeIssueId(id), 'all');
    const sinceTime = Date.parse(since);
    if (!Number.isNaN(sinceTime)) {
      return events.filter((event) => Date.parse(event.created_at) > sinceTime);
    }
    const idx = events.findIndex((event) => event.event_id === since);
    return idx >= 0 ? events.slice(idx + 1) : events;
  }

  async rebuildIssueIndex(options: { force?: boolean } = {}): Promise<LocalIssueIndex> {
    await this.ensureLayout();
    return this.lockManager.withIndexLock('rebuild issue index', async () => {
      const itemDir = this.path('items');
      const entries = (await readdir(itemDir, { withFileTypes: true }))
        .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
        .sort((a, b) => a.name.localeCompare(b.name));
      const inputs = await Promise.all(entries.map(async entry => {
        const metadata = await stat(join(itemDir, entry.name));
        return [entry.name, metadata.mtimeMs, metadata.ctimeMs, metadata.size];
      }));
      const inputFingerprint = createHash('sha256').update(JSON.stringify([1, inputs])).digest('hex');
      if (!options.force) {
        try {
          const cached = JSON.parse(await readFile(this.path('index/issues.index.json'), 'utf-8')) as LocalIssueIndex;
          if (cached?.provider === 'local' && Array.isArray(cached.issues) && cached.inputFingerprint === inputFingerprint) {
            return cached;
          }
        } catch (error: unknown) {
          if (!(error instanceof SyntaxError) && !(isNodeError(error) && error.code === 'ENOENT')) throw error;
        }
      }
      const issues: LocalIssueIndexEntry[] = [];
      for (const entry of entries) {
        const record = parseIssueMarkdown(await readFile(join(itemDir, entry.name), 'utf-8'));
        issues.push({
          id: record.fields.id,
          title: record.fields.title,
          status: record.fields.status,
          type: record.fields.type,
          priority: record.fields.priority,
          labels: record.fields.labels,
          assignees: record.fields.assignees,
          updated_at: record.fields.updated_at,
          closed_at: record.fields.closed_at,
          path: `items/${entry.name}`,
        });
      }
      issues.sort((a, b) => a.id.localeCompare(b.id));
      const index: LocalIssueIndex = {
        provider: 'local',
        rebuilt_at: new Date().toISOString(),
        inputFingerprint,
        issues,
      };
      await atomicWrite(this.path('index/issues.index.json'), `${JSON.stringify(index, null, 2)}\n`);
      return index;
    });
  }

  private async ensureLayout(): Promise<void> {
    await mkdir(this.path('items'), { recursive: true });
    await mkdir(this.path('events/bodies'), { recursive: true });
    await mkdir(this.path('index'), { recursive: true });
    await mkdir(this.path('locks'), { recursive: true });
  }

  private async allocateIssueId(): Promise<string> {
    return this.lockManager.withIdLock('allocate issue id', async () => {
      const config = await this.readConfig();
      const nextFromFile = await readFile(this.path('next-id'), 'utf-8')
        .then((raw) => Number.parseInt(raw.trim(), 10))
        .catch(() => config.issue_key.next);
      const next = Number.isInteger(nextFromFile) && nextFromFile > 0 ? nextFromFile : config.issue_key.next;
      const id = `${config.issue_key.prefix}-${String(next).padStart(config.issue_key.padding, '0')}`;
      const updated: LocalIssueConfig = {
        ...config,
        issue_key: { ...config.issue_key, next: next + 1 },
      };
      await atomicWrite(this.path('config.json'), `${JSON.stringify(updated, null, 2)}\n`);
      await atomicWrite(this.path('next-id'), `${next + 1}\n`);
      return id;
    });
  }

  private async readConfigIfExists(): Promise<LocalIssueConfig | null> {
    const raw = await readFile(this.path('config.json'), 'utf-8').catch((error: unknown) => {
      if (isNodeError(error) && error.code === 'ENOENT') return null;
      throw error;
    });
    if (raw === null) return null;
    const config = JSON.parse(raw) as LocalIssueConfig;
    validateConfig(config);
    return config;
  }

  private async readConfig(): Promise<LocalIssueConfig> {
    const config = await this.readConfigIfExists();
    if (!config) throw new LocalIssueProviderError('Local issue system is not initialized. Run aiwg issues init --prefix <PROJECT> to initialize local storage; use the target tracker tools for external issues.');
    return config;
  }

  private async readIndexOrRebuild(): Promise<LocalIssueIndex> {
    const raw = await readFile(this.path('index/issues.index.json'), 'utf-8').catch((error: unknown) => {
      if (isNodeError(error) && error.code === 'ENOENT') return null;
      throw error;
    });
    if (!raw) return this.rebuildIssueIndex();
    return JSON.parse(raw) as LocalIssueIndex;
  }

  private async readIssue(id: string): Promise<LocalIssueRecord> {
    const raw = await readFile(this.itemPath(id), 'utf-8').catch((error: unknown) => {
      if (isNodeError(error) && error.code === 'ENOENT') {
        throw new LocalIssueProviderError(`local issue not found: ${id}`);
      }
      throw error;
    });
    const record = parseIssueMarkdown(raw);
    if (record.fields.id !== id) {
      throw new LocalIssueProviderError(`issue id mismatch: path ${id}, frontmatter ${record.fields.id}`);
    }
    return record;
  }

  private async touchIssueUpdatedAt(id: string, updatedAt: string): Promise<void> {
    const current = await this.readIssue(id);
    const next = {
      fields: { ...current.fields, updated_at: updatedAt },
      body: current.body,
    };
    validateIssueFields(next.fields);
    await atomicWrite(this.itemPath(id), serializeIssueMarkdown(next));
  }

  private async appendEventUnlocked(
    id: string,
    input: Omit<LocalIssueEvent, 'event_id' | 'issue_id' | 'created_at'> & { created_at?: string; body?: string }
  ): Promise<LocalIssueEvent> {
    if (!VALID_EVENT_TYPES.has(input.type)) {
      throw new LocalIssueProviderError(`invalid local issue event type: ${input.type}`);
    }
    const eventId = createEventId();
    const createdAt = input.created_at ?? new Date().toISOString();
    let bodyPath: string | undefined = input.body_path;
    if (input.body !== undefined && input.body.length > 0) {
      bodyPath = `events/bodies/${eventId}.md`;
      await atomicWrite(this.path(bodyPath), input.body);
    }
    const event: LocalIssueEvent = {
      event_id: eventId,
      issue_id: id,
      type: input.type,
      author: requireNonEmpty(input.author, 'event author'),
      created_at: createdAt,
      ...(bodyPath ? { body_path: bodyPath } : {}),
      ...(input.data ? { data: input.data } : {}),
    };
    await appendJsonLineSynced(this.eventPath(id), event);
    return event;
  }

  private async readEvents(id: string, comments: GetLocalIssueOptions['comments']): Promise<LocalIssueEventWithBody[]> {
    const raw = await readFile(this.eventPath(id), 'utf-8').catch((error: unknown) => {
      if (isNodeError(error) && error.code === 'ENOENT') return '';
      throw error;
    });
    const events = raw
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as LocalIssueEvent);
    const selected = selectEvents(events, comments);
    return Promise.all(
      selected.map(async (event) => {
        if (!event.body_path) return event;
        const body = await readFile(this.path(event.body_path), 'utf-8').catch(() => undefined);
        return body === undefined ? event : { ...event, body };
      })
    );
  }

  private itemPath(id: string): string {
    return this.path(`items/${id}.md`);
  }

  private eventPath(id: string): string {
    return this.path(`events/${id}.jsonl`);
  }

  private projectRoot(): string {
    const parent = dirname(this.root);
    return basename(parent) === '.aiwg' ? dirname(parent) : dirname(this.root);
  }

  private path(relPath: string): string {
    const abs = resolve(this.root, relPath);
    if (abs !== this.root && !abs.startsWith(this.root + sep)) {
      throw new LocalIssueProviderError(`local issue path escapes root: ${relPath}`);
    }
    return abs;
  }
}

export function parseIssueMarkdown(content: string): LocalIssueRecord {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    throw new LocalIssueProviderError('local issue markdown must start with YAML frontmatter');
  }
  const fields = parseYaml(match[1]) as LocalIssueFields;
  validateIssueFields(fields);
  return { fields, body: match[2] ?? '' };
}

export function serializeIssueMarkdown(issue: LocalIssueRecord): string {
  validateIssueFields(issue.fields);
  return `---\n${stringifyYaml(issue.fields).trimEnd()}\n---\n${issue.body}`;
}

function validateConfig(config: LocalIssueConfig): void {
  if (config.provider !== 'local') throw new LocalIssueProviderError('local issue config provider must be "local"');
  normalizePrefix(config.issue_key?.prefix);
  if (!Number.isInteger(config.issue_key.padding) || config.issue_key.padding < 1) {
    throw new LocalIssueProviderError('local issue config padding must be a positive integer');
  }
  if (!Number.isInteger(config.issue_key.next) || config.issue_key.next < 1) {
    throw new LocalIssueProviderError('local issue config next must be a positive integer');
  }
}

function validateIssueFields(fields: LocalIssueFields): void {
  normalizeIssueId(fields.id);
  requireNonEmpty(fields.title, 'issue title');
  if (!VALID_STATUSES.has(fields.status)) throw new LocalIssueProviderError(`invalid issue status: ${fields.status}`);
  if (!VALID_TYPES.has(fields.type)) throw new LocalIssueProviderError(`invalid issue type: ${fields.type}`);
  if (!VALID_PRIORITIES.has(fields.priority)) throw new LocalIssueProviderError(`invalid issue priority: ${fields.priority}`);
  fields.labels = normalizeStringArray(fields.labels);
  fields.assignees = normalizeStringArray(fields.assignees);
  requireIsoTimestamp(fields.created_at, 'created_at');
  requireIsoTimestamp(fields.updated_at, 'updated_at');
  if (fields.closed_at !== null) requireIsoTimestamp(fields.closed_at, 'closed_at');
  if (!fields.links || !Array.isArray(fields.links.external) || !Array.isArray(fields.links.children) || !Array.isArray(fields.links.related)) {
    throw new LocalIssueProviderError('issue links must include external, children, and related arrays');
  }
  if (fields.links.parent !== null && typeof fields.links.parent !== 'string') {
    throw new LocalIssueProviderError('issue links.parent must be a string or null');
  }
  if (!fields.source || !fields.source.provider || !('external_id' in fields.source)) {
    throw new LocalIssueProviderError('issue source metadata is required');
  }
}

function matchesFilter(issue: LocalIssueIndexEntry, filter: LocalIssueFilter | undefined): boolean {
  if (!filter) return true;
  if (filter.status && !includesOne(filter.status, issue.status)) return false;
  if (filter.type && !includesOne(filter.type, issue.type)) return false;
  if (filter.priority && !includesOne(filter.priority, issue.priority)) return false;
  if (filter.labels && !filter.labels.every((label) => issue.labels.includes(label))) return false;
  if (filter.assignee && !issue.assignees.includes(filter.assignee)) return false;
  if (filter.search) {
    const haystack = `${issue.id} ${issue.title} ${issue.labels.join(' ')}`.toLowerCase();
    if (!haystack.includes(filter.search.toLowerCase())) return false;
  }
  return true;
}

function includesOne<T>(value: T | T[], candidate: T): boolean {
  return Array.isArray(value) ? value.includes(candidate) : value === candidate;
}

function selectEvents(events: LocalIssueEvent[], comments: GetLocalIssueOptions['comments']): LocalIssueEvent[] {
  if (comments === undefined || comments === 'all') return events;
  const n = typeof comments === 'number' ? comments : Number.parseInt(comments.replace(/^last:/, ''), 10);
  if (!Number.isInteger(n) || n < 0) {
    throw new LocalIssueProviderError(`invalid comments selector: ${comments}`);
  }
  return events.slice(Math.max(0, events.length - n));
}

function normalizePrefix(prefix: string): string {
  const normalized = requireNonEmpty(prefix, 'issue key prefix').toUpperCase();
  if (!/^[A-Z][A-Z0-9]*$/.test(normalized)) {
    throw new LocalIssueProviderError(`invalid issue key prefix: ${prefix}`);
  }
  return normalized;
}

function normalizeIssueId(id: string): string {
  const normalized = requireNonEmpty(id, 'issue id').toUpperCase();
  if (!/^[A-Z][A-Z0-9]*-\d+$/.test(normalized)) {
    throw new LocalIssueProviderError(`invalid local issue id: ${id}`);
  }
  return normalized;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) throw new LocalIssueProviderError('expected string array');
  return value.map((item) => requireNonEmpty(String(item), 'array item'));
}

function requireNonEmpty(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new LocalIssueProviderError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function requireIsoTimestamp(value: string, field: string): void {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new LocalIssueProviderError(`${field} must be an ISO timestamp`);
  }
}

function createEventId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `evt-${Date.now().toString(36)}-${random}`;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temp, content, 'utf-8');
  await rename(temp, path);
}

async function appendJsonLineSynced(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, 'a');
  try {
    await handle.write(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export interface LocalIssuePrefixSuggestion {
  prefix: string;
  source: string;
}

export async function suggestLocalIssuePrefix(projectRoot: string): Promise<LocalIssuePrefixSuggestion | null> {
  const packageJsonPath = join(resolve(projectRoot), 'package.json');
  const rawPackage = await readFile(packageJsonPath, 'utf-8').catch(() => null);
  if (rawPackage) {
    const parsed = JSON.parse(rawPackage) as { name?: string };
    const prefix = prefixFromName(parsed.name);
    if (prefix) return { prefix, source: 'package.json#name' };
  }
  const fromDirectory = prefixFromName(basename(resolve(projectRoot)));
  return fromDirectory ? { prefix: fromDirectory, source: 'directory' } : null;
}

function prefixFromName(name: string | undefined): string | null {
  if (!name) return null;
  const withoutScope = name.includes('/') ? name.split('/').pop() ?? name : name;
  const initials = withoutScope
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join('');
  const candidate = (initials.length >= 2 ? initials : withoutScope).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (!candidate || !/^[A-Z][A-Z0-9]*$/.test(candidate)) return null;
  return candidate.slice(0, 12);
}

export function localIssueRoot(projectRoot: string): string {
  return projectAiwgPath(resolve(projectRoot), 'issues');
}

export function localIssueRelativePath(projectRoot: string, absPath: string): string {
  return relative(resolve(projectRoot), absPath).split(sep).join('/');
}
