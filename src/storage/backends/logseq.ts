/**
 * Logseq Storage Adapter
 *
 * Writes and reads markdown files in a Logseq graph on disk. Like the
 * Obsidian adapter, this is filesystem-shaped — Logseq graphs are
 * directories of `.md` (or `.org`) files plus a `logseq/` config dir
 * we never touch.
 *
 * About the Logseq HTTP API: as of April 2025 the DB-backed Logseq
 * rewrite is still in development; file-backed graphs remain primary.
 * Logseq exposes an HTTP API at `http://127.0.0.1:12315/api` (with a
 * bearer token issued from Settings → Features → Developer mode), but
 * verifying its exact command surface requires hands-on Logseq access.
 *
 * What this adapter does:
 *   - Reads / writes / lists / deletes markdown files via fs
 *   - Optional HTTP API reachability probe (when `useApi: true`) —
 *     emits a one-time stderr warning if `LOGSEQ_API_TOKEN` is unset or
 *     the API is unreachable
 *   - Refuses paths into the graph's `logseq/` config directory
 *   - Transforms `WriteMeta.frontmatter` from YAML into Logseq's
 *     page-level `property:: value` syntax
 *   - Never writes block IDs (`id::`) — Logseq auto-assigns them
 *
 * Path layout (mirrors Logseq's on-disk conventions):
 *   pages/<title>.md          regular pages
 *   journals/YYYY_MM_DD.md    journal entries
 *   logseq/*                  REFUSED (Logseq config)
 *
 * @design @docs/storage/overview.md
 * @issue #934
 * @issue #958
 */

import { existsSync } from 'fs';
import { resolveSensitiveInput, type SensitiveInputDependencies } from '../../auth/sensitive-input.js';
import { credentialReferenceInput } from '../../mcp/credentials.mjs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'fs/promises';
import { dirname, join, relative, resolve, sep } from 'path';
import type { LogseqBackendConfig, StorageAdapter, StorageEntry, WriteMeta } from '../types.js';

const LOGSEQ_CONFIG_DIR = 'logseq';
const DEFAULT_API_URL = 'http://127.0.0.1:12315/api';

export class LogseqAdapter implements StorageAdapter {
  /** Absolute path to the Logseq graph root. */
  private readonly graph: string;
  private readonly apiUrl: string;
  private readonly useApi: boolean;
  private readonly apiTokenEnv?: string;
  private apiWarned = false;

  constructor(config: LogseqBackendConfig, private readonly sensitiveInput: SensitiveInputDependencies = {}) {
    this.graph = resolve(expandHome(config.graph));
    this.apiUrl = config.apiUrl ?? DEFAULT_API_URL;
    this.useApi = config.useApi ?? true;
    this.apiTokenEnv = config.apiTokenEnv;
  }

  async init(): Promise<void> {
    if (!existsSync(this.graph)) {
      throw new Error(`storage(logseq): graph does not exist: ${this.graph}`);
    }
    if (this.useApi) await this.probeApi();
  }

  /**
   * One-shot API reachability probe. Warns once on missing token or
   * unreachable endpoint. Direct fs writes still work without it.
   */
  private async probeApi(): Promise<void> {
    if (this.apiWarned) return;

    const input = credentialReferenceInput(this.apiTokenEnv ?? 'LOGSEQ_API_TOKEN', 'Logseq apiTokenEnv');
    // Keep the optional legacy environment path, including its missing-token warning.
    const token = input.env
      ? (this.sensitiveInput.environment ?? process.env)[input.env]
      : await resolveSensitiveInput(input, this.sensitiveInput);
    if (!token && this.apiTokenEnv !== undefined) {
      throw new Error('storage(logseq): apiTokenEnv is not set; use ENV_NAME, file:ABSOLUTE_PATH or store:NAME.');
    }
    if (!token) {
      this.apiWarned = true;
      process.stderr.write(
        `storage(logseq): API requested (useApi: true) but LOGSEQ_API_TOKEN is not set.\n` +
          `  AIWG will continue with direct file writes against the graph.\n` +
          `  Set LOGSEQ_API_TOKEN (Settings → Features → Developer mode) or set "useApi": false to suppress.\n`
      );
      return;
    }

    try {
      // Lightweight reachability probe — most Logseq API servers respond
      // to a simple POST. We don't synthesize a specific command; just
      // confirm the endpoint is reachable.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      try {
        await fetch(this.apiUrl, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ method: 'logseq.App.getCurrentGraph' }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch {
      this.apiWarned = true;
      process.stderr.write(
        `storage(logseq): API server is not reachable.\n` +
          `  AIWG will continue with direct file writes against the graph.\n` +
          `  Start Logseq with the API server enabled, or set "useApi": false to suppress.\n`
      );
    }
  }

  /**
   * Validate a subsystem-relative path. Rejects traversal, absolute
   * paths, backslashes, and any path inside the graph's `logseq/` dir.
   */
  private resolveSafe(relPath: string): string {
    if (typeof relPath !== 'string' || relPath.length === 0) {
      throw new Error('storage(logseq): path must be a non-empty string');
    }
    if (relPath.includes('\\')) {
      throw new Error(`storage(logseq): backslash not allowed in path "${relPath}"`);
    }
    if (relPath.startsWith('/') || relPath.startsWith('~')) {
      throw new Error(`storage(logseq): absolute paths not allowed: "${relPath}"`);
    }
    const segments = relPath.split('/');
    if (segments.some((s) => s === '..')) {
      throw new Error(`storage(logseq): ".." traversal not allowed in "${relPath}"`);
    }

    const abs = resolve(this.graph, relPath);

    if (abs !== this.graph && !abs.startsWith(this.graph + sep)) {
      throw new Error(`storage(logseq): resolved path escapes graph root: "${relPath}"`);
    }
    const relFromGraph = relative(this.graph, abs);
    if (
      relFromGraph === LOGSEQ_CONFIG_DIR ||
      relFromGraph.startsWith(LOGSEQ_CONFIG_DIR + sep)
    ) {
      throw new Error(
        `storage(logseq): refusing to operate on logseq/ graph config (${relPath})`
      );
    }
    return abs;
  }

  async read(path: string): Promise<string | null> {
    const abs = this.resolveSafe(path);
    if (!existsSync(abs)) return null;
    return readFile(abs, 'utf-8');
  }

  async write(path: string, content: string, meta?: WriteMeta): Promise<void> {
    const abs = this.resolveSafe(path);
    await mkdir(dirname(abs), { recursive: true });

    let body = content;

    // Strip YAML frontmatter from the content (if any) — Logseq doesn't
    // recognize it. Move what we can to page-level properties.
    const yaml = extractYamlFrontmatter(body);
    if (yaml) {
      body = yaml.body;
    }

    // Merge supplied frontmatter + extracted YAML into Logseq page-properties
    const merged: Record<string, unknown> = { ...(yaml?.fields ?? {}), ...(meta?.frontmatter ?? {}) };
    if (Object.keys(merged).length > 0) {
      body = renderPageProperties(merged) + body;
    }

    // Defensive: refuse to write `id::` block IDs ourselves. Logseq
    // auto-assigns them; if the caller smuggled one in, strip it.
    body = stripBlockIds(body);

    await writeFile(abs, body, 'utf-8');
  }

  async list(prefix: string): Promise<StorageEntry[]> {
    if (typeof prefix !== 'string') {
      throw new Error('storage(logseq): list prefix must be a string');
    }
    if (prefix.length > 0) this.resolveSafe(prefix);
    if (!existsSync(this.graph)) return [];

    const out: StorageEntry[] = [];
    await walkInto(this.graph, this.graph, prefix, out);
    return out;
  }

  async delete(path: string): Promise<void> {
    const abs = this.resolveSafe(path);
    if (!existsSync(abs)) return;
    await rm(abs, { force: true });
  }
}

async function walkInto(
  root: string,
  dir: string,
  prefix: string,
  out: StorageEntry[]
): Promise<void> {
  let entries: import('fs').Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const e of entries) {
    // Skip the graph config directory at the root level
    if (e.name === LOGSEQ_CONFIG_DIR && dir === root) continue;

    const full = join(dir, e.name);
    const rel = relative(root, full).split(sep).join('/');

    if (e.isDirectory()) {
      if (prefix === '' || rel.startsWith(prefix) || prefix.startsWith(rel + '/')) {
        await walkInto(root, full, prefix, out);
      }
      continue;
    }
    if (!e.isFile()) continue;
    if (prefix !== '' && !rel.startsWith(prefix)) continue;

    let size: number | undefined;
    let modifiedAt: Date | undefined;
    try {
      const s = await stat(full);
      size = s.size;
      modifiedAt = s.mtime;
    } catch {
      // ignore
    }
    const entry: StorageEntry = { path: rel };
    if (size !== undefined) entry.size = size;
    if (modifiedAt !== undefined) entry.modifiedAt = modifiedAt;
    out.push(entry);
  }
}

function expandHome(p: string): string {
  if (p.startsWith('~/')) {
    const { homedir } = require('os') as typeof import('os');
    return join(homedir(), p.slice(2));
  }
  if (p === '~') {
    const { homedir } = require('os') as typeof import('os');
    return homedir();
  }
  return p;
}

interface ExtractedYaml {
  fields: Record<string, unknown>;
  body: string;
}

function stripBlockIds(content: string): string {
  const chunks: string[] = [];
  let start = 0;
  while (start < content.length) {
    let property = start;
    while (property < content.length && /\s/u.test(content[property])) property++;
    if (content.startsWith('id::', property)) {
      // Only the property's own line belongs to the block ID.
      let end = property + 4;
      while (end < content.length && !/[\n\r\u2028\u2029]/u.test(content[end])) end++;
      if (content[end] === '\r' && content[end + 1] === '\n') end++;
      start = end < content.length ? end + 1 : content.length;
      continue;
    }
    // Keep the original line and any preceding blank lines verbatim.
    let end = property;
    while (end < content.length && !/[\n\r\u2028\u2029]/u.test(content[end])) end++;
    if (end < content.length) end++;
    chunks.push(content.slice(start, end));
    start = end;
  }
  return chunks.join('');
}

/**
 * If `content` starts with a `---` YAML block, parse the block and
 * return the parsed fields plus the body without the YAML. Otherwise
 * return null.
 *
 * Minimal parser — handles `key: value` and `key: [a, b, c]` lines.
 * Anything more complex falls back to dropping the value as a string.
 */
function extractYamlFrontmatter(content: string): ExtractedYaml | null {
  if (!content.startsWith('---')) return null;
  let openingEnd = 3;
  let firstNewline = -1;
  let lastNewline = -1;
  while (openingEnd < content.length && /\s/u.test(content[openingEnd])) {
    if (content[openingEnd] === '\n') {
      if (firstNewline < 0) firstNewline = openingEnd;
      lastNewline = openingEnd;
    }
    openingEnd++;
  }
  if (firstNewline < 0) return null;
  let yamlStart = lastNewline + 1;
  let closing = content.indexOf('\n---', yamlStart);
  if (closing < 0) {
    closing = content.indexOf('\n---', firstNewline + 1);
    if (closing < 0) return null;
    yamlStart = firstNewline + 1;
    for (let index = yamlStart; index < closing; index++) {
      if (content[index] === '\n') yamlStart = index + 1;
    }
  }
  const yamlBody = content.slice(yamlStart, content[closing - 1] === '\r' ? closing - 1 : closing);
  let bodyStart = closing + 4;
  while (bodyStart < content.length && /\s/u.test(content[bodyStart])) bodyStart++;
  const body = content.slice(bodyStart);
  const fields: Record<string, unknown> = {};
  for (const line of yamlBody.split(/\r?\n/)) {
    if (line.trim().length === 0 || line.trim().startsWith('#')) continue;
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const k = line.slice(0, separator).trimEnd();
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(k)) continue;
    const rawV = line.slice(separator + 1).trimStart();
    if (/[\r\u2028\u2029]/u.test(rawV)) continue;
    fields[k] = parseYamlScalar(rawV.trim());
  }
  return { fields, body };
}

function parseYamlScalar(raw: string): unknown {
  if (raw === '') return '';
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null' || raw === '~') return null;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (/^-?\d+\.\d+$/.test(raw)) return Number(raw);
  // Quoted string
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    try {
      return JSON.parse(raw.replace(/^'/, '"').replace(/'$/, '"'));
    } catch {
      return raw.slice(1, -1);
    }
  }
  // Inline array
  if (raw.startsWith('[') && raw.endsWith(']')) {
    return raw
      .slice(1, -1)
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map(parseYamlScalar);
  }
  return raw;
}

/**
 * Render a flat object as Logseq page-level properties:
 *
 *   tags:: ai, note
 *   created:: 2026-04-28
 *
 *   <body follows here>
 */
function renderPageProperties(fields: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    lines.push(`${k}:: ${formatLogseqValue(v)}`);
  }
  lines.push('');
  return lines.join('\n');
}

function formatLogseqValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.map((x) => formatLogseqValue(x)).join(', ');
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}
