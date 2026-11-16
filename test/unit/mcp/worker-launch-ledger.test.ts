// Cover launch accounting for both transports without spawning real workers.
import { expect, it, vi } from 'vitest';
import { createWorkerLaunchLedger } from '../../../src/mcp/tools/worker-launch-ledger.mjs';

it.each([
  ['shell', { launched: true }, 1],
  ['shell', { launched: false, launchAttempted: true }, 1],
  ['shell', { launched: false, dispatchState: 'submission-uncertain' }, 1],
  ['shell', { launched: false }, 0],
  ['mcp', { outcome: 'responded', dispatchState: 'dispatched' }, 1],
  ['mcp', { outcome: 'blocked', dispatchState: 'dispatched' }, 1],
  ['mcp', { outcome: 'blocked', dispatchState: 'submission-uncertain' }, 1],
  ['mcp', { outcome: 'blocked', dispatchState: 'never-began' }, 0],
  ['mcp', { outcome: 'responded' }, 1],
  ['mcp', { outcome: 'blocked' }, 0],
] as const)('T-OG-17 records %s launch evidence %j as %i', async (transport, result, expected) => {
  const ledger = createWorkerLaunchLedger();
  const launcher = vi.fn(async () => result);
  const wrapped = ledger.track(launcher, transport);
  expect(ledger.count()).toBe(0);
  expect(await wrapped('invocation', { fixture: true })).toBe(result);
  expect(launcher).toHaveBeenCalledWith('invocation', { fixture: true });
  expect(ledger.count()).toBe(expected);
  await wrapped();
  expect(ledger.count()).toBe(expected * 2);
  expect(createWorkerLaunchLedger().count()).toBe(0);
});

it.each([false, true])('T-OG-17 retains thrown launch evidence only if attempted=%s', async launchAttempted => {
  const ledger = createWorkerLaunchLedger();
  const error = Object.assign(Error('fixture launch failure'), { launchAttempted });
  const launch = ledger.track(async () => { throw error; }, 'shell');
  await expect(launch()).rejects.toBe(error);
  expect(ledger.count()).toBe(launchAttempted ? 1 : 0);
});

it('T-OG-17 counts a native MCP launch while its call is pending and records it only once', async () => {
  const ledger = createWorkerLaunchLedger();
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const registerControl = vi.fn();
  const control = { stop: vi.fn() };
  const call = ledger.track(async (_binding: unknown, _server: unknown, context: { registerControl(control: unknown): void }) => {
    context.registerControl(control);
    context.registerControl(control);
    await finished;
    context.registerControl(null);
    return { outcome: 'responded', dispatchState: 'dispatched' };
  }, 'mcp');
  const pending = call({}, {}, { registerControl });
  expect(ledger.count()).toBe(1);
  expect(registerControl).toHaveBeenCalledWith(control);
  finish();
  await pending;
  expect(registerControl).toHaveBeenLastCalledWith(null);
  expect(ledger.count()).toBe(1);
});
