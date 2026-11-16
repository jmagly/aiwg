// Exercise zero-worker publication, placement and signed receipt failures offline.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, linkSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { harness } from '../effects/helpers.js';
import { lookupWorkerDelivery, prepareWorkerDelivery } from '../../../src/effects/worker-delivery.js';
import { sha256Digest } from '../../../src/effects/identity.js';
import { verifyWorkerRun } from '../../../tools/ralph-external/lib/worker-verification-cli.mjs';

const inputs = vi.hoisted(() => ({ roots: [] as string[] }));
vi.mock('../../../tools/_resolve-impl.mjs', async original => {
  const actual = await original<any>();
  return { ...actual, importImpl: async (url: string, name: string) => {
    if (name === 'cli/handlers/models.js') return { loadWorkerInputs: async () => ({ drivers: {
      fixture: { qualification: { installation: { workerWritableRoots: inputs.roots } } },
    } }) };
    if (name === 'mcp/tools/worker-verify-deliver-schema.mjs') return import('../../../src/mcp/tools/worker-verify-deliver-schema.mjs');
    return actual.importImpl(url, name);
  } };
});

let h: ReturnType<typeof harness>, destination: string, worker: string;
beforeEach(() => {
  h = harness(); destination = join(h.dir, 'answer.json'); worker = join(h.dir, 'worker');
  mkdirSync(worker); inputs.roots = [worker];
});
afterEach(() => h.cleanup());
const stop = { reason: 'No qualified local transport.', status: 'blocked', launch_count: 0,
  uncertainty_statement: 'Selection is blocked.', code: 'LOCAL_TRANSPORT_UNAVAILABLE', blocking_rule: 'Local-only data must stay local.' };
const request = () => ({ projectDir: h.dir, deliverablePath: destination, typedStop: stop });
const publish = (input = request()) => verifyWorkerRun(input, { prepareRecord: async (_project: string, metadata: any) => prepareWorkerDelivery(h.ledger(), metadata) });

describe('T-OG-04 zero-worker typed-stop publication', () => {
  it.each([false, true])('atomically publishes canonical JSON and a signed typed-stop receipt (existing=%s)', async existing => {
    if (existing) writeFileSync(destination, 'previous');
    const result = await publish();
    const bytes = readFileSync(destination, 'utf8');
    expect(bytes).toBe('{"blocking_rule":"Local-only data must stay local.","code":"LOCAL_TRANSPORT_UNAVAILABLE","launch_count":0,"reason":"No qualified local transport.","status":"blocked","uncertainty_statement":"Selection is blocked."}\n');
    expect(result).toMatchObject({ status: 'accepted', kind: 'typed-stop', artifactDigest: sha256Digest(bytes), deliveryRecord: { phase: 'completed' } });
    expect(await lookupWorkerDelivery(h.ledger(), destination)).toMatchObject({ verified: true, kind: 'typed-stop', verifierId: 'typed-stop@1', artifactDigest: sha256Digest(bytes) });
  });
  it('allows a stop when no worker installation is qualified', async () => {
    inputs.roots = [];
    expect((await publish()).status).toBe('accepted');
  });
  it('refuses an undercount after one recorded launch before signing (#4205)', async () => {
    writeFileSync(destination, 'previous');
    const prepareRecord = vi.fn();
    await expect(verifyWorkerRun(request(), { prepareRecord, recordedLaunches: () => 1 }))
      .rejects.toMatchObject({ code: 'TYPED_STOP_LAUNCH_MISMATCH', message: expect.stringContaining(
        'A typed stop can only be published before any worker launch in this session; after a launch, the conductor must retry the worker or publish a verified worker artifact.') });
    expect(prepareRecord).not.toHaveBeenCalled();
    expect(readFileSync(destination, 'utf8')).toBe('previous');
  });
  it('accepts an explicitly empty recorded launch ledger', async () => {
    expect((await verifyWorkerRun(request(), { recordedLaunches: () => 0,
      prepareRecord: async (_project: string, metadata: any) => prepareWorkerDelivery(h.ledger(), metadata) })).status).toBe('accepted');
  });
  it('rechecks launches recorded while the signed intent was pending', async () => {
    let launches = 0;
    const complete = vi.fn();
    await expect(verifyWorkerRun(request(), { recordedLaunches: () => launches,
      prepareRecord: async () => { launches++; return complete; } })).rejects.toMatchObject({ code: 'TYPED_STOP_LAUNCH_MISMATCH' });
    expect(complete).not.toHaveBeenCalled();
    expect(existsSync(destination)).toBe(false);
  });
  it.each(['symlink', 'hardlink', 'directory', 'writable', 'parent-alias'])('refuses unsafe destination %s before a signed intent', async kind => {
    const source = join(worker, 'source'); writeFileSync(source, 'worker');
    if (kind === 'symlink') symlinkSync(source, destination);
    if (kind === 'hardlink') linkSync(source, destination);
    if (kind === 'directory') mkdirSync(destination);
    if (kind === 'writable') destination = join(worker, 'answer');
    if (kind === 'parent-alias') { const alias = join(h.dir, 'alias'); symlinkSync(worker, alias); destination = join(alias, 'answer'); }
    const prepareRecord = vi.fn();
    await expect(verifyWorkerRun(request(), { prepareRecord })).rejects.toThrow(/non-linked|outside worker-writable/);
    expect(prepareRecord).not.toHaveBeenCalled();
    expect(readFileSync(source, 'utf8')).toBe('worker');
  });
  it('refuses signing failure without changing a prior destination', async () => {
    writeFileSync(destination, 'previous');
    await expect(verifyWorkerRun(request(), { prepareRecord: async () => { throw Error('signing unavailable'); } })).rejects.toThrow('signing unavailable');
    expect(readFileSync(destination, 'utf8')).toBe('previous');
  });
  it('preserves published bytes when a second stop or a prior worker record conflicts', async () => {
    await publish();
    const bytes = readFileSync(destination);
    await expect(publish()).rejects.toThrow('TYPED_STOP_CONFLICT');
    expect(readFileSync(destination)).toEqual(bytes);
    destination = join(h.dir, 'worker-answer'); writeFileSync(destination, 'worker');
    const complete = await prepareWorkerDelivery(h.ledger(), { deliverablePath: destination, artifactDigest: sha256Digest('worker'),
      runDir: join(h.dir, 'run'), invocationId: 'worker-1', verifierId: 'trusted-verification@1' });
    await complete();
    await expect(publish()).rejects.toThrow('TYPED_STOP_CONFLICT');
    expect(readFileSync(destination, 'utf8')).toBe('worker');
  });
  it.each([{ runDir: '/run' }, { artifactPath: '/artifact' }, { checks: [] }, { typedStop: { ...stop, launch_count: 1 } }])('rejects invalid internal dispatch %#', async extra => {
    await expect(publish({ ...request(), ...extra } as any)).rejects.toThrow('TYPED_STOP_INVALID');
    expect(existsSync(destination)).toBe(false);
  });
  it('publishes through MCP and reports typed-stop via the installed delivery-status CLI', () => {
    const fixture = fileURLToPath(new URL('../../fixtures/ralph-external/mcp-typed-stop-deliver.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [fixture, h.dir], { cwd: h.dir, encoding: 'utf8', timeout: 15000,
      env: { NODE_ENV: 'test', HOME: h.dir, PATH: process.env.PATH, AIWG_RESOLVE_IMPL_FROM: 'dist', AIWG_EFFECT_LEDGER_TEST_KEY: '42'.repeat(32) } });
    expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.published).toMatchObject({ status: 'accepted', kind: 'typed-stop', deliveryRecord: { phase: 'completed' } });
    expect(output.lookup).toMatchObject({ verified: true, kind: 'typed-stop', verifierId: 'typed-stop@1' });
    expect(output.lookup).not.toHaveProperty('invocationId');
    expect(output.invalid).toMatchObject({ isError: true });
    expect(output.conflict).toMatchObject({ isError: true });
    expect(output.bytes).toBe('{"blocking_rule":"Policy denies this launch.","code":"POLICY_DENIED","launch_count":0,"status":"denied"}\n');
  });
});
