// Runtime discovery remains bounded and unknown when Muse cannot provide a valid version.
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { discoverProjectMuseModels } from '../../../src/models/muse-models.js';
import type { ModelDiscoveryCommandRunner, ModelDiscoveryOptions } from '../../../src/models/model-discovery.js';
import { writeExecutable } from '../../helpers/write-executable.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'aiwg-muse-runtime-'));
  roots.push(homeDir);
  const catalogDir = path.join(homeDir, '.local/share/muse/model-catalog');
  await mkdir(catalogDir, { recursive: true });
  await writeFile(path.join(catalogDir, 'catalog.json'),
    await readFile(new URL('../../fixtures/providers/muse/catalog.json', import.meta.url)));
  const runner = vi.fn<ModelDiscoveryCommandRunner>(async () => ({ stdout: 'Muse Code 1.4.25 (1.4.25-R9361.1)\n', stderr: '', exitCode: 0 }));
  const options: ModelDiscoveryOptions = { aiwgRoot: homeDir, homeDir,
    inventory: { generatedAt: new Date().toISOString(), projectDir: homeDir, providers: [], activeProvider: null, activeSource: 'test' }, runner };
  return { options, runner, catalogDir };
}

it('probes the default Muse runtime without a project installation', async () => {
  const { options, runner } = await fixture();
  const result = await discoverProjectMuseModels(options);
  expect(result.models[0].worker).toMatchObject({ runtimeVersion: '1.4.25', accountScope: 'local-account' });
  expect(runner).toHaveBeenCalledWith('muse', ['--version'], { cwd: tmpdir(), timeoutMs: 5000, env: expect.any(Object) });
  expect(runner.mock.calls[0][2]!.env).not.toHaveProperty('HOME');
});

it.each(['exit', 'banner', 'throw'])('keeps a %s version probe unknown without losing catalog facts', async failure => {
  const { options, runner } = await fixture();
  if (failure === 'throw') runner.mockRejectedValueOnce(new Error('unavailable'));
  else runner.mockResolvedValueOnce({ stdout: failure === 'banner' ? 'invalid' : '', stderr: '', exitCode: failure === 'exit' ? 1 : 0 });
  const result = await discoverProjectMuseModels(options);
  expect(result.models[0].worker).toMatchObject({ runtimeVersion: 'unknown', availability: 'accessible' });
});

it('preserves explicit catalog, runtime and account inputs without probing', async () => {
  const { options, runner, catalogDir } = await fixture();
  options.muse = { catalogDir, runtimeVersion: '1.4.12', accountBinding: 'explicit-account' };
  const result = await discoverProjectMuseModels(options);
  expect(result.models[0].worker).toMatchObject({ runtimeVersion: '1.4.12', accountScope: 'explicit-account' });
  expect(runner).not.toHaveBeenCalled();
});

it('ignores disabled, local and unrelated installations and binds a native Muse alias', async () => {
  const { options, runner } = await fixture();
  const native = { adapter: 'providers:muse', accountScope: 'native-account', quotaScope: 'quota', executable: '/fake/muse' };
  options.parallelism = { clis: {
    disabled: { ...native, enabled: false }, local: { ...native, localModels: { endpoint: 'http://127.0.0.1:1', models: [] } },
    other: { ...native, adapter: 'providers:codex' }, alias: native,
  }, groups: {} };
  const result = await discoverProjectMuseModels(options);
  expect(result.models[0].worker!.accountScope).toBe('native-account');
  expect(runner.mock.calls[0][0]).toBe('/fake/muse');
});

it('does not assign an ambiguous installation account to provider-wide refresh', async () => {
  const { options, runner } = await fixture();
  const native = { adapter: 'providers:muse', accountScope: 'first', quotaScope: 'quota' };
  options.parallelism = { clis: { muse: native, second: { ...native, accountScope: 'second' } }, groups: {} };
  const result = await discoverProjectMuseModels(options);
  expect(result.models[0].worker!.accountScope).toBe('local-account');
  expect(runner.mock.calls[0][0]).toBe('muse');
});

it('uses the isolated HOME catalog and real bounded command runner when overrides are absent', async () => {
  const { options } = await fixture();
  await writeExecutable(path.join(options.homeDir!, 'muse'), `#!${process.execPath}
if (process.argv.slice(2).join(' ') !== '--version' || process.env.HOME) process.exit(90);
console.log('Muse Code 1.4.25 (1.4.25-R9361.1)');
`);
  vi.stubEnv('HOME', options.homeDir!);
  vi.stubEnv('PATH', options.homeDir!);
  delete options.homeDir;
  delete options.runner;
  const result = await discoverProjectMuseModels(options);
  expect(result.models[0].worker).toMatchObject({ runtimeVersion: '1.4.25', availability: 'accessible' });
});
