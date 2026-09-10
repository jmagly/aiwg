/** A2A approval routing for the public mission API. */
import { createHash, randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import { A2AClient, A2A_HITL_PROMPT_V1 } from '../a2a/client.js';
import { buildHitlResponseMessage, extractHitlEnvelope } from '../a2a/hitl.js';
import type { A2AProtocolVersion, JsonValue, NormalizedAgentInterface } from '../a2a/types.js';
import type { ExecutorRegistry } from './executor-registry.js';

export interface MissionA2ABinding {
  instanceId: string;
  taskId: string;
  contextId?: string;
  protocolVersion: A2AProtocolVersion;
  selectedInterface?: NormalizedAgentInterface;
  /** One response may be in flight per task. Other missions remain independent. */
  responding?: boolean;
  acceptedPrompts: Set<string>;
  attempts?: Map<string, { messageId: string; digest: string }>;
}

type Reply = { status: 200 | 400 | 403 | 404 | 409 | 410 | 422 | 502; body: Record<string, unknown> };

export async function respondToA2AMission(
  registry: ExecutorRegistry,
  missionId: string,
  promptId: string,
  response: JsonValue,
  opts: { fetch?: typeof fetch } = {},
): Promise<Reply> {
  const mission = registry.getMission(missionId);
  const binding = mission?.a2a;
  const executor = mission && registry.getRegistration(mission.executorId);
  if (!mission || !binding || !executor) return reply(404, 'mission_binding_not_found');
  if (binding.responding || binding.acceptedPrompts.has(promptId)) return reply(409, 'approval_already_submitted');
  if (['done', 'failed', 'aborted'].includes(mission.state)) return reply(409, 'mission_terminal');

  binding.responding = true;
  try {
    const client = new A2AClient({
      baseUrl: executor.transportEndpoints.rest,
      bearer: executor.token,
      instanceId: binding.instanceId,
      protocolVersion: binding.protocolVersion,
      protocolPolicy: binding.protocolVersion,
      optionalExtensions: [A2A_HITL_PROMPT_V1],
      ...(binding.selectedInterface ? { selectedInterface: binding.selectedInterface } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
    // Re-read the owning task: cached mission events can outlive a prompt.
    const task = await client.getTask(binding.taskId);
    if (task.id !== binding.taskId || task.contextId !== binding.contextId) return reply(409, 'task_binding_mismatch');
    const extracted = extractHitlEnvelope(task);
    if (!extracted?.ok) return reply(409, 'no_valid_pending_approval');
    const prompt = extracted.envelope;
    if (prompt.prompt_id !== promptId) return reply(409, 'approval_prompt_mismatch');
    if (prompt.deadline && Date.parse(prompt.deadline) <= Date.now()) return reply(410, 'approval_expired');
    // The local mission API has no authenticated operator identity. Never
    // accept a caller-supplied name as authority for a restricted prompt.
    if (prompt.allowed_responders && !prompt.allowed_responders.includes('any')) return reply(403, 'authenticated_responder_required');
    try {
      const validate = new Ajv({ allErrors: true, strict: true }).compile(prompt.response_schema as object);
      if ('$async' in validate && validate.$async === true) return reply(422, 'approval_schema_unsupported');
      if (!validate(response)) return reply(422, 'approval_response_invalid');
    } catch {
      return reply(422, 'approval_schema_unsupported');
    }
    if (registry.getMission(missionId) !== mission || mission.a2a !== binding
      || ['done', 'failed', 'aborted'].includes(mission.state)) {
      return reply(409, 'mission_changed_during_approval');
    }
    const digest = createHash('sha256').update(JSON.stringify(response)).digest('hex');
    const attempts = binding.attempts ??= new Map();
    const previous = attempts.get(promptId);
    if (previous && previous.digest !== digest) return reply(409, 'approval_retry_payload_changed');
    const attempt = previous ?? { messageId: randomUUID(), digest };
    attempts.set(promptId, attempt);
    const result = await client.sendMessage(buildHitlResponseMessage({
      promptId, response, messageId: attempt.messageId, taskId: binding.taskId,
      ...(binding.contextId ? { contextId: binding.contextId } : {}),
    }));
    if (result.task.id !== binding.taskId || result.task.contextId !== binding.contextId) return reply(502, 'approval_result_binding_mismatch');
    binding.acceptedPrompts.add(promptId);
    // Audit correlation only; approval payloads can contain sensitive data.
    registry.handleEvent({
      event: 'mission.progress', executor_id: mission.executorId, mission_id: missionId,
      ts: new Date().toISOString(),
      data: { action: 'hitl_response_accepted', hitl_id: promptId, a2a_task_id: binding.taskId },
    });
    return { status: 200, body: { ok: true } };
  } catch {
    // Preserve the binding for a retry; the next attempt rechecks executor state.
    return reply(502, 'approval_forward_failed');
  } finally {
    binding.responding = false;
  }
}

function reply(status: Reply['status'], error: string): Reply {
  return { status, body: { error } };
}
