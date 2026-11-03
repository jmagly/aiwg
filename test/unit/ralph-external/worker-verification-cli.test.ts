// Exercise the installed worker CLI with synthetic launcher records and clients.
import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { rmSync } from '../../helpers/worker-capture-cleanup.mjs';
import { WorkerCaptureOwner } from '../../../tools/ralph-external/lib/worker-capture.mjs';
import { publishWorkerRecord } from '../../../tools/ralph-external/session-launcher.mjs';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWorkerVerificationArgs } from '../../../tools/ralph-external/lib/worker-verification-cli.mjs';
import { parseWorkerLaunchArgs, resolveRetryReference } from '../../../tools/ralph-external/lib/worker-launch-cli.mjs';
import { verifyRetryPredecessor } from '../../../tools/ralph-external/session-launcher.mjs';
import { sampleWorkerIdentity } from '../../../tools/ralph-external/process-monitor.mjs';
import { inspectWorkerPath } from '../../../src/serve/worker-invocation-paths.js';
import { observeChildClose, stopAndReap, waitForCondition } from '../../helpers/worker-lifecycle.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const quote = (s: string) => "'" + s.replaceAll("'", "'\"'\"'") + "'";
function fixture(mode = 'enforced') {
  const root = mkdtempSync(path.join(tmpdir(), 'aiwg-verify-cli-')); roots.push(root);
  const worktree = path.join(root, 'worker'), run = path.join(root, 'run'), clients = path.join(root, 'clients');
  for (const dir of [worktree, run, clients]) mkdirSync(dir, { mode: 0o700 });
  mkdirSync(path.join(clients, 'proc'));
  const artifact = path.join(worktree, 'final.json');
  const inputsFixture = path.join(clients, 'inputs.mjs');
  copyFileSync(path.join(repo, 'test/fixtures/ralph-external/verification-inputs.mjs'), inputsFixture);
  writeFileSync(path.join(clients, 'qualified-roots.json'), JSON.stringify([worktree]));
  writeFileSync(artifact, '{"status":"completed"}');
  const writeRecord = (name: string, value: unknown) => writeFileSync(path.join(run, name), JSON.stringify(value), { mode: 0o600 });
  writeFileSync(path.join(run, '.launch-owner'), 'previous-1', { mode: 0o600 });
  writeRecord('invocation.json', { origin: 'launcher', invocationId: 'previous-1', worktree: { path: worktree }, paths: { final: artifact } });
  writeRecord('exit.json', { invocationId: 'previous-1', termination: 'confirmed' });
  copyFileSync(path.join(repo, 'test/fixtures/ralph-external/verification-systemd.mjs'), path.join(clients, 'client.mjs'));
  writeFileSync(path.join(clients, 'mode.txt'), mode);
  for (const command of ['systemd-run', 'systemctl']) {
    writeFileSync(path.join(clients, command), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(clients, 'client.mjs'))} "$@"\n`, { mode: 0o700 });
  }
  const check = (code = 'console.log("checked")') => JSON.stringify({ id: 'unit', command: process.execPath, args: ['-e', code] });
  const invoke = (extra: string[] = ['--check', check()]) => {
    const result = spawnSync(process.execPath, ['--import', inputsFixture, path.join(repo, 'tools/ralph-external/index.mjs'),
      '--verify-worker', '--run-dir', run, '--json', ...extra], {
      cwd: worktree, timeout: 15_000, encoding: 'utf8',
      env: { HOME: root, PATH: clients + path.delimiter + process.env.PATH, AIWG_RESOLVE_IMPL_FROM: 'dist' },
    });
    expect(result.error).toBeUndefined();
    expect(result.stdout, result.stderr).not.toBe('');
    return { ...result, output: JSON.parse(result.stdout) };
  };
  return { root, worktree, run, artifact, writeRecord, check, invoke };
}

describe('T-OG-04 installed CLI trusted verification', () => {
  it('accepts protected checks and binds artifact/tree digests using the installed verifier', () => {
    const f = fixture();
    // A task checkout cannot replace the CLI's installed implementation.
    const poison = path.join(f.worktree, 'tools/ralph-external/lib');
    mkdirSync(poison, { recursive: true });
    writeFileSync(path.join(poison, 'trusted-verification.mjs'), 'throw new Error("task verifier imported");');
    const result = f.invoke();
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toMatchObject({ version: 1, kind: 'worker-verification', status: 'accepted',
      isolation: { mode: 'systemd-unit' }, exitCode: 0 });
    expect(result.output.artifactDigest).toMatch(/^sha256:/);
    expect(result.output.treeDigest).toMatch(/^fd-tree:sha256:/);
    expect(result.output.evidence).toHaveLength(1);
    expect(result.output.runnerRef).toBe(new URL('../../../tools/ralph-external/lib/trusted-verification.mjs', import.meta.url).href);
  });

  it('checks sealed capture digests before executing protected checks (#3832)', async () => {
    const f = fixture();
    const invocation = JSON.parse(await readFile(path.join(f.run, 'invocation.json'), 'utf8'));
    invocation.captures = {};
    const owner = new WorkerCaptureOwner({ runDir: f.run, paths: invocation.paths, captures: {},
      inspect: inspectWorkerPath, invocationId: invocation.invocationId });
    const publish = owner.writer(publishWorkerRecord);
    await publish(f.run, 'invocation.json', invocation, inspectWorkerPath);
    await publish(f.run, 'exit.json', { invocationId: invocation.invocationId, termination: 'confirmed' }, inspectWorkerPath);
    await owner.finish();
    expect(f.invoke().output.status).toBe('accepted');
    const exit = JSON.parse(await readFile(path.join(f.run, 'exit.json'), 'utf8'));
    const snapshot = exit.captureSeal.files[0].path;
    await chmod(snapshot, 0o600);
    await writeFile(snapshot, 'tampered capture');
    await chmod(snapshot, 0o400);
    const result = f.invoke(['--check', f.check('throw new Error("must not execute")')]);
    expect(result.status).toBe(1);
    expect(result.output).toMatchObject({ status: 'rejected', evidence: [], errorCode: 'VERIFICATION_REQUEST_FAILED' });
    expect(result.output.findings.join(' ')).toMatch(/capture seal verification failed.*digest mismatch/);
  });

  it.each(['unavailable', 'missing-home'])('fails closed before checks when isolation is %s', mode => {
    const f = fixture(mode);
    const result = f.invoke(['--check', f.check('throw new Error("must not execute")')]);
    expect(result.status).toBe(2);
    expect(result.output).toMatchObject({ status: 'blocked', errorCode: 'ISOLATION_UNAVAILABLE', evidence: [] });
    expect(result.stderr).toContain('ISOLATION_UNAVAILABLE');
  });

  it('rejects a protected-check failure independently of worker claims', () => {
    const f = fixture();
    const result = f.invoke(['--check', f.check('process.exit(7)')]);
    expect(result.status, result.stderr).toBe(1);
    expect(result.output).toMatchObject({ status: 'rejected', artifactDigest: null });
    expect(result.output.findings).toContain('unit: failed (exit 7)');
    expect(readFileSync(f.artifact, 'utf8')).toContain('completed');
  });

  it('refuses forged run records inside another independently qualified writable root', () => {
    const f = fixture();
    // Metadata names one tree; host qualifications independently expose another
    // writable root containing the forged, privately-moded run records.
    writeFileSync(path.join(f.root, 'clients/qualified-roots.json'), JSON.stringify([f.worktree, f.run]));
    const result = f.invoke();
    expect(result.status).toBe(1);
    expect(result.output.findings.join(' ')).toContain('inside a worker-writable root');
    expect(result.output.evidence).toEqual([]);
  });

  it('rechecks marked empty-group evidence before the independent verification isolation probe', () => {
    const f = fixture('unavailable');
    const local = sampleWorkerIdentity(process.pid);
    f.writeRecord('process.json', { invocationId: 'previous-1', invocationMarker: 'previous-1', origin: 'launcher', isolation: 'native-sandbox',
      supervisor: local, worker: { ...local, pid: 2147483646, pgid: 2147483646 },
      identityObservation: 'stable-owned-group', ownership: 'owned-group' });
    f.writeRecord('exit.json', { invocationId: 'previous-1', exitCode: 0, isolation: 'native-sandbox', termination: 'uncertain' });
    const result = f.invoke(['--check', f.check(), '--check-descendants']);
    expect(result.output).toMatchObject({ status: 'blocked', errorCode: 'ISOLATION_UNAVAILABLE' });
    expect(JSON.parse(readFileSync(path.join(f.run, 'exit.json'), 'utf8'))).toMatchObject({ termination: 'confirmed', descendants: 'none' });
  });

  it('keeps verification refused while the owned group is live, even with --check-descendants', async () => {
    const f = fixture();
    const child = spawn(process.execPath, [path.join(repo, 'test/fixtures/ralph-external/termination-worker.mjs'), 'descendant'],
      { detached: true, stdio: 'ignore' });
    const closed = observeChildClose(child);
    try {
      let identity;
      await waitForCondition(() => {
        identity = sampleWorkerIdentity(child.pid);
        return identity?.pgid === child.pid;
      });
      expect(identity?.pgid).toBe(child.pid);
      f.writeRecord('process.json', { invocationId: 'previous-1', invocationMarker: 'previous-1', origin: 'launcher', isolation: 'degraded',
        supervisor: sampleWorkerIdentity(process.pid), worker: identity,
        identityObservation: 'stable-owned-group', ownership: 'owned-group' });
      f.writeRecord('exit.json', { invocationId: 'previous-1', exitCode: 0, isolation: 'degraded', termination: 'uncertain' });
      const result = f.invoke(['--check', f.check('throw new Error("must not execute")'), '--check-descendants']);
      expect(result.output).toMatchObject({ status: 'rejected', errorCode: 'VERIFICATION_REQUEST_FAILED', evidence: [] });
      expect(result.output.findings.join(' ')).toMatch(/signal-0 still finds members.*--check-descendants/);
      expect(JSON.parse(readFileSync(path.join(f.run, 'exit.json'), 'utf8')).termination).toBe('uncertain');
    } finally { await stopAndReap(child, closed, { ownedGroup: true }); }
  });

  it('refuses verification when the group is empty but an escaped marked process survives', async () => {
    const f = fixture();
    const child = spawn(process.execPath, [path.join(repo, 'test/fixtures/ralph-external/termination-worker.mjs'), 'descendant'],
      { detached: true, stdio: 'ignore', env: { AIWG_WORKER_INVOCATION_ID: 'previous-1' } });
    const closed = observeChildClose(child);
    try {
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      symlinkSync(`/proc/${child.pid}`, path.join(f.root, 'clients/proc', String(child.pid)));
      const local = sampleWorkerIdentity(process.pid);
      f.writeRecord('process.json', { invocationId: 'previous-1', invocationMarker: 'previous-1', origin: 'launcher', isolation: 'native-sandbox',
        supervisor: local, worker: { ...local, pid: 2147483646, pgid: 2147483646 },
        identityObservation: 'stable-owned-group', ownership: 'owned-group' });
      f.writeRecord('exit.json', { invocationId: 'previous-1', exitCode: 0, isolation: 'native-sandbox', termination: 'uncertain' });
      const result = f.invoke(['--check', f.check('throw new Error("must not execute")'), '--check-descendants']);
      expect(result.output).toMatchObject({ status: 'rejected', errorCode: 'VERIFICATION_REQUEST_FAILED', evidence: [] });
      expect(result.output.findings.join(' ')).toMatch(/escaped-descendant evidence: same-uid process still carries invocation marker/);
      expect(JSON.parse(readFileSync(path.join(f.run, 'exit.json'), 'utf8')).termination).toBe('uncertain');
    } finally {
      await stopAndReap(child, closed, { ownedGroup: true });
    }
  });

  it('refuses uncertain termination before checks and rejects degraded isolation options', () => {
    const f = fixture();
    f.writeRecord('exit.json', { invocationId: 'previous-1', termination: 'uncertain' });
    expect(f.invoke().output.findings.join(' ')).toMatch(/not confirmed.*--check-descendants/);
    const args = ['--verify-worker', '--run-dir', f.run, '--check', f.check()];
    expect(() => parseWorkerVerificationArgs([...args, '--allow-degraded-worker'])).toThrow(/Unsupported/);
    expect(() => parseWorkerVerificationArgs([...args.slice(0, -1), JSON.stringify({ id: 'unsafe', command: process.execPath, allowDegradedIsolation: true })])).toThrow(/overrides/);
    expect(() => parseWorkerVerificationArgs(args.slice(0, -2))).toThrow(/Usage/);
  });
});

describe('T-OG-04 one-flag retry predecessor derivation', () => {
  it('derives the launcher ID and still verifies matching owned confirmed-stop records', async () => {
    const f = fixture();
    const parsed = parseWorkerLaunchArgs(['--launch-worker', '--invocation', '/new-plan.json', '--run-dir', '/new-run', '--retry-of-run-dir', f.run]);
    const reference = await resolveRetryReference(parsed.retryOf, { inspect: inspectWorkerPath });
    expect(reference).toEqual({ invocationId: 'previous-1', runDir: f.run });
    await expect(verifyRetryPredecessor(reference, { inspect: inspectWorkerPath, workerWritableRoots: [f.worktree] })).resolves.toMatchObject({ invocationId: 'previous-1' });
    f.writeRecord('exit.json', { invocationId: 'other', termination: 'confirmed' });
    await expect(verifyRetryPredecessor(reference, { inspect: inspectWorkerPath })).rejects.toThrow(/identity/);
  });

  it('refuses invalid launcher metadata and preserves an explicit ID assertion', async () => {
    const f = fixture();
    const explicit = await resolveRetryReference({ invocationId: 'wrong', runDir: f.run }, { inspect: inspectWorkerPath });
    await expect(verifyRetryPredecessor(explicit, { inspect: inspectWorkerPath })).rejects.toThrow(/match/);
    f.writeRecord('invocation.json', { invocationId: 'worker-claim', origin: 'worker' });
    await expect(resolveRetryReference({ runDir: f.run }, { inspect: inspectWorkerPath })).rejects.toThrow(/launcher/);
  });
});
