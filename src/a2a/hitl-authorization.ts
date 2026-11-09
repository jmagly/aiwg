// Resolves host-bound prompt actions without deriving authority from executor text or schemas.
import Ajv from 'ajv';
import type { HitlCheck } from '../policy/hitl-check.js';
import type { HitlAction } from '../policy/hitl-types.js';
import type { HitlPromptEnvelope, HitlDeliveryAdapter } from './hitl.js';
import type { JsonValue } from './types.js';

export interface BoundHitlApproval {
  taskId: string;
  contextId?: string;
  promptId: string;
  /** Digest of the exact envelope reviewed by the host, including schema and responder policy. */
  promptDigest: string;
  action: HitlAction;
  response: JsonValue;
}
export interface PromptAuthorization {
  projectDir: string;
  /** Host-owned execution-plan bindings, never populated from task metadata or issue/model output. */
  bindings: ReadonlyMap<string, BoundHitlApproval>;
}
export interface PromptContext {
  envelope: HitlPromptEnvelope;
  taskId?: string;
  contextId?: string;
  authorization?: PromptAuthorization;
}
export type PromptReceipt = Pick<HitlCheck, 'receipt' | 'authorizationGrant' | 'provenance'>;

export async function lookupPromptAuthorization(opts: PromptContext): Promise<{
  response: JsonValue; authorization: PromptReceipt;
} | undefined> {
  try {
    const { checkHitlAuthorization } = await import('../policy/hitl-check.js');
    const { hitlDigest } = await import('../policy/hitl.js');
    const envelope = structuredClone(opts.envelope);
    const supplied = opts.authorization?.bindings.get(envelope.prompt_id);
    const binding = supplied && structuredClone(supplied);
    let eligible = binding && binding.taskId === opts.taskId && binding.contextId === opts.contextId
      && binding.promptId === envelope.prompt_id && binding.promptDigest === hitlDigest(envelope)
      && (!envelope.allowed_responders || envelope.allowed_responders.includes('any'))
      && (!envelope.deadline || Date.parse(envelope.deadline) > Date.now());
    if (eligible) {
      try {
        const validate = new Ajv({ strict: true }).compile(envelope.response_schema as object);
        eligible = !('$async' in validate && validate.$async === true) && !!validate(binding!.response);
      } catch { eligible = false; }
    }
    // No host classification means unknown effects. Still consult the resolver,
    // which retains review rather than treating prompt text as a safe action.
    const checked = await checkHitlAuthorization(opts.authorization?.projectDir ?? process.cwd(), eligible ? binding!.action : null);
    if (!eligible || checked.decision !== 'auto-authorized' || !checked.receipt?.file || !checked.receipt.effectId) return;
    if (envelope.deadline && Date.parse(envelope.deadline) <= Date.now()) return;
    return { response: binding!.response, authorization: { receipt: checked.receipt,
      provenance: checked.provenance, ...(checked.authorizationGrant ? { authorizationGrant: checked.authorizationGrant } : {}) } };
  } catch {
    return; // Lookup failures retain the existing human collection path.
  }
}

export async function collectAuthorizedHitlResponse(opts: PromptContext & { adapter: HitlDeliveryAdapter }, signal: AbortSignal) {
  const authorized = signal.aborted ? undefined : await lookupPromptAuthorization(opts);
  if (authorized && !signal.aborted) return authorized;
  return { response: await opts.adapter.collect(opts.envelope, {
    ...(opts.taskId !== undefined ? { taskId: opts.taskId } : {}),
    ...(opts.contextId !== undefined ? { contextId: opts.contextId } : {}), signal,
  }), authorization: undefined };
}
