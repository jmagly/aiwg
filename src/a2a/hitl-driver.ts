// HITL orchestrator driver — glues the SSE stream consumer, envelope
// extractor, delivery adapter, schema validator, and reply poster
// together.
//
// Usage:
//
//   import { A2AClient } from './client.js';
//   import { CliHitlDeliveryAdapter } from './hitl-cli.js';
//   import { driveHitlPromptsForTask } from './hitl-driver.js';
//
//   const client = new A2AClient({ ... });
//   await driveHitlPromptsForTask({
//     client,
//     taskId,
//     adapter: new CliHitlDeliveryAdapter(),
//     auditLog,
//   });
//
// The driver:
//   1. Subscribes to the task's SSE stream.
//   2. For each `status-update` with `state === 'input-required'`, extracts
//      the hitl-prompt envelope (returns silently if absent — not every
//      input-required state carries a HITL prompt).
//   3. Validates the envelope, sets up a deadline-based AbortController if
//      `envelope.deadline` is present.
//   4. Routes to the configured delivery adapter to collect a response.
//   5. Validates the response against `envelope.response_schema` using Ajv.
//   6. POSTs the reply Message via `client.sendMessage`. Surfaces 422
//      `hitl_response_invalid` as a clear operator error and re-prompts.
//   7. Writes one audit-log entry per decision.
//
// Concurrent prompts are correlated by `prompt_id` and tracked in an
// in-memory Map so a single task may have multiple outstanding HITL
// prompts simultaneously (per spec).
//
// @issue #1255

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { A2AClient } from './client.js';
import type { HitlDeliveryAdapter, HitlPromptEnvelope } from './hitl.js';
import {
  buildHitlResponseMessage,
  extractHitlEnvelope,
  validateResponseStructurally,
} from './hitl.js';
import type { JsonValue, StreamEvent } from './types.js';
import { collectAuthorizedHitlResponse, type PromptAuthorization, type PromptReceipt } from './hitl-authorization.js';
import { digestDecisionContext } from '../audit/operator-decision.js';

// ── Audit log surface ──────────────────────────────────────────────────

export interface HitlAuditEntry {
  authorization?: PromptReceipt;
  /** ISO 8601 timestamp at the moment the decision was finalized. */
  decided_at: string;
  /** Operator identity (delivery adapter's view — CLI uses $USER, etc.). */
  operator: string;
  /** Delivery channel name ('cli', 'slack', 'web', ...). */
  channel: string;
  prompt_id: string;
  task_id?: string;
  context_id?: string;
  outcome: 'responded' | 'invalid' | 'expired' | 'aborted' | 'unauthorized' | 'send_failed';
  /** Redacted response-context digest; raw approval payloads are never audited. */
  response_digest?: string;
  /** Failure detail — present on non-success outcomes. */
  error?: string;
  /** How long the operator took (ms). */
  duration_ms: number;
}

export interface HitlAuditLog {
  /** Persist one decision. Implementations may async-flush to disk. */
  append(entry: HitlAuditEntry): Promise<void> | void;
}

/** Default audit log — writes to stderr as JSONL. Replace with a file/HTTP sink in production. */
export class StderrHitlAuditLog implements HitlAuditLog {
  append(entry: HitlAuditEntry): void {
    process.stderr.write(JSON.stringify({ hitl_audit: entry }) + '\n');
  }
}

// ── Ajv bootstrap (transitive dep — zero new top-level deps) ──────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AjvValidate = ((data: unknown) => boolean) & { errors?: any[] | null };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _ajvCompile: ((schema: any) => AjvValidate) | null = null;
let _ajvBootstrapped = false;

function bootstrapAjv(): void {
  if (_ajvBootstrapped) return;
  _ajvBootstrapped = true;

  try {
    const require = createRequire(fileURLToPath(import.meta.url));
    const projectRoot = resolvePath(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..'
    );

    const candidates = [
      join(projectRoot, 'node_modules', 'ajv', 'dist', '2020.js'),
      join(projectRoot, 'node_modules', 'ajv', 'dist', 'ajv.js'),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let Ajv: any = null;
    for (const p of candidates) {
      if (existsSync(p)) {
        try {
          Ajv = require(p);
          break;
        } catch {
          /* try next */
        }
      }
    }
    if (!Ajv) return;
    const AjvClass = Ajv.default ?? Ajv;
    // strict: false because operator-supplied schemas vary widely; we
    // accept whatever they declare. validateSchema: false avoids meta-
    // schema URI fetches.
    const ajv = new AjvClass({
      strict: false,
      allErrors: true,
      validateSchema: false,
    });

    const formatsPath = join(
      projectRoot,
      'node_modules',
      'ajv-formats',
      'dist',
      'index.js'
    );
    if (existsSync(formatsPath)) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fm: any = require(formatsPath);
        const addFormats = fm.default ?? fm;
        if (typeof addFormats === 'function') addFormats(ajv);
      } catch {
        /* formats are optional */
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _ajvCompile = (schema: any) => ajv.compile(schema) as AjvValidate;
  } catch {
    /* graceful degrade to structural validator */
  }
}

/**
 * Validate `response` against the JSON Schema in `envelope.response_schema`.
 * Uses Ajv when available (transitive dep); falls back to the structural
 * validator in `hitl.ts` otherwise.
 */
export function validateResponseAgainstSchema(
  envelope: HitlPromptEnvelope,
  response: JsonValue
): { ok: true } | { ok: false; errors: string[] } {
  bootstrapAjv();
  if (_ajvCompile) {
    try {
      const validate = _ajvCompile(envelope.response_schema);
      if (validate(response)) return { ok: true };
      const errors = (validate.errors ?? []).map(formatAjvError);
      return { ok: false, errors };
    } catch (e) {
      // Schema itself was malformed — fall through to structural.
      // Don't swallow silently: include the error in fallback notes.
      const structural = validateResponseStructurally(
        envelope.response_schema,
        response
      );
      if (structural.ok) return structural;
      return {
        ok: false,
        errors: [
          `ajv refused schema (${(e as Error).message}); structural fallback:`,
          ...structural.errors,
        ],
      };
    }
  }
  return validateResponseStructurally(envelope.response_schema, response);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatAjvError(err: any): string {
  const path = err.instancePath || '$';
  return `${path}: ${err.message ?? 'invalid'}`;
}

// ── Driver ─────────────────────────────────────────────────────────────

export interface DriveHitlOptions {
  authorization?: PromptAuthorization;
  client: A2AClient;
  taskId: string;
  adapter: HitlDeliveryAdapter;
  auditLog?: HitlAuditLog;
  /**
   * Cap the number of retries when the executor rejects a response with
   * 422 `hitl_response_invalid`. Default: 3. After this many failed
   * attempts the driver records an `invalid` audit entry and surfaces
   * the last error to the caller.
   */
  maxRevalidationRetries?: number;
  /**
   * Optional override for generating reply messageIds (defaults to
   * `crypto.randomUUID()`).
   */
  messageIdFactory?: () => string;
  /** Stop after this many resolved prompts (test convenience). */
  maxPrompts?: number;
  /** Outer cancellation signal — closes the SSE subscription on abort. */
  signal?: AbortSignal;
}

/**
 * Subscribe to a task's SSE stream and drive HITL prompts to completion
 * via the supplied adapter. Resolves when the stream closes (task reaches
 * a terminal state) or when `maxPrompts` is reached.
 */
export async function driveHitlPromptsForTask(opts: DriveHitlOptions): Promise<void> {
  const auditLog = opts.auditLog ?? new StderrHitlAuditLog();
  const maxRetries = Math.max(1, opts.maxRevalidationRetries ?? 3);
  const messageIdFactory = opts.messageIdFactory ?? defaultMessageIdFactory;

  let prompts = 0;

  const subscription = opts.client.subscribeToTask(opts.taskId, {
    signal: opts.signal,
  });

  try {
    for await (const event of subscription) {
      const envelope = extractEnvelopeFromEvent(event);
      if (!envelope) continue;

      const ctx = inferEventContext(event);
      await driveOnePrompt({
        envelope,
        authorization: opts.authorization,
        client: opts.client,
        adapter: opts.adapter,
        auditLog,
        taskId: opts.taskId,
        contextId: ctx.contextId,
        deadline: envelope.deadline,
        maxRetries,
        messageIdFactory,
      });

      prompts++;
      if (opts.maxPrompts !== undefined && prompts >= opts.maxPrompts) break;
    }
  } finally {
    subscription.close();
  }
}

/**
 * Drive a single prompt-response cycle. Exposed for callers that want
 * to bypass the SSE stream (e.g. when an envelope arrives via the push-
 * notification webhook receiver in #1256).
 */
export async function driveOnePrompt(opts: {
  authorization?: PromptAuthorization;
  envelope: HitlPromptEnvelope;
  client: Pick<A2AClient, 'sendMessage'>;
  adapter: HitlDeliveryAdapter;
  auditLog: HitlAuditLog;
  taskId?: string;
  contextId?: string;
  deadline?: string;
  maxRetries?: number;
  messageIdFactory?: () => string;
}): Promise<void> {
  const auditLog = opts.auditLog;
  const maxRetries = Math.max(1, opts.maxRetries ?? 3);
  const messageIdFactory = opts.messageIdFactory ?? defaultMessageIdFactory;
  const startedAt = Date.now();

  const operator = adapterOperator(opts.adapter);
  if (!isResponderAllowed(opts.envelope.allowed_responders, operator)) {
    await auditLog.append({
      decided_at: new Date().toISOString(),
      operator,
      channel: opts.adapter.name,
      prompt_id: opts.envelope.prompt_id,
      ...(opts.taskId !== undefined ? { task_id: opts.taskId } : {}),
      ...(opts.contextId !== undefined ? { context_id: opts.contextId } : {}),
      outcome: 'unauthorized',
      error: 'operator is not authorized by allowed_responders',
      duration_ms: Date.now() - startedAt,
    });
    return;
  }

  // Set up the deadline AbortController if the envelope declares one.
  const controller = new AbortController();
  const deadlineMs = parseDeadline(opts.envelope.deadline);
  let deadlineTimer: NodeJS.Timeout | undefined;
  if (deadlineMs !== null) {
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) {
      controller.abort();
    } else {
      deadlineTimer = setTimeout(() => controller.abort(), remaining);
    }
  }

  let lastError: string | undefined;

  try {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      let response: JsonValue;
      let authorization: PromptReceipt | undefined;
      try {
        ({ response, authorization } = await collectAuthorizedHitlResponse(opts, controller.signal));
      } catch (err) {
        if (controller.signal.aborted) {
          await auditLog.append({
            decided_at: new Date().toISOString(),
            operator: adapterOperator(opts.adapter),
            channel: opts.adapter.name,
            prompt_id: opts.envelope.prompt_id,
            ...(opts.taskId !== undefined ? { task_id: opts.taskId } : {}),
            ...(opts.contextId !== undefined ? { context_id: opts.contextId } : {}),
            outcome: 'expired',
            error:
              deadlineMs !== null && Date.now() >= deadlineMs
                ? 'deadline expired before response'
                : (err as Error).message,
            duration_ms: Date.now() - startedAt,
          });
          return;
        }
        await auditLog.append({
          decided_at: new Date().toISOString(),
          operator: adapterOperator(opts.adapter),
          channel: opts.adapter.name,
          prompt_id: opts.envelope.prompt_id,
          ...(opts.taskId !== undefined ? { task_id: opts.taskId } : {}),
          ...(opts.contextId !== undefined ? { context_id: opts.contextId } : {}),
          outcome: 'aborted',
          error: (err as Error).message,
          duration_ms: Date.now() - startedAt,
        });
        return;
      }

      const validation = validateResponseAgainstSchema(opts.envelope, response);
      if (!validation.ok) {
        lastError = validation.errors.join('; ');
        // Surface the schema gap clearly and let the operator retry.
        process.stderr.write(
          `HITL response invalid: ${lastError}\n` +
            (attempt + 1 < maxRetries
              ? `(retry ${attempt + 1}/${maxRetries - 1})\n`
              : '')
        );
        continue;
      }

      // Validation passed — POST the reply.
      const reply = buildHitlResponseMessage({
        promptId: opts.envelope.prompt_id,
        response,
        messageId: messageIdFactory(),
        ...(opts.taskId !== undefined ? { taskId: opts.taskId } : {}),
        ...(opts.contextId !== undefined ? { contextId: opts.contextId } : {}),
      });

      try {
        await opts.client.sendMessage(reply);
      } catch (err) {
        // Surface 422 hitl_response_invalid distinctly from network errors.
        const msg = (err as Error).message;
        if (/422|hitl_response_invalid/.test(msg)) {
          lastError = msg;
          process.stderr.write(
            `Executor rejected response (HTTP 422): ${msg}\n` +
              (attempt + 1 < maxRetries
                ? `(retry ${attempt + 1}/${maxRetries - 1})\n`
                : '')
          );
          continue;
        }
        await auditLog.append({
          decided_at: new Date().toISOString(),
          operator: adapterOperator(opts.adapter),
          channel: opts.adapter.name,
          prompt_id: opts.envelope.prompt_id,
          ...(opts.taskId !== undefined ? { task_id: opts.taskId } : {}),
          ...(opts.contextId !== undefined ? { context_id: opts.contextId } : {}),
          outcome: 'send_failed',
          error: msg,
          duration_ms: Date.now() - startedAt,
        });
        throw err;
      }

      await auditLog.append({
        decided_at: new Date().toISOString(),
        operator: adapterOperator(opts.adapter),
        channel: opts.adapter.name,
        prompt_id: opts.envelope.prompt_id,
        ...(opts.taskId !== undefined ? { task_id: opts.taskId } : {}),
        ...(opts.contextId !== undefined ? { context_id: opts.contextId } : {}),
        outcome: 'responded',
        ...(authorization ? { authorization } : {}),
        response_digest: digestDecisionContext(response),
        duration_ms: Date.now() - startedAt,
      });
      return;
    }

    // Exhausted retries — record the final invalid outcome.
    await auditLog.append({
      decided_at: new Date().toISOString(),
      operator: adapterOperator(opts.adapter),
      channel: opts.adapter.name,
      prompt_id: opts.envelope.prompt_id,
      ...(opts.taskId !== undefined ? { task_id: opts.taskId } : {}),
      ...(opts.contextId !== undefined ? { context_id: opts.contextId } : {}),
      outcome: 'invalid',
      error: lastError ?? 'response did not validate after max retries',
      duration_ms: Date.now() - startedAt,
    });
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
}

// ── helpers ────────────────────────────────────────────────────────────

function extractEnvelopeFromEvent(event: StreamEvent): HitlPromptEnvelope | null {
  if (event.type === 'task') {
    const result = extractHitlEnvelope(event.task);
    if (result?.ok) return result.envelope;
    return null;
  }
  if (event.type === 'status') {
    const result = extractHitlEnvelope(event.status);
    if (result?.ok) return result.envelope;
    return null;
  }
  return null;
}

function inferEventContext(event: StreamEvent): { contextId?: string } {
  if (event.type === 'task') {
    return event.task.contextId !== undefined
      ? { contextId: event.task.contextId }
      : {};
  }
  return event.type === 'status' || event.type === 'artifact'
    ? event.contextId !== undefined ? { contextId: event.contextId } : {}
    : event.type === 'message' && event.message.contextId !== undefined
      ? { contextId: event.message.contextId }
      : {};
}

function parseDeadline(deadline: string | undefined): number | null {
  if (!deadline) return null;
  const ms = Date.parse(deadline);
  return Number.isFinite(ms) ? ms : null;
}

function adapterOperator(adapter: HitlDeliveryAdapter): string {
  // CLI adapter exposes `operatorId`; other adapters may too. Fall back
  // to the adapter name so the audit entry is never empty.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const id = (adapter as any).operatorId;
  return typeof id === 'string' && id.length > 0 ? id : adapter.name;
}

/**
 * Enforce the v1 coarse responder policy before collecting or forwarding a
 * response. Consensus policies require an aggregate routing adapter and are
 * therefore not satisfied by a single-principal adapter.
 */
export function isResponderAllowed(
  policies: string[] | undefined,
  responderId: string,
): boolean {
  const effective = policies?.length ? policies : ['any'];
  if (effective.includes('any')) return true;
  return effective.some(policy =>
    policy.startsWith('specific:') && policy.slice('specific:'.length) === responderId
  );
}

function defaultMessageIdFactory(): string {
  // Prefer crypto.randomUUID; fall back to timestamp+random for older node.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const crypto: any = (globalThis as any).crypto;
  if (crypto && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `hitl-reply-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}
