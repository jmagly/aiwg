/**
 * Activity-log auto-append hook
 *
 * Post-command hook that automatically appends an activity-log entry
 * after qualifying CLI commands succeed. Closes the discipline gap
 * called out in the activity-log rule:
 *
 *   "Subagents silently create and delete artifacts with no record
 *   visible to the parent orchestrator"
 *
 * Failures are non-blocking: if the entry can't be written, we log to
 * stderr and let the primary command's success stand.
 *
 * @design @docs/storage/overview.md
 * @issue #934
 * @issue #978
 */

import type { ActivityOperation } from '../../../activity-log/types.js';
import { formatEntry } from '../../../activity-log/types.js';
import { resolveStorage } from '../../../storage/index.js';
import type { HookContext, HookHandler, HookResult } from '../types.js';

const LOG_PATH = 'activity.log';

/**
 * Map of CLI command id → operation token. Commands not in this map
 * skip the hook (most reads, queries, scaffolding helpers, etc.).
 */
const COMMAND_OPERATION_MAP: Record<string, ActivityOperation> = {
  // Framework deployment
  use: 'deploy',
  refresh: 'deploy',
  remove: 'delete',

  // Extension scaffolding
  'add-agent': 'create',
  'add-command': 'create',
  'add-skill': 'create',
  'add-template': 'create',
  'add-behavior': 'create',

  // Validation
  'validate-metadata': 'lint',

  // Index updates
  index: 'update', // Note: 'aiwg index build' is the primary mutating subcommand

  // Ops ecosystem
  ops: 'create', // crude — `aiwg ops init` creates; `push`/`adopt` also mutate
};

/**
 * Build a one-line summary from the command + args. Bounded to ≤120
 * chars per the activity-log rule.
 */
function summarize(command: string, args: string[]): string {
  const argString = args.join(' ').trim();
  const base = argString.length > 0 ? `aiwg ${command} ${argString}` : `aiwg ${command}`;
  if (base.length <= 120) return base;
  return base.slice(0, 117) + '...';
}

/**
 * Returns true when AIWG_SKIP_ACTIVITY_LOG is set to a truthy value.
 * Mirrors the gate in src/activity-log/cli.ts (#975).
 */
function isActivityLogSkipped(): boolean {
  const raw = process.env['AIWG_SKIP_ACTIVITY_LOG'];
  if (!raw) return false;
  const v = raw.toLowerCase().trim();
  if (v === '0' || v === 'false' || v === '') return false;
  return true;
}

export const activityLogPostCommandHook: HookHandler = {
  id: 'aiwg:activity-log-auto-append',
  event: 'post-command',
  priority: 100,
  filter: {
    // Only fire for the commands we know how to summarize. The map above
    // is the source of truth.
    commands: Object.keys(COMMAND_OPERATION_MAP),
  },

  async execute(ctx: HookContext): Promise<HookResult> {
    // A dry-run is a strict no-write contract. The command handler may preview
    // mutations, but the post-command hook must not create activity.log as a
    // side effect of that preview.
    if (ctx.args.includes('--dry-run')) {
      return { action: 'continue' };
    }

    // Skip on env-var opt-out
    if (isActivityLogSkipped()) {
      return { action: 'continue' };
    }

    // Skip if the command failed (post-command runs even on failure for
    // some hook flows; we never want to log a failure as a successful op)
    const exitCode = ctx.data?.['exitCode'];
    if (typeof exitCode === 'number' && exitCode !== 0) {
      return { action: 'continue' };
    }

    const operation = COMMAND_OPERATION_MAP[ctx.command];
    if (!operation) {
      // Filter should prevent this, but defensive
      return { action: 'continue' };
    }

    try {
      const adapter = await resolveStorage('activity_log');
      const line =
        formatEntry({
          timestamp: new Date(),
          operation,
          summary: summarize(ctx.command, ctx.args),
        }) + '\n';

      // Prefer atomic append (#976) when available
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
      // Non-blocking — log to stderr and let the primary command's
      // success stand. Per the activity-log rule's "Rule 4: Non-Blocking".
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`activity-log auto-append failed (non-fatal): ${msg}\n`);
    }

    return { action: 'continue' };
  },
};

/**
 * The list of commands the hook fires for. Exported for tests.
 */
export const HOOKED_COMMANDS = Object.keys(COMMAND_OPERATION_MAP);
