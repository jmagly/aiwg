/**
 * Fortemi Storage Adapter
 *
 * Routes storage operations through Fortemi's MCP tool surface. Fortemi
 * is the first-party AIWG semantic-memory project — Rust + PostgreSQL +
 * pgvector + SKOS + W3C PROV — referenced as "Forte" in #934 and
 * confirmed as Fortemi in #961.
 *
 * Tool surface (per `.aiwg/planning/training-framework/phase-4-fortemi-review.md`):
 *   capture_knowledge  - create note (we use this for first writes)
 *   update_note        - revise existing note (we use this for re-writes)
 *   get_note           - retrieve full note (read)
 *   list_notes         - filter/paginate (list)
 *   search             - text/semantic/spatial/temporal search (query)
 *   manage_collection  - organize notes in folders (we use folder=subsystem
 *                        scope to mirror the StorageAdapter contract)
 *
 * Path semantics:
 *   note_id = `${subsystem}:${path}` — the adapter passes the
 *   subsystem-relative path; the registry-supplied `subsystem` is
 *   prepended to keep different subsystems' notes from colliding.
 *
 * Caveats:
 *   - This adapter ships with the parameter shapes documented in the
 *     planning doc, but those shapes have NOT yet been validated against
 *     a live Fortemi instance. Treat this as alpha. The
 *     `McpClientLike.callTool(name, args)` injection point lets tests
 *     stub freely; real-world parameter mismatches surface as MCP
 *     errors that bubble up to the consumer.
 *   - Delete is implemented via `update_note` with `archived: true`
 *     because Fortemi's MCP surface does not document a direct delete
 *     tool (immutability + versioning is core to the design).
 *
 * @design @docs/storage/overview.md
 * @issue #934
 * @issue #961
 * @issue #972
 */

import { createHash } from 'node:crypto';
import { debuglog } from 'node:util';
import { hasSecretLookingLiterals } from '../../mcp/credentials.mjs';
import type { SensitiveInputDependencies } from '../../auth/sensitive-input.js';
import type {
  FortemiBackendConfig,
  StorageAdapter,
  StorageEntry,
  WriteMeta,
} from '../types.js';

/**
 * Minimal MCP client surface this adapter consumes. Tests provide a
 * stub; production wires this to `@modelcontextprotocol/sdk/client/*`
 * via `createDefaultMcpClient(serverName)`.
 */
export interface McpClientLike {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  listTools?(): Promise<{
    tools?: Array<{ name: string; inputSchema?: Record<string, unknown> }>;
  }>;
  serverVersion?(): { name?: string; version?: string } | undefined;
  close?(): Promise<void>;
}

/**
 * Factory that, given a server name, returns a connected MCP client.
 * The default factory uses the SDK's stdio transport and AIWG's MCP
 * registry; tests inject a stub so no subprocess is spawned.
 */
export type McpClientFactory = (serverName: string) => Promise<McpClientLike>;

export interface FortemiAdapterOptions {
  /** Subsystem this adapter is bound to. Used to scope note IDs. */
  subsystem: string;
  /** Backend config from storage.config. */
  config: FortemiBackendConfig;
  /** Optional override for tests. Defaults to the SDK-backed factory. */
  clientFactory?: McpClientFactory;
}

type ToolSchema = { name: string; inputSchema?: Record<string, unknown> };
type FortemiToolProfile = 'legacy-note-id' | 'source-addressed-v1';
const FORTEMI_QUERY_LIMIT = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function schemaProperties(
  tool: ToolSchema | undefined,
): Record<string, unknown> {
  const properties = tool?.inputSchema?.properties;
  return properties && typeof properties === 'object'
    ? (properties as Record<string, unknown>)
    : {};
}

/** Select an argument contract from discovered capabilities, never a version string. */
export function resolveFortemiToolProfile(
  tools: ToolSchema[],
): FortemiToolProfile {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const legacy = schemaProperties(byName.get('get_note'));
  if ('note_id' in legacy) return 'legacy-note-id';
  const currentGet = schemaProperties(byName.get('get_note'));
  const currentUpsert = schemaProperties(byName.get('upsert_external_notes'));
  const currentItems = currentUpsert.items as
    { items?: { properties?: Record<string, unknown> } } | undefined;
  if (
    'id' in currentGet &&
    'source_namespace' in currentUpsert &&
    'items' in currentUpsert &&
    currentItems?.items?.properties &&
    'external_id' in currentItems.items.properties &&
    'content' in currentItems.items.properties &&
    'caller_stable_id' in currentItems.items.properties
  )
    return 'source-addressed-v1';
  throw new Error('storage(fortemi): unsupported live MCP tool contract');
}

/** Stable UUID used as the opaque Fortemi handle for a subsystem/path identity. */
export function fortemiStableNoteId(subsystem: string, path: string): string {
  const bytes = createHash('sha256')
    .update(`aiwg-storage\0${subsystem}\0${path}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const DEFAULT_MCP_SERVER = 'fortemi';
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface RemoteServerDefinition {
  name: string;
  type: 'stdio' | 'http' | 'sse';
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  headerEnv?: Record<string, string>;
  envFrom?: Record<string, string>;
}

export function resolveMcpRequestHeaders(
  server: Pick<RemoteServerDefinition, 'headers' | 'headerEnv'>,
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const headers = { ...(server.headers ?? {}) };
  for (const [header, envName] of Object.entries(server.headerEnv ?? {})) {
    if (!ENV_NAME.test(envName)) {
      throw new Error(
        'storage(fortemi): invalid environment variable reference; use ENV_NAME, file:ABSOLUTE_PATH or store:NAME.',
      );
    }
    const value = environment[envName];
    if (!value) {
      throw new Error(
        `storage(fortemi): required credential environment variable "${envName}" is not set`,
      );
    }
    headers[header] =
      header.toLowerCase() === 'authorization' ? `Bearer ${value}` : value;
  }
  return headers;
}

export function validateRemoteMcpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`storage(fortemi): invalid MCP server URL "${raw}"`);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(
      'storage(fortemi): remote MCP URLs must use HTTPS; HTTP is allowed only for loopback development',
    );
  }
  return url;
}

export function unwrapMcpToolResult(result: unknown): unknown {
  if (!result || typeof result !== 'object') return result;
  const envelope = result as {
    isError?: boolean;
    structuredContent?: unknown;
    content?: Array<{ type?: string; text?: string }>;
  };
  if (envelope.isError) {
    const detail = envelope.content
      ?.filter((item) => item.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text)
      .join('; ');
    if (
      detail &&
      /(?:API error 404|status(?: code)? 404)/i.test(detail) &&
      /(?:Note not found|problems\/not-found)/i.test(detail)
    ) {
      return { not_found: true };
    }
    throw new Error(
      `storage(fortemi): MCP tool failed${detail ? `: ${detail}` : ''}`,
    );
  }
  if (envelope.structuredContent !== undefined)
    return envelope.structuredContent;
  const text = envelope.content?.find(
    (item) => item.type === 'text' && typeof item.text === 'string',
  )?.text;
  if (text === undefined) return result;
  try {
    return JSON.parse(text);
  } catch {
    return { content: text };
  }
}

export class FortemiAdapter implements StorageAdapter {
  private readonly subsystem: string;
  private readonly mcpServer: string;
  private readonly scheme: string | undefined;
  private readonly clientFactory: McpClientFactory;
  private client: McpClientLike | null = null;
  private profile: FortemiToolProfile | null = null;

  constructor(opts: FortemiAdapterOptions) {
    this.subsystem = opts.subsystem;
    this.mcpServer = opts.config.mcpServer ?? DEFAULT_MCP_SERVER;
    this.scheme = opts.config.scheme;
    this.clientFactory = opts.clientFactory ?? createDefaultMcpClient;
  }

  async init(): Promise<void> {
    if (this.client) return;
    this.client = await this.clientFactory(this.mcpServer);
    if (this.client.listTools) {
      const discovered = await this.client.listTools();
      this.profile = resolveFortemiToolProfile(discovered.tools ?? []);
    } else {
      // Preserve injected/older clients which predate tool discovery.
      this.profile = 'legacy-note-id';
    }
  }

  async close(): Promise<void> {
    if (this.client?.close) {
      await this.client.close();
    }
    this.client = null;
    this.profile = null;
  }

  private async getClient(): Promise<McpClientLike> {
    if (!this.client) await this.init();
    if (!this.client) {
      throw new Error(
        `storage(fortemi): MCP client unavailable for server "${this.mcpServer}"`,
      );
    }
    return this.client;
  }

  private noteId(path: string): string {
    if (typeof path !== 'string' || path.length === 0) {
      throw new Error('storage(fortemi): path must be a non-empty string');
    }
    if (path.includes('\0')) {
      throw new Error(
        `storage(fortemi): null bytes not allowed in path "${path}"`,
      );
    }
    return `${this.subsystem}:${path}`;
  }

  async read(path: string): Promise<string | null> {
    const id = this.noteId(path);
    const client = await this.getClient();
    const result = (await client.callTool(
      'get_note',
      this.profile === 'source-addressed-v1'
        ? { id: fortemiStableNoteId(this.subsystem, path) }
        : { note_id: id },
    )) as {
      note?: { content?: string; revised_content?: string };
      original?: { content?: string };
      revised?: { content?: string };
      content?: string;
      revised_content?: string;
      not_found?: boolean;
    } | null;

    if (!result || result.not_found) return null;
    const note = result.note ?? result;
    if (!note) return null;
    return (
      result.revised?.content ??
      result.original?.content ??
      note.revised_content ??
      note.content ??
      null
    );
  }

  async write(path: string, content: string, meta?: WriteMeta): Promise<void> {
    const id = this.noteId(path);
    const client = await this.getClient();

    if (this.profile === 'source-addressed-v1') {
      const digest = createHash('sha256').update(content).digest('hex');
      await client.callTool('upsert_external_notes', {
        source_namespace: `aiwg.storage.${this.subsystem}`,
        source_schema_version: 'aiwg.storage-entry/v1',
        import_run_id: `sha256:${digest}`,
        batch_id: `sha256:${digest}`,
        policy: 'replace',
        items: [
          {
            external_id: path,
            content,
            content_digest: `sha256:${digest}`,
            caller_stable_id: fortemiStableNoteId(this.subsystem, path),
            metadata: { ...this.buildMetadata(meta), aiwg_storage_path: path },
            policy: 'replace',
          },
        ],
      });
      return;
    }

    // Try update first; if not found, capture as new. Two calls in the
    // worst case but idempotent — Fortemi's update_note increments the
    // version rather than overwriting, which matches the Phase-4 design.
    const existing = (await client.callTool('get_note', { note_id: id })) as {
      note?: unknown;
      not_found?: boolean;
    } | null;

    if (existing && !existing.not_found && existing.note) {
      await client.callTool('update_note', {
        note_id: id,
        content,
        metadata: this.buildMetadata(meta),
      });
    } else {
      await client.callTool('capture_knowledge', {
        note_id: id,
        content,
        scheme: this.scheme,
        metadata: this.buildMetadata(meta),
      });
    }
  }

  async list(prefix: string): Promise<StorageEntry[]> {
    if (typeof prefix !== 'string') {
      throw new Error('storage(fortemi): list prefix must be a string');
    }
    const client = await this.getClient();
    const subsystemPrefix = `${this.subsystem}:`;
    const fullPrefix =
      prefix.length === 0 ? subsystemPrefix : `${subsystemPrefix}${prefix}`;

    const result = (await client.callTool('list_notes', {
      ...(this.profile === 'source-addressed-v1'
        ? { limit: 500, offset: 0 }
        : { id_prefix: fullPrefix, scheme: this.scheme }),
    })) as {
      notes?: Array<{ note_id: string; size?: number; updated_at?: string }>;
    } | null;

    const notes = result?.notes ?? [];
    return notes
      .map((n) => {
        const current = n as typeof n & {
          id?: string;
          metadata?: { aiwg_storage_path?: string; subsystem?: string };
        };
        const path = current.metadata?.aiwg_storage_path;
        return typeof path === 'string' &&
          current.metadata?.subsystem === this.subsystem
          ? {
              ...n,
              note_id: `${subsystemPrefix}${path}`,
              external_id: current.id,
            }
          : n;
      })
      .filter(
        (n) =>
          typeof n.note_id === 'string' && n.note_id.startsWith(fullPrefix),
      )
      .map((n) => {
        const entry: StorageEntry = {
          path: n.note_id.slice(subsystemPrefix.length),
          externalId:
            (n as typeof n & { external_id?: string }).external_id ?? n.note_id,
        };
        if (typeof n.size === 'number') entry.size = n.size;
        if (typeof n.updated_at === 'string') {
          const d = new Date(n.updated_at);
          if (!Number.isNaN(d.getTime())) entry.modifiedAt = d;
        }
        return entry;
      });
  }

  async delete(path: string): Promise<void> {
    // Fortemi's MCP surface does not document a destructive delete —
    // immutability + versioning is core to the design. We mark the note
    // archived via update_note instead. This matches the storage-design
    // contract (delete is "no-op when missing"; here we just suppress
    // the note from list/read by archiving it).
    const id = this.noteId(path);
    const client = await this.getClient();
    const identityArgs =
      this.profile === 'source-addressed-v1'
        ? { id: fortemiStableNoteId(this.subsystem, path) }
        : { note_id: id };
    const existing = (await client.callTool('get_note', identityArgs)) as {
      note?: unknown;
      not_found?: boolean;
    } | null;
    if (
      !existing ||
      existing.not_found ||
      (this.profile !== 'source-addressed-v1' && !existing.note)
    )
      return;
    await client.callTool('update_note', {
      ...identityArgs,
      archived: true,
    });
  }

  async query(q: string): Promise<StorageEntry[]> {
    const client = await this.getClient();
    const subsystemPrefix = `${this.subsystem}:`;
    const result = (await client.callTool('search', {
      ...(this.profile === 'source-addressed-v1'
        ? { action: 'text', query: q, limit: FORTEMI_QUERY_LIMIT }
        : { query: q, id_prefix: subsystemPrefix, scheme: this.scheme }),
    })) as {
      results?: Array<{
        note_id?: string;
        id?: string;
        score?: number;
        metadata?: { aiwg_storage_path?: string; subsystem?: string };
      }>;
    } | null;

    const results = result?.results ?? [];
    const hydrated = [] as typeof results;
    for (const resultItem of results.slice(0, FORTEMI_QUERY_LIMIT)) {
      let item = resultItem;
      if (
        this.profile === 'source-addressed-v1' &&
        typeof item.id === 'string' &&
        UUID.test(item.id) &&
        (!item.metadata || typeof item.metadata.aiwg_storage_path !== 'string')
      ) {
        const detail = (await client.callTool('get_note', { id: item.id })) as {
          note?: { id?: string; metadata?: { aiwg_storage_path?: string; subsystem?: string } };
          not_found?: boolean;
        } | null;
        if (!detail || detail.not_found) continue;
        const note = detail.note;
        if (!note || note.id !== item.id) continue;
        item = { ...item, metadata: note.metadata };
      }
      hydrated.push(item);
    }
    return hydrated
      .map((r) => {
        const path = r.metadata?.aiwg_storage_path;
        return typeof path === 'string' &&
          r.metadata?.subsystem === this.subsystem
          ? { ...r, note_id: `${subsystemPrefix}${path}` }
          : r;
      })
      .filter(
        (r) =>
          typeof r.note_id === 'string' &&
          r.note_id.startsWith(subsystemPrefix),
      )
      .map((r) => ({
        path: r.note_id!.slice(subsystemPrefix.length),
        externalId: r.id ?? r.note_id,
      }));
  }

  private buildMetadata(meta: WriteMeta | undefined): Record<string, unknown> {
    const out: Record<string, unknown> = {
      subsystem: this.subsystem,
      source: 'aiwg-storage-adapter',
    };
    if (meta?.contentType) out['content_type'] = meta.contentType;
    if (meta?.frontmatter) out['frontmatter'] = meta.frontmatter;
    if (this.scheme) out['scheme'] = this.scheme;
    return out;
  }
}

/**
 * Default MCP client factory. Resolves the server config from AIWG's
 * McpServerRegistry, spawns the stdio transport, and returns a
 * connected client.
 *
 * Implemented as a lazy import so tests that inject a stub never load
 * the SDK or touch the registry.
 */
export const createDefaultMcpClient = async (
  serverName: string,
  registryOverride?: {
    get(name: string): Promise<RemoteServerDefinition | undefined>;
  },
  environment: NodeJS.ProcessEnv = process.env,
  sensitiveInput: SensitiveInputDependencies = {},
): Promise<McpClientLike> => {
  const { McpServerRegistry, resolveMcpCredentialMaps } = await import('../../mcp/registry.js');
  const registry = registryOverride ?? new McpServerRegistry();
  const server = await registry.get(serverName);
  if (!server) {
    throw new Error(
      `storage(fortemi): MCP server "${serverName}" is not registered. ` +
        `Add it via "aiwg mcp add ${serverName} --command <cmd>" before using the fortemi backend.`,
    );
  }
  // Lazy imports keep unit tests that inject a stub isolated from transports.
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const hasCredentials = [server.env, server.headers, server.envFrom, server.headerEnv]
    .some(map => Object.keys(map ?? {}).length > 0);
  if (hasCredentials && server.type === 'stdio' && debuglog('child_process').enabled) {
    throw new Error('MCP stdio credentials require NODE_DEBUG child_process logging to be disabled.');
  }
  // Reuse the registry resolver for file/store references. Preserve legacy env
  // bytes and Authorization's existing Bearer prefix at the transport boundary.
  const hasNewReferences = [...Object.values(server.headerEnv ?? {}), ...Object.values(server.envFrom ?? {})]
    .some(reference => /^(?:file|store):/.test(reference));
  const resolved = hasNewReferences
    ? await resolveMcpCredentialMaps(server, { ...sensitiveInput, environment })
    : { env: server.env ? { ...server.env } : undefined, headers: resolveMcpRequestHeaders(server, environment) };
  if (!hasNewReferences) {
    for (const [key, name] of Object.entries(server.envFrom ?? {})) {
      if (!ENV_NAME.test(name) || !environment[name]) {
        throw new Error('storage(fortemi): envFrom requires a set ENV_NAME, file:ABSOLUTE_PATH or store:NAME.');
      }
      resolved.env = { ...resolved.env, [key]: environment[name]! };
    }
  }
  const secrets = [
    ...Object.entries(resolved.env ?? {}).filter(([key, value]) =>
      key in (server.envFrom ?? {}) || hasSecretLookingLiterals({ name: server.name, env: { [key]: value } })).map(([, value]) => value),
    ...Object.values(resolved.headers ?? {}),
    ...Object.values(resolved.headers ?? {}).map(value => value.replace(/^Bearer /i, '')),
  ].filter(Boolean).sort((a, b) => b.length - a.length);
  const redact = (text: string): string => secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), text);
  const protect = async <T>(operation: () => Promise<T>): Promise<T> => {
    try { return await operation(); }
    catch (error) { throw new Error(redact(error instanceof Error ? error.message : 'MCP transport failed')); }
  };
  const protectResult = <T>(value: T): T => {
    if (typeof value === 'string') return redact(value) as T;
    if (Array.isArray(value)) return value.map(protectResult) as T;
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, value]) => [redact(key), protectResult(value)])) as T;
    return value;
  };
  try {
    let transport;
    if (server.type === 'stdio') {
      const { StdioClientTransport } =
        await import('@modelcontextprotocol/sdk/client/stdio.js');
      transport = new StdioClientTransport({
        command: server.command ?? '',
        args: server.args ?? [],
        env: resolved.env,
        ...(hasCredentials ? { stderr: 'pipe' as const } : {}),
      });
    } else {
      if (!server.url) {
        throw new Error(
          `storage(fortemi): MCP server "${serverName}" has no URL`,
        );
      }
      const url = validateRemoteMcpUrl(server.url);
      const headers = resolved.headers ?? {};
      if (hasNewReferences) {
        for (const header of Object.keys(server.headerEnv ?? {})) {
          if (header.toLowerCase() === 'authorization') headers[header] = `Bearer ${headers[header]}`;
        }
      }
      if (server.type === 'http') {
        const { StreamableHTTPClientTransport } =
          await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
        transport = new StreamableHTTPClientTransport(url, {
          requestInit: { headers },
        });
      } else if (server.type === 'sse') {
        const { SSEClientTransport } =
          await import('@modelcontextprotocol/sdk/client/sse.js');
        transport = new SSEClientTransport(url, {
          requestInit: { headers },
          eventSourceInit: {
            fetch: async (input, init) => {
              const merged = new Headers(init?.headers);
              for (const [name, value] of Object.entries(headers))
                merged.set(name, value);
              return fetch(input, { ...init, headers: merged });
            },
          },
        });
      } else {
        throw new Error(
          `storage(fortemi): unsupported MCP transport "${String(server.type)}"`,
        );
      }
    }
    const client = new Client(
      { name: 'aiwg-storage-fortemi-adapter', version: '1.0.0' },
      { capabilities: {} },
    );
    if (hasCredentials && server.type === 'stdio') {
      // The recipient's stderr can contain credentials. Drain without forwarding.
      (transport as import('@modelcontextprotocol/sdk/client/stdio.js').StdioClientTransport).stderr?.on('data', () => {});
    }
    await protect(() => client.connect(transport));

    return {
      async callTool(name, args) {
        const call = async () => unwrapMcpToolResult(await client.callTool({ name, arguments: args }));
        return protectResult(await protect(call));
      },
      async listTools() {
        return protectResult(await protect(() => client.listTools()));
      },
      serverVersion() {
        return protectResult(client.getServerVersion());
      },
      async close() {
        await protect(() => client.close());
      },
    };
  } catch (error) {
    throw new Error(redact(error instanceof Error ? error.message : 'MCP transport failed'));
  }
};
