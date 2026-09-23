import { DecisionGraphError, planDecisionGraph, type DecisionGraph, type GraphPlan } from './graph.js';
import { effectiveGraphCeilings, type GraphCeilings } from './graph-evidence.js';
import { canonicalJson } from '../security/artifact-trust.js';

type Usage = { attempts: number; tokens: number; costMicros: number };
const empty = (): Usage => ({ attempts: 0, tokens: 0, costMicros: 0 });
const fields = ['attempts', 'tokens', 'costMicros'] as const;
const safe = (value: number) => Number.isSafeInteger(value) && value >= 0;

/** Synchronous reservations protect cumulative and per-stage capacity before adapter calls.
 * Host estimates must be conservative bounds, including unknown cost. This is not a
 * network dispatcher; callers retain Flow identities, transport and authorization.
 */
export class GraphBudgetLedger {
  private total = empty();
  private readonly stages = new Map<number, Usage>();
  private readonly active = new Map<number, number>();
  private readonly stageStarted = new Map<number, number>();
  private cancelled = false;
  private readonly started: number;
  private readonly limits: DecisionGraph['budget'];
  constructor(private readonly graph: DecisionGraph, private readonly plan: GraphPlan,
    ceilings: GraphCeilings[] = [], private readonly clock: () => number = Date.now) {
    const pins = new Set(graph.nodes.flatMap(n => [n.definition.digest, n.binding.digest]));
    if (canonicalJson(plan) !== canonicalJson(planDecisionGraph(graph, pins))) throw new DecisionGraphError('graph/plan mismatch');
    this.limits = effectiveGraphCeilings(graph, ...ceilings);
    this.started = clock();
    if (!Number.isFinite(this.started)) throw new DecisionGraphError('invalid clock');
  }
  cancel(): void { this.cancelled = true; }
  /** All-or-nothing synchronous batch claim; no remote call occurs before every
   * member passes stage, graph and concurrency capacity checks. */
  reserveBatch(stage: number, estimates: readonly Usage[]): Array<(actual: Usage) => void> {
    if (!estimates.length || !estimates.every(e => fields.every(field => safe(e[field])) && e.attempts >= 1)) {
      throw new DecisionGraphError('invalid graph batch estimate');
    }
    const now = this.clock();
    if (this.cancelled) throw new DecisionGraphError('graph cancelled');
    if (!Number.isFinite(now) || now < this.started || now - this.started >= this.limits.deadlineMs ||
        !this.plan.stages.some(s => s.stage === stage)) throw new DecisionGraphError('graph batch deadline or stage invalid');
    const limit = this.graph.stageBudgets?.find(item => item.stage === stage)?.limits ?? this.limits;
    if (now - (this.stageStarted.get(stage) ?? now) >= limit.deadlineMs) throw new DecisionGraphError('stage deadline exhausted');
    const total = Object.fromEntries(fields.map(field => [field, estimates.reduce((sum, e) => sum + e[field], 0)])) as Usage;
    const spent = this.stages.get(stage) ?? empty();
    if (estimates.length + (this.active.get(stage) ?? 0) > Math.min(limit.concurrency, this.limits.concurrency) ||
        fields.some(field => !safe(total[field]) || this.total[field] + total[field] > this.limits[field] ||
          spent[field] + total[field] > limit[field])) throw new DecisionGraphError('graph batch budget exhausted');
    return estimates.map(estimate => this.reserveAt(stage, estimate, now));
  }
  reserve(stage: number, estimate: Usage): (actual: Usage) => void {
    return this.reserveAt(stage, estimate, this.clock());
  }
  private reserveAt(stage: number, estimate: Usage, now: number): (actual: Usage) => void {
    if (this.cancelled) throw new DecisionGraphError('graph cancelled');
    if (!Number.isFinite(now) || now < this.started || now - this.started >= this.limits.deadlineMs) {
      throw new DecisionGraphError('graph deadline exhausted');
    }
    if (!this.plan.stages.some(s => s.stage === stage)) throw new DecisionGraphError('unknown graph stage');
    if (!fields.every(field => safe(estimate[field])) || estimate.attempts < 1) throw new DecisionGraphError('invalid graph estimate');
    const stageLimit = this.graph.stageBudgets?.find(item => item.stage === stage)?.limits ?? this.limits;
    const stageStart = this.stageStarted.get(stage) ?? now;
    if (now - stageStart >= stageLimit.deadlineMs) throw new DecisionGraphError('stage deadline exhausted');
    const used = this.stages.get(stage) ?? empty();
    if ([this.total, used].some((spent, index) => fields.some(field =>
      spent[field] + estimate[field] > (index === 0 ? this.limits : stageLimit)[field]))) {
      throw new DecisionGraphError('graph budget exhausted');
    }
    const count = this.active.get(stage) ?? 0;
    if (count >= Math.min(this.limits.concurrency, stageLimit.concurrency)) throw new DecisionGraphError('graph concurrency exhausted');
    for (const field of fields) { this.total[field] += estimate[field]; used[field] += estimate[field]; }
    this.stages.set(stage, used); this.active.set(stage, count + 1);
    this.stageStarted.set(stage, stageStart);
    let settled = false;
    return (actual: Usage): void => {
      if (settled) throw new DecisionGraphError('graph reservation already settled');
      settled = true;
      this.active.set(stage, this.active.get(stage)! - 1);
      // Never refund an attempt: even a failed/uncertain dispatch consumes it.
      const finished = this.clock();
      if (!fields.every(field => safe(actual[field])) || fields.some(field => actual[field] > estimate[field]) ||
          !Number.isFinite(finished) || finished < now || finished - this.started > this.limits.deadlineMs ||
          finished - stageStart > stageLimit.deadlineMs) {
        this.cancelled = true;
        throw new DecisionGraphError('graph usage exceeded reservation');
      }
      for (const field of ['tokens', 'costMicros'] as const) {
        this.total[field] -= estimate[field] - actual[field]; used[field] -= estimate[field] - actual[field];
      }
    };
  }
}
