/**
 * Project-Local Activity Log Helper
 *
 * Inline activity-log emission for project-local artifact lifecycle events.
 * Wraps the storage adapter from `resolveStorage('activity_log')` and emits
 * single-line entries per the format frozen by the activity-log rule.
 *
 * The generic post-command hook in `cli/hooks/builtin/activity-log-hook.ts`
 * emits one entry per CLI invocation (`aiwg use sdlc`). This helper emits
 * per-event entries (per-bundle, per-provider) at finer granularity, as
 * specified by the design doc.
 *
 * @design @docs/customization/project-local-lifecycle.md
 * @implements #1037
 * @issue #1049
 */

import type { ActivityOperation } from '../activity-log/types.js';
import { formatEntry } from '../activity-log/types.js';
import { resolveStorage } from '../storage/index.js';

const LOG_PATH = 'activity.log';

/**
 * Project-local activity event names. The wire-format `operation` token
 * always falls back to one of the frozen `ACTIVITY_OPERATIONS`; the
 * detail (deploy-failed, remove-mutated, etc.) lives in the summary
 * prefix so the rule's enum doesn't have to grow.
 */
export type ProjectLocalEvent =
  | 'discover'
  | 'deploy'
  | 'deploy-failed'
  | 'conflict'
  | 'shadow-acknowledged'
  | 'shadow-refused'
  | 'remove'
  | 'remove-mutated'
  | 'remove-conflict'
  | 'remove-force'
  | 'promote'
  | 'promote-failed';

/** Map design-event → frozen wire-format op token. */
const EVENT_TO_OP: Record<ProjectLocalEvent, ActivityOperation> = {
  discover: 'query',
  deploy: 'deploy',
  'deploy-failed': 'deploy',
  conflict: 'deploy',
  'shadow-acknowledged': 'deploy',
  'shadow-refused': 'deploy',
  remove: 'delete',
  'remove-mutated': 'delete',
  'remove-conflict': 'delete',
  'remove-force': 'delete',
  promote: 'promote',
  'promote-failed': 'promote',
};

export interface ActivityEvent {
  event: ProjectLocalEvent;
  /** Bundle id, e.g., "my-ext". */
  name: string;
  /** Bundle type, e.g., "extension". */
  type: string;
  /** Free-form summary (one line, ≤120 chars after the prefix). */
  summary: string;
}

/**
 * Append an activity-log entry for a project-local lifecycle event.
 *
 * Non-blocking: write failures are swallowed with a stderr warning. The
 * caller's primary operation must not depend on log success.
 *
 * Wire format: `## [TS] <op> | <event>: <name>:<type> | <summary>`
 */
export async function appendProjectLocalActivity(ev: ActivityEvent): Promise<void> {
  if (process.env['AIWG_SKIP_ACTIVITY_LOG']) {
    const v = process.env['AIWG_SKIP_ACTIVITY_LOG'].toLowerCase().trim();
    if (v && v !== '0' && v !== 'false') return;
  }

  const op = EVENT_TO_OP[ev.event];
  const compactSummary = `${ev.event}: ${ev.name}:${ev.type} | ${ev.summary}`;
  const line =
    formatEntry({
      timestamp: new Date(),
      operation: op,
      summary: compactSummary,
    }) + '\n';

  try {
    const adapter = await resolveStorage('activity_log');
    if (typeof adapter.append === 'function') {
      const existing = (await adapter.read(LOG_PATH)) ?? '';
      if (existing.length > 0 && !existing.endsWith('\n')) {
        await adapter.append(LOG_PATH, '\n');
      }
      await adapter.append(LOG_PATH, line);
    } else {
      const existing = (await adapter.read(LOG_PATH)) ?? '';
      const trailing = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
      await adapter.write(LOG_PATH, existing + trailing + line);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`project-local activity log append failed (non-fatal): ${msg}\n`);
  }
}

/**
 * Emit `discover` events for newly-seen bundles. Per #1049 design's
 * "discover noise control": dedupe by reading the most recent N lines
 * and skipping (name, type) pairs that already appeared.
 *
 * Cheap heuristic — exact log de-dup is not required. We just want to
 * avoid filling the log with the same lines on every read-only command.
 */
export async function emitDiscoverEventsDeduped(
  bundles: ReadonlyArray<{ id: string; type: string }>,
): Promise<void> {
  if (bundles.length === 0) return;
  if (process.env['AIWG_SKIP_ACTIVITY_LOG']) {
    const v = process.env['AIWG_SKIP_ACTIVITY_LOG'].toLowerCase().trim();
    if (v && v !== '0' && v !== 'false') return;
  }

  let recent = '';
  try {
    const adapter = await resolveStorage('activity_log');
    recent = (await adapter.read(LOG_PATH)) ?? '';
  } catch {
    // Read failed — fall through and emit unconditionally (rather than
    // suppress important events because we couldn't read history).
  }

  const tail = recent.split('\n').slice(-200).join('\n');

  for (const b of bundles) {
    const marker = `discover: ${b.id}:${b.type}`;
    if (tail.includes(marker)) continue;
    await appendProjectLocalActivity({
      event: 'discover',
      name: b.id,
      type: b.type,
      summary: `manifest discovered`,
    });
  }
}
