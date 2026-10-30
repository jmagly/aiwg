// Mission Control agents operations, extracted from the shared handler.
import type { HandlerContext, HandlerResult } from './types.js';
import * as ui from '../ui.js';

import { hasFlag } from './mc-args.js';

// ── Agent routing query ──────────────────────────────────────

/**
 * aiwg mc agents [--filter key=value...] [--json]
 *
 * Queries GET /api/agents/candidates on the local aiwg serve instance and
 * prints a table of agents that match the given routing filter. This is a thin
 * CLI wrapper over the #916 routing endpoint so operators can check routing
 * from a terminal without opening the dashboard.
 *
 * Filter flags:
 *   --framework <name>       Require a specific AIWG framework (repeatable)
 *   --sandbox <id>           Restrict to a specific sandbox
 *   --agent <id>             Restrict to a specific agent ID
 *   --name <n>               Match by logical name
 *   --max-cpu <pct>          Reject agents above this CPU %
 *   --min-memory <gb>        Reject agents below this memory threshold
 *   --json                   Output raw JSON
 */
export async function mcAgents(ctx: HandlerContext): Promise<HandlerResult> {
  const args = ctx.args;
  const json = hasFlag(args, '--json');

  const port = process.env['AIWG_SERVE_PORT'] ?? '7337';
  const base = `http://127.0.0.1:${port}`;

  const params = new URLSearchParams();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--framework' && args[i + 1]) { params.append('frameworks', args[++i]!); }
    else if (a === '--sandbox' && args[i + 1]) { params.set('sandbox_id', args[++i]!); }
    else if (a === '--agent' && args[i + 1]) { params.set('agent_id', args[++i]!); }
    else if (a === '--name' && args[i + 1]) { params.set('agent_name', args[++i]!); }
    else if (a === '--max-cpu' && args[i + 1]) { params.set('max_cpu_percent', args[++i]!); }
    else if (a === '--min-memory' && args[i + 1]) { params.set('min_memory_gb', args[++i]!); }
  }

  // 5s timeout so a wedged serve cannot hang the CLI. Override with
  // AIWG_FETCH_TIMEOUT_MS for slow local environments or integration tests.
  const fetchTimeoutMs = (() => {
    const raw = process.env['AIWG_FETCH_TIMEOUT_MS'];
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 5_000;
  })();

  let result: { selected?: Record<string, unknown>; candidates: Record<string, unknown>[] };
  try {
    // Combine user-cancel (Ctrl-C) with the per-call timeout so the fetch
    // aborts on either. `AbortSignal.any` requires Node 20+.
    const signal = ctx.signal
      ? AbortSignal.any([ctx.signal, AbortSignal.timeout(fetchTimeoutMs)])
      : AbortSignal.timeout(fetchTimeoutMs);
    const resp = await fetch(`${base}/api/agents/candidates?${params.toString()}`, {
      signal,
    });
    if (!resp.ok) {
      ui.error(`aiwg serve returned ${resp.status} — is it running on port ${port}?`);
      return { exitCode: 1 };
    }
    result = await resp.json() as typeof result;
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      ui.error(`aiwg serve on port ${port} timed out after ${fetchTimeoutMs}ms. Is it wedged?`);
    } else {
      ui.error(`Cannot reach aiwg serve on port ${port}. Start it with: aiwg serve`);
    }
    return { exitCode: 1 };
  }

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return { exitCode: 0 };
  }

  ui.blank();
  console.log(`  ${ui.brandMark()} ${ui.bold('Agent Routing Candidates')}`);
  ui.rule();

  if (result.candidates.length === 0) {
    ui.info('No matching agents found for the given filter.');
    return { exitCode: 0 };
  }

  for (const c of result.candidates) {
    const agent = c['agent'] as Record<string, unknown> | undefined;
    const agentId = agent?.['agentId'] as string ?? '?';
    const logicalName = agent?.['logicalName'] as string | undefined;
    const sandboxName = c['sandboxName'] as string ?? '';
    const cpu = (agent?.['latestMetrics'] as Record<string, number> | undefined)?.['cpu_percent'];
    const status = agent?.['status'] as string ?? '';
    const isSelected = (result.selected as Record<string, unknown> | undefined)?.['sandboxName'] === sandboxName &&
      ((result.selected as Record<string, unknown>)?.['agent'] as Record<string, unknown> | undefined)?.['agentId'] === agentId;

    const label = logicalName ? `${logicalName} (${agentId})` : agentId;
    const cpuStr = cpu !== undefined ? ` cpu:${cpu.toFixed(0)}%` : '';
    const selectedMark = isSelected ? ' ← selected' : '';
    console.log(`  • ${ui.bold(label)}  sandbox:${sandboxName}  status:${status}${cpuStr}${selectedMark}`);
    const reason = c['matchReason'] as string | undefined;
    if (reason) console.log(`      reason: ${reason}`);
  }

  ui.blank();
  return { exitCode: 0 };
}
