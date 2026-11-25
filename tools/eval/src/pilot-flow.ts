// Exercise the existing FlowGraph runtime with a local, fixture-only node adapter.
// @ts-expect-error The existing addon runtime is an untyped ESM module.
import { executeFlowGraph } from '../../../agentic/code/addons/composition-engine/lib/runtime.mjs';
import type { PilotArm, PilotPins, PilotTask, ResponseTape } from './pilot-types.js';

export async function executeFixtureFlow(graph: any, arm: PilotArm, task: Pick<PilotTask, 'input'>, tape: ResponseTape, pins: PilotPins) {
  let text = tape.text;
  let needs = !tape.self_pass;
  let verified = false;
  let invalidTransitions = 0;
  const effects: string[] = [];
  const idempotency = new Set<string>();
  const report = await executeFlowGraph(graph, {
    runId: 'offline-fixture',
    adapterId: 'offline-fixture-v1',
    invokeNode: async ({ node }: any) => {
      if (node.id === 'draft') { text = tape.text; needs = arm.configuration === 'loop' || !tape.self_pass; }
      if (node.id === 'repair' || (node.id === 'prepare' && needs)) { text = tape.refined ?? text; needs = false; }
      if (node.id === 'verify') verified = true;
      if (node.id === 'publish') {
        if (!verified) invalidTransitions++;
        for (let attempt = 0; attempt < (task.input.retry ? 2 : 1); attempt++) {
          const key = 'fixture-effect';
          if (node.idempotencyKey && idempotency.has(key)) continue;
          idempotency.add(key); effects.push(key);
        }
      }
      return {
        outputs: { artifact: text, needs },
        usage: { tokens: Math.ceil(tape.total_tokens / 4), costUsd: 0, timeMs: Math.ceil(tape.latency_ms / 4) },
      };
    },
  });
  const realized = report.realizedResources;
  // The immutable dataset budget also bounds resources of every control structure.
  const exceeded = realized.tokens > pins.budget.total_tokens || realized.timeMs > pins.budget.latency_ms;
  return {
    text,
    status: (exceeded ? 'partial' : report.status === 'completed' ? tape.status : 'failed') as ResponseTape['status'],
    total_tokens: realized.tokens as number,
    latency_ms: realized.timeMs as number,
    tool_calls: effects.length,
    invalid_transitions: invalidTransitions,
    duplicate_effects: Math.max(0, effects.length - 1),
    trace: report.trace,
    flow_evidence: report.evidence,
  };
}
