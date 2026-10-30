// Read an existing conductor ledger without session synchronization or persistence.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { summarizeMissionLedger } from '../../serve/mission-conductor.js';
import type { MissionLedger } from '../../serve/mission-conductor.js';
import type { HandlerContext, HandlerResult } from './types.js';
import { parseFlag, hasFlag } from './mc-args.js';
import * as ui from '../ui.js';

function ledgerShape(value: any): value is MissionLedger {
  return value !== null && typeof value === 'object' && typeof value.missionId === 'string'
    && Array.isArray(value.cycles) && value.cycles.every((cycle: any) => cycle
      && typeof cycle.cycleId === 'string' && typeof cycle.routed === 'boolean')
    && new Set(value.cycles.map((cycle: any) => cycle.cycleId)).size === value.cycles.length
    && value.checkpoint && ['completed', 'failed', 'pending'].every(key =>
      Array.isArray(value.checkpoint[key]) && value.checkpoint[key].every((id: unknown) => typeof id === 'string'))
    && (value.executionMode === undefined || ['plan-only', 'executed'].includes(value.executionMode));
}

export async function mcSummary(ctx: HandlerContext): Promise<HandlerResult> {
  const path = parseFlag(ctx.args, '--ledger');
  if (!path || path.startsWith('--')) {
    ui.error('Usage: aiwg mc summary --ledger <path> [--json]');
    return { exitCode: 1 };
  }
  try {
    const ledger: unknown = JSON.parse(await readFile(resolve(ctx.cwd, path), 'utf8'));
    if (!ledgerShape(ledger)) throw new Error('Invalid Mission ledger: cycles and checkpoints are required');
    const summary = summarizeMissionLedger(ledger);
    if (hasFlag(ctx.args, '--json')) console.log(JSON.stringify(summary, null, 2));
    else {
      console.log(`Mission ${summary.missionId}`);
      console.log(Object.entries(summary.counts).map(([status, count]) => `${status}: ${count}`).join(', '));
      for (const cycle of summary.cycles) console.log(`${cycle.cycleId}: ${cycle.status} — ${cycle.reason}`);
    }
    return { exitCode: 0 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ui.error(message);
    return { exitCode: 1, message };
  }
}
