// #3846: a provider home (~/.hermes, ~/.codex) can hold gigabytes of runtime
// data. The ownership snapshot must not hold those bytes or re-read them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DeploymentOutputState, captureDeploymentOutputs, recordDeploymentOutputs, sameOutput,
} from '../../../src/providers/deployment-ownership.mjs';
import { preserveDeploymentOutputs } from '../../../src/providers/deployment-preservation.mjs';

let root: string;
const write = (name: string, value: string) => {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
  return file;
};
const receipt = (dir: string) => JSON.parse(fs.readFileSync(path.join(root, dir, '.aiwg-manifest.json'), 'utf8'));
// Files written by the test are seconds old; shift the clock so the snapshot
// treats them as settled, as it would a real provider install.
const settled = () => vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-ownership-snapshot-')); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { force: true, recursive: true }); });

describe('deployment ownership snapshot memory (#3846)', () => {
  it('keeps runtime data as stat-only entries and AIWG outputs as digests or bytes', () => {
    const runtime = write('hermes-agent/lib/module.py', 'x'.repeat(4096));
    const db = write('cache/blob.bin', 'y'.repeat(8192));
    const unmanagedSkill = write('skills/operator/SKILL.md', 'operator skill');
    const managedSkill = write('skills/aiwg/demo/SKILL.md', 'managed');
    write('skills/aiwg/demo/.aiwg-manifest.json', JSON.stringify({ managed: { 'SKILL.md': { hash: 'sha256:0' } } }));
    const settings = write('profiles/default/config.yaml', 'a: 1\n');
    settled();
    const snapshot = captureDeploymentOutputs([root]);
    for (const file of [runtime, db]) {
      const entry = snapshot.get(file);
      expect(entry).toBeInstanceOf(DeploymentOutputState);
      expect((entry as DeploymentOutputState).hash).toBeUndefined();
    }
    const skill = snapshot.get(unmanagedSkill) as DeploymentOutputState;
    expect(skill).toBeInstanceOf(DeploymentOutputState);
    expect(skill.hash).toMatch(/^sha256:/);
    expect(Buffer.isBuffer(snapshot.get(managedSkill))).toBe(true);
    expect(Buffer.isBuffer(snapshot.get(path.join(root, 'skills/aiwg/demo/.aiwg-manifest.json')))).toBe(true);
    expect(Buffer.isBuffer(snapshot.get(settings))).toBe(true);
  });

  it('does not re-read unchanged runtime files after the deploy and still records new outputs', () => {
    const runtime = Array.from({ length: 50 }, (_, index) => write(`tools/python/lib/m${index}.py`, `print(${index})`));
    settled();
    const before = captureDeploymentOutputs([root]);
    const output = write('skills/aiwg/demo/SKILL.md', 'deployed');
    const reads = vi.spyOn(fs, 'readFileSync');
    recordDeploymentOutputs(before, [root], { mode: 'sdlc' });
    const readPaths = reads.mock.calls.map(([file]) => path.resolve(String(file)));
    for (const file of runtime) expect(readPaths).not.toContain(file);
    expect(receipt('skills/aiwg/demo').managed['SKILL.md']).toMatchObject({ owners: ['sdlc-complete'] });
    for (const file of runtime) expect(fs.existsSync(path.join(path.dirname(file), '.aiwg-manifest.json'))).toBe(false);
  });

  it('still records a changed runtime file as changed', () => {
    const file = write('state/notes.txt', 'one');
    settled();
    const before = captureDeploymentOutputs([root]);
    fs.writeFileSync(file, 'two!');
    const after = captureDeploymentOutputs([root], { previous: before });
    expect(sameOutput(before.get(file), after.get(file))).toBe(false);
    expect((after.get(file) as DeploymentOutputState).hash).toMatch(/^sha256:/);
  });

  it('does not adopt an identically rewritten unrecorded skill file', () => {
    const file = write('skills/legacy/SKILL.md', 'legacy body');
    settled();
    const before = captureDeploymentOutputs([root]);
    fs.writeFileSync(file, 'legacy body');
    recordDeploymentOutputs(before, [root], { mode: 'sdlc' });
    expect(fs.existsSync(path.join(root, 'skills/legacy/.aiwg-manifest.json'))).toBe(false);
  });

  it('never restores runtime data that the snapshot holds without bytes', () => {
    const file = write('cache/session.db', 'runtime');
    settled();
    const before = captureDeploymentOutputs([root]);
    fs.rmSync(file);
    preserveDeploymentOutputs(before, [root], { target: root, copyMode: true });
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('unreadable provider files (#3846)', () => {
  it('records an unreadable runtime settings file by stat instead of aborting', () => {
    const file = write('state-snapshots/old/config.yaml', 'secret: 1\n');
    const read = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((target: fs.PathOrFileDescriptor, options?: unknown) => {
      if (path.resolve(String(target)) === file) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return read(target, options as never);
    }) as typeof fs.readFileSync);
    const snapshot = captureDeploymentOutputs([root]);
    expect(snapshot.get(file)).toBeInstanceOf(DeploymentOutputState);
    expect((snapshot.get(file) as DeploymentOutputState).hash).toBeUndefined();
  });

  it('treats a file deleted between stat and read as absent', () => {
    const file = write('sessions/rollout.jsonl', '{}');
    const read = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((target: fs.PathOrFileDescriptor, options?: unknown) => {
      if (path.resolve(String(target)) === file) throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
      return read(target, options as never);
    }) as typeof fs.readFileSync);
    expect(captureDeploymentOutputs([root]).has(file)).toBe(false);
  });
});
