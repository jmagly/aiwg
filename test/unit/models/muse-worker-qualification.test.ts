// Muse catalog refresh and approval exercise only a disposable native catalog and fake CLI.
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { doctorWorkerCliFixture } from '../../helpers/doctor-worker-cli.js';
import { writeExecutable } from '../../helpers/write-executable.js';
import { qualifyProbedWorkers } from '../../../tools/cli/worker-qualification.mjs';
import { loadProviderModelCapabilities } from '../../../src/models/provider-policy.js';
import * as discovery from '../../../src/models/model-discovery.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(current: boolean | undefined) {
  const f = await doctorWorkerCliFixture();
  roots.push(f.root);
  const binary = path.join(f.root, 'fake-bin/muse');
  const calls = path.join(f.root, 'muse-calls.jsonl');
  await writeExecutable(binary, `#!${process.execPath}
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.argv.slice(2).join(' ') === '--version') console.log('Muse Code 1.4.25 (1.4.25-R9361.1)');
else process.exit(90);
`);
  const configFile = path.join(f.project, '.aiwg/aiwg.config');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  config.providers = ['muse'];
  config.parallelism.clis = { muse: { adapter: 'providers:muse', executable: binary,
    accountScope: 'synthetic-account', quotaScope: 'synthetic-quota' } };
  config.parallelism.groups.workers.members[0] = { id: 'primary', cli: 'muse', model: 'muse-spark-1.3', roles: ['coding'] };
  await writeFile(configFile, JSON.stringify(config));
  const catalog = JSON.parse(await readFile(new URL('../../fixtures/providers/muse/catalog.json', import.meta.url), 'utf8'));
  if (current === undefined) delete catalog.rows[0].is_current;
  else catalog.rows[0].is_current = current;
  catalog.fetchedAt = new Date().toISOString();
  const catalogDir = path.join(f.root, '.local/share/muse/model-catalog');
  await mkdir(catalogDir, { recursive: true });
  await writeFile(path.join(catalogDir, 'synthetic.json'), JSON.stringify(catalog));
  return { ...f, calls };
}

it('#4394 refresh binds native Muse catalog rows to the installed runtime and account, then qualifies', async () => {
  const f = await fixture(true);
  const refresh = await f.run(['models', 'refresh', '--provider', 'muse', '--json']);
  expect(refresh.code, refresh.stdout + refresh.stderr).toBe(0);
  const cache = JSON.parse(await readFile(path.join(f.root, '.cache/aiwg/model-catalog.v1.json'), 'utf8'));
  expect(cache.discovery.providers.muse.models[0]).toMatchObject({ id: 'muse-spark-1.3', worker: {
    availability: 'accessible', runtimeVersion: '1.4.25', accountScope: 'synthetic-account',
  } });
  const result = await f.run(['doctor', '--probe-workers', '--qualify', '--cli', 'muse', '--yes', '--json']);
  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).qualification).toMatchObject({ status: 'recorded', results: [{
    cli: 'muse', status: 'qualified', models: ['muse-spark-1.3'],
  }] });
  expect((await readFile(f.calls, 'utf8')).trim().split('\n').every(line => JSON.parse(line).join(' ') === '--version')).toBe(true);
});

it.each([false, undefined])('#4394 explains missing Muse current-model evidence (%s) without recommending an ineffective refresh', async current => {
  const f = await fixture(current);
  const result = await f.run(['doctor', '--probe-workers', '--qualify', '--cli', 'muse', '--yes', '--json']);
  const report = JSON.parse(result.stdout).qualification;
  expect(report).toMatchObject({ status: 'partial', results: [{ cli: 'muse', status: 'partial', models: [] }] });
  const warning = report.results[0].warning;
  expect(warning).toContain('Muse');
  expect(warning).toContain('is_current: true');
  expect(warning).toContain('sign in');
  expect(warning).toContain('aiwg doctor --probe-workers --qualify --cli muse --yes');
  expect(warning).not.toContain('Refresh model discovery before qualifying again');
});

it.each(['missing-row', 'missing-provider', 'mixed'])('reports exact missing Muse evidence for %s', async state => {
  const f = await fixture(true);
  const catalogFile = path.join(f.root, '.local/share/muse/model-catalog/synthetic.json');
  const catalog = JSON.parse(await readFile(catalogFile, 'utf8'));
  if (state === 'missing-row') catalog.rows[0].model_id = 'another-model';
  if (state === 'missing-provider') delete catalog.rows[0].provider_id;
  if (state === 'mixed') {
    const configFile = path.join(f.project, '.aiwg/aiwg.config');
    const config = JSON.parse(await readFile(configFile, 'utf8'));
    config.parallelism.groups.workers.members.push({ id: 'secondary', cli: 'muse', model: 'absent-model', roles: ['coding'] });
    await writeFile(configFile, JSON.stringify(config));
  }
  await writeFile(catalogFile, JSON.stringify(catalog));
  const result = await f.run(['doctor', '--probe-workers', '--qualify', '--cli', 'muse', '--yes', '--json']);
  const report = JSON.parse(result.stdout).qualification;
  expect(report).toMatchObject({ status: 'partial', results: [{ cli: 'muse', status: 'partial',
    models: state === 'mixed' ? ['muse-spark-1.3'] : [],
    warning: expect.stringContaining('missing exact model_id/provider_id catalog row'),
  }] });
});

it.each(['qualified', 'mixed', 'availability', 'runtimeVersion', 'accountScope', 'catalog-error'])('reports Muse %s through the source qualification API', async gap => {
  const f = await fixture(true);
  await symlink(path.join(process.cwd(), 'src'), path.join(f.installed, 'src'));
  const observed = await discovery.discoverMuseCatalogModels({
    catalogDir: path.join(f.root, '.local/share/muse/model-catalog'),
    runtimeVersion: '1.4.25', accountBinding: 'synthetic-account',
  });
  if (gap === 'availability') observed.models[0].worker!.availability = 'unknown';
  if (gap === 'runtimeVersion') observed.models[0].worker!.runtimeVersion = '1.4.12';
  if (gap === 'accountScope') observed.models[0].worker!.accountScope = 'old-account';
  if (gap === 'catalog-error') { observed.models = []; observed.error = 'Synthetic catalog unavailable'; }
  vi.spyOn(discovery, 'discoverMuseCatalogModels').mockResolvedValueOnce(observed);
  vi.stubEnv('HOME', f.root);
  vi.stubEnv('AIWG_CONFIG', f.config);
  vi.stubEnv('AIWG_HOME', f.installed);
  vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
  const config = JSON.parse(await readFile(path.join(f.project, '.aiwg/aiwg.config'), 'utf8'));
  config.parallelism.groups.workers.execution.sandbox = 'external';
  if (gap === 'mixed') config.parallelism.groups.workers.members.push({ id: 'missing', cli: 'muse', model: 'absent-model', roles: ['coding'] });
  const result = await qualifyProbedWorkers({ projectDir: f.project, packageRoot: f.installed, config,
    registry: loadProviderModelCapabilities(), section: { installFindings: [{ cli: 'muse', readiness: 'ready',
      installedVersion: '1.4.25', executable: path.join(f.root, 'fake-bin/muse') }] }, yes: true });
  expect(result, JSON.stringify(result)).toMatchObject({ status: gap === 'qualified' ? 'recorded' : 'partial', results: [{
    status: gap === 'qualified' ? 'qualified' : 'partial', models: ['qualified', 'mixed'].includes(gap) ? ['muse-spark-1.3'] : [],
  }] });
  if (gap === 'qualified') { expect(result.results[0].warning).toBeUndefined(); return; }
  const detail = gap === 'availability' ? 'accessibility (is_current: true)'
    : gap === 'catalog-error' ? 'Muse catalog discovery failed: Synthetic catalog unavailable'
      : gap === 'mixed' ? 'missing exact model_id/provider_id catalog row'
        : `matching ${gap === 'runtimeVersion' ? 'installed runtimeVersion' : 'accountScope'}`;
  expect(result.results[0].warning).toContain(detail);
});
