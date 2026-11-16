// Own lazily created immutable inputs for one update, including nested redeploys.
import { AsyncLocalStorage } from 'node:async_hooks';

const sessions = new AsyncLocalStorage();

export async function withDeploymentInputSession(work) {
  const existing = sessions.getStore();
  if (existing && !existing.closed) return work();
  const session = { inputs: new Map(), closed: false };
  return sessions.run(session, async () => {
    let result, workError, failed = false;
    try { result = await work(); }
    catch (error) { workError = error; failed = true; }
    session.closed = true;
    const errors = [];
    for (const { value, dispose } of session.inputs.values()) {
      try { dispose(value); } catch (error) { errors.push(error); }
    }
    session.inputs.clear();
    if (failed) {
      if (errors.length) {
        // Even a frozen or primitive thrown value must keep its identity.
        try { Object.defineProperty(workError, 'disposeErrors', { value: errors, configurable: true }); } catch {}
      }
      throw workError;
    }
    if (errors.length) throw new AggregateError(errors, 'Failed to dispose deployment inputs');
    return result;
  });
}

/** Outside an update, keep the established standalone deployment lifecycle. */
export function deploymentSessionInput(key, create, dispose) {
  const session = sessions.getStore();
  if (!session || session.closed) return undefined;
  if (!session.inputs.has(key)) session.inputs.set(key, { value: create(), dispose });
  return session.inputs.get(key).value;
}
