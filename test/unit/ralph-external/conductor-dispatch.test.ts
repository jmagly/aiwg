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
