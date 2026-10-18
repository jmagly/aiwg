import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { mkdir, cp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdtemp } from '../../helpers/temp-dir.js';
import { buildCliPackage } from '../../../tools/release/build-cli-package.mjs';

async function stage(resolver: boolean, implementation: 'missing' | 'present' | 'broken' = 'missing') {
  const root = await mkdtemp(join(tmpdir(), 'aiwg-monitor-dependencies-'));
  const directory = join(root, 'tools/ralph-external');
  await mkdir(join(directory, 'lib'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@aiwg/cli', type: 'module' }));
  await cp('tools/ralph-external/process-monitor.mjs', join(directory, 'process-monitor.mjs'));
  await cp('tools/ralph-external/lib/worker-health.mjs', join(directory, 'lib/worker-health.mjs'));
  if (resolver) await cp('tools/_resolve-impl.mjs', join(root, 'tools/_resolve-impl.mjs'));
  if (implementation !== 'missing') {
    await mkdir(join(root, 'dist/src/process'), { recursive: true });
    for (const file of ['bounded-child-process.mjs', 'signal-child.mjs']) {
      await cp(`src/process/${file}`, join(root, 'dist/src/process', file));
    }
    if (implementation === 'broken') await writeFile(join(root, 'dist/src/process/bounded-child-process.mjs'), 'throw new Error("broken helper");');
  }
  return { root, url: pathToFileURL(join(directory, 'process-monitor.mjs')).href };
}

function sample(url: string, root: string) {
  // Native Node loading must be exercised: Vite rewrites missing import URLs.
  return spawnSync(process.execPath, ['--input-type=module', '-e', `
    const module = await import(${JSON.stringify(url)});
    const monitor = new module.ProcessMonitor({ projectRoot: ${JSON.stringify(root)} });
    monitor.monitoredLoops.set('loop', { pid: process.pid });
    console.log(JSON.stringify(monitor.getProcessHealth('loop')));
  `], { encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL' });
}

describe('process monitor dependency closure (#3078)', () => {
  it.each([false, true])('distinguishes missing resolver and implementation (resolver present=%s)', async resolver => {
    const { root, url } = await stage(resolver);
    const child = sample(url, root);
    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout);
    expect(result.status).toBe('unavailable');
    expect(result.unavailableReason).toContain(resolver ? 'implementation missing' : 'resolver missing');
  });

  it('does not swallow an implementation defect', async () => {
    const { root, url } = await stage(true, 'broken');
    const child = sample(url, root);
    expect(child.status).not.toBe(0);
    expect(child.stderr).toContain('broken helper');
  });

  it('ships the helper alongside the staged monitor and samples a live process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-monitor-package-'));
    await buildCliPackage({ outputDir: root });
    const child = sample(pathToFileURL(join(root, 'tools/ralph-external/process-monitor.mjs')).href, root);
    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout);
    expect(['running', 'sleeping']).toContain(result.status);
    expect(result.cpu).toEqual(expect.any(Number));
  });
});
