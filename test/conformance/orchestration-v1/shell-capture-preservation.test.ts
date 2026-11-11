/** T-OG-15 (partial): two resolved shell plans must preserve the first fake Codex attempt. */
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rm } from '../../helpers/worker-capture-cleanup.mjs';
import { loadProviderModelCapabilities } from '../../../src/models/provider-policy.js';
import { resolveWorkerInvocation, type WorkerInvocationDriver } from '../../../src/serve/worker-invocation.js';
import { CodexAdapter } from '../../../tools/ralph-external/lib/codex-adapter.mjs';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('T-OG-15 raw shell capture preservation (partial)', () => {
  it('refuses the second exact resolved command after a changed brief without replacing any first-attempt bytes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-shell-preservation-')); roots.push(root);
    const cwd = path.join(root, "worker '雪"); await mkdir(cwd);
    const brief = path.join(cwd, 'brief.md'), final = path.join(cwd, 'answer.json');
    const config = path.join(root, 'fake.json'), received = path.join(root, 'received.json');
    const f = workerResolutionFixture(), owner = new CodexAdapter();
    const adapter = structuredClone(loadProviderModelCapabilities().providers.codex.workerHealthAdapter!);
    adapter.qualification = f.snapshot.registry.providers.codex.workerAdapter!.qualification;
    const profile = adapter.invocationProfiles!['direct-shell'];
    for (const control of Object.values(profile.controls)) control.support = 'native';
    adapter.capabilities = { ...f.snapshot.registry.providers.codex.workerAdapter!.capabilities, output: 'validated-file' };
    profile.envAllowlist = adapter.invocation.envAllowlist = ['PATH', 'AIWG_FAKE_WORKER_CONFIG'];
    f.snapshot.registry.providers.codex.workerAdapter = adapter;
    f.snapshot.installations.codex = { ...f.snapshot.installations.codex, cliVersion: '0.161.0', profile: 'direct-shell' };
    const discovery = f.snapshot.catalog.discovery!.instances!.codex;
    discovery.runtimeVersion = '0.161.0';
    for (const model of discovery.models) model.worker!.runtimeVersion = '0.161.0';
    const drivers: Record<string, WorkerInvocationDriver> = { codex: {
      qualification: { adapter, adapterId: 'codex', cliVersion: '0.161.0' },
      buildInvocation: async input => ({ argv: [process.execPath, path.resolve('test/fixtures/providers/codex/fake-codex.mjs'),
        ...owner.buildWorkerArgs(input, profile, input.permissions)], stdin: 'brief-text', envNames: profile.envAllowlist }),
    } };
    const request = { role: 'coding', task: 'implementation', group: 'workers', brief, workdir: cwd,
      final_output: final, transport: 'shell' as const };
    const resolve = async () => {
      const plan = await resolveWorkerInvocation(f.snapshot, request, drivers, f.request.now);
      expect(plan.status, JSON.stringify(plan.diagnostics)).toBe('eligible');
      expect(plan.invocation!.readiness).toBe('launchable');
      expect(plan.invocation!.shellCommand).not.toContain('SYNTHETIC-BRIEF');
      return plan.invocation!;
    };
    const run = (shellCommand: string) => spawnSync('/bin/sh', ['-c', shellCommand], { cwd,
      env: { PATH: process.env.PATH, AIWG_FAKE_WORKER_CONFIG: config }, encoding: 'utf8', timeout: 10000 });
    await writeFile(brief, 'SYNTHETIC-BRIEF first attempt.');
    await writeFile(config, JSON.stringify({ scenario: 'structured-final-with-prose', structuredFinalPath: final, recordPath: received }));
    const first = await resolve(), run1 = run(first.shellCommand!);
    expect(run1.status, run1.stderr).toBe(0);
    expect(JSON.parse(await readFile(final, 'utf8')).status).toBe('completed');
    const paths = [final, first.stdoutPath!, first.stderrPath!, `${final}.last-message`, received];
    const before = await Promise.all(paths.map(filename => readFile(filename)));
    await writeFile(brief, 'SYNTHETIC-BRIEF second distinct attempt.');
    await writeFile(config, JSON.stringify({ scenario: 'prose-only', writeProseFinal: true, structuredFinalPath: final, recordPath: received }));
    const second = await resolve();
    expect(second.briefDigest).not.toBe(first.briefDigest);
    expect([second.finalPath, second.stdoutPath, second.stderrPath]).toEqual([first.finalPath, first.stdoutPath, first.stderrPath]);
    const run2 = run(second.shellCommand!);
    expect(run2.status, run2.stderr).not.toBe(0);
    expect(await Promise.all(paths.map(filename => readFile(filename)))).toEqual(before);
  });
});
