// Reproduce sandbox stdin-pipe failures without a Codex installation.
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, fstatSync, readSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';

const state = vi.hoisted(() => ({ directories: [], closed: [], inspect: undefined }));
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal();
  return { ...fs, closeSync: fd => { state.closed.push(fd); return fs.closeSync(fd); }, mkdtempSync: (...args) => {
    const directory = fs.mkdtempSync(...args);
    state.directories.push(directory);
    return directory;
  } };
});
vi.mock('node:child_process', async importOriginal => {
  const cp = await importOriginal();
  const guard = (api, options) => {
    const stdin = options?.stdio?.[0];
    if (!Array.isArray(options?.stdio) || stdin === undefined || stdin === null || stdin === 'pipe') {
      throw Object.assign(new Error('sandbox cannot create stdin pipe'), { code: 'EPERM' });
    }
    state.inspect?.(api, options);
  };
  return { ...cp,
    execSync: (command, options) => { guard('exec', options); return cp.execSync(command, { ...options, timeout: positiveTimeoutMs(options.timeout, 3000), killSignal: 'SIGKILL' }); },
    execFileSync: (file, args, options) => { guard('file', options); return cp.execFileSync(file, args, { ...options, timeout: positiveTimeoutMs(options.timeout, 3000), killSignal: 'SIGKILL' }); },
    spawnSync: (file, args, options) => { guard('spawn', options); return cp.spawnSync(file, args, { ...options, timeout: positiveTimeoutMs(options.timeout, 3000), killSignal: 'SIGKILL' }); },
  };
});

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dropGitignored } from '../../../src/config/gitignore.js';

import { boundedExecSync, boundedExecFileSync, boundedSpawnSync, positiveTimeoutMs } from '../../../src/process/bounded-child-process.mjs';

// All variants run a local Node echo fixture; no provider CLI is required.
const calls = {
  exec: options => boundedExecSync('node -e "process.stdin.pipe(process.stdout)"', 'quick', options),
  file: options => boundedExecFileSync(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], 'quick', options),
  spawn: options => boundedSpawnSync(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], 'quick', options),
};

beforeEach(() => { state.directories = []; state.closed = []; state.inspect = undefined; });
afterEach(() => {
  for (const directory of state.directories) expect(existsSync(directory)).toBe(false);
});

for (const [api, call] of Object.entries(calls)) {
  describe(`${api}: sandbox-safe synchronous stdin`, () => {
    it.each([['default', undefined], ['pipe', 'pipe'], ['inherit', 'inherit'],
      ['array pipe', ['pipe', 'pipe', 'pipe']], ['array null', [null, 'pipe', 'pipe']],
      ['parent fd', [0, 'pipe', 'pipe']], ['parent stream', [process.stdin, 'pipe', 'pipe']]])(
      'avoids an unusable stdin pipe (%s)', (_label, stdio) => {
        state.inspect = (_api, options) => expect(options.stdio[0]).toBe('ignore');
        const result = call({ stdio, encoding: 'utf8' });
        expect(api === 'spawn' ? result.stdout : result).toBe(stdio === 'inherit' ? null : '');
        if (api === 'spawn') { expect(result.status).toBe(0); expect(result.error).toBeUndefined(); }
        expect(state.directories).toEqual([]);
    });

    it.each([['text', 'héllo\0world\n'], ['empty', ''], ['buffer', Buffer.from([0, 255, 128, 10])],
      ['typed array', new Uint8Array([1, 0, 2])]])(
      'delivers input through a private regular-file descriptor (%s)', (_label, input) => {
        let descriptor;
        state.inspect = (_api, options) => {
          expect(options).not.toHaveProperty('input');
          descriptor = options.stdio[0];
          expect(typeof descriptor).toBe('number');
          const stat = fstatSync(descriptor);
          expect(stat.isFile()).toBe(true);
          if (process.platform !== 'win32') expect(stat.mode & 0o777).toBe(0o600);
          const expected = Buffer.from(input);
          const bytes = Buffer.alloc(expected.length);
          readSync(descriptor, bytes, 0, bytes.length, 0);
          expect(bytes).toEqual(expected);
          expect(state.directories).toHaveLength(1);
        };
        const options = { input, stdio: ['inherit', 'pipe', 'ignore'] };
        const result = call(options);
        expect(api === 'spawn' ? result.stdout : result).toEqual(Buffer.from(input));
        expect(options.stdio).toEqual(['inherit', 'pipe', 'ignore']);
        expect(options.input).toBe(input);
        expect(state.closed).toContain(descriptor);
      },
    );

    it('removes the private input file and closes its descriptor after a synchronous throw', () => {
      let descriptor;
      state.inspect = (_api, options) => {
        descriptor = options.stdio[0];
        throw Object.assign(new Error('fixture spawn failure'), { code: 'EACCES' });
      };
      expect(() => call({ input: 'private' })).toThrow('fixture spawn failure');
      expect(state.directories).toHaveLength(1);
      expect(state.closed).toContain(descriptor);
    });
  });
}

it('cleans up input after a real timeout and keeps timeout result enrichment', () => {
  let descriptor;
  state.inspect = (_api, options) => { descriptor = options.stdio[0]; };
  const result = boundedSpawnSync(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], 'quick', {
    input: 'private', timeout: 150,
  });
  expect(result.error?.code).toBe('ETIMEDOUT');
  expect(result.error?.message).toContain("'quick' tier bound of 150ms");
  expect(result.signal).toBe('SIGKILL');
  expect(state.closed).toContain(descriptor);
});

it('filters Git-ignored discovery candidates despite unusable synchronous stdin pipes', () => {
  const root = mkdtempSync(join(tmpdir(), 'aiwg-discover-pipe-'));
  try {
    expect(boundedSpawnSync('git', ['init', '-q'], 'quick', { cwd: root }).status).toBe(0);
    writeFileSync(join(root, '.gitignore'), 'draft*\n');
    state.inspect = (_api, options) => {
      expect(typeof options.stdio[0]).toBe('number');
      expect(options).not.toHaveProperty('input');
    };
    expect(dropGitignored(root, ['draft notes.md', 'keep.md', 'draft\nnotes.md'])).toEqual(['keep.md']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('preserves spawn error results and cleans input when the executable is missing', () => {
  let descriptor;
  state.inspect = (_api, options) => { descriptor = options.stdio[0]; };
  const result = boundedSpawnSync('aiwg-missing-executable-4032', [], 'quick', { input: 'private' });
  expect(result.error?.code).toBe('ENOENT');
  expect(result.status).toBeNull();
  expect(result.signal).toBeNull();
  expect(state.closed).toContain(descriptor);
  state.inspect = undefined;
  const native = spawnSync('aiwg-missing-executable-4032', [], {
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 1000, killSignal: 'SIGKILL',
  });
  expect(result.stdout).toBe(native.stdout);
  expect(result.output).toEqual(native.output);
});

it('removes the private directory when writing input fails before spawn', () => {
  expect(() => boundedSpawnSync(process.execPath, [], 'quick', { input: {} })).toThrow(TypeError);
  expect(state.directories).toHaveLength(1);
});
