// Mission Control command routing and public compatibility exports.
import type { CommandHandler, HandlerContext, HandlerResult } from './types.js';
import * as ui from '../ui.js';

import { wantsHelp } from './mc-args.js';
import { printSubcommandHelp, showMcHelp } from './mc-help.js';
import { mcStart, mcDispatch } from './mc-dispatch.js';
import { mcRun } from './mc-run.js';
import { mcStatus, mcList, mcWatch } from './mc-status.js';
import { mcAbort, mcPause, mcResume, mcStop } from './mc-control.js';
import { mcAgents } from './mc-agents.js';
export { createMcAdmissionScheduler } from './mc-admission.js';
export { createMcFlowAdapter } from './mc-worker.js';
export { SONNET_CACHE_USD, COST_WARNING_THRESHOLD_USD, COST_REPORTING_PROVIDERS, estimateMissionRunCost, type MissionRunCostEstimate } from './mc-run.js';

// ── Subcommand router ────────────────────────────────────────
import { mcSummary } from './mc-summary.js';

export const subcommands: Record<string, (ctx: HandlerContext) => Promise<HandlerResult>> = {
  summary: mcSummary,
  start: mcStart,
  dispatch: mcDispatch,
  run: mcRun, // #1439
  status: mcStatus,
  watch: mcWatch,
  abort: mcAbort,
  cancel: mcAbort,
  pause: mcPause,
  resume: mcResume,
  stop: mcStop,
  list: mcList,
  agents: mcAgents,
};

// ── Exported handler ─────────────────────────────────────────

export const mcHandler: CommandHandler = {
  id: 'mc',
  name: 'Mission Control',
  description: 'Multi-loop background orchestration (start, dispatch, status, watch, stop)',
  category: 'orchestration',
  aliases: ['mission-control'],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    const subcmd = ctx.args[0];

    if (!subcmd || subcmd === '--help' || subcmd === '-h') {
      showMcHelp();
      return { exitCode: 0 };
    }

    const handler = subcommands[subcmd];
    if (!handler) {
      ui.error(`Unknown subcommand: ${subcmd}. Run 'aiwg mc --help' for usage.`);
      return { exitCode: 1 };
    }

    // #1440: '--help' / '-h' on any subcommand prints usage and exits BEFORE
    // any side-effecting logic. The previous behavior — e.g. 'mc start --help'
    // actually creating a session — violated the universal --help convention.
    const subArgs = ctx.args.slice(1);
    if (wantsHelp(subArgs)) {
      printSubcommandHelp(subcmd);
      return { exitCode: 0 };
    }

    // Pass remaining args to subcommand
    const subCtx: HandlerContext = {
      ...ctx,
      args: subArgs,
    };

    return handler(subCtx);
  },
};

/**
 * All MC-related handlers for bulk registration
 */
export const mcHandlers: CommandHandler[] = [mcHandler];
