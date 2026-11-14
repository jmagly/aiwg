// Exercise the installed entry point without starting a conductor or model CLI.
import { afterEach, expect, it, vi } from 'vitest';
const run = vi.hoisted(() => vi.fn(async () => 7));
vi.mock('../../../tools/ralph-external/lib/conductor-isolation.mjs', () => ({ runConductorCli: run }));
import { main } from '../../../tools/ralph-external/index.mjs';
const exitCode = process.exitCode;
afterEach(() => { process.exitCode = exitCode; vi.restoreAllMocks(); });
it('dispatches conductor argv intact before worker-status flags', async () => {
  const args = ['--run-conductor', '--conductor-root', '/synthetic', '--deliverable', '/synthetic/deliver', '--', '/bin/sh', '--workers'];
  await main(args);
  expect(run).toHaveBeenCalledWith(args);
  expect(process.exitCode).toBe(7);
});
it('keeps invalid worker-status requests on their existing diagnostic path', async () => {
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  await main(['--workers', '--invalid']);
  expect(process.exitCode).toBe(1); expect(run).not.toHaveBeenCalled();
  expect(stderr).toHaveBeenCalled();
});

it('#4163 refuses --launch-worker inside a confined conductor unit before parsing or launching', async () => {
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubEnv('AIWG_CONFINED_CONDUCTOR', '1');
  try {
    await main(['--launch-worker', '--invocation', '/synthetic/plan.json', '--run-dir', '/synthetic/run']);
    expect(process.exitCode).toBe(2);
    expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/^OG_CONFINED_LAUNCH_REFUSED/));
  } finally { vi.unstubAllEnvs(); }
});

it('#4163 leaves --launch-worker to its normal argument checks outside a confined unit', async () => {
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubEnv('AIWG_CONFINED_CONDUCTOR', '');
  try {
    await expect(main(['--launch-worker'])).rejects.toThrow(/^Usage: ralph-external --launch-worker/);
  } finally { vi.unstubAllEnvs(); }
  expect(stderr.mock.calls.flat().join(' ')).not.toContain('OG_CONFINED_LAUNCH_REFUSED');
});
