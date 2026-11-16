// Exercise #4144 delay budgets, failure diagnostics, and child config ownership.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalCaptureEvidence, identityPublicationPauseMs } from '../../helpers/scoped-recovery-evidence.mjs';
import { buildWorkerInvocationEnvironment } from '../../../tools/ralph-external/lib/worker-invocation-processes.mjs';

afterEach(() => vi.unstubAllEnvs());

describe('#4144 scoped recovery regression helpers', () => {
  it.each([
    [0, 2300], [1700, 600], [2300, 0], [5100, 0],
  ])('after %i ms polling/scheduling, pauses only %i ms', (elapsed, expected) => {
    expect(identityPublicationPauseMs(10_000, 10_000 + elapsed)).toBe(expected);
  });

  it.each(['missing', 'malformed'])('reports %s config and invocation alongside retained exit evidence', async kind => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-equiv-evidence-'));
    try {
      const configPath = join(root, 'config.json');
      const invocationPath = join(root, 'plan.json');
      if (kind === 'malformed') {
        await writeFile(configPath, '{');
        await writeFile(invocationPath, '{');
      }
      await writeFile(join(root, 'exit.json'), JSON.stringify({ errorCode: 'FINAL_OUTPUT_INVALID' }));
      const [evidence] = JSON.parse(await finalCaptureEvidence({ runDir: root, configPath, invocationPath }));
      expect(evidence.config).toEqual({ path: configPath, error: expect.any(String) });
      expect(evidence.invocation).toEqual({ path: invocationPath, error: expect.any(String) });
      expect(JSON.parse(evidence.exit)).toEqual({ errorCode: 'FINAL_OUTPUT_INVALID' });
      expect(evidence.final).toEqual({ path: null, error: 'ERR_INVALID_ARG_TYPE' });
      expect(evidence.record).toEqual({ path: null, error: 'ERR_INVALID_ARG_TYPE' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('fixes fake-worker config at spawn even if the parent stubs it before the child reads it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-equiv-env-'));
    let child;
    let closed;
    try {
      const configPath = join(root, 'spawn-config.json');
      const laterConfigPath = join(root, 'later-config.json');
      const recordPath = join(root, 'record.json');
      await writeFile(configPath, JSON.stringify({ scenario: 'success', recordPath }));
      await writeFile(laterConfigPath, JSON.stringify({ scenario: 'missing-final', recordPath: join(root, 'wrong-record.json') }));
      vi.stubEnv('AIWG_FAKE_WORKER_CONFIG', configPath);
      const { env } = buildWorkerInvocationEnvironment(['AIWG_FAKE_WORKER_CONFIG'], 'synthetic-env-snapshot');
      const fixtureUrl = new URL('../../fixtures/ralph-worker-cli.mjs', import.meta.url).href;
      // Hold module loading until the parent changes its environment. The
      // fixture's config() therefore runs strictly after the second stub.
      child = spawn(process.execPath, ['--input-type=module', '-e', `
        process.stdout.write('ready\\n');
        for await (const chunk of process.stdin) {}
        await import(${JSON.stringify(fixtureUrl)});
      `], { env, stdio: ['pipe', 'pipe', 'pipe'] });
      closed = once(child, 'close');
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      await once(child.stdout, 'data');
      vi.stubEnv('AIWG_FAKE_WORKER_CONFIG', laterConfigPath);
      child.stdin.end();
      const [code, signal] = await closed;
      expect({ code, signal }, stderr).toEqual({ code: 0, signal: null });
      expect(JSON.parse(await readFile(recordPath, 'utf8')).scenario).toBe('success');
      expect(stdout).toContain('"type":"result"');
      await expect(readFile(join(root, 'wrong-record.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
      await rm(root, { recursive: true, force: true });
    }
  });
});
