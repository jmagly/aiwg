import { mkdtempSync } from 'node:fs';
import { workerSigningFixture } from '../../helpers/worker-qualification-signing.js';
import { qualificationDigest } from '../../../src/models/qualification-digest.mjs';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectRecordedWorkerQualifications, workerNegativeFixtureDigest, loadRecordedWorkerInstallations, prepareWorkerInstallationStore } from '../../../src/models/worker-installation.mjs';
import { DEFAULT_WORKER_SELECTION, WORKER_OPERATOR_APPROVAL, loadProviderModelCapabilities, WorkerRoleEffortError } from '../../../src/models/provider-policy.js';

vi.mock('node:child_process', { spy: true });
vi.mock('node:fs/promises', { spy: true });
// Node's native homedir ignores thread-local env changes in Vitest's pool.
vi.mock('node:os', async importOriginal => {
  const os = await importOriginal<typeof import('node:os')>();
  return { ...os, homedir: () => process.env.HOME || os.homedir() };
});
const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('qualification store permission repair', () => {
  it('projects only bound, unexpired historical approvals without probing, importing drivers, or reading auth', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'aiwg-guided-worker-evidence-')); roots.push(root);
    const cwd = path.join(root, 'project'); const store = path.join(root, 'store');
    await Promise.all([fs.mkdir(cwd), fs.mkdir(store, { mode: 0o700 })]);
    vi.stubEnv('AIWG_CONFIG', store);
    const evidence = { scopeDigest: `sha256:${'a'.repeat(64)}`, fixtureDigest: await workerNegativeFixtureDigest(),
      verifiedAt: new Date().toISOString(), evidenceRef: WORKER_OPERATOR_APPROVAL };
    const adapter = { provider: 'codex', qualification: { status: 'qualified', evidenceRef: WORKER_OPERATOR_APPROVAL },
      invocationProfiles: { default: { installationQualification: evidence } } };
    const record = { cli: 'codex', adapter, binding: { profile: 'default', cliVersion: '1', accountScope: 'test-account' },
      installation: { cwd, profile: 'default', cliVersion: '1', effectiveConfigDigest: qualificationDigest(DEFAULT_WORKER_SELECTION), evidence } };
    const signing = await workerSigningFixture(root, cwd);
    signing.sign(record);
    const input = { cwd, policy: DEFAULT_WORKER_SELECTION,
      parallelism: { clis: { codex: { adapter: 'providers:codex', accountScope: 'test-account', quotaScope: 'test-quota' } } } };
    const file = path.join(store, 'worker-installations.json');
    const write = async () => fs.writeFile(file, JSON.stringify({ version: 1, registrations: [record] }), { mode: 0o600 });
    await write();
    const reads = vi.spyOn(fs, 'open');
    const fileReads = vi.spyOn(fs, 'readFile');
    reads.mockClear(); fileReads.mockClear();
    expect(await inspectRecordedWorkerQualifications(input)).toEqual([{ cli: 'codex', provider: 'codex' }]);
    expect(await inspectRecordedWorkerQualifications({ ...input, includeInputs: true })).toEqual([
      { cli: 'codex', provider: 'codex', binding: record.binding, adapter, observations: undefined },
    ]);
    expect(spawn).not.toHaveBeenCalled();
    expect(reads.mock.calls.map(([name]) => String(name))).toContain(file);
    // Only public trust is needed to project historical qualifications.
    expect([...reads.mock.calls, ...fileReads.mock.calls].map(([name]) => String(name))).not.toContain(signing.keyPath);
    record.installation.evidence.verifiedAt = '2000-01-01T00:00:00.000Z';
    await write();
    expect(await inspectRecordedWorkerQualifications(input)).toEqual([]);
    record.installation.evidence.verifiedAt = new Date().toISOString();
    record.binding.accountScope = 'other-account';
    await write();
    expect(await inspectRecordedWorkerQualifications(input)).toEqual([]);
  });

  it('requires recorded approvals before policy prechecks, then checks policy before record validation', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'aiwg-policy-order-')); roots.push(root);
    const cwd = path.join(root, 'project'); const store = path.join(root, 'store');
    await Promise.all([fs.mkdir(cwd), fs.mkdir(store, { mode: 0o700 })]);
    vi.stubEnv('AIWG_CONFIG', store);
    const policyError = new WorkerRoleEffortError('coding');
    const precheckPolicy = vi.fn(() => { throw policyError; });
    const input = { registry: loadProviderModelCapabilities(), cwd, precheckPolicy };
    await expect(loadRecordedWorkerInstallations(input)).rejects.toMatchObject({ code: 'OG_ADAPTER_UNQUALIFIED',
      details: { rejections: [{ registration: null, reason: 'no-records' }] } });
    expect(precheckPolicy).not.toHaveBeenCalled();
    // Invalid record content must not mask the actionable policy error.
    await fs.writeFile(path.join(store, 'worker-installations.json'), JSON.stringify({ version: 1, registrations: [{}] }), { mode: 0o600 });
    await expect(loadRecordedWorkerInstallations(input)).rejects.toBe(policyError);
    expect(precheckPolicy).toHaveBeenCalledOnce();
  });

  it('selects the exact canonical workspace before validating its approval, without falling back to a peer', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'aiwg-workspace-approvals-')); roots.push(root);
    const first = path.join(root, 'first'); const second = path.join(root, 'second');
    const alias = path.join(root, 'alias'); const store = path.join(root, 'store');
    await Promise.all([fs.mkdir(first), fs.mkdir(second), fs.mkdir(store, { mode: 0o700 })]);
    await fs.symlink(first, alias);
    vi.stubEnv('AIWG_CONFIG', store);
    vi.stubEnv('AIWG_3475_ABSENT', undefined);
    // Deliberately invalid proofs distinguish which workspace's record the
    // owner checked, without importing a driver or running a version probe.
    const registrations = [
      { cli: 'codex', binding: {}, adapter: {}, installation: { cwd: first, environmentNames: ['AIWG_3475_ABSENT'] } },
      { cli: 'codex', binding: { profile: 'changed' }, adapter: {}, installation: { cwd: second, profile: 'original' } },
    ];
    const signing = await workerSigningFixture(root, first);
    for (const record of registrations) signing.sign(record);
    // Both workspaces use the same explicitly configured public ledger.
    await fs.mkdir(path.join(second, '.aiwg'));
    await fs.copyFile(path.join(first, '.aiwg/aiwg.config'), path.join(second, '.aiwg/aiwg.config'));
    await fs.copyFile(path.join(first, '.aiwg-location'), path.join(second, '.aiwg-location'));
    const filename = path.join(store, 'worker-installations.json');
    await fs.writeFile(filename, JSON.stringify({ version: 1, registrations }), { mode: 0o600 });
    for (const cwd of [first, alias]) {
      await expect(loadRecordedWorkerInstallations({ registry: loadProviderModelCapabilities(), cwd }))
        .rejects.toMatchObject({ details: { rejections: [{ registration: 0, reason: 'environment-name' }] } });
    }
    await expect(loadRecordedWorkerInstallations({ registry: loadProviderModelCapabilities(), cwd: second }))
      .rejects.toMatchObject({ details: { rejections: [{ registration: 1, reason: 'binding-mismatch' }] } });
    registrations.push({ ...registrations[0], installation: { ...registrations[0].installation, cwd: alias } });
    await fs.writeFile(filename, JSON.stringify({ version: 1, registrations }));
    await expect(loadRecordedWorkerInstallations({ registry: loadProviderModelCapabilities(), cwd: first }))
      .rejects.toMatchObject({ details: { rejections: [
        { registration: 0, reason: 'record-identity' }, { registration: 2, reason: 'record-identity' },
      ] } });
  });

  it.each([128, 129])('bounds secret-free registration diagnostics for %s records', async count => {
    const root = mkdtempSync(path.join(tmpdir(), 'aiwg-store-diagnostics-'));
    roots.push(root);
    const cwd = path.join(root, 'project');
    const store = path.join(root, 'store');
    await fs.mkdir(cwd); await fs.mkdir(store, { mode: 0o700 });
    vi.stubEnv('AIWG_CONFIG', store);
    const privateText = 'synthetic-private-content!';
    await fs.writeFile(path.join(store, 'worker-installations.json'), JSON.stringify({ version: 1,
      registrations: Array.from({ length: count }, () => ({ cli: privateText })) }), { mode: 0o600 });
    const error = await loadRecordedWorkerInstallations({ registry: loadProviderModelCapabilities(), cwd }).catch(error => error);
    const rejections = count === 128
      ? Array.from({ length: count }, (_, registration) => ({ registration, reason: 'record-identity' }))
      : [{ registration: null, reason: 'store-record' }];
    expect(error).toMatchObject({ code: 'OG_ADAPTER_UNQUALIFIED', details: { rejections } });
    expect(`${error.stack}${JSON.stringify(error)}`).not.toContain(privateText);
  });

  it.each([
    { configured: undefined, cli: undefined, drift: true },
    { configured: ['codex'], cli: undefined, drift: true },
    { configured: ['factory'], cli: undefined, drift: false },
    { configured: [], cli: undefined, drift: false },
    { configured: null, cli: undefined, drift: false },
    { configured: undefined, cli: 'codex', drift: true },
    { configured: undefined, cli: 'factory', drift: false },
    { configured: ['factory'], cli: 'codex', drift: false },
  ])('#4073 scopes shared-store policy checks ($configured, $cli)', async ({ configured, cli, drift }) => {
    const root = mkdtempSync(path.join(tmpdir(), 'aiwg-shared-worker-store-')); roots.push(root);
    const projectA = path.join(root, 'project-a'); const cwd = path.join(root, 'project-b');
    const store = path.join(root, 'store');
    await Promise.all([fs.mkdir(projectA), fs.mkdir(cwd), fs.mkdir(store, { mode: 0o700 })]);
    vi.stubEnv('AIWG_CONFIG', store);
    const policy = structuredClone(DEFAULT_WORKER_SELECTION);
    const oldPolicy = { ...policy, roleGuidance: {} };
    const signing = await workerSigningFixture(root, cwd);
    const record = signing.sign({ cli: 'codex', binding: { boundary: null }, adapter: {}, installation: {
      cwd: projectA, boundary: null, policy: oldPolicy, effectiveConfigDigest: qualificationDigest(oldPolicy),
    } });
    await fs.writeFile(path.join(store, 'worker-installations.json'),
      JSON.stringify({ version: 1, registrations: [record] }), { mode: 0o600 });
    const parallelism = configured === undefined ? undefined : configured === null ? {} : { clis: Object.fromEntries(configured.map(id =>
      [id, { adapter: `providers:${id}`, accountScope: 'fixture', quotaScope: 'fixture' }])) };
    const error = await loadRecordedWorkerInstallations({ registry: loadProviderModelCapabilities(), cwd,
      policy, parallelism, cli }).catch(error => error);
    expect(error).toMatchObject({ code: 'OG_ADAPTER_UNQUALIFIED', details: { rejections: [
      { registration: drift ? 0 : null, reason: drift ? 'effective-config-digest' : 'no-records' },
    ] } });
    if (drift) {
      expect(error.message).toContain('Worker policy changed since qualification');
      expect(error.message).toContain(projectA);
      expect(error.message).toContain('requalify the worker tree');
    } else expect(error.message).not.toContain(projectA);
  });

  it('keeps null registration failures inside the scoped diagnostic boundary', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'aiwg-null-registration-')); roots.push(root);
    const cwd = path.join(root, 'project'); const store = path.join(root, 'store');
    await fs.mkdir(cwd); await fs.mkdir(store, { mode: 0o700 });
    vi.stubEnv('AIWG_CONFIG', store);
    await fs.writeFile(path.join(store, 'worker-installations.json'), JSON.stringify({ version: 1, registrations: [null] }), { mode: 0o600 });
    await expect(loadRecordedWorkerInstallations({ registry: loadProviderModelCapabilities(), cwd }))
      .rejects.toMatchObject({ code: 'OG_ADAPTER_UNQUALIFIED', details: { rejections: [{ registration: 0, reason: 'record-identity' }] } });
  });

  it.each([null, { cli: { toString: {} } }])('#4073 excludes malformed identities outside configured CLIs (%j)', async record => {
    const root = mkdtempSync(path.join(tmpdir(), 'aiwg-unconfigured-worker-')); roots.push(root);
    const cwd = path.join(root, 'project'); const store = path.join(root, 'store');
    await fs.mkdir(cwd); await fs.mkdir(store, { mode: 0o700 });
    vi.stubEnv('AIWG_CONFIG', store);
    await fs.writeFile(path.join(store, 'worker-installations.json'),
      JSON.stringify({ version: 1, registrations: [record] }), { mode: 0o600 });
    await expect(loadRecordedWorkerInstallations({ registry: loadProviderModelCapabilities(), cwd, parallelism: { clis: {} } }))
      .rejects.toMatchObject({ code: 'OG_ADAPTER_UNQUALIFIED', details: { rejections: [{ registration: null, reason: 'no-records' }] } });
  });

  it.each([0o775, 0o777])('refuses repair beneath a writable ancestor (%s)', async mode => {
    const home = mkdtempSync(path.join(tmpdir(), 'aiwg-store-ancestor-'));
    roots.push(home);
    vi.stubEnv('HOME', home);
    const ancestor = path.join(home, 'config');
    const store = path.join(ancestor, 'aiwg');
    await fs.mkdir(store, { recursive: true });
    await fs.chmod(ancestor, mode);
    await fs.chmod(store, 0o775);
    vi.stubEnv('AIWG_CONFIG', store);
    const open = vi.spyOn(fs, 'open');
    for (const apply of [false, true]) {
      await expect(prepareWorkerInstallationStore({ workerWritableRoots: [], apply }))
        .rejects.toThrow(`Untrusted installation store ancestor: ${ancestor}`);
    }
    expect(open).not.toHaveBeenCalled();
    expect((await fs.stat(store)).mode & 0o777).toBe(0o775);
  });

  it.each([0o755, 0o700])('repairs beneath trusted ancestors (%s)', async mode => {
    const home = mkdtempSync(path.join(tmpdir(), 'aiwg-store-trusted-'));
    roots.push(home);
    vi.stubEnv('HOME', home);
    const ancestor = path.join(home, 'config');
    const store = path.join(ancestor, 'aiwg');
    await fs.mkdir(store, { recursive: true });
    await fs.chmod(ancestor, mode);
    await fs.chmod(store, 0o775);
    vi.stubEnv('AIWG_CONFIG', store);
    const options = { workerWritableRoots: [] };
    await expect(prepareWorkerInstallationStore(options)).resolves.toEqual([{ path: store, action: 'chmod go-w' }]);
    expect((await fs.stat(store)).mode & 0o777).toBe(0o775);
    await prepareWorkerInstallationStore({ ...options, apply: true });
    expect((await fs.stat(store)).mode & 0o777).toBe(0o755);
  });

  it('refuses another owner with the path and never chmods it', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'aiwg-store-owner-'));
    roots.push(root);
    vi.stubEnv('AIWG_CONFIG', root);
    const { lstat: original } = await vi.importActual<typeof fs>('node:fs/promises');
    vi.spyOn(fs, 'lstat').mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
      const stat = await original(...args);
      return args[0] === root ? Object.assign(Object.create(stat), { uid: process.getuid!() + 1 }) : stat;
    });
    const open = vi.spyOn(fs, 'open');
    await expect(prepareWorkerInstallationStore({ workerWritableRoots: [], apply: true }))
      .rejects.toThrow(`Installation store path is owned by another user: ${root}`);
    expect(open).not.toHaveBeenCalled();
  });

  it('never repairs a writable store file or a symlinked directory', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'aiwg-store-path-'));
    roots.push(root);
    vi.stubEnv('AIWG_CONFIG', root);
    const filename = path.join(root, 'worker-installations.json');
    await fs.writeFile(filename, '{}');
    await fs.chmod(filename, 0o666);
    await expect(prepareWorkerInstallationStore({ workerWritableRoots: [], apply: true }))
      .rejects.toThrow(`Untrusted installation store permissions: ${filename}`);
    expect((await fs.stat(filename)).mode & 0o777).toBe(0o666);
    const link = `${root}-link`;
    roots.push(link);
    await fs.symlink(root, link);
    vi.stubEnv('AIWG_CONFIG', link);
    await expect(prepareWorkerInstallationStore({ workerWritableRoots: [], apply: true }))
      .rejects.toThrow('Symlinked installation store');
  });
});

describe('approval store maintenance', () => {
  async function fixture() {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'aiwg-approval-store-')); roots.push(root);
    const cwd = path.join(root, 'workspace');
    const config = path.join(root, 'config');
    await fs.mkdir(cwd); await fs.mkdir(config, { mode: 0o700 });
    vi.stubEnv('AIWG_CONFIG', config);
    const filename = path.join(config, 'worker-installations.json');
    const records = [
      { cli: 'codex', installation: { cwd } },
      { cli: 'muse', installation: { cwd } },
      { cli: 'codex', installation: { cwd: path.join(root, 'deleted') } },
    ];
    await fs.writeFile(filename, JSON.stringify({ version: 1, registrations: records }), { mode: 0o600 });
    const owner = await import('../../../src/models/worker-installation-store.mjs');
    return { root, cwd, filename, records, ...owner };
  }

  it.each(['list', 'remove'])('takes the qualification lock before %s', async operation => {
    const f = await fixture();
    const lock = await fs.open(`${f.filename}.lock`, 'wx', 0o600);
    let settled = false;
    const request = operation === 'list'
      ? f.listWorkerApprovals({ cwd: f.cwd, cli: 'codex' })
      : f.forgetWorkerApproval({ cwd: f.cwd, workspace: f.cwd, cli: 'codex', yes: true });
    const result = request.finally(() => { settled = true; });
    try {
      await new Promise(resolve => setTimeout(resolve, 80));
      expect(settled).toBe(false);
      expect(JSON.parse(await fs.readFile(f.filename, 'utf8')).registrations).toEqual(f.records);
    } finally { await lock.close(); await fs.unlink(`${f.filename}.lock`); }
    expect(await result).toHaveLength(operation === 'list' ? 2 : 1);
    await expect(fs.access(`${f.filename}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.stat(f.filename)).mode & 0o777).toBe(0o600);
  });

  it('lists stale workspaces and removes exact CLI/workspace keys, including deleted paths', async () => {
    const f = await fixture();
    expect(await f.listWorkerApprovals({ cwd: f.cwd })).toEqual([
      { cli: 'codex', workspace: f.cwd, workspaceExists: true },
      { cli: 'muse', workspace: f.cwd, workspaceExists: true },
      { cli: 'codex', workspace: path.join(f.root, 'deleted'), workspaceExists: false },
    ]);
    await f.forgetWorkerApproval({ cwd: f.cwd, workspace: f.cwd, cli: 'codex', yes: true });
    expect(JSON.parse(await fs.readFile(f.filename, 'utf8')).registrations).toEqual(f.records.slice(1));
    await f.forgetWorkerApproval({ cwd: f.cwd, workspace: '../deleted', yes: true });
    expect(JSON.parse(await fs.readFile(f.filename, 'utf8')).registrations).toEqual([f.records[1]]);
    const bytes = await fs.readFile(f.filename, 'utf8');
    await expect(f.forgetWorkerApproval({ cwd: f.cwd, workspace: f.cwd, cli: 'codex', yes: true })).rejects.toThrow('No worker approval found');
    await expect(f.forgetWorkerApproval({ cwd: f.cwd, workspace: f.cwd, yes: false })).rejects.toThrow('requires --yes');
    expect(await fs.readFile(f.filename, 'utf8')).toBe(bytes);
  });

  it('retains authority when a workspace cannot be inspected due to permissions', async () => {
    const f = await fixture();
    vi.spyOn(fs, 'stat').mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
    const record = { cli: 'new', installation: { cwd: f.cwd } };
    expect(await f.retainWorkerApprovals(f.records, record)).toEqual([...f.records, record]);
  });

  it('fails closed when a held lock exhausts retries without stealing it', async () => {
    const f = await fixture();
    await fs.writeFile(`${f.filename}.lock`, 'held', { mode: 0o600 });
    const bytes = await fs.readFile(f.filename, 'utf8');
    // Keep real I/O and advance only the retry delay.
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => {
      queueMicrotask(callback); return 0;
    }) as any);
    await expect(f.listWorkerApprovals({ cwd: f.cwd })).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await fs.readFile(`${f.filename}.lock`, 'utf8')).toBe('held');
    expect(await fs.readFile(f.filename, 'utf8')).toBe(bytes);
  });

  it('propagates lock I/O failures without modifying approvals', async () => {
    const f = await fixture();
    const bytes = await fs.readFile(f.filename, 'utf8');
    const { open } = await vi.importActual<typeof fs>('node:fs/promises');
    const error = Object.assign(new Error('synthetic I/O failure'), { code: 'EIO' });
    vi.spyOn(fs, 'open').mockImplementation(((name: any, ...args: any[]) =>
      name === `${f.filename}.lock` ? Promise.reject(error) : (open as any)(name, ...args)) as any);
    await expect(f.listWorkerApprovals({ cwd: f.cwd })).rejects.toBe(error);
    expect(await fs.readFile(f.filename, 'utf8')).toBe(bytes);
  });

  it.each(['{', '{"version":2,"registrations":[]}', '{"version":1,"registrations":{}}'])
    ('rejects malformed stores and releases the lock (%s)', async bytes => {
      const f = await fixture();
      await fs.writeFile(f.filename, bytes);
      await expect(f.listWorkerApprovals({ cwd: f.cwd })).rejects.toThrow();
      expect(await fs.readFile(f.filename, 'utf8')).toBe(bytes);
      await expect(fs.access(`${f.filename}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
    });

  it('refuses an untrusted store without repairing permissions or taking a lock', async () => {
    const f = await fixture();
    await fs.chmod(f.filename, 0o666);
    await expect(f.listWorkerApprovals({ cwd: f.cwd })).rejects.toThrow('Untrusted installation store permissions');
    expect((await fs.stat(f.filename)).mode & 0o777).toBe(0o666);
    await expect(fs.access(`${f.filename}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(f.listWorkerApprovals({ cwd: path.dirname(f.filename) })).rejects.toThrow('Worker-writable installation store');
  });

  it('filters CLI inventory and revokes every CLI only for the canonical target', async () => {
    const f = await fixture();
    const alias = path.join(f.root, 'alias');
    await fs.symlink(f.cwd, alias);
    expect(await f.listWorkerApprovals({ cwd: f.cwd, cli: 'muse' })).toEqual([
      { cli: 'muse', workspace: f.cwd, workspaceExists: true },
    ]);
    expect(await f.listWorkerApprovals({ cwd: f.cwd, cli: 'absent' })).toEqual([]);
    expect(await f.forgetWorkerApproval({ cwd: f.cwd, workspace: alias, yes: true })).toEqual([
      { cli: 'codex', workspace: f.cwd }, { cli: 'muse', workspace: f.cwd },
    ]);
    expect(JSON.parse(await fs.readFile(f.filename, 'utf8')).registrations).toEqual([f.records[2]]);
    expect((await fs.stat(f.filename)).mode & 0o777).toBe(0o600);
  });

  it('treats a missing store as empty and missing revocation as a non-mutating error', async () => {
    const f = await fixture();
    await fs.unlink(f.filename);
    expect(await f.listWorkerApprovals({ cwd: f.cwd })).toEqual([]);
    await expect(f.forgetWorkerApproval({ cwd: f.cwd, workspace: f.cwd, yes: true }))
      .rejects.toThrow(`No worker approval found for ${f.cwd}`);
    await expect(fs.access(f.filename)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(`${f.filename}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains entries on non-ENOENT identity failures and preserves unknown workspace metadata', async () => {
    const f = await fixture();
    const { realpath } = await vi.importActual<typeof fs>('node:fs/promises');
    const error = Object.assign(new Error('synthetic denied'), { code: 'EACCES' });
    vi.spyOn(fs, 'realpath').mockImplementation(((name: any, ...args: any[]) =>
      name === f.cwd ? Promise.reject(error) : (realpath as any)(name, ...args)) as any);
    const record = { cli: 'new', installation: { cwd: f.cwd } };
    expect(await f.retainWorkerApprovals([f.records[0], { cli: 'unknown' }], record))
      .toEqual([f.records[0], { cli: 'unknown' }, record]);
    await expect(f.forgetWorkerApproval({ cwd: f.cwd, workspace: f.cwd, yes: true })).rejects.toBe(error);
    expect(JSON.parse(await fs.readFile(f.filename, 'utf8')).registrations).toEqual(f.records);
    vi.mocked(fs.realpath).mockRestore();
    await fs.writeFile(f.filename, JSON.stringify({ version: 1, registrations: [{ cli: 'unknown' }] }));
    expect(await f.listWorkerApprovals({ cwd: f.cwd })).toEqual([
      { cli: 'unknown', workspace: null, workspaceExists: true },
    ]);
  });

  it('prunes deleted and non-directory workspaces, replaces exact keys, and enforces the retained cap', async () => {
    const f = await fixture();
    const file = path.join(f.root, 'ordinary-file');
    await fs.writeFile(file, 'fixture');
    const record = { cli: 'codex', installation: { cwd: f.cwd } };
    expect(await f.retainWorkerApprovals([...f.records, { cli: 'old', installation: { cwd: file } },
      { cli: 'nested', installation: { cwd: path.join(file, 'child') } }], record)).toEqual([f.records[1], record]);
    const full = Array.from({ length: 128 }, (_, i) => ({ cli: `live-${i}`, installation: { cwd: f.cwd } }));
    await expect(f.retainWorkerApprovals(full, record)).rejects.toThrow('store is full (128 workspace approvals)');
    expect(full).toHaveLength(128);
    expect(await f.retainWorkerApprovals(full, { ...record, cli: 'live-0' })).toHaveLength(128);
  });

});
