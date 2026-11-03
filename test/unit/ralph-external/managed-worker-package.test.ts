import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { cliToolFiles } from '../../../tools/release/cli-package-files.mjs';
import { parseManagedWorkerLaunchArgs } from '../../../tools/ralph-external/session-launcher.mjs';

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('T-OG-14 packaged managed one-shot entry point', () => {
  it('requires the fenced parent contract and rejects legacy, retry and duplicate flags', () => {
    const args = ['--launch-worker', '--invocation', '/synthetic/plan', '--run-dir', '/synthetic/capture',
      '--managed-request', 'synthetic-request', '--managed-generation', '2'];
    expect(parseManagedWorkerLaunchArgs(args)).toEqual({ invocationPath: '/synthetic/plan', runDir: '/synthetic/capture',
      managedAdmission: { requestId: 'synthetic-request', generation: 2 } });
    for (const extra of [['--provider', 'codex'], ['--retry-of', 'previous'], ['--launch-worker'], ['--allow-degraded-worker']]) {
      expect(() => parseManagedWorkerLaunchArgs([...args, ...extra])).toThrow(/Unsupported|Duplicate/);
    }
    expect(() => parseManagedWorkerLaunchArgs(args.slice(0, -2))).toThrow(/fenced admission/);
    expect(() => parseManagedWorkerLaunchArgs([...args.slice(0, -1), '0'])).toThrow(/generation/);
  });

  it.each(['aiwg', '@aiwg/cli'])('%s loads the shipped session owner without source or the unshipped loop entry point', async name => {
    const source = process.cwd();
    const manifest = JSON.parse(await readFile(join(source, name === 'aiwg' ? 'package.json' : 'packages/cli/package.json'), 'utf8'));
    const stagedTools = cliToolFiles(source, manifest.files);
    const buildScript = await readFile(join(source, 'tools/release/build-cli-package.mjs'), 'utf8');
    const root = await mkdtemp(join(tmpdir(), 'managed-package-')); roots.push(root);
    await writeFile(join(root, 'package.json'), JSON.stringify({ name, type: 'module' }));
    await symlink(join(source, 'node_modules'), join(root, 'node_modules'), 'dir');
    const toolFiles = ['tools/_resolve-impl.mjs', 'tools/ralph-external/session-launcher.mjs',
      'tools/ralph-external/process-monitor.mjs', 'tools/scripts/resource-preflight.mjs',
      ...['worker-inputs', 'worker-final', 'strict-worker-json', 'worker-launch-cli', 'managed-worker-attempt', 'session-attempt', 'worker-health', 'worker-artifacts', 'consecutive-failure-circuit-breaker', 'session-environment', 'launcher-recovery-evidence',
        'worker-isolation', 'worker-isolation-args', 'worker-unit-cleanup', 'worker-native-sandbox', 'worker-isolation-status', 'worker-retry-evidence', 'worker-termination', 'worker-invocation-processes', 'worker-invocation-ancestry', 'worker-context', 'systemd-client', 'recovery-probe'].map(file => `tools/ralph-external/lib/${file}.mjs`)];
    for (const file of toolFiles) {
      expect(manifest.files.includes('tools/') || manifest.files.includes(file), file).toBe(true);
      if (name === '@aiwg/cli') expect(stagedTools, file).toContain(file);
      await mkdir(dirname(join(root, file)), { recursive: true });
      await copyFile(join(source, file), join(root, file));
    }
    const capabilities = 'agentic/code/providers/model-capabilities.v1.json';
    expect(manifest.files.includes('agentic/') || manifest.files.includes('agentic/code/providers/')).toBe(true);
    if (name === '@aiwg/cli') expect(buildScript).toContain("'agentic', 'code', 'providers'");
    await mkdir(dirname(join(root, capabilities)), { recursive: true });
    await copyFile(join(source, capabilities), join(root, capabilities));
    // These runtime sources are already ESM; stage their published dist locations without a build.
    for (const file of ['process/signal-child.mjs', 'process/bounded-child-process.mjs', 'models/worker-installation.mjs', 'models/worker-installation-store.mjs', 'models/qualification-digest.mjs',
      'models/worker-artifact-binding.mjs', 'serve/worker-artifacts.mjs', 'config/dispatch-thresholds-runtime.mjs', 'config/host-resource-runtime.mjs', 'config/worker-invocation-marker.mjs', 'config/worker-attribution.mjs', 'config/project-artifacts-runtime.mjs']) {
      await mkdir(dirname(join(root, 'dist/src', file)), { recursive: true });
      await copyFile(join(source, 'src', file), join(root, 'dist/src', file));
    }
    const entry = join(root, 'tools/ralph-external/session-launcher.mjs');
    const imported = await exec(process.execPath, ['--input-type=module', '-e',
      `const owner = await import(${JSON.stringify(pathToFileURL(entry).href)}); console.log(typeof owner.SessionLauncher, typeof owner.parseManagedWorkerLaunchArgs);`],
    { cwd: root, timeout: 10_000, env: { PATH: process.env.PATH, AIWG_RESOLVE_IMPL_FROM: 'dist' } });
    expect(imported.stdout.trim()).toBe('function function');
    await expect(exec(process.execPath, [resolve(entry), '--provider', 'codex'],
      { cwd: root, timeout: 10_000, env: { PATH: process.env.PATH, AIWG_RESOLVE_IMPL_FROM: 'dist' } }))
      .rejects.toMatchObject({ code: 1, stderr: 'Unsupported managed worker option: --provider\n' });
  });
});
