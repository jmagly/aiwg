// Register production systemd launch-preparation regressions with a controlled admission clock.
import { existsSync, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { ScopedFailureBreaker } from '../../../tools/ralph-external/lib/consecutive-failure-circuit-breaker.mjs';
import { systemdClientFixture } from '../../fixtures/systemd-client.js';
import { workerPromptBrief } from '../../../tools/ralph-external/lib/worker-prompt.mjs';

type LaunchHarness = {
  root: string;
  work: string;
  input: { final_output: string };
  registry: { canStart(): boolean; get(id: string): { terminalAt: unknown; control: unknown } };
  run(): Promise<{ status: string; termination: string; invocationId: string }>;
};

export function registerSystemdLaunchPreparationTests<H extends LaunchHarness>({
  harness: createHarness, installJsonWorker, roots, waitFor, healthyGateLive,
}: {
  harness: (options?: Record<string, unknown>) => Promise<H>;
  installJsonWorker: (h: H) => Promise<void>;
  roots: string[];
  waitFor: (predicate: () => boolean) => Promise<void>;
  healthyGateLive: object;
}) {
  // These cases inject the systemd-run result. Keep preparation within the
  // admission budget regardless of scheduler delays, so the real launch is
  // reached. Stop/recheck timers still run normally and assertions wait for
  // observable stop and cleanup state.
  const harness = (options: Record<string, unknown>) => createHarness({
    scopedBreaker: new ScopedFailureBreaker({ nowMs: () => 0, jitterMs: () => 0 }),
    ...options,
  });

  it('supplies a memory ceiling and private framed stdin to the production systemd launcher', async () => {
    const client = systemdClientFixture();
    roots.push(client.root);
    vi.stubEnv('PATH', client.root);
    let stdinPath = '';
    let h: Awaited<ReturnType<typeof harness>>;
    const spawn = vi.fn((command: string, args: string[], _options: any) => {
      if (command === client.binary) {
        expect(args).toContain('MemoryMax=2G');
        const property = args.find(arg => arg.startsWith('StandardInputFile='))!;
        stdinPath = property.slice('StandardInputFile='.length);
        const frame = JSON.parse(readFileSync(stdinPath, 'utf8'));
        // #4156: the shell brief carries the launcher's final-output contract.
        expect(frame).toEqual({ message: workerPromptBrief('private worker brief', h.input.final_output).toString('utf8'), model_override: 'synthetic/a%b', cwd: h.work });
        expect(args.join(' ')).not.toContain('private worker brief');
        expect(readFileSync(stdinPath).length).toBeGreaterThan(0);
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: args.includes('show-environment') ? '' : '123\n', stderr: '' };
    });
    h = await harness({ gateInputs: { live: healthyGateLive, isolation: { mode: 'systemd-unit' }, spawn },
      waitForUnitTermination: async () => ({ termination: 'confirmed', exitCode: 0 }) });
    await installJsonWorker(h);
    const result = await h.run();
    expect(result.termination).toBe('confirmed');
    expect(spawn.mock.calls.filter(c => c[0] === client.binary)).toHaveLength(1);
    // Launcher exceptions become outcomes; a swallowed assertion must fail here.
    expect(spawn.mock.results[spawn.mock.calls.findIndex(c => c[0] === client.binary)])
      .toEqual({ type: 'return', value: { status: 0, stdout: '', stderr: '' } });
    expect(spawn).toHaveBeenCalledWith(client.binary, expect.arrayContaining(['MemoryMax=2G']),
      expect.objectContaining({ env: expect.objectContaining({ PATH: client.root }) }));
    expect(spawn).toHaveBeenCalledWith(client.systemctl, ['--user', 'show-environment'],
      expect.objectContaining({ env: expect.objectContaining({ PATH: client.root }) }));
    expect(stdinPath).not.toBe('');
    await expect(stat(stdinPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(h.registry.canStart()).toBe(true);
  });

  it.each(['nonzero', 'timeout', 'throws'])('retains framed stdin and output after an attempted systemd launch %s until stopped', async failure => {
    const client = systemdClientFixture();
    roots.push(client.root);
    vi.stubEnv('PATH', client.root);
    let stdinPath = '';
    let unit = '';
    let confirmed = false;
    let h: Awaited<ReturnType<typeof harness>>;
    const spawn = vi.fn((binary: string, args: string[]) => {
      if (binary !== client.binary) return { status: 0, stdout: '', stderr: '' };
      stdinPath = args.find(arg => arg.startsWith('StandardInputFile='))!.slice('StandardInputFile='.length);
      unit = args.find(arg => arg.startsWith('--unit='))!.slice('--unit='.length);
      if (failure === 'throws') throw new Error('client failed after unit acceptance');
      return { status: 1, error: failure === 'timeout' ? new Error('ETIMEDOUT') : undefined, stderr: 'client failed' };
    });
    const stop = vi.fn(async (name: string) => {
      expect(name).toBe(unit);
      expect(h.registry.canStart()).toBe(false);
      expect(existsSync(stdinPath)).toBe(true);
      expect(existsSync(h.input.final_output)).toBe(true);
      return { ok: true };
    });
    const kill = vi.fn(async () => ({ ok: true }));
    const observe = vi.fn(async () => confirmed ? { termination: 'confirmed', exitCode: 1 }
      : { termination: 'uncertain', exitCode: null });
    h = await harness({ gateInputs: { live: healthyGateLive, isolation: { mode: 'systemd-unit' }, spawn },
      waitForUnitTermination: observe, stopWorkerUnit: stop, killWorkerUnit: kill });
    await installJsonWorker(h);
    const pending = h.run();
    await waitFor(() => stop.mock.calls.length > 0);
    const result = await pending;
    expect(result.status).toBe('blocked');
    expect(result.termination).toBe('uncertain');
    expect(h.registry.get(result.invocationId).terminalAt).toBeNull();
    expect(h.registry.get(result.invocationId).control).not.toBeNull();
    expect(spawn.mock.calls.filter(c => c[0] === client.binary)).toHaveLength(1);
    expect(unit).not.toBe('');
    expect(stdinPath).not.toBe('');
    expect(stop).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalled();
    await expect(stop.mock.results[0].value).resolves.toEqual({ ok: true });
    expect(kill).toHaveBeenCalledWith(unit, expect.objectContaining({ signal: expect.any(AbortSignal), timeout: expect.any(Number) }));
    expect(h.registry.canStart()).toBe(false);
    expect(existsSync(stdinPath)).toBe(true);
    expect(existsSync(h.input.final_output)).toBe(true);
    confirmed = true;
    await waitFor(() => h.registry.canStart() && !existsSync(stdinPath) && !existsSync(h.input.final_output));
    expect(h.registry.get(result.invocationId)).toMatchObject({ status: 'failed', termination: 'confirmed', control: null });
  });

}
