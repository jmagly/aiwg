// Mission Control session operations, extracted from the shared handler.
import type { HandlerResult } from './types.js';
import * as ui from '../ui.js';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { randomBytes } from 'node:crypto';

import { type Session } from './mc-types.js';
import { parseFlag } from './mc-args.js';

// ── Constants ────────────────────────────────────────────────

export const MC_ROOT = '.aiwg/ralph-external/mc';

export const SESSIONS_DIR = join(MC_ROOT, 'sessions');

export const CONTROL_ID_RE = /^[a-zA-Z0-9._-]+$/;

// ── Helpers ──────────────────────────────────────────────────

export function genId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function readSession(sessionId: string): Promise<Session | null> {
  if (!CONTROL_ID_RE.test(sessionId)) return null;
  const path = join(SESSIONS_DIR, sessionId, 'session.json');
  try {
    const raw = await fs.readFile(path, 'utf-8');
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

export async function writeSession(session: Session, { touch = true }: { touch?: boolean } = {}): Promise<void> {
  const dir = join(SESSIONS_DIR, session.id);
  await ensureDir(dir);
  if (touch) session.updatedAt = new Date().toISOString();
  const destination = join(dir, 'session.json');
  const temporary = join(dir, `.session.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  await fs.writeFile(temporary, JSON.stringify(session, null, 2));
  await fs.rename(temporary, destination);
}

export async function appendLog(sessionId: string, event: Record<string, unknown>): Promise<void> {
  const logPath = join(SESSIONS_DIR, sessionId, 'log.jsonl');
  const entry = JSON.stringify({ ...event, ts: new Date().toISOString() });
  await fs.appendFile(logPath, entry + '\n');
}

export type MutationResult =
  | { ok: true; session: Session; replayed: boolean }
  | { ok: false; code: 'mission_conflict' | 'session_not_found' | 'target_not_found' | 'invalid_state' | 'capacity'; message: string };

/**
 * Apply one durable Mission Control mutation under a cross-process lock.
 * `expectedUpdatedAt` provides optimistic concurrency and `requestId` makes
 * retries idempotent across CLI/Cockpit reconnects.
 */
export async function mutateSession(
  sessionId: string,
  action: string,
  target: string,
  expectedUpdatedAt: string | undefined,
  requestId: string | undefined,
  mutate: (session: Session) => string | undefined,
): Promise<MutationResult> {
  if (!CONTROL_ID_RE.test(sessionId) || !CONTROL_ID_RE.test(target)) {
    return { ok: false, code: 'target_not_found', message: 'invalid Mission control identifier' };
  }
  const dir = join(SESSIONS_DIR, sessionId);
  await ensureDir(dir);
  const lockPath = join(dir, '.control.lock');
  let lock;
  try {
    lock = await fs.open(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return { ok: false, code: 'mission_conflict', message: 'another Mission control mutation is in progress' };
    }
    throw error;
  }
  try {
    const session = await readSession(sessionId);
    if (!session) return { ok: false, code: 'session_not_found', message: `Session not found: ${sessionId}` };
    if (expectedUpdatedAt && session.updatedAt !== expectedUpdatedAt) {
      return { ok: false, code: 'mission_conflict', message: `expected revision ${expectedUpdatedAt}; current revision is ${session.updatedAt}` };
    }
    if (requestId && session.mutationKeys?.[requestId]) {
      const prior = session.mutationKeys[requestId]!;
      if (prior.action !== action || prior.target !== target) {
        return { ok: false, code: 'mission_conflict', message: `request id '${requestId}' was already used for another mutation` };
      }
      return { ok: true, session, replayed: true };
    }
    const errorCode = mutate(session);
    if (errorCode === 'target_not_found') return { ok: false, code: errorCode, message: `Mission not found: ${target}` };
    if (errorCode === 'invalid_state') return { ok: false, code: errorCode, message: `Mutation '${action}' is invalid from state '${session.state}'` };
    if (errorCode === 'capacity') return { ok: false, code: errorCode, message: `Session at capacity (${session.maxMissions} missions)` };
    const nextUpdatedAt = new Date().toISOString();
    session.updatedAt = nextUpdatedAt;
    if (requestId) {
      session.mutationKeys = { ...(session.mutationKeys ?? {}), [requestId]: { action, target, updatedAt: nextUpdatedAt } };
    }
    await writeSession(session, { touch: false });
    await appendLog(session.id, { event: `control_${action}`, target, requestId: requestId ?? null, replayed: false, revision: session.updatedAt });
    return { ok: true, session, replayed: false };
  } finally {
    await lock.close();
    await fs.unlink(lockPath).catch(() => undefined);
  }
}

export function mutationFlags(args: string[]): { expectedUpdatedAt?: string; requestId?: string } {
  return {
    expectedUpdatedAt: parseFlag(args, '--expected-updated-at'),
    requestId: parseFlag(args, '--request-id'),
  };
}

export function mutationFailure(result: Extract<MutationResult, { ok: false }>): HandlerResult {
  ui.error(`${result.code}: ${result.message}`);
  return { exitCode: result.code === 'mission_conflict' ? 3 : 1, message: `${result.code}: ${result.message}` };
}

export async function listSessions(): Promise<Session[]> {
  try {
    const entries = await fs.readdir(SESSIONS_DIR, { withFileTypes: true });
    const sessions: Session[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const s = await readSession(entry.name);
        if (s) sessions.push(s);
      }
    }
    return sessions;
  } catch {
    return [];
  }
}

export async function findActiveSession(sessionIdArg?: string): Promise<Session | null> {
  if (sessionIdArg) return readSession(sessionIdArg);

  // Find latest active session
  const sessions = await listSessions();
  const active = sessions
    .filter(s => s.state === 'active' || s.state === 'paused')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return active[0] || null;
}
