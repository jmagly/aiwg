/**
 * Mission Conductor (#1546).
 *
 * A Mission is the cross-stack dynamic-orchestration primitive (naming per
 * #1536): one durable, audited conductor fans worker cycles out across
 * *heterogeneous* agentic stacks (Claude ↔ Codex ↔ …) and aggregates results.
 * In-stack primitives (Claude's Workflow tool, Codex `/goal`) are the in-stack
 * WORKERS a Mission dispatches to — not substitutes for the conductor.
 *
 * This builds on the proven substrate (no new transport):
 *   - `routeMission()` (agent-router.ts) selects an executor by `ExecutorFilter`.
 *   - executors advertise their stack via the `runtime:<name>` capability
 *     (slice-1 convention; see agent-router cross-stack test).
 *   - StackAdapter (stack-adapters.ts) maps a worker cycle onto a stack's
 *     native primitive and supplies the `runtime:<name>` token to filter on.
 *
 * RETAINED-OWNERSHIP INVARIANT (non-negotiable, #1537 ADR, cross-stack):
 * the conductor owns the bookkeeping — activity log, best-output selection,
 * cost tracking, crash-resilient checkpoint/resume — IDENTICALLY regardless of
 * which stack each worker ran on. The native primitive drives worker mechanism
 * only; it never owns gates, durability, or provenance.
 *
 * @implements #1546
 */

import { routeMission } from './agent-router.js';
import type { ExecutorRegistration } from './executor-registry.js';
import { StackAdapterRegistry } from './stack-adapters.js';
import type { GraphExecutionMetadata, GraphRunIdentity } from '../flow/graph-metadata.js';
import { assertMissionWorkerHandoff } from '../mission-protocol/codecs.js';
import { lookupEffect, reconcileEffect, recordIntent, type EffectLedger, type EffectReceipt } from '../effects/ledger.js';
import { createVerifierRegistry } from '../effects/verifiers/registry.js';
import { fileDigestVerifier } from '../effects/verifiers/file.js';
import type { WorkerResult, WorkerDirectResult } from '../mission-protocol/types.js';
export { summarizeMissionLedger } from './mission-summary.js';

/** A single worker cycle within a Mission — runs on exactly one stack. */
export interface WorkerCycle {
  id: string;
  /** Which stack runs this worker (resolved to a `runtime:<name>` filter). */
  runtime: string;
  /** The worker task the dispatched executor drives via its native primitive. */
  prompt: string;
  /** Additional capabilities the executor must advertise (beyond the runtime). */
  requiredCapabilities?: string[];
  /** Long-running workers require the `resumable` capability (per ADR §3). */
  longRunning?: boolean;
  /** The worker's sole effect. The conductor records intent before dispatch and verifies completion.
   * Host-supplied digests must describe the intended bytes and, for replacement, the pre-write bytes. */
  fileEffect?: { target: string; payloadDigest: string; previousDigest?: string };
  /** Graph node projection. Present only for GraphPlaybook missions. */
  graph?: Omit<GraphExecutionMetadata, 'schemaVersion' | 'graphId' | 'graphVersion' | 'runId' | 'nodeRunId'> & {
    nodeRunId?: string;
  };
}

/** A Mission: a goal + measurable completion criterion + worker cycles. */
export interface MissionPlan {
  missionId: string;
  goal: string;
  /** Measurable completion criterion (per the vague-discretion rule). */
  completionCriterion: string;
  cycles: WorkerCycle[];
  /** Required when any cycle is projected from a GraphPlaybook. */
  graph?: GraphRunIdentity;
}

/** Outcome of dispatching one worker cycle. */
export interface CycleResult {
  cycleId: string;
  runtime: string;
  primitive: string;
  executorId?: string;
  /** True when an executor advertising the cycle's runtime was selected. */
  routed: boolean;
  reason: string;
  output?: string;
  /** Existing adapter/verifier result, retained without creating an acceptance store. */
  workerResult?: WorkerResult | WorkerDirectResult;
  /** Runtime-agnostic cost units (e.g. output tokens) for cross-stack aggregation. */
  cost: number;
  graph?: GraphExecutionMetadata;
}

/**
 * Conductor-side ledger. The retained-ownership invariant means every field
 * here is populated the same way regardless of which stack ran each worker.
 */
export interface MissionLedger {
  missionId: string;
  goal: string;
  completionCriterion: string;
  /** Mode of this conductor pass. Absent on legacy ledgers. */
  executionMode?: 'plan-only' | 'executed';
  /** Scorer used by this pass; null means best-output selection is unavailable. */
  scorerId?: string | null;
  /** Append-only audit trail (one line per conductor decision/observation). */
  activityLog: string[];
  cycles: CycleResult[];
  /** Cross-stack cost aggregation. */
  totalCost: number;
  /** Best-output selection (REF-015) across the cycles that produced output. */
  bestOutput?: { cycleId: string; runtime: string; output: string; score: number };
  /** Crash-resilient checkpoint: which cycles completed vs. remain. */
  checkpoint: { completed: string[]; pending: string[]; failed: string[] };
  /** Distinct stacks a worker actually ran on. */
  runtimesUsed: string[];
  /** Optional for ordinary Missions; required for GraphPlaybook projections. */
  graph?: GraphRunIdentity;
}

/**
 * Runs a single dispatched worker on its selected executor. The real seam to
 * `aiwg serve`'s dispatch-router + WS event stream plugs in here; tests inject
 * a fake. Without a worker, planning marks the cycle as routed-but-not-executed so the
 * conductor is honest about what is wired vs. pending the live transport.
 */
export type RunWorker = (
  cycle: WorkerCycle,
  executor: ExecutorRegistration,
  invocation: { runtimeCapability: string; primitive: string; describe: string },
) => { output?: string; cost?: number; workerResult?: CycleResult['workerResult'] }
  | Promise<{ output?: string; cost?: number; workerResult?: CycleResult['workerResult'] }>;

/** Scores a worker output against the mission's outcome; higher is better. */
export type ScoreOutput = (result: CycleResult) => number;

export interface ConductorOptions {
  adapters?: StackAdapterRegistry;
  /** Worker execution seam (default: plan-only, no execution). */
  runWorker?: RunWorker;
  /** Outcome scorer (e.g. executable checks). Without one, no best output is reported. */
  scoreOutput?: ScoreOutput;
  /** Stable evaluator identity/version. Defaults to 'custom' when scoreOutput is supplied. */
  scorerId?: string;
  /** Resume from a prior ledger's checkpoint (skip already-completed cycles). */
  resumeFrom?: MissionLedger;
  /** Host-owned durable ledger for cycles declaring a file effect; its projectDir bounds file reads. */
  effectLedger?: EffectLedger;
}

/**
 * The cross-stack Mission conductor. Decomposes a Mission into worker cycles,
 * dispatches each to an executor of the chosen runtime via `routeMission`, and
 * retains all bookkeeping conductor-side regardless of stack.
 */
export class MissionConductor {
  private adapters: StackAdapterRegistry;
  private runWorker?: RunWorker;
  private scoreOutput?: ScoreOutput;
  private scorerId: string | null;
  private effectLedger?: EffectLedger;

  constructor(opts: ConductorOptions = {}) {
    this.adapters = opts.adapters ?? new StackAdapterRegistry();
    this.runWorker = opts.runWorker;
    this.scoreOutput = opts.scoreOutput;
    this.scorerId = opts.scoreOutput ? (opts.scorerId ?? 'custom') : null;
    this.effectLedger = opts.effectLedger;
  }

  /**
   * Conduct a Mission across the given executor pool. Returns the ledger.
   * `resumeFrom` (if given) skips cycles already marked completed — the
   * crash-resilient resume path; their prior results are carried forward.
   */
  async conduct(plan: MissionPlan, pool: ExecutorRegistration[], resumeFrom?: MissionLedger): Promise<MissionLedger> {
    assertMissionWorkerHandoff(plan, 'mission-conductor');
    for (const cycle of plan.cycles) assertMissionWorkerHandoff(cycle, 'mission-conductor');
    if (resumeFrom) {
      assertMissionWorkerHandoff(resumeFrom, 'mission-conductor');
      for (const cycle of resumeFrom.cycles) assertMissionWorkerHandoff(cycle, 'mission-conductor');
    }
    if (plan.cycles.some((cycle) => cycle.graph) && !plan.graph) {
      throw new Error('Graph-projected worker cycles require MissionPlan.graph identity.');
    }
    const carried = new Map<string, CycleResult>();
    if (resumeFrom) {
      for (const c of resumeFrom.cycles) {
        if (resumeFrom.checkpoint.completed.includes(c.cycleId)) carried.set(c.cycleId, c);
      }
    }

    const ledger: MissionLedger = {
      missionId: plan.missionId,
      goal: plan.goal,
      completionCriterion: plan.completionCriterion,
      executionMode: this.runWorker ? 'executed' : 'plan-only',
      scorerId: this.scorerId,
      activityLog: [],
      cycles: [],
      totalCost: 0,
      checkpoint: { completed: [], pending: [], failed: [] },
      runtimesUsed: [],
      ...(plan.graph ? { graph: structuredClone(plan.graph) } : {}),
    };

    ledger.activityLog.push(
      `mission ${plan.missionId} start — goal: ${plan.goal} — ${plan.cycles.length} cycle(s)` +
        ` — mode: ${ledger.executionMode}, scorer: ${ledger.scorerId ?? '(none)'}` +
        (resumeFrom ? ` (resume: ${carried.size} carried)` : ''),
    );

    for (const cycle of plan.cycles) {
      const graph = plan.graph && cycle.graph ? {
        ...structuredClone(plan.graph),
        ...structuredClone(cycle.graph),
        schemaVersion: 'graph.flow.aiwg.io/v1' as const,
        nodeRunId: cycle.graph.nodeRunId ?? `${plan.graph.runId}:${cycle.graph.nodeId}`,
      } : undefined;
      // Resume: carry a previously-completed cycle forward, identical bookkeeping.
      const prior = carried.get(cycle.id);
      if (prior) {
        ledger.cycles.push(prior);
        ledger.checkpoint.completed.push(cycle.id);
        ledger.totalCost += prior.cost;
        if (prior.executorId) ledger.activityLog.push(`cycle ${cycle.id} resumed (was complete on ${prior.runtime})`);
        continue;
      }

      const adapter = this.adapters.get(cycle.runtime);
      if (!adapter) {
        // No silent drop — record the unroutable cycle (vague-discretion / anti-laziness).
        const result: CycleResult = {
          cycleId: cycle.id,
          runtime: cycle.runtime,
          primitive: '(none)',
          routed: false,
          reason: `no stack adapter registered for runtime '${cycle.runtime}'`,
          cost: 0,
          ...(graph ? { graph } : {}),
        };
        ledger.cycles.push(result);
        ledger.checkpoint.failed.push(cycle.id);
        ledger.activityLog.push(`cycle ${cycle.id} UNROUTABLE — ${result.reason}`);
        continue;
      }

      const filter = {
        capabilities: [adapter.runtimeCapability, ...(cycle.requiredCapabilities ?? [])],
      };
      const routing = routeMission(pool, filter, cycle.longRunning ?? false);

      if (!routing.selected) {
        const result: CycleResult = {
          cycleId: cycle.id,
          runtime: cycle.runtime,
          primitive: adapter.primitive,
          routed: false,
          reason: `no connected executor advertises ${filter.capabilities.join(', ')}`,
          cost: 0,
          ...(graph ? { graph } : {}),
        };
        ledger.cycles.push(result);
        ledger.checkpoint.failed.push(cycle.id);
        ledger.activityLog.push(`cycle ${cycle.id} UNASSIGNED — ${result.reason}`);
        continue;
      }

      const executor = routing.selected.executor;
      const invocation = adapter.invoke(cycle.prompt, graph);
      ledger.activityLog.push(
        `cycle ${cycle.id} → executor ${executor.name} (${executor.executorId}) on ${cycle.runtime}: ${invocation.describe}`,
      );

      if (!this.runWorker) {
        ledger.cycles.push({
          cycleId: cycle.id,
          runtime: cycle.runtime,
          primitive: adapter.primitive,
          executorId: executor.executorId,
          routed: true,
          reason: 'plan-only: worker not configured; execution pending',
          cost: 0,
          ...(graph ? { graph } : {}),
        });
        ledger.activityLog.push(`cycle ${cycle.id} PLANNED on ${cycle.runtime} — execution pending`);
        continue;
      }

      let output: string | undefined;
      let workerResult: CycleResult['workerResult'];
      let cost = 0;
      let reason = routing.selected.matchReason;
      try {
        let intent: EffectReceipt | undefined;
        let recovered = false;
        const effects = this.effectLedger;
        const reconcile = (id: string) => reconcileEffect(effects!, id, {
          verifiers: createVerifierRegistry([fileDigestVerifier({ root: effects!.projectDir })]),
          expected: { previousDigest: cycle.fileEffect!.previousDigest ?? null },
        });
        if (cycle.fileEffect) {
          if (!effects) throw new Error('file effect requires a host-configured effect ledger');
          const { target, payloadDigest, previousDigest } = cycle.fileEffect;
          intent = await recordIntent(effects, {
            kind: 'file.digest', target, payloadDigest,
            context: { missionId: plan.missionId, cycleId: cycle.id,
              ...(previousDigest === undefined ? {} : { previousDigest }) },
          });
          const recorded = await lookupEffect(effects, intent.effectId);
          if (recorded.tombstoned || recorded.records.some(record => record.phase === 'failed')) {
            throw new Error(`file effect ${intent.effectId} replay blocked: terminal outcome or tombstone`);
          }
          recovered = recorded.records.some(record => record.phase === 'completed');
          if (!recovered) {
            const checked = await reconcile(intent.effectId);
            if (checked.result.verification.result === 'unknown') {
              throw new Error(`file effect ${intent.effectId} replay blocked: ${checked.result.verification.reason}`);
            }
            recovered = checked.completed !== null;
          }
          if (recovered) reason = `file effect ${intent.effectId} completed; worker replay skipped`;
        }
        if (!recovered) {
          const ran = await this.runWorker(cycle, executor, invocation);
          output = ran.output;
          workerResult = ran.workerResult === undefined ? undefined : structuredClone(ran.workerResult);
          cost = ran.cost ?? 0;
          if (intent) {
            const checked = await reconcile(intent.effectId);
            if (!checked.completed) throw new Error(`file effect ${intent.effectId} completion unverified: ${checked.result.verification.reason}`);
          }
        }
      } catch (err) {
        const result: CycleResult = {
          cycleId: cycle.id,
          runtime: cycle.runtime,
          primitive: adapter.primitive,
          executorId: executor.executorId,
          routed: true,
          reason: `worker error: ${err instanceof Error ? err.message : String(err)}`,
          cost: 0,
          ...(graph ? { graph } : {}),
        };
        ledger.cycles.push(result);
        ledger.checkpoint.failed.push(cycle.id);
        ledger.activityLog.push(`cycle ${cycle.id} FAILED on ${cycle.runtime} — ${result.reason}`);
        continue;
      }

      const result: CycleResult = {
        cycleId: cycle.id,
        runtime: cycle.runtime,
        primitive: adapter.primitive,
        executorId: executor.executorId,
        routed: true,
        reason,
        output,
        ...(workerResult ? { workerResult } : {}),
        cost,
        ...(graph ? { graph } : {}),
      };
      ledger.cycles.push(result);
      ledger.checkpoint.completed.push(cycle.id);
      ledger.totalCost += cost;
      ledger.activityLog.push(`cycle ${cycle.id} done on ${cycle.runtime} (cost ${cost})`);
    }

    // Planned cycles remain pending until a worker executes them.
    const accounted = new Set([...ledger.checkpoint.completed, ...ledger.checkpoint.failed]);
    ledger.checkpoint.pending = plan.cycles.map((c) => c.id).filter((id) => !accounted.has(id));

    // Cross-stack aggregation: distinct runtimes that actually ran a worker.
    ledger.runtimesUsed = [
      ...new Set(ledger.cycles.filter((c) => c.routed && accounted.has(c.cycleId)).map((c) => c.runtime)),
    ];

    // Best-output selection (REF-015) — conductor-side, across stacks.
    let best: MissionLedger['bestOutput'] | undefined;
    if (this.scoreOutput) {
      for (const c of ledger.cycles) {
        if (c.output === undefined) continue;
        const score = this.scoreOutput(c);
        if (!Number.isFinite(score)) {
          ledger.activityLog.push(`cycle ${c.cycleId} UNSCORED — scorer ${this.scorerId} returned a non-finite score`);
          continue;
        }
        if (!best || score > best.score) {
          best = { cycleId: c.cycleId, runtime: c.runtime, output: c.output, score };
        }
      }
    } else {
      ledger.activityLog.push('best-output unavailable: no scorer configured');
    }
    ledger.bestOutput = best;

    ledger.activityLog.push(
      `mission ${plan.missionId} end — completed ${ledger.checkpoint.completed.length}, ` +
        `failed ${ledger.checkpoint.failed.length}, runtimes [${ledger.runtimesUsed.join(', ')}], ` +
        `total cost ${ledger.totalCost}`,
    );

    return ledger;
  }
}
