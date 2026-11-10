// Bounded native projection pinned to the captured Grok Build 1.0.77 store.
import { lstat, opendir, readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, parse, resolve } from 'node:path';
import { z } from 'zod';
import { number } from '../../schema/zod-validation.mjs';
import {
  schemaIssueDetail,
  schemaRejectionDetail,
  SessionContractError,
  assertSupportedSchemaMajor,
  type SelectedSource,
  type SourceDescriptor,
} from '../contracts.js';
import { matchSessionWorkspace, type WorkspaceMatchKind } from '../workspace-matching.js';
import { authorizeSourceFile } from '../policy.js';
import {
  streamBoundedJsonLines,
  type BoundedJsonRecord,
  readBoundedText,
  type ReaderLimits,
} from '../readers.js';

import { nativeDrift, parseNativeSummary, projectNativeLine, nativeProjectionRecord, type NativeProjection } from './grok-build-native-records.js';

export const GROK_BUILD_NATIVE_SCHEMA_VERSION = '1.0.0';
export const GROK_BUILD_NATIVE_SCHEMA_MAJOR = 1;
export const GROK_BUILD_NATIVE_LOCATOR_CLASS = 'grok-build-native-chat-history';
export const GROK_BUILD_NATIVE_SESSION_FILENAME = 'chat_history.jsonl';
export const GROK_BUILD_ACTIVE_SESSIONS_SCHEMA_VERSION = 1;
export const GROK_BUILD_ACTIVE_FRESHNESS_MS = 120_000;
export const GROK_BUILD_NATIVE_DISCOVERY_MAX_FILES = 10_000;
const ACTIVE_SESSIONS_MAX_BYTES = 1024 * 1024;

export function grokBuildNativeEnabled(): boolean {
  return process.env.AIWG_GROK_BUILD_NATIVE_EXPERIMENTAL === '1'
    && process.env.AIWG_GROK_BUILD_NATIVE_VERSION === '1.0.77';
}

/** One availability message for native readers, discovery and CLI capability reports. */
export function grokBuildNativeAvailability() {
  const enabled = grokBuildNativeEnabled();
  return {
    reasonCode: enabled ? 'GROK_BUILD_NATIVE_EXPERIMENTAL_ENABLED' : 'GROK_BUILD_NATIVE_EXPERIMENTAL_DISABLED',
    remediation: `Grok Build native ingestion is experimental and ${enabled ? 'enabled for the captured subset; other scenarios remain' : 'disabled and'} unqualified. `
      + 'AIWG_GROK_BUILD_NATIVE_EXPERIMENTAL=1 and AIWG_GROK_BUILD_NATIVE_VERSION=1.0.77 are both required; '
      + 'only exact 1.0.77 text/tool records with chat_format_version 1 are supported. '
      + 'Authorize the sessions root separately with --grok-root. '
      + 'Unknown versions or schemas must fall back to `grok export <session-id> <session-id>.md` and import the authorized Markdown file.',
  };
}

export function assertGrokBuildNativeEnabled(): void {
  if (!grokBuildNativeEnabled()) {
    throw new SessionContractError('UNSUPPORTED_OPERATION', grokBuildNativeAvailability().remediation);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ActiveSessionsSchema = z.looseObject({
  schemaVersion: z.union([z.string(), z.number()]),
  sessions: z.array(z.looseObject({
    sessionId: z.string().regex(UUID),
    cwd: z.string().optional(),
    lastHeartbeatAt: number().optional(),
  })),
});

export type GrokBuildActiveRegistry = z.infer<typeof ActiveSessionsSchema>;

export interface GrokBuildLiveEvidence {
  state: 'active' | 'unknown';
  basis: 'grok-active-sessions' | 'none';
  reasonCode: string;
}

/** Decode a url-encoded cwd directory name exactly once; null means skip. */
export function decodeGrokBuildWorkspaceDir(name: string): string | null {
  if (!name || name.includes('/') || name.includes('\\')) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    return null;
  }
  if (!decoded.startsWith('/') || decoded.includes('\0')) return null;
  return decoded;
}

export function grokBuildNativeSessionId(locator: string): string | null {
  const sessionId = dirname(locator).split('/').pop()?.split('\\').pop() ?? '';
  return UUID.test(sessionId) ? sessionId.toLowerCase() : null;
}

/** Enumerate documented `<root>/<url-encoded cwd>/<id>/chat_history.jsonl` paths. */
export async function* discoverGrokBuildNativeChatHistories(
  root: string,
  maxFiles = GROK_BUILD_NATIVE_DISCOVERY_MAX_FILES,
): AsyncGenerator<SourceDescriptor> {
  assertGrokBuildNativeEnabled();
  await assertSafeNativeRoot(root);
  const resolved = resolve(root);
  let workspaces;
  try {
    workspaces = await opendir(resolved);
  } catch {
    return;
  }
  let count = 0;
  for await (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    const decoded = decodeGrokBuildWorkspaceDir(workspace.name);
    if (!decoded) continue;
    const workspacePath = resolve(resolved, workspace.name);
    if (workspacePath !== resolved && !workspacePath.startsWith(`${resolved}/`)) continue;
    let sessions;
    try {
      sessions = await opendir(workspacePath);
    } catch {
      continue;
    }
    for await (const session of sessions) {
      if (!session.isDirectory() || !UUID.test(session.name)) continue;
      const sessionPath = resolve(workspacePath, session.name);
      if (!sessionPath.startsWith(`${workspacePath}/`)) continue;
      let entries;
      try {
        entries = await opendir(sessionPath);
      } catch {
        continue;
      }
      for await (const entry of entries) {
        if (!entry.isFile() || entry.name !== GROK_BUILD_NATIVE_SESSION_FILENAME) continue;
        if (++count > maxFiles) {
          throw new SessionContractError(
            'RESOURCE_LIMIT_EXCEEDED',
            'Grok Build native session discovery exceeded the authorized file limit',
            { limit: 'maxFiles', configured: maxFiles, observed: count },
          );
        }
        yield {
          provider: 'grok-build',
          locator: resolve(sessionPath, entry.name),
          locatorClass: GROK_BUILD_NATIVE_LOCATOR_CLASS,
          nativeSessionId: session.name.toLowerCase(),
        };
      }
    }
  }
}

/** Match a native locator against the authorized workspace via its cwd directory. */
export async function grokBuildSourceWorkspaceMatch(
  locator: string,
  workspacePath: string,
): Promise<WorkspaceMatchKind | null> {
  const segments = locator.replace(/\\/g, '/').split('/');
  const encoded = segments.at(-3);
  if (!encoded) return null;
  const decoded = decodeGrokBuildWorkspaceDir(encoded);
  if (!decoded) return null;
  return matchSessionWorkspace(decoded, workspacePath);
}

export async function readGrokBuildNativeChatHistory(
  source: SelectedSource,
  limits?: Partial<ReaderLimits>,
): Promise<{ records: Array<{ record: NativeProjection; line: BoundedJsonRecord }>; incompleteTail: boolean }> {
  assertGrokBuildNativeEnabled();
  const { sessionId, cwd } = await authorizeGrokBuildNativeSource(source);
  try { await rejectNativeSymlinks(resolve(dirname(source.locator), 'summary.json')); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') nativeDrift();
    throw error;
  }
  const summary = await readBoundedText({
    selectedPath: resolve(dirname(source.locator), 'summary.json'), allowedRoots: source.authorizedScope.allowedRoots,
  }, limits);
  let metadata: unknown;
  try { metadata = JSON.parse(summary.value); } catch { nativeDrift(); }
  const sessionMetadata = parseNativeSummary(metadata, sessionId, cwd);
  const input = await streamBoundedJsonLines({ selectedPath: source.locator, allowedRoots: source.authorizedScope.allowedRoots }, { consistency: 'complete', limits });
  const records: Array<{ record: NativeProjection; line: BoundedJsonRecord }> = [];
  const calls = new Set<string>();
  const results = new Set<string>();
  let promptIndex = -1;
  for await (const line of input) {
    const projected = projectNativeLine(line, cwd, sessionMetadata);
    const raw = line.value as { prompt_index?: number };
    if (raw.prompt_index !== undefined) {
      if (raw.prompt_index <= promptIndex) nativeDrift();
      promptIndex = raw.prompt_index;
    }
    for (const entry of projected) {
      const { kind, toolCallId } = entry.record;
      if (kind === 'tool-call' && toolCallId) {
        if (calls.has(toolCallId)) nativeDrift();
        calls.add(toolCallId);
      }
      if (kind === 'tool-result' && toolCallId) {
        if (!calls.has(toolCallId) || results.has(toolCallId)) nativeDrift();
        results.add(toolCallId);
      }
      records.push(entry);
    }
  }
  if (records.length === 0) throw new SessionContractError('MALFORMED_SOURCE', 'Grok Build native chat history is empty; use `grok export <session-id> <session-id>.md`.');
  return { records, incompleteTail: input.incompleteTail };
}

/** Authorize native identity/path before a caller may use the CLI fallback. */
export async function authorizeGrokBuildNativeSource(source: SelectedSource): Promise<{ sessionId: string; cwd: string }> {
  const sessionId = grokBuildNativeSessionId(source.locator);
  if (source.locatorClass !== GROK_BUILD_NATIVE_LOCATOR_CLASS || !sessionId
    || basename(source.locator) !== GROK_BUILD_NATIVE_SESSION_FILENAME) {
    throw new SessionContractError('SOURCE_NOT_AUTHORIZED', 'Grok Build native source must be an explicitly authorized chat_history.jsonl path');
  }
  await authorizeSourceFile({ selectedPath: source.locator, allowedRoots: source.authorizedScope.allowedRoots });
  for (const root of source.authorizedScope.allowedRoots) await assertSafeNativeRoot(root);
  await rejectNativeSymlinks(source.locator);
  const cwd = decodeGrokBuildWorkspaceDir(dirname(dirname(source.locator)).split('/').pop() ?? '');
  if (!cwd) nativeDrift();
  return { sessionId, cwd };
}

export const toGrokBuildNativeRecord = nativeProjectionRecord;

async function rejectNativeSymlinks(input: string): Promise<void> {
  let current = resolve(input);
  while (current !== parse(current).root) {
    if ((await lstat(current)).isSymbolicLink()) throw new SessionContractError('SOURCE_SYMLINK', 'Grok Build native paths cannot contain symlinks');
    current = dirname(current);
  }
}
async function assertSafeNativeRoot(root: string): Promise<void> {
  if (!isAbsolute(root) || resolve(root) === parse(resolve(root)).root) throw new SessionContractError('SOURCE_NOT_AUTHORIZED', 'Grok Build sessions root must be an absolute non-root directory');
  await rejectNativeSymlinks(root);
  if (!(await lstat(root)).isDirectory()) throw new SessionContractError('SOURCE_NOT_AUTHORIZED', 'Grok Build sessions root must be a directory');
}

/** Read and validate active_sessions.json (read-only, bounded); throws on misuse. */
export async function readGrokBuildActiveRegistry(
  selectedPath: string,
  allowedRoots: string[],
): Promise<GrokBuildActiveRegistry> {
  assertGrokBuildNativeEnabled();
  const authorized = await authorizeSourceFile({
    selectedPath, allowedRoots, maxBytes: ACTIVE_SESSIONS_MAX_BYTES,
  });
  const raw = await readFile(authorized.canonicalPath, 'utf8');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new SessionContractError(
      'SCHEMA_DRIFT',
      'Grok Build active_sessions.json is not valid JSON',
      schemaIssueDetail('<root>'),
    );
  }
  const parsed = ActiveSessionsSchema.safeParse(value);
  if (!parsed.success) {
    throw new SessionContractError(
      'SCHEMA_DRIFT',
      'unrecognized Grok Build active_sessions.json shape',
      schemaRejectionDetail(parsed.error),
    );
  }
  assertSupportedSchemaMajor(
    declaredSchema(parsed.data.schemaVersion), GROK_BUILD_ACTIVE_SESSIONS_SCHEMA_VERSION,
  );
  return parsed.data;
}

/** Provider-reported activity only; never a verified running process. */
export function grokBuildLiveState(
  registry: GrokBuildActiveRegistry | null,
  sessionId: string,
  nowMs = Date.now(),
): GrokBuildLiveEvidence {
  if (!registry) return { state: 'unknown', basis: 'none', reasonCode: 'NO_ACTIVE_SESSIONS_GRANT' };
  const entry = registry.sessions.find((item) => item.sessionId.toLowerCase() === sessionId.toLowerCase());
  if (!entry) return { state: 'unknown', basis: 'grok-active-sessions', reasonCode: 'SESSION_NOT_LISTED' };
  if (entry.lastHeartbeatAt === undefined) {
    return { state: 'unknown', basis: 'grok-active-sessions', reasonCode: 'NO_HEARTBEAT' };
  }
  const heartbeatMs = entry.lastHeartbeatAt < 10_000_000_000
    ? entry.lastHeartbeatAt * 1_000
    : entry.lastHeartbeatAt;
  if (!Number.isFinite(heartbeatMs)) {
    return { state: 'unknown', basis: 'grok-active-sessions', reasonCode: 'INVALID_HEARTBEAT' };
  }
  if (heartbeatMs > nowMs) {
    return { state: 'unknown', basis: 'grok-active-sessions', reasonCode: 'FUTURE_HEARTBEAT' };
  }
  if (nowMs - heartbeatMs > GROK_BUILD_ACTIVE_FRESHNESS_MS) {
    return { state: 'unknown', basis: 'grok-active-sessions', reasonCode: 'STALE_HEARTBEAT' };
  }
  return { state: 'active', basis: 'grok-active-sessions', reasonCode: 'FRESH_HEARTBEAT' };
}

export function parseGrokBuildNativeCursor(value?: string): number {
  if (!value) return 0;
  if (!/^\d+$/.test(value)) {
    throw new SessionContractError('SCHEMA_DRIFT', 'invalid Grok Build native cursor', schemaIssueDetail('cursor'));
  }
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor)) throw new SessionContractError('SCHEMA_DRIFT', 'invalid Grok Build native cursor', schemaIssueDetail('cursor'));
  return cursor;
}

function declaredSchema(value: unknown): string {
  if (typeof value === 'number') return `${value}.0.0`;
  return /^\d+$/.test(String(value)) ? `${value}.0.0` : String(value);
}
