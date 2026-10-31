// Prepare remote tools in the root lifecycle; subagent renders only mount definitions.
import { createMcpConnection, useAgentStart, useAgentFinish, useDelivery, useTool } from '@flue/runtime';

const deliveries = new WeakMap();
export function bindRemoteSpecialist(definition, connection) {
  const delivery = useDelivery();
  let delegates = deliveries.get(delivery);
  if (!delegates) deliveries.set(delivery, delegates = new Map());
  let state = delegates.get(definition.name);
  if (!state) delegates.set(definition.name, state = {});
  const close = async () => {
    const pending = state.pending;
    state.pending = undefined;
    state.live = undefined;
    state.removeAbort?.();
    if (pending) await (await pending).close();
  };
  useAgentStart(async ({ signal }) => {
    state.pending ??= createMcpConnection(connection);
    try { state.live = await state.pending; }
    catch (error) { state.pending = undefined; throw error; }
    state.removeAbort?.();
    const abort = () => { void close().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    state.removeAbort = () => signal.removeEventListener('abort', abort);
    if (signal.aborted) await close();
  });
  useAgentFinish(close);
  return { ...definition, agent() {
    if (!state.live) throw new Error(`Specialist ${definition.name} remote tools are not ready; mount it in the root agent render`);
    for (const tool of state.live.tools) useTool(tool);
    return definition.agent();
  } };
}
