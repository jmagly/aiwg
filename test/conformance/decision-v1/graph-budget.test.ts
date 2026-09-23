import { describe, expect, it } from 'vitest';
import { GraphBudgetLedger } from '../../../src/decision/graph-budget.js';
import { planDecisionGraph, type DecisionGraph } from '../../../src/decision/graph.js';
const pin = { id: 'artifact', version: 'v1', digest: `sha256:${'a'.repeat(64)}` as const };
const hash = `sha256:${'b'.repeat(64)}` as const;
const budget = { attempts: 3, deadlineMs: 20, tokens: 10, costMicros: 10, fanOut: 1, beamWidth: 1, depth: 2, concurrency: 1 };
const graph: DecisionGraph = { schemaVersion: 'decision-graph/v1', id: 'ledger', entry: 'a', terminals: ['b'],
  nodes: ['a', 'b'].map((id, stage) => ({ id, stage, subject: 'case', target: 'jev', model: 'm', egress: 'local',
    stateDigest: hash, definition: pin, binding: pin, input: stage ? ['in'] : [], output: ['out'] })),
  edges: [{ from: 'a', to: 'b', source: 'out', destination: 'in' }], budget,
  stageBudgets: [{ stage: 1, limits: { ...budget, attempts: 1, tokens: 2, deadlineMs: 5 } }],
};
const plan = planDecisionGraph(graph, new Set([pin.digest]));
describe('DAG pre-dispatch reservation with fake clock', () => {
  it('DAG-019 enforces minimum caller ceiling and concurrent stage capacity', () => {
    let now = 0;
    const ledger = new GraphBudgetLedger(graph, plan, [{ tokens: 3 }], () => now);
    const settle = ledger.reserve(0, { attempts: 1, tokens: 2, costMicros: 2 });
    expect(() => ledger.reserve(0, { attempts: 1, tokens: 1, costMicros: 1 })).toThrow(/concurrency/);
    now = 2; settle({ attempts: 1, tokens: 1, costMicros: 1 });
    expect(() => ledger.reserve(1, { attempts: 1, tokens: 3, costMicros: 1 })).toThrow(/budget/);
    const finish = ledger.reserve(1, { attempts: 1, tokens: 2, costMicros: 1 });
    now = 4; finish({ attempts: 1, tokens: 2, costMicros: 1 });
    expect(() => ledger.reserve(1, { attempts: 1, tokens: 1, costMicros: 1 })).toThrow(/budget/);
  });
  it('DAG-020 cancels on cost overrun and limits per-stage/total fake-clock deadlines', () => {
    let now = 0;
    const ledger = new GraphBudgetLedger(graph, plan, [], () => now);
    const settle = ledger.reserve(1, { attempts: 1, tokens: 1, costMicros: 1 });
    now = 6;
    expect(() => settle({ attempts: 1, tokens: 1, costMicros: 1 })).toThrow(/reservation/);
    expect(() => ledger.reserve(0, { attempts: 1, tokens: 1, costMicros: 1 })).toThrow(/cancelled/);
    const next = new GraphBudgetLedger(graph, plan, [], () => now);
    now = 30;
    expect(() => next.reserve(0, { attempts: 1, tokens: 1, costMicros: 1 })).toThrow(/deadline/);
  });
  it('DAG-021 rejects invalid estimates and untrusted plan changes before dispatch', () => {
    const ledger = new GraphBudgetLedger(graph, plan, [], () => 0);
    expect(() => ledger.reserve(0, { attempts: 1, tokens: -1, costMicros: 1 })).toThrow(/estimate/);
    expect(() => new GraphBudgetLedger(graph, { ...plan, edges: [] })).toThrow(/mismatch/);
    ledger.cancel();
    expect(() => ledger.reserve(0, { attempts: 1, tokens: 1, costMicros: 1 })).toThrow(/cancelled/);
  });
});
