// Remote delegates must use public adapted tools and close per-delivery connections.
import { beforeEach, expect, it, vi } from 'vitest';
const hooks = vi.hoisted(() => ({ delivery: {}, starts: [] as ((ctx: { signal: AbortSignal }) => Promise<void>)[], finishes: [] as (() => Promise<void>)[],
  connect: vi.fn(), mount: vi.fn() }));
vi.mock('@flue/runtime', () => ({
  createMcpConnection: hooks.connect, useTool: hooks.mount, useDelivery: () => hooks.delivery,
  useAgentStart: (run: (ctx: { signal: AbortSignal }) => Promise<void>) => hooks.starts.push(run),
  useAgentFinish: (run: () => Promise<void>) => hooks.finishes.push(run),
}));
import { bindRemoteSpecialist } from '../../../packages/flue/remote-specialist.js';
const definition = { name: 'reviewer', description: 'Synthetic reviewer', agent: () => 'Review the supplied code.' };
const connection = { name: 'aiwg', url: 'http://127.0.0.1:1/mcp', auth: 'synthetic' };
const ctx = () => ({ signal: new AbortController().signal });
beforeEach(() => {
  hooks.delivery = {}; hooks.starts = []; hooks.finishes = [];
  hooks.connect.mockReset(); hooks.mount.mockReset();
});

it('prepares in root lifecycle, survives rerenders, mounts adapted definitions and closes once', async () => {
  const tools = [{ name: 'mcp__aiwg__discover' }], close = vi.fn();
  hooks.connect.mockResolvedValue({ tools, close });
  const first = bindRemoteSpecialist(definition, connection);
  expect(() => first.agent()).toThrow('remote tools are not ready');
  expect(hooks.connect).not.toHaveBeenCalled();
  await hooks.starts[0](ctx());
  const rerender = bindRemoteSpecialist(definition, { ...connection });
  await hooks.starts[1](ctx());
  expect(rerender.agent()).toBe('Review the supplied code.');
  expect(hooks.mount).toHaveBeenCalledExactlyOnceWith(tools[0]);
  expect(hooks.connect).toHaveBeenCalledExactlyOnceWith(connection);
  await Promise.all(hooks.finishes.map(run => run()));
  expect(close).toHaveBeenCalledTimes(1);
  expect(() => rerender.agent()).toThrow('remote tools are not ready');
});

it('isolates different deliveries and retries a failed connection without caching failure', async () => {
  hooks.connect.mockRejectedValueOnce(new Error('401 Unauthorized'));
  bindRemoteSpecialist(definition, connection);
  await expect(hooks.starts[0](ctx())).rejects.toThrow('401 Unauthorized');
  const close = vi.fn();
  hooks.connect.mockResolvedValue({ tools: [], close });
  await hooks.starts[0](ctx());
  hooks.delivery = {};
  const second = bindRemoteSpecialist(definition, connection);
  expect(() => second.agent()).toThrow('remote tools are not ready');
  await hooks.starts[1](ctx());
  expect(second.agent()).toBe('Review the supplied code.');
  expect(hooks.connect).toHaveBeenCalledTimes(3);
  await Promise.all(hooks.finishes.map(run => run()));
  expect(close).toHaveBeenCalledTimes(2);
});

it('closes an adapted connection when the submission aborts', async () => {
  const close = vi.fn();
  hooks.connect.mockResolvedValue({ tools: [], close });
  const delegate = bindRemoteSpecialist(definition, connection);
  const controller = new AbortController();
  await hooks.starts[0]({ signal: controller.signal });
  controller.abort();
  await Promise.resolve();
  expect(close).toHaveBeenCalledTimes(1);
  expect(() => delegate.agent()).toThrow('remote tools are not ready');
});
