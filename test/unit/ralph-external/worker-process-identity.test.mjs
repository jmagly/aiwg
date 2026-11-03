// Synthetic /proc snapshots reproduce exit_mm racing the launcher's first birth sample.
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sampleWorkerProcIdentity } from '../../../tools/ralph-external/lib/worker-process-identity.mjs';
import { observeWorkerTermination } from '../../../tools/ralph-external/lib/worker-termination.mjs';
import { sampleWorkerIdentity } from '../../../tools/ralph-external/process-monitor.mjs';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const stat = (state, start = '100', parent = process.pid) =>
  `123 (worker) ${state} ${parent} 123 123 ${Array(15).fill('0').join(' ')} ${start} 0\n`;
function fixture(state = 'Z') {
  const procRoot = fs.mkdtempSync(join(tmpdir(), 'aiwg-worker-birth-'));
  roots.push(procRoot);
  fs.mkdirSync(join(procRoot, '123'));
  fs.mkdirSync(join(procRoot, 'sys/kernel/random'), { recursive: true });
  fs.writeFileSync(join(procRoot, 'sys/kernel/random/boot_id'), 'synthetic-boot\n');
  fs.writeFileSync(join(procRoot, '123/stat'), stat(state));
  fs.writeFileSync(join(procRoot, '123/status'), `Uid:\t${process.getuid()}\t${process.getuid()}\n`);
  fs.writeFileSync(join(procRoot, '123/environ'), '');
  return { procRoot, platform: 'linux', host: 'synthetic-host' };
}

describe('T-OG-04 kernel birth capture at exit (#3835)', () => {
  it('retains a zombie direct child birth even though /exe has disappeared', () => {
    const input = fixture();
    const identity = sampleWorkerProcIdentity(123, input);
    expect(identity).toMatchObject({ pid: 123, pgid: 123, parentPid: process.pid,
      startTicks: '100', state: 'Z', executable: null });
    const local = sampleWorkerIdentity(process.pid);
    const supervisor = { ...local, host: input.host, bootId: identity.bootId };
    expect(observeWorkerTermination({ workerExited: true, identity, supervisor, invocationId: 'exited',
      kill: () => { throw Object.assign(new Error(), { code: 'ESRCH' }); },
      scan: () => ({ confirmed: true, missing: null }) })).toEqual({ confirmed: true, missing: null });
  });

  it('rechecks the same birth when exit occurs between stat and exe', () => {
    const input = fixture('S');
    const injected = { ...fs, readlinkSync: filename => {
      fs.writeFileSync(join(input.procRoot, '123/stat'), stat('Z'));
      return fs.readlinkSync(filename);
    } };
    expect(sampleWorkerProcIdentity(123, { ...input, fs: injected }))
      .toMatchObject({ startTicks: '100', state: 'Z', executable: null });
  });

  it.each(['live', 'denied', 'reused', 'reparented', 'vanished'])(
    'does not recover identity from an unreadable executable for %s', scenario => {
      const input = fixture(scenario === 'live' ? 'S' : 'Z');
      const injected = { ...fs, readlinkSync: () => {
        if (scenario === 'reused') fs.writeFileSync(join(input.procRoot, '123/stat'), stat('Z', '101'));
        if (scenario === 'reparented') fs.writeFileSync(join(input.procRoot, '123/stat'), stat('Z', '100', 1));
        if (scenario === 'vanished') fs.rmSync(join(input.procRoot, '123/stat'));
        throw Object.assign(new Error(), { code: scenario === 'denied' ? 'EACCES' : 'ENOENT' });
      } };
      expect(sampleWorkerProcIdentity(123, { ...input, fs: injected })).toBeNull();
    });
});
