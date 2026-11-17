// T-OG-12: doctor reports worker policy wiring without model calls.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorkerProbe } from '../../../tools/cli/doctor-worker-probe.mjs';
import { checkWorkerHealthReadiness } from '../../../tools/cli/doctor-worker-health.mjs';
import { collectWorkerPolicyDiagnostics } from '../../../tools/cli/doctor-worker-policy.mjs';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';
import { workerSigningFixture } from '../../helpers/worker-qualification-signing.js';
import { qualificationDigest } from '../../../src/models/qualification-digest.mjs';
import { workerNegativeFixtureDigest } from '../../../src/models/worker-installation.mjs';
import { ConfigLoader } from '../../../src/models/config-loader.js';
import { WORKER_OPERATOR_APPROVAL } from '../../../src/models/provider-policy.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'aiwg-worker-policy-')); roots.push(root);
  const project = join(root, 'project');
  const store = join(root, 'store');
  await mkdir(project); await mkdir(store, { mode: 0o700 });
  vi.stubEnv('AIWG_CONFIG', store); vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
  const { snapshot } = workerResolutionFixture();
  const config = snapshot.config;
  config.parallelism!.clis = { codex: { adapter: 'providers:codex', accountScope: 'synthetic', quotaScope: 'synthetic' } };
  const models = { defaults: { workerSelection: { roleGuidance: { coding: {
    groups: ['workers'], tier: 'standard', initialEffort: 'medium', effortLadder: ['medium', 'high'],
  } } } } };
  await writeFile(join(project, 'models.json'), JSON.stringify(models));
  return { root, project, store, config, models };
}

describe('doctor policy checks (#4261, #4262)', () => {
  it.each([true, false])('includes policy findings in probe output (JSON: %s)', async json => {
    const f = await fixture();
    const executable = join(f.root, 'fake-codex');
    await writeFile(executable, `#!${process.execPath}\nconsole.log('codex-cli 0.161.0');\n`, { mode: 0o755 });
    f.config.parallelism!.clis!.codex.executable = executable;
    f.config.parallelism!.groups!.workers.requiredRoles = ['coding'];
    f.config.parallelism!.groups!.workers.execution = { sandbox: 'external', approval: 'never', transport: 'shell' };
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await runWorkerProbe(f.project, { json }, f.config)).toBe(1);
    if (json) expect(JSON.parse(String(output.mock.calls[0][0])).workerPolicyDiagnostics).toEqual([
      expect.objectContaining({ message: expect.stringContaining('No qualified route covers coding') }),
    ]);
    else expect(log.mock.calls.flat().join('\n')).toContain('Worker Policy: OG_ADAPTER_UNQUALIFIED');
  });

  it('keeps an unused declaration advisory in probe and ordinary offline doctor', async () => {
    const f = await fixture();
    f.config.parallelism = { clis: { unused: { adapter: 'providers:codex', executable: '/not-installed', accountScope: 'local', quotaScope: 'local' } } };
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await runWorkerProbe(f.project, { json: true }, f.config)).toBe(0);
    const check = vi.fn();
    await checkWorkerHealthReadiness({ config: f.config, configFailed: false, cwd: f.project, AIWG_ROOT: process.cwd(), check });
    expect(check).toHaveBeenCalledWith('Worker Policy', 'warn', expect.stringContaining('no group'));
  });

  it('reports a model policy load error with the configuration repair locations', async () => {
    const f = await fixture();
    await writeFile(join(f.project, 'models.json'), '{');
    expect(await collectWorkerPolicyDiagnostics(f.project, f.config)).toEqual([
      expect.objectContaining({ code: 'OG_CONFIG_REFERENCE', message: expect.stringContaining('Review models.json and parallelism') }),
    ]);
  });

  it('names the exact models.json fix and unused CLI repair independently of probes', async () => {
    const f = await fixture();
    f.config.parallelism!.groups!.cursor = structuredClone(f.config.parallelism!.groups!.workers);
    f.config.parallelism!.groups!.cursor.requiredRoles = ['coding'];
    f.config.parallelism!.clis!.unused = { adapter: 'providers:cursor', accountScope: 'local', quotaScope: 'local' };
    const diagnostics = await collectWorkerPolicyDiagnostics(f.project, f.config);
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ pointer: '/defaults/workerSelection/roleGuidance/coding/groups',
        message: expect.stringContaining('add "cursor" to defaults.workerSelection.roleGuidance.coding.groups') }),
      expect.objectContaining({ pointer: '/parallelism/clis/unused', message: expect.stringContaining('no group') }),
    ]));
    expect(diagnostics.some(row => row.pointer === '/parallelism/groups/cursor/requiredRoles')).toBe(false);
  });

  it('reports signed stale policy evidence before dispatch, including hand-edited role guidance', async () => {
    const f = await fixture();
    f.config.parallelism!.groups!.workers.requiredRoles = ['coding'];
    const signing = await workerSigningFixture(f.root, f.project);
    const policy = (await new ConfigLoader(f.project).load(f.config.parallelism)).defaults.workerSelection;
    const evidence = { scopeDigest: `sha256:${'a'.repeat(64)}`, fixtureDigest: await workerNegativeFixtureDigest(),
      verifiedAt: new Date().toISOString(), evidenceRef: WORKER_OPERATOR_APPROVAL };
    const record = { cli: 'codex', modelObservations: workerResolutionFixture().snapshot.catalog.discovery!.instances!.codex,
      adapter: { provider: 'codex', qualification: { status: 'qualified', evidenceRef: WORKER_OPERATOR_APPROVAL }, invocationProfiles: { default: { installationQualification: evidence } } },
      binding: { profile: 'default', cliVersion: '1', accountScope: 'synthetic' }, installation: {
        cwd: f.project, profile: 'default', cliVersion: '1', policy, effectiveConfigDigest: qualificationDigest(policy), evidence,
      } };
    signing.sign(record);
    await writeFile(join(f.store, 'worker-installations.json'), JSON.stringify({ version: 1, registrations: [record] }), { mode: 0o600 });
    expect(await collectWorkerPolicyDiagnostics(f.project, f.config)).toEqual([]);
    f.models.defaults.workerSelection.roleGuidance.coding.initialEffort = 'high';
    await writeFile(join(f.project, 'models.json'), JSON.stringify(f.models));
    expect(await collectWorkerPolicyDiagnostics(f.project, f.config)).toEqual(expect.arrayContaining([
      expect.objectContaining({ pointer: '/defaults/workerSelection/roleGuidance',
        message: expect.stringContaining('Worker policy changed since qualification') }),
    ]));
  });

  it('reports a required role with no qualified member', async () => {
    const f = await fixture(); f.config.parallelism!.groups!.workers.requiredRoles = ['coding'];
    expect(await collectWorkerPolicyDiagnostics(f.project, f.config, { requiredRoles: false })).toEqual([]);
    expect(await collectWorkerPolicyDiagnostics(f.project, f.config)).toEqual(expect.arrayContaining([
      expect.objectContaining({ pointer: '/parallelism/groups/workers/requiredRoles',
        message: expect.stringContaining('No qualified route covers coding') }),
    ]));
  });
});
