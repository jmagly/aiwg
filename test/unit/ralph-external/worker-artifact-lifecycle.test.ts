import { usePlatformSimulation } from '../../helpers/windows-simulation.mjs';
/** Stop-proof retention and post-write containment regressions with local fixtures. */
import fs, { mkdtemp, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { rm } from '../../helpers/worker-capture-cleanup.mjs';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workerInvocationFixture } from '../../fixtures/worker-single-invocation.js';
import { ScopedFailureBreaker } from '../../../tools/ralph-external/lib/consecutive-failure-circuit-breaker.mjs';
import { materializeWorkerArtifacts } from '../../../tools/ralph-external/lib/worker-artifacts.mjs';

const simulatePlatform = usePlatformSimulation({ afterEach });

const roots: string[] = [], breakers: ScopedFailureBreaker[] = [];
afterEach(async () => {
  vi.unstubAllEnvs(); vi.restoreAllMocks(); syncBuiltinESMExports();
  for (const breaker of breakers.splice(0)) breaker.destroy();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const artifact = { name: 'patch', content: 'synthetic private brief' };
async function workspace() {
  vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-artifact-lifecycle-')); roots.push(root);
  const cwd = path.join(root, 'work'), runDir = path.join(root, 'run');
  await mkdir(cwd); await mkdir(runDir, { mode: 0o700 });
  const prefix = '.agents/skills/aiwg-brief-', relativePath = `${prefix}invocation-1/SKILL.md`;
  return { root, runDir, cwd, invocationId: 'invocation-1', argv: [process.execPath, '${artifact:patch}'],
    artifacts: [{ ...artifact, location: 'workspace-relative', prefix, relativePath }] };
}

describe('T-OG-15/23 artifact ownership and stop proof (#2905)', () => {
  it.each([true, false])('retains artifacts after an uncertain degraded exit (recovery gate %s)', async gated => {
    const f = await workerInvocationFixture({ artifacts: [artifact] }, { roots, breakers });
    const result = await f.launch({ sampleIdentity: () => null, ...(gated ? {} : { scopedBreaker: null }) });
    expect(result.termination).toBe('uncertain');
    expect(result.artifactCleanup).toEqual({ status: 'retained', reason: 'stop-proof-uncertain' });
    expect(await readFile(path.join(f.runDir, 'artifact-patch'), 'utf8')).toBe(artifact.content);
    const saved = JSON.parse(await readFile(path.join(f.runDir, 'exit.json'), 'utf8'));
    expect(saved.artifactCleanup).toEqual(result.artifactCleanup);
  });
  it.each([true, false])('retains workspace artifacts after an uncertain stop (recovery gate %s)', async gated => {
    const f = await workerInvocationFixture({ scenario: 'hang' }, { roots, breakers });
    // Use the existing declaration owner; no new schema or transport is needed.
    const original = f.drivers.codex.buildInvocation;
    f.drivers.codex.buildInvocation = async (input: any) => ({ ...await original(input), artifacts: [{ ...artifact,
      location: 'workspace-relative', prefix: '.agents/skills/aiwg-brief-',
      relativePath: `.agents/skills/aiwg-brief-${input.invocationId}/SKILL.md` }] });
    const { resolveWorkerInvocation } = await import('../../../src/serve/worker-invocation.js');
    const plan = await resolveWorkerInvocation(f.snapshot, f.plan.request!, f.drivers, f.request.now);
    await writeFile(f.invocationPath, JSON.stringify(plan));
    const child: any = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.unref = () => {};
    child.pid = 2147483646;
    f.launcher.once('launched', () => { f.launcher.kill(); queueMicrotask(() => {
      child.stdout.end(); child.stderr.end(); child.emit('exit', null, 'SIGTERM'); child.emit('close', null, 'SIGTERM');
    }); });
    const result = await f.launch({ ...(gated ? {} : { scopedBreaker: null }), launchIsolated: () => ({ child, mode: 'degraded' }) });
    expect(result.termination).toBe('uncertain');
    expect(result.artifactCleanup.status).toBe('retained');
    expect(await readFile(path.join(f.cwd, plan.invocation!.artifacts![0].relativePath!), 'utf8')).toBe(artifact.content);
  });
  it('re-walks the full cwd chain after writing and reverts the transient outside-cwd leaf', async () => {
    const f = await workspace(), original = fs.open, moved = path.join(f.root, 'relocated');
    let hit = false;
    vi.spyOn(fs, 'open').mockImplementation(async (...args: any[]) => {
      const handle = await (original as any)(...args);
      if (!hit && String(args[0]).endsWith('/SKILL.md')) {
        hit = true;
        const write = handle.writeFile.bind(handle);
        vi.spyOn(handle, 'writeFile').mockImplementation(async (...values: any[]) => {
          await write(...values);
          await rename(path.join(f.cwd, '.agents'), moved);
        });
      }
      return handle;
    });
    syncBuiltinESMExports();
    await expect(materializeWorkerArtifacts(f, f.runDir)).rejects.toThrow(/containment/);
    expect(hit).toBe(true);
    expect(await readdir(path.join(moved, 'skills'))).toEqual([]);
  });
  it.each(['missing', 'replacement'])('retains and reports artifacts when the portable parent is %s', async scenario => {
    const f = await workspace();
    simulatePlatform('darwin');
    const result = await materializeWorkerArtifacts(f, f.runDir);
    const target = path.dirname(result.argv[1]), moved = path.join(f.root, 'relocated');
    await rename(target, moved);
    if (scenario === 'replacement') { await mkdir(target); await writeFile(path.join(target, 'SKILL.md'), 'unrelated'); }
    await expect(result.cleanup()).rejects.toThrow(/cleanup failed/);
    const retained = await readdir(f.runDir, { recursive: true });
    const contents = await Promise.all(retained.map(name => readFile(path.join(f.runDir, name), 'utf8').catch(() => '')));
    if (scenario === 'replacement') expect(contents).toContain('unrelated');
    expect(await readFile(path.join(moved, 'SKILL.md'), 'utf8')).toBe(artifact.content);
  });
});
