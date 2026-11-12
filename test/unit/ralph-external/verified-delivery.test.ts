// In-process fakes exercise the publication boundary independently of subprocess fixtures.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const fake = vi.hoisted(() => ({ status: 'accepted', workerRoot: '', degraded: false, record: {}, complete: vi.fn(), prepare: vi.fn(), lookup: vi.fn() }));
vi.mock('../../../tools/_resolve-impl.mjs', () => ({ importImpl: async (_url: string, name: string) => {
  if (name === 'serve/worker-invocation-paths.js') return { inspectWorkerPath: vi.fn() };
  if (name === 'cli/handlers/models.js') return { loadWorkerInputs: async () => ({ drivers: { fake: { qualification: { installation: { workerWritableRoots: [fake.workerRoot] } } } } }) };
  if (name === 'effects/host.js') return { effectSession: async (projectDir: string, subsystem: string) => ({ projectDir, subsystem }), openLedger: (session: any) => session };
  if (name === 'effects/worker-delivery.js') return { prepareWorkerDelivery: fake.prepare, lookupWorkerDelivery: fake.lookup };
  throw Error('unexpected implementation: ' + name);
} }));
vi.mock('../../../tools/ralph-external/session-launcher.mjs', () => ({ verifyRetryPredecessor: vi.fn() }));
vi.mock('../../../tools/ralph-external/lib/worker-inputs.mjs', () => ({ boundedPrivateRead: async () => Buffer.from(JSON.stringify(fake.record)) }));
vi.mock('../../../tools/ralph-external/lib/verification-isolation.mjs', () => ({
  probeVerificationIsolationCapabilities: () => ({ mode: fake.degraded ? 'degraded' : 'systemd-unit', degraded: [] }),
  missingRequiredCapabilities: () => fake.degraded ? ['homeReadIsolation'] : [],
}));
vi.mock('../../../tools/ralph-external/lib/worker-delivery-record.mjs', () => ({ prepareDeliveryRecord: (...args: any[]) => fake.prepare(...args), lookupDeliveryRecord: (...args: any[]) => fake.lookup(...args) }));
vi.mock('../../../tools/ralph-external/lib/trusted-verification.mjs', async original => ({
  ...await original<any>(), verifyWorkerArtifact: ({ artifactPath }: any) => ({ status: fake.status, verifierId: 'trusted-verification@1', artifactDigest: `sha256:${createHash('sha256').update(readFileSync(artifactPath)).digest('hex')}`, findings: [] }),
}));
import { verifyWorkerRun, runWorkerVerificationCli } from '../../../tools/ralph-external/lib/worker-verification-cli.mjs';
let root: string, worker: string, artifact: string, destination: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'aiwg-delivery-boundary-'));
  worker = path.join(root, 'worker'); mkdirSync(worker); fake.workerRoot = worker;
  artifact = path.join(worker, 'final'); destination = path.join(root, 'answer');
  writeFileSync(artifact, 'accepted'); writeFileSync(destination, 'previous');
  fake.record = { invocationId: 'owned-1', worktree: { path: worker }, paths: { final: artifact } };
  fake.status = 'accepted'; fake.degraded = false;
  fake.complete.mockResolvedValue({ phase: 'completed', recordHash: 'signed' });
  fake.prepare.mockResolvedValue(fake.complete);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const checks = [{ id: 'unit', command: '/bin/sh', args: ['-c', ':'] }];
const request = () => ({ runDir: path.join(root, 'run'), checks, deliverablePath: destination });
describe('T-OG-04 verified publication and receipt ordering', () => {
  it('prepares a signed intent, publishes accepted bytes and completes the delivery receipt', async () => {
    fake.prepare.mockImplementationOnce(async () => {
      expect(readFileSync(destination, 'utf8')).toBe('previous');
      return async () => { expect(readFileSync(destination, 'utf8')).toBe('accepted'); return fake.complete(); };
    });
    expect(await verifyWorkerRun(request())).toMatchObject({ status: 'accepted', deliveryRecord: { phase: 'completed' } });
    expect(fake.prepare.mock.calls[0][1]).toMatchObject({ invocationId: 'owned-1', runDir: request().runDir, deliverablePath: destination, verifierId: 'trusted-verification@1' });
  });
  it.each(['rejected', 'blocked'])('never publishes or records %s output', async status => {
    fake.status = status;
    expect((await verifyWorkerRun(request())).status).toBe(status);
    expect(readFileSync(destination, 'utf8')).toBe('previous');
    expect(fake.prepare).not.toHaveBeenCalled();
  });
  it('blocks degraded verification before creating a delivery intent', async () => {
    fake.degraded = true;
    expect(await verifyWorkerRun(request())).toMatchObject({ status: 'blocked', errorCode: 'ISOLATION_UNAVAILABLE' });
    expect(fake.prepare).not.toHaveBeenCalled();
  });
  it('cannot publish when signing is unavailable or when the accepted bytes change', async () => {
    fake.prepare.mockRejectedValueOnce(Error('signing unavailable'));
    await expect(verifyWorkerRun(request())).rejects.toThrow('signing unavailable');
    fake.prepare.mockImplementationOnce(async () => { writeFileSync(artifact, 'mutated'); return fake.complete; });
    await expect(verifyWorkerRun(request())).rejects.toThrow('digest changed');
    expect(readFileSync(destination, 'utf8')).toBe('previous'); expect(fake.complete).not.toHaveBeenCalled();
  });
  it('permits verification without publication and rejects missing launcher paths', async () => {
    expect((await verifyWorkerRun({ ...request(), deliverablePath: undefined, artifactPath: artifact })).status).toBe('accepted');
    expect(fake.prepare).not.toHaveBeenCalled();
    fake.record = {};
    await expect(verifyWorkerRun(request())).rejects.toThrow('absolute worktree and artifact');
  });
  it.each([true, false])('reports read-only delivery lookup (%s)', async verified => {
    fake.lookup.mockResolvedValue({ verified });
    const stdout = vi.fn(), stderr = vi.fn();
    expect(await runWorkerVerificationCli(['--verify-worker', '--delivery-status', '--deliverable', destination, '--json'], { stdout, stderr })).toBe(verified ? 0 : 1);
    expect(JSON.parse(stdout.mock.calls[0][0])).toEqual({ verified });
    expect(fake.prepare).not.toHaveBeenCalled();
  });
});

it('uses the existing host delivery scope for record writes and read-only lookup', async () => {
  const adapter = await vi.importActual<any>('../../../tools/ralph-external/lib/worker-delivery-record.mjs');
  const metadata = { artifactDigest: 'sha256:synthetic', deliverablePath: destination };
  await adapter.prepareDeliveryRecord(root, metadata);
  expect(fake.prepare).toHaveBeenCalledWith({ projectDir: root, subsystem: 'delivery' }, metadata);
  fake.lookup.mockResolvedValue({ verified: false });
  expect(await adapter.lookupDeliveryRecord(root, destination)).toEqual({ verified: false });
  expect(fake.lookup).toHaveBeenCalledWith({ projectDir: root, subsystem: 'delivery' }, destination);
});
it('prints an unverified lookup without running checks or publishing', async () => {
  fake.lookup.mockResolvedValue({ verified: false }); const stdout = vi.fn();
  expect(await runWorkerVerificationCli(['--verify-worker', '--delivery-status', '--deliverable', destination], { stdout })).toBe(1);
  expect(stdout).toHaveBeenCalledWith('Deliverable: unverified');
});
