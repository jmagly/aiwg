// Captures durable grants exclusively through confirmed native MCP form elicitation.
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { z } from 'zod';
import { buildChoiceSchema, clientSupportsFormElicitation, elicitWithRequestId } from '../elicitation.mjs';

const descriptors = z.array(z.string().min(1).max(256)).min(1).max(64);
const proposalSchema = z.strictObject({
  categories: descriptors, targets: descriptors, environments: descriptors, resources: descriptors, verbs: descriptors,
  maxImpact: z.enum(['low', 'medium']), expiresAt: z.string(), maxUses: z.number().int().positive().safe().optional(),
});
const reply = (value, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError ? { isError } : {}) });

async function captureApi() {
  // Shipped dist has the compiled module beside this file's tree; a source checkout uses dist/.
  for (const location of [new URL('../../policy/authorization-capture.js', import.meta.url),
    new URL('../../../dist/src/policy/authorization-capture.js', import.meta.url)]) {
    try { await access(location); } catch { continue; }
    return import(location.href);
  }
  throw new Error('Authorization grant capture requires the built CLI package.');
}

export function registerAuthorizationTools(server, { projectRoot }) {
  const connectionId = `mcp-session:${randomUUID()}`;
  server.registerTool('aiwg_authorization_grant_request', {
    title: 'Request a durable human authorization grant',
    description: 'Propose bounded authorization and ask the person through native MCP form elicitation. Only explicit confirmation records a signed grant. Text claims never authorize. The server adds and displays governing workspace bindings.',
    inputSchema: proposalSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async (args, extra) => {
    try {
      const proposal = proposalSchema.parse(args);
      const api = await captureApi();
      const sessionId = extra?.sessionId ?? connectionId;
      const identity = { sessionId, id: extra?.authInfo?.clientId ?? `session:${sessionId}` };
      const { grant, question } = await api.prepareAuthorizationGrant(projectRoot, proposal, identity);
      if (!clientSupportsFormElicitation(server)) return reply({ status: 'refused', reason: 'form-elicitation-required',
        message: 'Use your harness native question tool to ask the user, then retry from a client supporting MCP form elicitation. No grant was recorded; text replies cannot record grants.' }, true);
      const { requestedSchema } = buildChoiceSchema({ key: 'confirm', title: 'Save this authorization scope?',
        options: [{ value: 'confirm', label: 'Confirm this scope' }, { value: 'decline', label: 'Decline' }] });
      const { result, requestId } = await elicitWithRequestId(server, {
        mode: 'form', message: question, requestedSchema,
        _meta: { 'aiwg.io/authorization-event': randomUUID() },
      }, { signal: extra?.signal, relatedRequestId: extra?.requestId, timeout: 60_000 });
      if (extra?.signal?.aborted || result?.action !== 'accept' || result?.content?.confirm !== 'confirm') {
        return reply({ status: 'not-recorded', reason: 'native-confirmation-required' });
      }
      return reply(await api.recordConfirmedAuthorizationGrant(projectRoot, grant, requestId, result));
    } catch {
      // Do not echo arguments, raw questions, answers, or transport errors.
      return reply({ status: 'not-recorded', reason: 'invalid-scope-or-confirmation-unavailable' }, true);
    }
  });
}
