// Verify worker qualification process status through the shipped CLI, without provider access.
import { access, chmod, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { doctorWorkerCliFixture } from '../../helpers/doctor-worker-cli.js';
import { installedHostResourceReaders } from '../../helpers/host-resource-handler.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const f = await doctorWorkerCliFixture();
  roots.push(f.root);
  return f;
}

describe('explicit doctor qualification exit status (#3690)', () => {
  async function qualifiedFixture() {
    const f = await fixture();
    const roles = ['efficiency', 'coding', 'reasoning'];
    const doctorHealthFile = path.join(f.installed, 'tools/cli/doctor-worker-health.mjs');
    const doctorHealth = await readFile(doctorHealthFile, 'utf8');
    expect(doctorHealth).toContain('hostResources: readLiveHostResources({ paths: [cwd]');
    await writeFile(doctorHealthFile, doctorHealth.replace('hostResources: readLiveHostResources({ paths: [cwd]',
      `hostResources: readLiveHostResources({ ...${installedHostResourceReaders()}, paths: [cwd]`));
    const configFile = path.join(f.project, '.aiwg/aiwg.config');
    const config = JSON.parse(await readFile(configFile, 'utf8'));
    config.parallelism.groups.workers.requiredRoles = roles;
    config.parallelism.groups.workers.members[0].roles = roles;
    await writeFile(configFile, JSON.stringify(config));
    const modelsFile = path.join(f.project, 'models.json');
    const models = JSON.parse(await readFile(modelsFile, 'utf8'));
    for (const role of roles) models.defaults.workerSelection.roleGuidance[role] = {
      ...models.defaults.workerSelection.roleGuidance.coding, tier: role === 'reasoning' ? 'premium' : 'standard' };
    await writeFile(modelsFile, JSON.stringify(models));
    const qualified = await f.run(['doctor', '--probe-workers', '--qualify', '--yes', '--json']);
    expect(qualified.code, qualified.stdout + qualified.stderr).toBe(0);
    expect(JSON.parse(qualified.stdout).qualification.status).toBe('recorded');
    expect((await f.resolve()).code).toBe(0);
    return { f, config, configFile };
  }

  it('#3906 plain doctor recognizes qualified roles and reports premium authorization', async () => {
    const { f } = await qualifiedFixture();
    // Plain doctor must use offline evidence: a subsequent CLI probe would fail.
    await writeFile(path.join(f.root, 'fake-bin/codex'), `#!${process.execPath}\nprocess.exit(91);\n`);
    const result = await f.run(['doctor']);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).not.toContain('WORKER_ROLE_NOT_READY');
    expect(result.stdout).toContain('WORKER_ROLE_PENDING_AUTHORIZATION');
    expect(result.stdout).toContain('--authorize-premium requires explicit operator confirmation');
    expect(result.stdout).toContain('⚠ Worker Health (reasoning): WORKER_ROLE_PENDING_AUTHORIZATION');
  });

  it('#3906 a changed configured model cannot borrow the previous model approval', async () => {
    const { f, config, configFile } = await qualifiedFixture();
    await writeFile(path.join(f.root, 'fake-bin/codex'), `#!${process.execPath}\nprocess.exit(91);\n`);
    config.parallelism.groups.workers.members[0].model = 'unqualified-model';
    await writeFile(configFile, JSON.stringify(config));
    const unqualified = await f.run(['doctor']);
    expect(unqualified.stdout).toContain('✗ Worker Health (coding): WORKER_ROLE_NOT_READY');
  });

  it.each([true, false])('fails for writable installed code (JSON: %s)', async json => {
    const f = await fixture();
    const manifest = path.join(f.installed, 'package.json');
    await chmod(manifest, 0o664);
    const result = await f.run(['doctor', '--probe-workers', '--qualify', '--yes', ...(json ? ['--json'] : [])]);
    expect(result.stdout).toContain('Installed module path is group/other-writable');
    const report = json ? JSON.parse(result.stdout) : JSON.parse(result.stdout.split('Worker qualification: ')[1].split('\n')[0]);
    const qualification = json ? report.qualification : report;
    expect(qualification).toMatchObject({ status: 'failed', results: [{ cli: 'codex', status: 'failed',
      message: expect.stringContaining(manifest) }] });
    if (json) expect(report.workers[0]).toMatchObject({ ready: true, inRange: true, reason: 'WORKER_DIRECT_READY' });
    else expect(result.stdout).toContain('Direct Worker codex: WORKER_DIRECT_READY');
    expect(result.code, result.stdout + result.stderr).toBe(1);
    expect((await stat(manifest)).mode & 0o777).toBe(0o664);
    await expect(access(path.join(f.config, 'worker-installations.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    const resolved = await f.resolve();
    expect(resolved.code).not.toBe(0);
    expect(resolved.stdout).toContain('OG_ADAPTER_UNQUALIFIED');
  }, 120_000);

  it.each([true, false])('returns zero for successful qualification (JSON: %s)', async json => {
    const f = await fixture();
    const result = await f.run(['doctor', '--probe-workers', '--qualify', '--yes', ...(json ? ['--json'] : [])]);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const report = json ? JSON.parse(result.stdout).qualification
      : JSON.parse(result.stdout.split('Worker qualification: ')[1].split('\n')[0]);
    expect(report.status).toBe('recorded');
    expect((await f.resolve()).code).toBe(0);
  }, 120_000);

  it('fails partial qualification when configured model observations are missing', async () => {
    const f = await fixture();
    const configFile = path.join(f.project, '.aiwg/aiwg.config');
    const config = JSON.parse(await readFile(configFile, 'utf8'));
    config.parallelism.groups.workers.members[0].model = 'missing-synthetic-model';
    await writeFile(configFile, JSON.stringify(config));
    const result = await f.run(['doctor', '--probe-workers', '--qualify', '--yes', '--json']);
    expect(result.code, result.stdout + result.stderr).toBe(1);
    expect(JSON.parse(result.stdout).qualification.status).toBe('partial');
    expect(JSON.parse(result.stdout).workers[0].ready).toBe(true);
  }, 120_000);

  it('keeps installation probes advisory without qualification', async () => {
    const f = await fixture();
    await chmod(path.join(f.installed, 'package.json'), 0o664);
    const result = await f.run(['doctor', '--probe-workers', '--json']);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ workers: [{ ready: true }] });
    expect(JSON.parse(result.stdout).qualification).toBeUndefined();
  }, 120_000);
  it('keeps plain doctor warnings advisory without qualification', async () => {
    const f = await fixture();
    await chmod(path.join(f.installed, 'package.json'), 0o664);
    const result = await f.run(['doctor']);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('WARN');
    expect(result.stdout).not.toContain('Worker qualification:');
    await expect(access(path.join(f.config, 'worker-installations.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 120_000);

  it('documents explicit qualification status in public help', async () => {
    const f = await fixture();
    const result = await f.run(['doctor', '--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('failed or partial explicit worker qualification');
    expect(result.stdout).toContain('ordinary doctor warnings are advisory');
    expect(result.stdout).toContain('same exit status in text and JSON');
  }, 120_000);

});
