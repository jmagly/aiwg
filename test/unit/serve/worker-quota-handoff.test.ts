import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { resolveWorkerInvocation, type WorkerInvocationDriver } from '../../../src/serve/worker-invocation.js';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it('skips a quota-exhausted account after running the rendered shell command (#4375)', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'aiwg-quota-handoff-')); roots.push(root);
  const cwd = path.join(root, 'project'); await mkdir(cwd);
  vi.stubEnv('AIWG_CONFIG', path.join(root, 'config'));
  const f = workerResolutionFixture();
  f.snapshot.config.parallelism!.clis = {
    codex: { adapter: 'providers:codex', accountScope: 'synthetic', quotaScope: 'limited' },
    other: { adapter: 'providers:codex', accountScope: 'synthetic', quotaScope: 'other' },
  };
  f.snapshot.installations.other = structuredClone(f.snapshot.installations.codex);
  const discovery = structuredClone(f.snapshot.catalog.discovery!.instances!.codex);
  discovery.models.forEach(row => { row.worker!.cliId = 'other'; });
  f.snapshot.catalog.discovery!.instances!.other = discovery;
  f.snapshot.config.parallelism!.groups!.workers.members[1].cli = 'other';
  const adapter = f.snapshot.registry.providers.codex.workerAdapter!;
  const driver: WorkerInvocationDriver = { qualification: { adapter, adapterId: adapter.id, cliVersion: '1.0.0' },
    buildInvocation: async input => ({ argv: [process.execPath, path.resolve('test/fixtures/worker-quota/fake-codex.mjs'),
      '--model', input.selected.model, '--effort', input.selected.effort.value!, '--sandbox', input.permissions.sandbox!,
      '--approval', input.permissions.approval!], stdin: 'brief-text', envNames: [] }) };
  const brief = path.join(cwd, 'brief.md'); await writeFile(brief, 'Bounded synthetic task.');
  const request = { role: 'coding', task: 'implementation', group: 'workers', brief, workdir: cwd,
    final_output: path.join(root, 'final.json'), transport: 'shell' as const };
  const drivers = { codex: driver, other: driver };
  const first = await resolveWorkerInvocation(f.snapshot, request, drivers, f.request.now);
  expect(first.selected?.member).toBe('primary');
  expect(first.invocation?.shellCommand).toBeTruthy();
  await expect(promisify(execFile)('/bin/sh', ['-c', first.invocation!.shellCommand!], {
    env: { ...process.env, TZ: 'UTC' }, timeout: 10000,
  })).rejects.toMatchObject({ code: 1 });
  expect(await readFile(first.invocation!.stdoutPath!, 'utf8')).toContain("You've hit your usage limit");
  const next = await resolveWorkerInvocation(f.snapshot, { ...request, final_output: path.join(root, 'next.json') }, drivers, f.request.now);
  expect(next.selected?.member).toBe('alternate');
  expect(next.exclusions.flatMap(e => e.diagnostics).some(d => d.message.includes('2026-11-29T10:56:00'))).toBe(true);
});
