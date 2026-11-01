// Carry trusted project scope and cancellation through existing CLI-backed tools.
import { AsyncLocalStorage } from 'node:async_hooks';

export const toolContext = new AsyncLocalStorage();

export function cliExecutionOptions(options) {
  const context = toolContext.getStore();
  return context ? { ...options, cwd: context.projectDir, signal: context.signal } : options;
}

export function bindCliCancellation(child, signal, terminate) {
  if (!signal) return;
  const children = toolContext.getStore()?.children;
  let release;
  const closed = new Promise(resolve => { release = resolve; });
  children?.add(closed);
  const abort = () => terminate(new Error('MCP tool cancelled'));
  signal.addEventListener('abort', abort, { once: true });
  child.once('close', () => {
    signal.removeEventListener('abort', abort);
    children?.delete(closed);
    release();
  });
  if (signal.aborted) abort();
}
