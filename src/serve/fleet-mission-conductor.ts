/**
 * Fleet Mission Conductor — management-plane orchestration over N executor
 * targets using the neutral fleet-workload/v1 vocabulary.
 *
 * AIWG owns parent fan-out, aggregation, audit, and completion. Execution
 * substrates (Agentic Sandbox first, other adapters later) own target-local
 * lifecycle and report revisioned observations through the RunFleetWorker seam.
 *
 * @implements #1991
 */

import { routeMission } from './agent-router.js';
import { routeCycleWorker, type RoutedWorkerInvocation } from './cycle-delegation.js';
import type { ExecutorRegistration } from './executor-registry.js';
import type { CycleResult, MissionLedger, MissionPlan, WorkerCycle } from './mission-conductor.js';
import { StackAdapterRegistry } from './stack-adapters.js';
import { assertMissionWorkerHandoff } from '../mission-protocol/codecs.js';

export type WorkloadKind =
  | 'persistent-agent'
  | 'daemon'
  | 'scheduled-collector'
  | 'one-shot-command';

export type ObservedState =
  | 'pending'
  | 'admitted'
  | 'starting'
  | 'running'
  | 'blocked'
  | 'detached'
  | 'retained'
  | 'healthy'
  | 'degraded'
  | 'restarting'
  | 'scheduled'
  | 'missed'
  | 'catching-up'
  | 'stopping'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed-out'
  | 'unknown'
  | 'operator-review-required';

export type BackpressureReason = 'capacity' | 'policy' | 'approval' | 'rate-limit' | 'dependency';
export type EvidenceKind = 'result' | 'log' | 'telemetry' | 'verifier' | 'other';

export interface FleetArtifact {
  kind: EvidenceKind;
  uri: string;
  sha256: string;
}

export interface FleetBackpressure {
  reason: BackpressureReason;
  retryable: boolean;
  retryAfter?: string;
}

export interface FleetEvent {
  revision: number;
  observedState: ObservedState;
  lastSeen: string;
  commandId?: string;
  taskId?: string;
  sessionId?: string;
  health?: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  backpressure?: FleetBackpressure;
  artifacts?: FleetArtifact[];
  errorCode?: string;
}

export interface FleetWorkerCycle extends WorkerCycle {
  workloadKind: WorkloadKind;
  /** Stable management-plane identity; generated from mission/cycle when omitted. */
  dispatchId?: string;
  idempotencyKey?: string;
  /** Optional hard target selection in addition to executor capability routing. */
  targetId?: string;
  /** Evidence kinds that must be present before this child may satisfy the parent. */
  requiredEvidence?: EvidenceKind[];
  /** Required for scheduled collectors; transported without interpreting cron syntax. */
  schedule?: string;
  policy?: {
    trustTier: `T${number}`;
    isolationKind: 'host' | 'container' | 'vm' | 'microvm' | 'custom';
    credentialPolicyRef?: string;
    networkPolicyRef?: string;
  };
  budgets?: { maxAttempts: number; timeoutSeconds: number; maxCostUsd?: number };
}

export type AggregationPolicy =
  | { mode: 'all-pass' }
  | { mode: 'quorum'; minimumSuccesses: number }
  | { mode: 'best-output' }
  | { mode: 'fail-fast' }
  | { mode: 'manual-review' };

export interface FleetMissionPlan extends Omit<MissionPlan, 'cycles'> {
  orchestratorId: string;
  cycles: FleetWorkerCycle[];
  aggregation: AggregationPolicy;
  /** Defaults to true: parent fan-out should use distinct executor targets. */
  requireDistinctTargets?: boolean;
}

export interface FleetLineage {
  orchestratorId: string;
  missionId: string;
  dispatchId: string;
  idempotencyKey: string;
  parentId: string | null;
  childId: string;
  targetId: string;
  executorId: string;
  runtimeId: string;
}

export interface FleetRunResult {
  output?: string;
  cost?: number;
  commandId?: string;
  sessionId?: string;
  events: FleetEvent[];
}

export type RunFleetWorker = (
  cycle: FleetWorkerCycle,
  executor: ExecutorRegistration,
  invocation: RoutedWorkerInvocation,
  lineage: FleetLineage,
) => FleetRunResult | Promise<FleetRunResult>;

export interface FleetCycleResult extends CycleResult {
  workloadKind: WorkloadKind;
  lineage?: FleetLineage;
  commandId?: string;
  taskId?: string;
  sessionId?: string;
  observedState: ObservedState;
  revision: number;
  lastSeen?: string;
  health?: FleetEvent['health'];
  backpressure?: FleetBackpressure;
  artifacts: FleetArtifact[];
  staleEventRevisions: number[];
  evidenceComplete: boolean;
  satisfied: boolean;
}

export interface FleetAggregation {
  policy: AggregationPolicy;
  successful: number;
  failed: number;
  pending: number;
  reviewRequired: number;
  evidenceMissing: string[];
  completionEligible: boolean;
  reason: string;
}

export interface FleetMissionLedger extends Omit<MissionLedger, 'cycles'> {
  cycles: FleetCycleResult[];
  parentState: 'pending' | 'running' | 'completed' | 'failed' | 'operator-review-required';
  aggregation: FleetAggregation;
}

export interface FleetLedgerStore {
  /** Persist an immutable snapshot; implementations provide actual durability. */
  save(ledger: FleetMissionLedger): void | Promise<void>;
}

export interface FleetConductorOptions {
  cwd?: string;
  adapters?: StackAdapterRegistry;
  runWorker: RunFleetWorker;
  scoreOutput?: (result: FleetCycleResult) => number;
  ledgerStore?: FleetLedgerStore;
}

const terminalFailures = new Set<ObservedState>(['failed', 'cancelled', 'timed-out']);
const reviewStates = new Set<ObservedState>(['unknown', 'operator-review-required']);

function lifecycleSatisfied(kind: WorkloadKind, state: ObservedState, health?: FleetEvent['health']): boolean {
  switch (kind) {
    case 'one-shot-command': return state === 'succeeded';
    case 'persistent-agent': return state === 'retained' || state === 'detached' || state === 'running';
    case 'daemon': return (state === 'healthy' || state === 'running') && health === 'healthy';
    case 'scheduled-collector': return state === 'scheduled' || state === 'succeeded';
  }
}

function collapseEvents(events: FleetEvent[]): {
  latest?: FleetEvent;
  stale: number[];
  artifacts: FleetArtifact[];
} {
  let latest: FleetEvent | undefined;
  const stale: number[] = [];
  const artifacts = new Map<string, FleetArtifact>();
  for (const event of events) {
    if (latest && event.revision <= latest.revision) {
      stale.push(event.revision);
      continue;
    }
    latest = event;
    for (const artifact of event.artifacts ?? []) artifacts.set(`${artifact.kind}:${artifact.uri}`, artifact);
  }
  return { latest, stale, artifacts: [...artifacts.values()] };
}

function emptyAggregation(policy: AggregationPolicy): FleetAggregation {
  return {
    policy,
    successful: 0,
    failed: 0,
    pending: 0,
    reviewRequired: 0,
    evidenceMissing: [],
    completionEligible: false,
    reason: 'children have not been evaluated',
  };
}

function aggregate(policy: AggregationPolicy, cycles: FleetCycleResult[]): FleetAggregation {
  const successful = cycles.filter((cycle) => cycle.satisfied).length;
  const failed = cycles.filter((cycle) => terminalFailures.has(cycle.observedState)).length;
  const reviewRequired = cycles.filter((cycle) => reviewStates.has(cycle.observedState)).length;
  const pending = cycles.length - successful - failed - reviewRequired;
  const evidenceMissing = cycles.filter((cycle) => !cycle.evidenceComplete).map((cycle) => cycle.cycleId);
  const allEvidence = evidenceMissing.length === 0;
  let policySatisfied = false;
  let reason = '';

  switch (policy.mode) {
    case 'all-pass':
      policySatisfied = cycles.length > 0 && successful === cycles.length;
      reason = `${successful}/${cycles.length} children satisfied all-pass`;
      break;
    case 'quorum':
      policySatisfied = successful >= policy.minimumSuccesses;
      reason = `${successful}/${policy.minimumSuccesses} quorum successes`;
      break;
    case 'best-output':
      policySatisfied = cycles.some((cycle) => cycle.satisfied && Boolean(cycle.output));
      reason = policySatisfied ? 'at least one satisfied child produced output' : 'no satisfied child produced output';
      break;
    case 'fail-fast':
      policySatisfied = failed === 0 && cycles.length > 0 && successful === cycles.length;
      reason = failed > 0 ? 'a child reached a terminal failure' : `${successful}/${cycles.length} children satisfied`;
      break;
    case 'manual-review':
      policySatisfied = false;
      reason = 'manual-review policy requires an audited operator decision';
      break;
  }

  if (reviewRequired > 0) reason = `${reviewRequired} child observation(s) require operator review`;
  if (!allEvidence) reason = `required evidence missing for: ${evidenceMissing.join(', ')}`;

  return {
    policy,
    successful,
    failed,
    pending,
    reviewRequired,
    evidenceMissing,
    completionEligible: policySatisfied && allEvidence && reviewRequired === 0,
    reason,
  };
}

function cloneLedger(ledger: FleetMissionLedger): FleetMissionLedger {
  return structuredClone(ledger);
}

/**
 * Runs every newly admitted child concurrently. Target allocation happens
 * before execution, so one slow child cannot serialize unrelated work.
 */
export class FleetMissionConductor {
  private readonly adapters: StackAdapterRegistry;
  private readonly runWorker: RunFleetWorker;
  private readonly scoreOutput: (result: FleetCycleResult) => number;
  private readonly ledgerStore?: FleetLedgerStore;
  /** Prevent concurrent child completions from committing snapshots out of order. */
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: FleetConductorOptions) {
    this.adapters = options.adapters ?? new StackAdapterRegistry();
    this.runWorker = options.runWorker;
    this.scoreOutput = options.scoreOutput ?? ((result) => result.output?.length ?? 0);
    this.ledgerStore = options.ledgerStore;
  }

  async conduct(
    plan: FleetMissionPlan,
    pool: ExecutorRegistration[],
    resumeFrom?: FleetMissionLedger,
  ): Promise<FleetMissionLedger> {
    assertMissionWorkerHandoff(plan, 'fleet-conductor');
    for (const cycle of plan.cycles) assertMissionWorkerHandoff(cycle, 'fleet-conductor');
    if (resumeFrom) {
      assertMissionWorkerHandoff(resumeFrom, 'fleet-conductor');
      for (const cycle of resumeFrom.cycles) assertMissionWorkerHandoff(cycle, 'fleet-conductor');
    }
    const priorById = new Map((resumeFrom?.cycles ?? []).map((cycle) => [cycle.cycleId, cycle]));
    const ledger: FleetMissionLedger = {
      missionId: plan.missionId,
      goal: plan.goal,
      completionCriterion: plan.completionCriterion,
      activityLog: [`mission ${plan.missionId} fleet start — ${plan.cycles.length} child workload(s)`],
      cycles: [],
      totalCost: 0,
      checkpoint: { completed: [], pending: plan.cycles.map((cycle) => cycle.id), failed: [] },
      runtimesUsed: [],
      parentState: 'running',
      aggregation: emptyAggregation(plan.aggregation),
    };

    const admitted: Array<{
      cycle: FleetWorkerCycle;
      executor: ExecutorRegistration;
      invocation: { runtimeCapability: string; primitive: string; describe: string };
      lineage: FleetLineage;
    }> = [];
    const usedExecutors = new Set<string>();

    for (const cycle of plan.cycles) {
      const prior = priorById.get(cycle.id);
      if (prior?.satisfied && prior.evidenceComplete && !reviewStates.has(prior.observedState)) {
        ledger.cycles.push(prior);
        ledger.activityLog.push(`child ${cycle.id} re-adopted from durable completed state`);
        continue;
      }

      const adapter = this.adapters.get(cycle.runtime);
      if (!adapter) {
        ledger.cycles.push(this.unroutable(cycle, `no stack adapter registered for runtime '${cycle.runtime}'`));
        continue;
      }

      let candidates = pool;
      if (cycle.targetId) candidates = candidates.filter((executor) => executor.executorId === cycle.targetId);
      if (plan.requireDistinctTargets !== false) {
        candidates = candidates.filter((executor) => !usedExecutors.has(executor.executorId));
      }
      const routing = routeMission(candidates, {
        capabilities: [adapter.runtimeCapability, ...(cycle.requiredCapabilities ?? [])],
      }, cycle.longRunning ?? false);
      if (!routing.selected) {
        ledger.cycles.push(this.unroutable(cycle, 'no distinct connected executor satisfies the child requirements'));
        continue;
      }

      const executor = routing.selected.executor;
      usedExecutors.add(executor.executorId);
      const dispatchId = cycle.dispatchId ?? `${plan.missionId}:${cycle.id}:dispatch`;
      const lineage: FleetLineage = {
        orchestratorId: plan.orchestratorId,
        missionId: plan.missionId,
        dispatchId,
        idempotencyKey: cycle.idempotencyKey ?? dispatchId,
        parentId: plan.missionId,
        childId: cycle.id,
        targetId: cycle.targetId ?? executor.executorId,
        executorId: executor.executorId,
        runtimeId: cycle.runtime,
      };
      admitted.push({ cycle, executor, invocation: adapter.invoke(cycle.prompt), lineage });
      ledger.activityLog.push(`child ${cycle.id} admitted on target ${lineage.targetId} as ${cycle.workloadKind}`);
    }

    ledger.aggregation = aggregate(plan.aggregation, ledger.cycles);
    await this.persist(ledger);

    await Promise.all(admitted.map(async ({ cycle, executor, invocation, lineage }) => {
      let result: FleetCycleResult;
      try {
        const selected = await routeCycleWorker(cycle, invocation, ledger.activityLog, this.options.cwd);
        const ran = await this.runWorker(cycle, executor, selected, lineage);
        const collapsed = collapseEvents(ran.events);
        const latest = collapsed.latest;
        const observedState = latest?.observedState ?? 'unknown';
        const artifacts = collapsed.artifacts;
        const required = cycle.requiredEvidence ?? [];
        const evidenceComplete = required.every((kind) => artifacts.some((artifact) => artifact.kind === kind));
        result = {
          cycleId: cycle.id,
          runtime: cycle.runtime,
          primitive: invocation.primitive,
          executorId: executor.executorId,
          routed: true,
          reason: latest ? `observed revision ${latest.revision}: ${observedState}` : 'runtime returned no lifecycle event',
          output: ran.output,
          cost: ran.cost ?? 0,
          workloadKind: cycle.workloadKind,
          lineage,
          commandId: ran.commandId ?? latest?.commandId,
          taskId: latest?.taskId,
          sessionId: ran.sessionId ?? latest?.sessionId,
          observedState,
          revision: latest?.revision ?? 0,
          lastSeen: latest?.lastSeen,
          health: latest?.health,
          backpressure: latest?.backpressure,
          artifacts,
          staleEventRevisions: collapsed.stale,
          evidenceComplete,
          satisfied: evidenceComplete && lifecycleSatisfied(cycle.workloadKind, observedState, latest?.health),
        };
      } catch (error) {
        result = {
          cycleId: cycle.id,
          runtime: cycle.runtime,
          primitive: invocation.primitive,
          executorId: executor.executorId,
          routed: true,
          reason: `worker error: ${error instanceof Error ? error.message : String(error)}`,
          cost: 0,
          workloadKind: cycle.workloadKind,
          lineage,
          observedState: 'unknown',
          revision: 0,
          artifacts: [],
          staleEventRevisions: [],
          evidenceComplete: (cycle.requiredEvidence ?? []).length === 0,
          satisfied: false,
        };
      }
      ledger.cycles.push(result);
      ledger.activityLog.push(`child ${cycle.id} observed ${result.observedState} at revision ${result.revision}`);
      ledger.aggregation = aggregate(plan.aggregation, ledger.cycles);
      await this.persist(ledger);
    }));

    // Stable plan order makes durable snapshots and UI projection deterministic.
    const order = new Map(plan.cycles.map((cycle, index) => [cycle.id, index]));
    ledger.cycles.sort((a, b) => (order.get(a.cycleId) ?? 0) - (order.get(b.cycleId) ?? 0));
    ledger.totalCost = ledger.cycles.reduce((sum, cycle) => sum + cycle.cost, 0);
    ledger.runtimesUsed = [...new Set(ledger.cycles.filter((cycle) => cycle.routed).map((cycle) => cycle.runtime))];
    ledger.checkpoint = {
      completed: ledger.cycles.filter((cycle) => cycle.satisfied).map((cycle) => cycle.cycleId),
      failed: ledger.cycles.filter((cycle) => terminalFailures.has(cycle.observedState)).map((cycle) => cycle.cycleId),
      pending: ledger.cycles.filter((cycle) => !cycle.satisfied && !terminalFailures.has(cycle.observedState)).map((cycle) => cycle.cycleId),
    };
    let best: FleetMissionLedger['bestOutput'];
    for (const cycle of ledger.cycles) {
      if (!cycle.output || !cycle.satisfied) continue;
      const score = this.scoreOutput(cycle);
      if (!best || score > best.score) best = { cycleId: cycle.cycleId, runtime: cycle.runtime, output: cycle.output, score };
    }
    ledger.bestOutput = best;
    ledger.aggregation = aggregate(plan.aggregation, ledger.cycles);
    ledger.parentState = ledger.aggregation.completionEligible
      ? 'completed'
      : ledger.aggregation.reviewRequired > 0 || plan.aggregation.mode === 'manual-review'
        ? 'operator-review-required'
        : ledger.aggregation.failed > 0
          ? 'failed'
          : 'pending';
    ledger.activityLog.push(`mission ${plan.missionId} fleet end — ${ledger.parentState}: ${ledger.aggregation.reason}`);
    await this.persist(ledger);
    return ledger;
  }

  private unroutable(cycle: FleetWorkerCycle, reason: string): FleetCycleResult {
    return {
      cycleId: cycle.id,
      runtime: cycle.runtime,
      primitive: '(none)',
      routed: false,
      reason,
      cost: 0,
      workloadKind: cycle.workloadKind,
      observedState: 'operator-review-required',
      revision: 0,
      artifacts: [],
      staleEventRevisions: [],
      evidenceComplete: (cycle.requiredEvidence ?? []).length === 0,
      satisfied: false,
    };
  }

  private async persist(ledger: FleetMissionLedger): Promise<void> {
    if (!this.ledgerStore) return;
    const snapshot = cloneLedger(ledger);
    this.persistQueue = this.persistQueue.then(async () => {
      await this.ledgerStore!.save(snapshot);
    });
    await this.persistQueue;
  }
}
