// Without writable temp storage, synchronous input falls back to Node's pipe instead of throwing (#4032).
import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boundedSpawnSync } from '../../../src/process/bounded-child-process.mjs';

describe('sync stdin without writable temp storage', () => {
  it('falls back to the native input pipe instead of throwing', () => {
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = join(tmpdir(), `aiwg-missing-${process.pid}`, 'not-created');
    try {
      const result = boundedSpawnSync(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], 'quick', { input: 'piped', encoding: 'utf8' });
      expect(result.error).toBeUndefined();
      expect(result.stdout).toBe('piped');
    } finally {
      if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
    }
  });
});
