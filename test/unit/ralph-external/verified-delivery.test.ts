// In-process fakes exercise the publication boundary independently of subprocess fixtures.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync, chmodSync, statSync, symlinkSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const fake = vi.hoisted(() => ({ status: 'accepted', workerRoot: '', degraded: false, record: {}, complete: vi.fn(), prepare: vi.fn(), lookup: vi.fn(), verify: vi.fn() }));
vi.mock('../../../tools/_resolve-impl.mjs', () => ({ importImpl: async (_url: string, name: string) => {
  if (name === 'serve/worker-invocation-paths.js') return { inspectWorkerPath: vi.fn().mockResolvedValue(true) };
  if (name === 'cli/handlers/models.js') return { loadWorkerInputs: async () => ({ drivers: { fake: { qualification: { installation: { workerWritableRoots: [fake.workerRoot] } } } } }) };
  if (name === 'effects/host.js') return { effectSession: async (projectDir: string, subsystem: string) => ({ projectDir, subsystem }), openLedger: (session: any) => session };
  if (name === 'effects/worker-delivery.js') return { prepareWorkerDelivery: fake.prepare, lookupWorkerDelivery: fake.lookup };
  throw Error('unexpected implementation: ' + name);
} }));
vi.mock('../../../tools/ralph-external/session-launcher.mjs', () => ({ verifyRetryPredecessor: vi.fn() }));
vi.mock('../../../tools/ralph-external/lib/worker-inputs.mjs', async original => {
  const actual = await original<any>();
  return { ...actual, boundedPrivateRead: async (filename: string, ...args: any[]) => filename.endsWith('/invocation.json')
    ? Buffer.from(JSON.stringify(fake.record)) : actual.boundedPrivateRead(filename, ...args) };
});
vi.mock('../../../tools/ralph-external/lib/verification-isolation.mjs', () => ({
  probeVerificationIsolationCapabilities: () => ({ mode: fake.degraded ? 'degraded' : 'systemd-unit', degraded: [] }),
  missingRequiredCapabilities: () => fake.degraded ? ['homeReadIsolation'] : [],
}));
vi.mock('../../../tools/ralph-external/lib/worker-delivery-record.mjs', () => ({ prepareDeliveryRecord: (...args: any[]) => fake.prepare(...args), lookupDeliveryRecord: (...args: any[]) => fake.lookup(...args) }));
vi.mock('../../../tools/ralph-external/lib/trusted-verification.mjs', async original => {
  const actual = await original<any>();
  return { ...actual, verifyWorkerArtifact: (request: any) => {
    const pinned = actual.pinArtifact(actual.resolveWorktreeRoot(request.worktreeRoot), request.artifactPath);
    try { request.guardArtifact?.(pinned, `sha256:${createHash('sha256').update(readFileSync(request.artifactPath)).digest('hex')}`); }
    finally { closeSync(pinned.fd); }
    return fake.verify(request);
  } };
});
import { verifyWorkerRun, runWorkerVerificationCli } from '../../../tools/ralph-external/lib/worker-verification-cli.mjs';
import { isContentFreeCheck, prepareWorkerDeliveryGuard } from '../../../tools/ralph-external/lib/worker-delivery-guards.mjs';
let root: string, worker: string, artifact: string, destination: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'aiwg-delivery-boundary-'));
  worker = path.join(root, 'worker'); mkdirSync(worker); fake.workerRoot = worker;
  artifact = path.join(worker, 'artifact.txt'); destination = path.join(root, 'answer');
  writeFileSync(artifact, 'accepted'); writeFileSync(destination, 'previous');
  fake.record = { invocationId: 'owned-1', worktree: { path: worker }, paths: { final: path.join(worker, 'final') } };
  writeFileSync(path.join(worker, 'final'), 'Worker handoff');
  mkdirSync(path.join(root, 'run'), { mode: 0o700 });
  writeExit(new Date().toISOString());
  fake.status = 'accepted'; fake.degraded = false;
  fake.verify.mockImplementation(({ artifactPath }: any) => ({ status: fake.status, verifierId: 'trusted-verification@1', artifactDigest: `sha256:${createHash('sha256').update(readFileSync(artifactPath)).digest('hex')}`, findings: [] }));
  fake.complete.mockResolvedValue({ phase: 'completed', recordHash: 'signed' });
  fake.prepare.mockResolvedValue(fake.complete);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const writeExit = (endedAt?: string) => writeFileSync(path.join(root, 'run/exit.json'), JSON.stringify({ endedAt }), { mode: 0o600 });
const request = () => ({ runDir: path.join(root, 'run'), artifactPath: artifact, checks: [{ id: 'content', command: process.execPath, args: ['-e', 'if (require("node:fs").readFileSync(process.argv[1], "utf8") !== "accepted") process.exit(1)', artifact] }], deliverablePath: destination });
describe('T-OG-04 verified publication and receipt ordering', () => {
  async function refused(input: any, errorCode: string) {
    const result = await verifyWorkerRun(input);
    expect(result).toMatchObject({ status: 'rejected', errorCode, artifactDigest: null, evidence: [] });
    expect(result.findings[0]).toContain(errorCode);
    expect(fake.verify).not.toHaveBeenCalled();
    expect(fake.prepare).not.toHaveBeenCalled();
    expect(readFileSync(destination, 'utf8')).toBe('previous');
    return result;
  }
  it('requires explicit artifact_path / --artifact before any check runs (#4167)', async () => {
    const result = await refused({ ...request(), artifactPath: undefined }, 'ARTIFACT_REQUIRED');
    expect(result.findings[0]).toMatch(/artifact_path.*--artifact/);
  });
  it.each(['direct', 'alias'])('never publishes the worker final (%s path)', async spelling => {
    const final = path.join(worker, 'final');
    let candidate = final;
    if (spelling === 'alias') {
      candidate = path.join(worker, 'alias'); symlinkSync(final, candidate);
    }
    await refused({ ...request(), artifactPath: candidate }, 'ARTIFACT_REQUIRED');
  });
  it.each(['missing-file', 'missing-endedAt', 'invalid-endedAt'])('requires exit evidence (%s) before checks (#4165)', async kind => {
    if (kind === 'missing-file') rmSync(path.join(root, 'run/exit.json'));
    else writeExit(kind === 'missing-endedAt' ? undefined : 'not-an-ISO-date');
    await refused(request(), 'EXIT_EVIDENCE_MISSING');
  });
  it.each(['created', 'modified', 'ctime-only', 'mtime-only'])('refuses artifacts %s after exit (#4165)', async kind => {
    writeExit(new Date(Date.now() - 10000).toISOString());
    if (kind === 'created') { rmSync(artifact); writeFileSync(artifact, 'accepted'); }
    if (kind === 'modified') writeFileSync(artifact, 'mutated');
    if (kind === 'ctime-only') {
      utimesSync(artifact, new Date(0), new Date(0)); chmodSync(artifact, 0o600);
      expect(statSync(artifact).mtimeMs).toBe(0);
    }
    if (kind === 'mtime-only') {
      writeExit(new Date().toISOString());
      utimesSync(artifact, new Date(), new Date(Date.now() + 10000));
    }
    await refused(request(), 'ARTIFACT_CHANGED_AFTER_EXIT');
  });
  it.each(['relative', 'absolute', 'extracted'])('refuses a mismatching %s worker artifact digest claim', async kind => {
    const claims = { artifacts: [{ path: kind === 'absolute' ? artifact : 'artifact.txt', digest: `sha256:${'0'.repeat(64)}` }] };
    writeFileSync(path.join(worker, 'final'), JSON.stringify(kind === 'extracted' ? { result: claims } : claims));
    await refused(request(), 'ARTIFACT_CHANGED_AFTER_EXIT');
  });
  it('guards the verifier pin even if an artifact changes after request preparation', async () => {
    const actual = await vi.importActual<any>('../../../tools/ralph-external/lib/trusted-verification.mjs');
    const runConfined = vi.fn();
    const guardArtifact = await prepareWorkerDeliveryGuard({ worktreeRoot: worker, artifactPath: artifact,
      finalPath: path.join(worker, 'final'), checks: request().checks,
      exit: JSON.parse(readFileSync(path.join(root, 'run/exit.json'), 'utf8')), inspect: async () => true });
    utimesSync(artifact, new Date(), new Date(Date.now() + 10000));
    expect(() => actual.verifyWorkerArtifact({ worktreeRoot: worker, artifactPath: artifact, guardArtifact,
      checks: [{ ...request().checks[0], runConfined }], allowedCheckBinaries: [process.execPath] })).toThrow(/ARTIFACT_CHANGED_AFTER_EXIT/);
    expect(runConfined).not.toHaveBeenCalled();
    expect(readFileSync(destination, 'utf8')).toBe('previous');
  });
  it('accepts matching claims and the two-second timestamp slack', async () => {
    const digest = `sha256:${createHash('sha256').update('accepted').digest('hex')}`;
    writeFileSync(path.join(worker, 'final'), JSON.stringify({ artifacts: [{ path: 'artifact.txt', digest }] }));
    const stat = statSync(artifact);
    writeExit(new Date(Math.max(stat.ctimeMs, stat.mtimeMs) - 1500).toISOString());
    expect(await verifyWorkerRun(request())).toMatchObject({ status: 'accepted', artifactDigest: digest });
    expect(fake.verify).toHaveBeenCalledOnce();
  });
  it.each(['test', '[', 'stat', 'ls', 'true', 'file', 'wc', 'unrelated', 'empty', 'mixed'])('refuses content-free checks (%s) before any check runs (#4168)', async command => {
    const contentFree = command === 'unrelated' ? [{ id: 'unrelated', command: process.execPath, args: ['-e', 'process.exit(0)'] }]
      : command === 'empty' ? []
      : command === 'mixed' ? [{ id: 'exists', command: '/usr/bin/test', args: ['-f', artifact] }, { id: 'noop', command: process.execPath, args: ['--version'] }]
      : [{ id: 'probe', command: `/usr/bin/${command}`, args: ['-f', artifact] }];
    await refused({ ...request(), checks: contentFree }, 'CHECKS_CONTENT_FREE');
  });
  it.each(['path', 'basename', 'directory', 'embedded', 'mixed'])('accepts a content check with an artifact %s reference', async kind => {
    const check = kind === 'basename' ? { id: 'python', command: '/usr/bin/python3', args: ['-c', 'assert open("artifact.txt").read() == "accepted"'] }
      : kind === 'directory' ? { id: 'node', command: process.execPath, args: ['--test', worker] }
      : kind === 'embedded' ? { id: 'node', command: process.execPath, args: ['-e', `if (require("node:fs").readFileSync(${JSON.stringify(artifact)}, "utf8") !== "accepted") process.exit(1)`] }
      : { id: 'jq', command: '/usr/bin/jq', args: ['-e', '.', artifact] };
    const checks = kind === 'mixed' ? [{ id: 'probe', command: '/usr/bin/test', args: ['-f', artifact] }, check] : [check];
    expect((await verifyWorkerRun({ ...request(), checks })).status).toBe('accepted');
    expect(fake.verify).toHaveBeenCalledOnce();
  });
  it('classifies probe paths with spaces and argument-less checks as content-free', () => {
    expect(isContentFreeCheck({ command: '/usr/bin/wc', args: ['-c', path.join(worker, 'artifact with spaces.txt')] }, path.join(worker, 'artifact with spaces.txt'))).toBe(true);
    expect(isContentFreeCheck({ command: process.execPath }, artifact)).toBe(true);
  });
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
    expect((await verifyWorkerRun({ ...request(), deliverablePath: undefined, artifactPath: undefined })).status).toBe('accepted');
    expect(fake.verify).toHaveBeenCalledWith(expect.objectContaining({ artifactPath: path.join(worker, 'final') }));
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
