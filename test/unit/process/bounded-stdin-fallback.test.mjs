// Without writable temp storage, synchronous input fails fast instead of using Node's pipe (#4032).
import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boundedExecFileSync, boundedSpawnSync } from '../../../src/process/bounded-child-process.mjs';
import { dropGitignored } from '../../../src/config/gitignore.js';

function withUnwritableTemp(run) {
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = join(tmpdir(), `aiwg-missing-${process.pid}`, 'not-created');
  try { return run(); } finally {
    if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
  }
}

describe('sync stdin without writable temp storage', () => {
  it('returns an error from boundedSpawnSync without starting the child or throwing', () => {
    const started = Date.now();
    const result = withUnwritableTemp(() => boundedSpawnSync(process.execPath,
      ['-e', 'setTimeout(() => {}, 60000)'], 'quick', { input: 'piped', encoding: 'utf8' }));
    expect(result.error).toBeInstanceOf(Error);
    expect(result.status).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('throws from boundedExecFileSync, as a failed native exec does', () => {
    expect(() => withUnwritableTemp(() => boundedExecFileSync(process.execPath,
      ['-e', 'process.stdin.pipe(process.stdout)'], 'quick', { input: 'piped', encoding: 'utf8' }))).toThrow();
  });

  it('keeps discover-path git filtering fast: files are kept when git cannot be asked', () => {
    const files = ['README.md', 'docs/a.md'];
    const started = Date.now();
    expect(withUnwritableTemp(() => dropGitignored(process.cwd(), files))).toEqual(files);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
