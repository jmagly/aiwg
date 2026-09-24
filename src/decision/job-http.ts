import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DecisionJob } from './job-contract.js';
import { JobConflictError, type JobScope, type JobSnapshot } from './job-store.js';
import type { createOfflineDecisionJobService } from './job-service.js';

export interface DecisionJobHttpOptions {
  /** Deliberate opt-in. No global route or listener is registered by this module. */
  enabled: true;
  service: ReturnType<typeof createOfflineDecisionJobService>;
  authenticate: (request: IncomingMessage) => Promise<JobScope | null>;
  /** Authorize queue admission only; this callback must not execute or dispatch provider work. */
  authorizeQueue: (actor: JobScope, snapshot: JobSnapshot) => Promise<boolean>;
  /** Host D10 hold/erasure controller; must call gateway.remove and independent lifecycle eraser. */
  deleteJob: (actor: JobScope, snapshot: JobSnapshot) => Promise<boolean>;
  authorizeResult: (actor: JobScope, snapshot: JobSnapshot, itemId: string) => Promise<boolean>;
  maxBodyBytes: number;
}
/** Explicitly mounted host HTTP boundary. All identity comes from authenticate(), never JSON. */
export function createDecisionJobHttpHandler(options: DecisionJobHttpOptions) {
  if (options.enabled !== true || !options.service || ![options.authenticate, options.authorizeQueue, options.deleteJob,
    options.authorizeResult].every(fn => typeof fn === 'function') ||
      !Number.isSafeInteger(options.maxBodyBytes) || options.maxBodyBytes < 1 || options.maxBodyBytes > 1_048_576)
    throw new JobConflictError('Authenticated job HTTP host required');
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const send = (code: number, value: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff' });
      res.end(JSON.stringify(value));
    };
    try {
      let actor: JobScope | null = null;
      try { actor = await options.authenticate(req); } catch { /* authentication fails closed */ }
      if (!actor || ![actor.tenantId, actor.projectId, actor.workspaceId, actor.principalId]
        .every(value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value))) {
        send(401, { error: 'unauthorized' }); return;
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] !== 'decision' || parts[1] !== 'jobs' || parts.length > 6) { send(404, { error: 'unavailable' }); return; }
      const method = req.method;
      if (req.headers['content-length'] && (!/^[0-9]+$/.test(req.headers['content-length']) ||
          Number(req.headers['content-length']) > options.maxBodyBytes)) {
        send(413, { error: 'request too large' }); return;
      }
      if (parts.length === 2 && method === 'POST') {
        const body = await readBody(req, options.maxBodyBytes);
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.hasOwn(body, 'scope')) {
          send(400, { error: 'invalid job' }); return;
        }
        const job = { ...body, scope: actor } as DecisionJob;
        const { handle, snapshot } = await options.service.gateway.submit(actor, job);
        send(202, { handle, state: snapshot.job.state, summary: snapshot.job.summary }); return;
      }
      if (parts.length === 2 && method === 'GET') {
        const limit = numberParam(url.searchParams.get('limit'), 100);
        if (limit === null) { send(400, { error: 'invalid page' }); return; }
        const page = await options.service.gateway.list(actor, url.searchParams.get('cursor') ?? undefined, limit);
        send(page ? 200 : 404, page ?? { error: 'unavailable' }); return;
      }
      const handle = parts[2];
      if (!handle || !/^dj1_[A-Za-z0-9_-]{40,2048}$/.test(handle)) { send(404, { error: 'unavailable' }); return; }
      if (parts.length === 3 && method === 'GET') {
        const snapshot = await options.service.gateway.poll(actor, handle);
        send(snapshot ? 200 : 404, snapshot ? summary(snapshot) : { error: 'unavailable' }); return;
      }
      if (parts.length === 3 && method === 'DELETE') {
        const snapshot = await options.service.gateway.poll(actor, handle);
        if (!snapshot || !await options.deleteJob(actor, snapshot)) { send(404, { error: 'unavailable' }); return; }
        send(204, {}); return;
      }
      if (parts.length === 4 && parts[3] === 'export' && method === 'GET') {
        const snapshot = await options.service.gateway.export(actor, handle);
        send(snapshot ? 200 : 404, snapshot ? summary(snapshot) : { error: 'unavailable' }); return;
      }
      if (parts.length === 4 && parts[3] === 'items' && method === 'GET') {
        const offset = numberParam(url.searchParams.get('offset'), 0);
        const limit = numberParam(url.searchParams.get('limit'), 100);
        if (offset === null || limit === null) { send(400, { error: 'invalid page' }); return; }
        const items = await options.service.gateway.items(actor, handle, offset, limit);
        send(items ? 200 : 404, items ? { items: items.map(item => ({ id: item.id, state: item.state,
          ...(item.resultDigest ? { resultDigest: item.resultDigest } : {}),
          ...(item.errorCode ? { errorCode: item.errorCode } : {}) })) } : { error: 'unavailable' }); return;
      }
      if (parts.length === 4 && parts[3] === 'cancel' && method === 'POST') {
        const snapshot = await options.service.gateway.poll(actor, handle);
        if (!snapshot) { send(404, { error: 'unavailable' }); return; }
        const canceled = await options.service.worker.cancel(actor, snapshot.job.id);
        send(canceled ? 200 : 404, canceled ? summary(canceled) : { error: 'unavailable' }); return;
      }
      if (parts.length === 4 && parts[3] === 'queue' && method === 'POST') {
        const snapshot = await options.service.gateway.poll(actor, handle);
        if (!snapshot || snapshot.job.state !== 'validating') { send(404, { error: 'unavailable' }); return; }
        // Missing input is not guessed or sourced from model-visible state.
        for (const item of snapshot.job.items)
          if (await options.service.payloads.get(actor, snapshot.job.id, item.id, 'input') === null)
            throw new JobConflictError('Job input unavailable');
        if (!await options.authorizeQueue(actor, snapshot)) { send(404, { error: 'unavailable' }); return; }
        const next = structuredClone(snapshot.job); next.state = 'queued';
        const queued = await options.service.runtime.advance(actor, snapshot.job.id, snapshot, next);
        send(202, summary(queued)); return;
      }
      if (parts.length === 5 && parts[3] === 'retry' && method === 'POST' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(parts[4]!)) {
        const next = await options.service.gateway.retry(actor, handle, parts[4]!);
        send(next ? 200 : 404, next ? summary(next) : { error: 'unavailable' }); return;
      }
      if (parts.length === 6 && parts[3] === 'items' && parts[5] === 'input' && method === 'PUT' &&
          /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(parts[4]!)) {
        const snapshot = await options.service.gateway.poll(actor, handle);
        if (!snapshot) { send(404, { error: 'unavailable' }); return; }
        await options.service.payloads.put(actor, snapshot.job.id, parts[4]!, 'input', await readBody(req, options.maxBodyBytes));
        send(204, {}); return;
      }
      if (parts.length === 6 && parts[3] === 'items' && parts[5] === 'result' && method === 'GET' &&
          /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(parts[4]!)) {
        const snapshot = await options.service.gateway.poll(actor, handle);
        if (!snapshot || !await options.authorizeResult(actor, snapshot, parts[4]!)) { send(404, { error: 'unavailable' }); return; }
        const value = await options.service.payloads.get(actor, snapshot.job.id, parts[4]!, 'result');
        send(value === null ? 404 : 200, value === null ? { error: 'unavailable' } : { result: value }); return;
      }
      send(404, { error: 'unavailable' });
    } catch (error) {
      if (res.headersSent) return;
      const message = error instanceof Error ? error.message : '';
      send(message.includes('throttled') || message.includes('ledger full') ? 429 :
        message === 'Job unavailable' || message === 'Validated job result unavailable' ? 404 :
        message.includes('body limit') ? 413 : error instanceof JobConflictError ? 409 : 500,
      { error: message.includes('throttled') ? 'rate limited' : 'unavailable' });
    }
  };
}
function summary(snapshot: JobSnapshot) {
  const job = snapshot.job;
  return { state: job.state, summary: job.summary, createdAtEpochMs: job.createdAtEpochMs,
    expiresAtEpochMs: job.expiresAtEpochMs, revision: snapshot.revision };
}
function numberParam(value: string | null, fallback: number): number | null {
  if (value === null) return fallback;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
async function readBody(req: IncomingMessage, max: number): Promise<unknown> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    bytes += data.length;
    if (bytes > max) throw new JobConflictError('Request body limit exceeded');
    chunks.push(data);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new JobConflictError('Invalid job JSON'); }
}
