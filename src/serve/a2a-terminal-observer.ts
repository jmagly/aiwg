/**
 * A2A terminal observer.
 *
 * v2 dispatch returns an A2A Task immediately. Executors may not also emit the
 * executor-contract mission.* event stream, so aiwg serve must follow the task
 * until it reaches a terminal A2A state and then project that state into the
 * ExecutorRegistry mission model.
 *
 * @issue #1374
 */

import { A2AClient, A2A_HITL_PROMPT_V1 } from '../a2a/client.js';
import {
  isTerminalTaskState,
  type A2AProtocolVersion,
  type NormalizedAgentInterface,
  type Task,
  type TaskState,
} from '../a2a/types.js';
import type {
  EventEnvelope,
  ExecutorRegistration,
  ExecutorRegistry,
} from './executor-registry.js';
import { extractGraphMetadata } from '../flow/graph-metadata.js';
import { autoRespondToA2AMission } from './mission-hitl.js';
import type { PromptAuthorization } from '../a2a/hitl-authorization.js';
import { extractHitlEnvelope } from '../a2a/hitl.js';

export interface A2ATerminalObserverOptions {
  authorization?: PromptAuthorization;
  fetch?: typeof fetch;
  pollIntervalMs?: number;
  maxPolls?: number;
  onError?: (err: unknown) => void;
  protocolVersion?: A2AProtocolVersion;
  selectedInterface?: NormalizedAgentInterface;
}

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_MAX_POLLS = 300;

export async function observeA2ATerminalState(
  registry: ExecutorRegistry,
  executor: ExecutorRegistration,
  missionId: string,
  a2aInstanceId: string,
  initialTask: Task,
  opts: A2ATerminalObserverOptions = {}
): Promise<void> {
  const mission = registry.getMission(missionId);
  if (mission && !(mission.a2a?.taskId === initialTask.id
    && mission.a2a.instanceId === a2aInstanceId)) {
    mission.a2a = {
      instanceId: a2aInstanceId, taskId: initialTask.id,
      ...(initialTask.contextId ? { contextId: initialTask.contextId } : {}),
      protocolVersion: opts.protocolVersion ?? '0.3',
      ...(opts.selectedInterface ? { selectedInterface: opts.selectedInterface } : {}),
      acceptedPrompts: new Set(),
      authorization: opts.authorization,
    };
  }
  if (mission?.a2a && opts.authorization && !mission.a2a.authorization) mission.a2a.authorization = opts.authorization;
  try {
    const clientOpts: ConstructorParameters<typeof A2AClient>[0] = {
      baseUrl: executor.transportEndpoints.rest,
      bearer: executor.token,
      instanceId: a2aInstanceId,
      protocolVersion: opts.protocolVersion ?? '0.3',
      protocolPolicy: opts.protocolVersion ?? '0.3',
      optionalExtensions: [A2A_HITL_PROMPT_V1],
    };
    if (opts.selectedInterface) clientOpts.selectedInterface = opts.selectedInterface;
    if (opts.fetch) clientOpts.fetch = opts.fetch;
    const client = new A2AClient(clientOpts);

    let task = initialTask;
    await emitNonTerminalProgress(registry, executor.executorId, missionId, task, opts);

    for (let attempt = 0; attempt <= (opts.maxPolls ?? DEFAULT_MAX_POLLS); attempt++) {
      if (isTerminalTaskState(task.status.state)) {
        emitTerminalTask(registry, executor.executorId, missionId, task);
        return;
      }

      if (attempt === (opts.maxPolls ?? DEFAULT_MAX_POLLS)) break;
      await sleep(opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
      task = await client.getTask(task.id);
      if (task.id !== initialTask.id || task.contextId !== initialTask.contextId) {
        throw new Error('A2A observer task binding changed');
      }
      await emitNonTerminalProgress(registry, executor.executorId, missionId, task, opts);
    }

    registry.failMission(
      missionId,
      `A2A task ${initialTask.id} did not reach a terminal state before observer timeout`
    );
  } catch (err) {
    registry.failMission(
      missionId,
      `A2A terminal observer failed: ${(err as Error).message ?? String(err)}`
    );
    opts.onError?.(err);
  }
}

async function emitNonTerminalProgress(
  registry: ExecutorRegistry,
  executorId: string,
  missionId: string,
  task: Task,
  opts: A2ATerminalObserverOptions,
): Promise<void> {
  const state = task.status.state;
  if (state === 'working') {
    registry.handleEvent(makeEnvelope('mission.started', executorId, missionId, task, {
      state: 'running',
      a2a_task_id: task.id,
      summary: taskStatusSummary(task),
    }));
    return;
  }
  if (state === 'input-required') {
    const prompt = extractHitlEnvelope(task);
    // Only a configured host binding source can authorize automatically. Without one, publish the
    // prompt synchronously as before, so the mission shows hitl-required when dispatch returns.
    const bound = opts.authorization ?? registry.getMission(missionId)?.a2a?.authorization;
    if (prompt?.ok && bound && await autoRespondToA2AMission(registry, missionId, prompt.envelope.prompt_id, opts)) return;
    registry.handleEvent(makeEnvelope('mission.hitl_required', executorId, missionId, task, {
      state: 'hitl-required',
      a2a_task_id: task.id,
      summary: taskStatusSummary(task),
      ...(prompt?.ok ? { hitl_id: prompt.envelope.prompt_id, hitl_prompt: prompt.envelope } : {}),
    }));
  }
}

function emitTerminalTask(
  registry: ExecutorRegistry,
  executorId: string,
  missionId: string,
  task: Task
): void {
  const state = task.status.state;
  if (state === 'completed') {
    registry.handleEvent(makeEnvelope('mission.completed', executorId, missionId, task, {
      state: 'done',
      a2a_task_id: task.id,
      summary: taskStatusSummary(task),
      ...exitCodeData(task),
    }));
    return;
  }

  if (state === 'canceled') {
    registry.handleEvent(makeEnvelope('mission.aborted', executorId, missionId, task, {
      state: 'aborted',
      a2a_task_id: task.id,
      summary: taskStatusSummary(task),
      error: taskStatusSummary(task) ?? `A2A task ${task.id} was canceled`,
      ...exitCodeData(task),
    }));
    return;
  }

  registry.handleEvent(makeEnvelope('mission.failed', executorId, missionId, task, {
    state: 'failed',
    a2a_task_id: task.id,
    summary: taskStatusSummary(task),
    error: taskStatusSummary(task) ?? `A2A task ${task.id} reached terminal state ${state}`,
    ...exitCodeData(task),
  }));
}

function makeEnvelope(
  event: EventEnvelope['event'],
  executorId: string,
  missionId: string,
  task: Task,
  data: Record<string, unknown>
): EventEnvelope {
  const graph = extractGraphMetadata(task.metadata);
  return {
    event,
    executor_id: executorId,
    mission_id: missionId,
    ts: task.status.timestamp ?? new Date().toISOString(),
    data: {
      ...data,
      ...(graph ? {
        graph_metadata: { ...graph, nodeState: taskStateToGraphState(task.status.state) },
        graph_node_state: taskStateToGraphState(task.status.state),
      } : {}),
    },
  };
}

function taskStateToGraphState(state: TaskState): string {
  switch (state) {
    case 'submitted': return 'pending';
    case 'working': return 'running';
    case 'input-required':
    case 'auth-required': return 'blocked-hitl';
    case 'completed': return 'succeeded';
    case 'failed':
    case 'rejected': return 'failed';
    case 'canceled': return 'canceled';
    default: return 'unknown';
  }
}

function taskStatusSummary(task: Task): string | undefined {
  return task.status.summary;
}

function exitCodeData(task: Task): { exit_code?: number } {
  return task.status.exitCode !== undefined ? { exit_code: task.status.exitCode } : {};
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer === 'object' && typeof timer.unref === 'function') {
      timer.unref();
    }
  });
}

export function isA2ATerminalState(state: TaskState): boolean {
  return isTerminalTaskState(state);
}
