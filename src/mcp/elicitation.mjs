/**
 * MCP elicitation helpers.
 *
 * Emit structured single/multi-select forms when the connected client supports
 * MCP form elicitation, with a graceful markdown fallback otherwise. This is the
 * stable path for agent-initiated structured questions on Codex, whose native
 * `request_user_input` tool is mode-gated and off by default (see #1668, #1676
 * and the native-ux-tools rule).
 *
 * @implements #1676
 * @see agentic/code/addons/aiwg-utils/rules/native-ux-tools.md
 */

/**
 * Normalize loosely-typed options into `{ value, label }` pairs.
 * Accepts plain strings or `{ label, value? }` objects.
 * @param {Array<string | { value?: string, label: string }>} options
 * @returns {Array<{ value: string, label: string }>}
 */
export function normalizeOptions(options) {
  return (options || []).map((o, i) => {
    if (typeof o === 'string') return { value: o, label: o };
    const label = o.label ?? o.value ?? String(i);
    const value = o.value ?? o.label ?? String(i);
    return { value, label };
  });
}

/**
 * True when the connected client advertises MCP form elicitation support.
 * @param {{ server?: { getClientCapabilities?: () => any } }} mcpServer
 * @returns {boolean}
 */
export function clientSupportsFormElicitation(mcpServer) {
  try {
    const caps = mcpServer?.server?.getClientCapabilities?.();
    return Boolean(caps?.elicitation?.form);
  } catch {
    return false;
  }
}

// Observe actual outgoing JSON-RPC IDs without depending on SDK private counters.
const elicitationTransports = new WeakMap();
export async function elicitWithRequestId(mcpServer, params, options) {
  const transport = mcpServer.server.transport;
  if (!transport) throw new Error('Elicitation requires a connected transport');
  let pending = elicitationTransports.get(transport);
  if (!pending) {
    pending = new Map();
    const send = transport.send.bind(transport);
    transport.send = (message, ...rest) => {
      if (message.method === 'elicitation/create') {
        const capture = pending.get(message.params?._meta?.['aiwg.io/authorization-event']);
        if (capture) capture.requestId = message.id;
      }
      return send(message, ...rest);
    };
    elicitationTransports.set(transport, pending);
  }
  const event = params._meta['aiwg.io/authorization-event'];
  const capture = {};
  pending.set(event, capture);
  try {
    const result = await mcpServer.server.elicitInput(params, options);
    if (capture.requestId === undefined) throw new Error('Missing elicitation request ID');
    return { result, requestId: String(capture.requestId) };
  } finally {
    pending.delete(event);
  }
}

/**
 * Build a restricted JSON-schema (MCP elicitation `requestedSchema`) for a
 * single- or multi-select choice over the given options.
 * @param {object} params
 * @returns {{ requestedSchema: object, key: string, options: Array<{value:string,label:string}> }}
 */
export function buildChoiceSchema({
  key = 'choice',
  title,
  description,
  options,
  multiSelect = false,
  minItems,
  maxItems,
}) {
  const opts = normalizeOptions(options);
  let prop;
  if (multiSelect) {
    prop = {
      type: 'array',
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      items: { anyOf: opts.map((o) => ({ const: o.value, title: o.label })) },
      ...(minItems != null ? { minItems } : {}),
      ...(maxItems != null ? { maxItems } : {}),
    };
  } else {
    prop = {
      type: 'string',
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      oneOf: opts.map((o) => ({ const: o.value, title: o.label })),
    };
  }
  return {
    requestedSchema: {
      type: 'object',
      properties: { [key]: prop },
      required: [key],
    },
    key,
    options: opts,
  };
}

/**
 * Ask the user a single- or multi-select question via MCP elicitation.
 *
 * Returns `{ supported: false }` when the client has no form-elicitation support
 * (caller should fall back to a markdown prompt). When supported, returns the
 * outcome with `action` of `accept` (plus `value`), `decline`, or `cancel`.
 * Never throws — any transport/capability error degrades to `{ supported: false }`.
 *
 * @param {{ server: { elicitInput: Function, getClientCapabilities?: Function } }} mcpServer
 * @param {object} params
 * @returns {Promise<{ supported: boolean, action?: string, value?: any, options: Array<{value:string,label:string}> }>}
 */
export async function elicitChoice(
  mcpServer,
  { question, options, multiSelect = false, key = 'choice', title, description, minItems, maxItems },
) {
  const { requestedSchema, options: opts } = buildChoiceSchema({
    key,
    title: title ?? question,
    description,
    options,
    multiSelect,
    minItems,
    maxItems,
  });

  if (!clientSupportsFormElicitation(mcpServer)) {
    return { supported: false, options: opts };
  }

  try {
    const result = await mcpServer.server.elicitInput({
      message: question,
      requestedSchema,
      mode: 'form',
    });
    const action = result?.action;
    if (action === 'accept') {
      return { supported: true, action, value: result?.content?.[key], options: opts };
    }
    return { supported: true, action: action === 'decline' ? 'decline' : 'cancel', options: opts };
  } catch {
    // Capability mismatch or transport error — degrade to markdown fallback.
    return { supported: false, options: opts };
  }
}

/**
 * Render a clear markdown prompt for clients without native elicitation.
 * @param {object} params
 * @returns {string}
 */
export function renderMarkdownPrompt({ question, options, multiSelect = false }) {
  const opts = normalizeOptions(options);
  const lines = [`**${question}**`, ''];
  for (const o of opts) {
    lines.push(o.label === o.value ? `- \`${o.value}\`` : `- ${o.label} (\`${o.value}\`)`);
  }
  lines.push('');
  lines.push(multiSelect ? '_Select one or more and reply with your choices._' : '_Reply with your choice._');
  return lines.join('\n');
}
