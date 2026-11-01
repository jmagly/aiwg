// Verify trusted CLI scope and cancellation bookkeeping without subprocesses.
import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { bindCliCancellation, cliExecutionOptions, toolContext } from '../../../src/mcp/tool-context.mjs';

it('preserves options outside a context and overrides cwd and signal inside it', () => {
  const original = { cwd: '/synthetic/untrusted', signal: new AbortController().signal, timeout: 42 };
  expect(cliExecutionOptions(original)).toBe(original);
  const signal = new AbortController().signal;
  toolContext.run({ projectDir: '/synthetic/project', signal }, () => {
    expect(cliExecutionOptions(original)).toEqual({ cwd: '/synthetic/project', signal, timeout: 42 });
    expect(cliExecutionOptions()).toEqual({ cwd: '/synthetic/project', signal });
  });
  expect(cliExecutionOptions(original)).toBe(original);
});

it('does nothing without a signal', () => {
  const child = new EventEmitter();
  const terminate = vi.fn();
  bindCliCancellation(child, undefined, terminate);
  expect(child.listenerCount('close')).toBe(0);
  expect(terminate).not.toHaveBeenCalled();
});

it('tracks child completion, cancels once and removes abort listeners on close', async () => {
  const child = new EventEmitter();
  const controller = new AbortController();
  const terminate = vi.fn();
  const children = new Set<Promise<void>>();
  const remove = vi.spyOn(controller.signal, 'removeEventListener');
  toolContext.run({ children }, () => bindCliCancellation(child, controller.signal, terminate));
  expect(children.size).toBe(1);
  const [closed] = children;
  let completed = false;
  void closed.then(() => { completed = true; });
  await Promise.resolve();
  expect(completed).toBe(false);
  controller.abort();
  expect(terminate).toHaveBeenCalledExactlyOnceWith(new Error('MCP tool cancelled'));
  expect(children.size).toBe(1);
  child.emit('close');
  await closed;
  expect(completed).toBe(true);
  expect(children.size).toBe(0);
  expect(remove).toHaveBeenCalledExactlyOnceWith('abort', expect.any(Function));
  expect(child.listenerCount('close')).toBe(0);
});

it.each([false, true])('handles an already aborted signal without a child set (context: %s)', async context => {
  const child = new EventEmitter();
  const controller = new AbortController();
  controller.abort();
  const terminate = vi.fn();
  const bind = () => bindCliCancellation(child, controller.signal, terminate);
  if (context) toolContext.run({}, bind);
  else bind();
  expect(terminate).toHaveBeenCalledExactlyOnceWith(new Error('MCP tool cancelled'));
  child.emit('close');
  expect(child.listenerCount('close')).toBe(0);
});

it('removes cancellation on normal completion before a later abort', () => {
  const child = new EventEmitter();
  const controller = new AbortController();
  const terminate = vi.fn();
  bindCliCancellation(child, controller.signal, terminate);
  child.emit('close');
  controller.abort();
  expect(terminate).not.toHaveBeenCalled();
});
