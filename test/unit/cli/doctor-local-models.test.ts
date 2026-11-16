// T-OG-03/12: public qualification, signed store and resolve with synthetic local models.
import { readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { doctorWorkerCliFixture } from '../../helpers/doctor-worker-cli.js';
import { localModelEndpoint } from '../../fixtures/local-model-endpoint.js';
import { workerLocalOnlyPreflight } from '../../../src/mcp/tools/worker-local-only-preflight.mjs';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function fixture() {
  const server = await localModelEndpoint();
  cleanup.push(server.close);
  const f = await doctorWorkerCliFixture();
  cleanup.push(() => rm(f.root, { recursive: true, force: true }));
  const filename = path.join(f.project, '.aiwg/aiwg.config');
  const config = JSON.parse(await readFile(filename, 'utf8'));
  config.parallelism.clis.codex.localModels = { endpoint: server.endpoint,
    models: [{ id: 'synthetic-model', checkpoint: 'fixture-q4-r1', contextTokens: 32000, maxOutputTokens: 4096, efforts: ['medium'] }] };
  await writeFile(filename, JSON.stringify(config));
  const modelFile = path.join(f.project, 'models.json');
  const models = JSON.parse(await readFile(modelFile, 'utf8'));
  models.defaults.workerSelection.dataPolicy.allowedProcessing = ['local'];
  await writeFile(modelFile, JSON.stringify(models));
  return { ...f, configDir: f.config, server, config, models, filename, modelFile };
}
describe('local endpoint qualification and dispatch (T-OG-03/12)', () => {
  it('qualifies the observed tuple, signs its receipt, renders -m and passes local-only preflight', async () => {
    const f = await fixture();
    const qualification = await f.run(['doctor', '--probe-workers', '--qualify', '--yes', '--json']);
    expect(qualification.code, qualification.stdout + qualification.stderr).toBe(0);
    expect(JSON.parse(qualification.stdout).qualification.results[0].models).toEqual(['synthetic-model']);
    const stored = JSON.parse(await readFile(path.join(f.configDir, 'worker-installations.json'), 'utf8'));
    const record = stored.registrations[0];
    expect(record.signature).toBeDefined();
    expect(record.modelObservations.source).toBe('local-endpoint');
    const observation = record.modelObservations.models[0];
    expect(observation.worker).toMatchObject({ checkpoint: 'fixture-q4-r1', dataUse: { processing: 'local' },
      qualification: { status: 'qualified', roles: ['coding'] } });
    const resolved = await f.resolve();
    expect(resolved.code, resolved.stdout + resolved.stderr).toBe(0);
    const plan = JSON.parse(resolved.stdout);
    expect(plan.invocation.argv).toEqual(expect.arrayContaining(['-m', 'synthetic-model']));
    expect(plan.invocation.readiness).toBe('launchable');
    await writeFile(path.join(f.project, 'private'), 'synthetic local-only input');
    const preflight = { root: f.project,
      snapshot: { config: f.config, models: { defaults: { workerSelection: { dataPolicy: { localOnlyPaths: ['private'] } } } },
        catalog: { discovery: { instances: { codex: record.modelObservations } } } },
      invocation: { selected: { cli: 'codex', model: 'synthetic-model', inferenceProvider: 'self-hosted' }, cwd: f.project }, drivers: {} };
    expect(await workerLocalOnlyPreflight(preflight)).toBeNull();
    observation.worker.dataUse.processing = 'remote';
    expect(await workerLocalOnlyPreflight(preflight)).toMatchObject({ code: 'LOCAL_ONLY_PATH_EXPOSED' });
    expect(f.server.requests).toHaveLength(1);
    f.models.defaults.workerSelection.dataPolicy.allowedProcessing = ['remote'];
    await writeFile(f.modelFile, JSON.stringify(f.models));
    await f.run(['doctor', '--probe-workers', '--qualify', '--yes', '--json']);
    const denied = await f.resolve();
    expect(denied.code).not.toBe(0);
    expect(denied.stdout).toContain('OG_DATA_POLICY');
  }, 60000);
  it.each([401, 200])('does not approve unavailable models (HTTP %s)', async status => {
    const f = await fixture();
    f.server.state.status = status;
    f.server.state.ids = [];
    const result = await f.run(['doctor', '--probe-workers', '--qualify', '--yes', '--json']);
    const report = JSON.parse(result.stdout);
    expect(report.qualification.results[0].models).toEqual([]);
    expect(report.qualification.status).toBe('partial');
    const denied = await f.resolve();
    expect(denied.code).not.toBe(0);
  }, 60000);
  it('requires requalification after the endpoint or checkpoint declaration changes', async () => {
    const f = await fixture();
    const result = await f.run(['doctor', '--probe-workers', '--qualify', '--yes', '--json']);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    f.config.parallelism.clis.codex.localModels.models[0].checkpoint = 'other-revision';
    await writeFile(f.filename, JSON.stringify(f.config));
    expect((await f.resolve()).code).not.toBe(0);
  }, 60000);
});
