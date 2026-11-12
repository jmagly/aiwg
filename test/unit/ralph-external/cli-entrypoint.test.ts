// Exercise the imported CLI entrypoint with local provider and loop doubles, never model processes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const doubles = vi.hoisted(() => ({ execute: vi.fn(), resume: vi.fn(), shutdown: vi.fn(),
  available: vi.fn(), registered: vi.fn(), watch: vi.fn() }));
vi.mock('../../../tools/ralph-external/orchestrator.mjs', () => ({ Orchestrator: class {
  execute = doubles.execute; resume = doubles.resume; gracefulShutdown = doubles.shutdown;
} }));
vi.mock('../../../tools/ralph-external/lib/provider-adapter.mjs', async importOriginal => ({
  ...await importOriginal(), ensureProvidersRegistered: async () => {}, hasProvider: doubles.registered,
  createProvider: () => ({ isAvailable: doubles.available, getVersion: async () => 'synthetic-1' }),
}));
vi.mock('../../../tools/ralph-external/process-monitor.mjs', async importOriginal => ({
  ...await importOriginal(), watchWorkerStatus: doubles.watch,
}));

const originalArgv = process.argv;
const originalExitCode = process.exitCode;
let root: string;
let exit: ReturnType<typeof vi.spyOn>;
const signals = new Map<string, () => Promise<void>>();
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'ralph-cli-entry-'));
  doubles.execute.mockResolvedValue({ success: true, reason: 'fixture complete', iterations: 1, loopId: 'fixture' });
  doubles.resume.mockResolvedValue({ success: true, reason: 'resumed', iterations: 2, loopId: 'fixture' });
  doubles.shutdown.mockResolvedValue(undefined); doubles.available.mockResolvedValue(true); doubles.registered.mockReturnValue(true);
  exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  const on = process.on;
  vi.spyOn(process, 'on').mockImplementation(function (event, listener) {
    if (event === 'SIGINT' || event === 'SIGTERM') { signals.set(event, listener); return process; }
    return on.call(process, event, listener);
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  process.argv = originalArgv; process.exitCode = originalExitCode;
  signals.clear(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true });
});
async function invoke(args: string[]) {
  vi.resetModules();
  process.argv = [process.execPath, path.resolve(import.meta.dirname, '../../../tools/ralph-external/index.mjs'), ...args];
  await import('../../../tools/ralph-external/index.mjs');
}

describe('T-OG-05/06 Ralph CLI dispatch and recovery boundaries', () => {
  it.each([true, false])('executes a bounded synthetic loop and maps success %s to exit status', async success => {
    doubles.execute.mockResolvedValue({ success, reason: 'fixture', iterations: 1, loopId: 'fixture' });
    mkdirSync(path.join(root, '.aiwg'));
    writeFileSync(path.join(root, '.aiwg/execution-mode.json'), '{"mode":"holdout-isolated"}');
    await invoke(['objective', '--completion', 'criteria', '--gitea-issue']);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(success ? 0 : 1));
    expect(doubles.execute).toHaveBeenCalledWith(expect.objectContaining({ objective: 'objective',
      completionCriteria: 'criteria', executionMode: 'holdout-isolated', giteaIntegration: { enabled: true } }));
  });

  it('resumes without overwriting persisted controls with parser defaults', async () => {
    await invoke(['--resume']);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(doubles.resume).toHaveBeenCalledExactlyOnceWith({ allowExhaustedResume: false });
    expect(doubles.execute).not.toHaveBeenCalled();
  });

  it('passes explicit resume overrides through and closes its temporary log', async () => {
    await invoke(['--resume', '--allow-exhausted-resume', '--max-iterations', '2', '--budget', '1.5',
      '--max-total-tokens', '100', '--exploration-quota', '2', '--budget-stop-policy', 'budget-wins',
      '--log-file', path.join(root, 'run.log')]);
    // vi.waitFor defaults to 1 s; the shared build01 runner needed longer to flush the log (CI run 104028).
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0), { timeout: 10_000 });
    await vi.waitFor(() => expect(readFileSync(path.join(root, 'run.log'), 'utf8')).toContain('Loop ID: fixture'), { timeout: 10_000 });
    expect(doubles.resume).toHaveBeenCalledWith({ allowExhaustedResume: true, maxIterations: 2,
      budgetPerIteration: 1.5, budgetLimits: { total_tokens: 100 }, explorationQuota: { enabled: true, k: 2 },
      budgetStopPolicy: 'budget-wins' });
  });

  it('maps an execution failure to a failure exit without attempting a retry', async () => {
    doubles.execute.mockRejectedValue(new Error('synthetic failure'));
    await invoke(['objective', '--completion', 'criteria']);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(console.error).toHaveBeenCalledWith('[External Ralph] Fatal error: synthetic failure');
    expect(doubles.execute).toHaveBeenCalledTimes(1);
  });

  it.each(['SIGINT', 'SIGTERM'])('shuts down once on %s and handles a repeated signal', async signal => {
    await invoke(['objective', '--completion', 'criteria']);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    await signals.get(signal)!();
    if (signal === 'SIGINT') {
      exit.mockImplementation(() => { throw new Error('synthetic process exit'); });
      await expect(signals.get(signal)!()).rejects.toThrow('synthetic process exit');
      expect(exit).toHaveBeenLastCalledWith(1);
    } else await signals.get(signal)!();
    expect(doubles.shutdown).toHaveBeenCalledTimes(1);
  });

  it.each(['SIGINT', 'SIGTERM'])('reports a failed %s shutdown and still exits', async signal => {
    doubles.shutdown.mockRejectedValue(new Error('shutdown fixture'));
    await invoke(['objective', '--completion', 'criteria']);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    await signals.get(signal)!();
    expect(console.error).toHaveBeenCalledWith('[External Ralph] Shutdown error: shutdown fixture');
  });

  it('dispatches worker status before provider probing', async () => {
    doubles.watch.mockResolvedValue(0);
    await invoke(['--status', '--workers', '--run-dir', root]);
    await vi.waitFor(() => expect(process.exitCode).toBe(0));
    expect(doubles.watch).toHaveBeenCalledWith({ watch: false, observe: false, json: false, runDir: root });
    expect(doubles.available).not.toHaveBeenCalled();
  });

  it.each([false, true])('normalizes unsafe status diagnostics with JSON %s', async json => {
    doubles.watch.mockRejectedValue(new Error('sensitive diagnostic text'));
    await invoke(['--status', '--workers', '--run-dir', root, ...(json ? ['--json'] : [])]);
    await vi.waitFor(() => expect(process.exitCode).toBe(1));
    if (json) expect(console.log).toHaveBeenCalledWith(expect.stringContaining('STATUS_REQUEST_FAILED'));
    else expect(console.error).toHaveBeenCalledWith('Worker status: STATUS_REQUEST_FAILED');
    expect(doubles.execute).not.toHaveBeenCalled();
  });
});
