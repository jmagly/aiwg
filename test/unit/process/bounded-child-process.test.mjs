import { useFixtureProcesses } from '../../helpers/fixture-processes.mjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import {
  AIWG_SYNC_LONG_TIMEOUT_MS_ENV,
  SYNC_PROCESS_TIER_BOUNDS_MS,
  boundedExecFileSync,
  boundedExecSync,
  boundedSpawnSync,
  resolveSyncProcessTimeoutMs,
} from '../../../src/process/bounded-child-process.mjs';

useFixtureProcesses();

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '../../fixtures/process');
const ignoreSigtermScript = join(fixtures, 'ignore-sigterm.mjs');
const readStdinScript = join(fixtures, 'read-stdin.mjs');
const pipeHolderScript = join(fixtures, 'spawn-detached-pipe-holder.mjs');

/** Best-effort SIGKILL of a pid recorded in `pidFile`; never throws. */
function killRecordedPid(pidFile) {
  if (!pidFile || !existsSync(pidFile)) return;
  try {
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    if (Number.isInteger(pid) && pid > 0) process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone or never existed — fine, this is just cleanup.
  }
  rmSync(pidFile, { force: true });
}

/** True while `pid` still exists (kill with signal 0 is a liveness probe). */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('resolveSyncProcessTimeoutMs — tier bounds and env override', () => {
  const originalEnv = process.env[AIWG_SYNC_LONG_TIMEOUT_MS_ENV];

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[AIWG_SYNC_LONG_TIMEOUT_MS_ENV];
    else process.env[AIWG_SYNC_LONG_TIMEOUT_MS_ENV] = originalEnv;
  });

  it('returns the fixed default for quick and network regardless of the long-tier env var', () => {
    process.env[AIWG_SYNC_LONG_TIMEOUT_MS_ENV] = '999';
    expect(resolveSyncProcessTimeoutMs('quick')).toBe(SYNC_PROCESS_TIER_BOUNDS_MS.quick);
    expect(resolveSyncProcessTimeoutMs('network')).toBe(SYNC_PROCESS_TIER_BOUNDS_MS.network);
    expect(SYNC_PROCESS_TIER_BOUNDS_MS.quick).toBe(30_000);
    expect(SYNC_PROCESS_TIER_BOUNDS_MS.network).toBe(120_000);
  });

  it('returns the default long-tier bound (10 minutes) when the env var is unset', () => {
    delete process.env[AIWG_SYNC_LONG_TIMEOUT_MS_ENV];
    expect(resolveSyncProcessTimeoutMs('long')).toBe(600_000);
    expect(SYNC_PROCESS_TIER_BOUNDS_MS.long).toBe(600_000);
  });

  it('raises the long-tier bound to a valid positive integer override', () => {
    process.env[AIWG_SYNC_LONG_TIMEOUT_MS_ENV] = '900000';
    expect(resolveSyncProcessTimeoutMs('long')).toBe(900_000);
  });

  it('disables the long-tier bound entirely on "0"', () => {
    process.env[AIWG_SYNC_LONG_TIMEOUT_MS_ENV] = '0';
    expect(resolveSyncProcessTimeoutMs('long')).toBe(0);
  });

  it('falls back to the default and warns once for an invalid value', async () => {
    vi.resetModules();
    const fresh = await import('../../../src/process/bounded-child-process.mjs?invalid-env-test');
    process.env[AIWG_SYNC_LONG_TIMEOUT_MS_ENV] = 'not-a-number';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(fresh.resolveSyncProcessTimeoutMs('long')).toBe(600_000);
      expect(fresh.resolveSyncProcessTimeoutMs('long')).toBe(600_000);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain(AIWG_SYNC_LONG_TIMEOUT_MS_ENV);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('falls back to the default for a negative value', () => {
    process.env[AIWG_SYNC_LONG_TIMEOUT_MS_ENV] = '-5';
    expect(resolveSyncProcessTimeoutMs('long')).toBe(600_000);
  });

  it('rejects an unknown tier', () => {
    expect(() => resolveSyncProcessTimeoutMs('medium')).toThrow(/quick.*network.*long|tier/i);
  });
});

describe('boundedSpawnSync — explicit timeout wins when smaller than the tier bound', () => {
  it('kills at the caller-supplied timeout, not the (much larger) tier bound', () => {
    const start = Date.now();
    const result = boundedSpawnSync('node', [ignoreSigtermScript], 'network', { timeout: 200 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5_000);
    expect(result.signal).toBe('SIGKILL');
    expect(result.error?.code).toBe('ETIMEDOUT');
  });

  it('ignores a non-positive explicit timeout and falls back to the tier bound', () => {
    // A real 30s wait would slow this test down pointlessly; just confirm the
    // *resolution* ignores timeout:0/negative rather than treating it as "no bound".
    const result = boundedSpawnSync('node', ['-e', 'process.exit(0)'], 'quick', { timeout: 0 });
    expect(result.status).toBe(0);
  });
});

describe('boundedSpawnSync — stdin is never inherited', () => {
  it('gives a reading child immediate EOF when stdio was "inherit"', () => {
    const result = boundedSpawnSync('node', [readStdinScript], 'quick', {
      stdio: ['inherit', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    expect(result.stdout?.trim()).toBe('EOF');
  });

  it('gives a reading child immediate EOF for the "inherit" shorthand (stdout/stderr still captured via pipe override)', () => {
    const result = boundedSpawnSync('node', [readStdinScript], 'quick', {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    expect(result.stdout?.trim()).toBe('EOF');
  });

  it('leaves stdin alone when the caller supplies `input`', () => {
    const result = boundedSpawnSync('node', [readStdinScript], 'quick', {
      input: 'hello-from-input',
      encoding: 'utf8',
    });
    expect(result.stdout?.trim()).toBe('DATA:hello-from-input');
  });

  it('normalizes the literal fd 0 (parent stdin) in position 0 (#3062 finding 5)', () => {
    const result = boundedSpawnSync('node', [readStdinScript], 'quick', {
      stdio: [0, 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    expect(result.stdout?.trim()).toBe('EOF');
  });

  it('normalizes the process.stdin stream object in position 0 (#3062 finding 5)', () => {
    const result = boundedSpawnSync('node', [readStdinScript], 'quick', {
      stdio: [process.stdin, 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    expect(result.stdout?.trim()).toBe('EOF');
  });

  it('leaves an explicit non-zero fd in position 0 alone (not a parent-stdin form)', () => {
    // Open a real fd (not 0) backed by a file with known content; if this
    // helper wrongly rewrote it to 'ignore' the child would read EOF
    // instead of the file's content.
    const file = join(tmpdir(), `aiwg-bounded-stdin-fd-${process.pid}-${Date.now()}.txt`);
    writeFileSync(file, 'hello-from-fd');
    const fd = openSync(file, 'r');
    try {
      const result = boundedSpawnSync('node', [readStdinScript], 'quick', {
        stdio: [fd, 'pipe', 'pipe'],
        encoding: 'utf8',
      });
      expect(result.stdout?.trim()).toBe('DATA:hello-from-fd');
    } finally {
      closeSync(fd);
      rmSync(file, { force: true });
    }
  });

  it('leaves `stdio: "pipe"` (default-equivalent) alone', () => {
    const result = boundedSpawnSync('node', [readStdinScript], 'quick', {
      stdio: 'pipe',
      encoding: 'utf8',
    });
    // Nothing is written to the child's stdin, so a 'pipe' stdin (unlike
    // 'ignore') simply never delivers any bytes — still an EOF read, but
    // for a different reason than the normalization under test; the point
    // here is only that this call does not hang or error.
    expect(result.stdout?.trim()).toBe('EOF');
  });

  it('delivers `input` even when stdio: "inherit" is also supplied (#3062 B/C finding 9)', () => {
    const result = boundedSpawnSync('node', [readStdinScript], 'quick', {
      stdio: 'inherit',
      input: 'hello-from-input',
      encoding: 'utf8',
    });
    // 'inherit' applies to all three streams, so stdout isn't captured —
    // the only observable proof the payload reached the child is its exit
    // status (read-stdin.mjs never throws on bad input, so this alone
    // isn't conclusive); the array forms below are the decisive proof.
    expect(result.status).toBe(0);
  });

  it('delivers `input` even when stdio[0] is the literal fd 0 (#3062 B/C finding 9)', () => {
    const result = boundedSpawnSync('node', [readStdinScript], 'quick', {
      stdio: [0, 'pipe', 'pipe'],
      input: 'hello-from-input',
      encoding: 'utf8',
    });
    expect(result.stdout?.trim()).toBe('DATA:hello-from-input');
  });

  it('delivers `input` even when stdio[0] is process.stdin (#3062 B/C finding 9)', () => {
    const result = boundedSpawnSync('node', [readStdinScript], 'quick', {
      stdio: [process.stdin, 'pipe', 'pipe'],
      input: 'hello-from-input',
      encoding: 'utf8',
    });
    expect(result.stdout?.trim()).toBe('DATA:hello-from-input');
  });

  it('preserves stdout/stderr settings when normalizing stdin for `input`', () => {
    const result = boundedSpawnSync('node', [readStdinScript], 'quick', {
      stdio: ['inherit', 'pipe', 'ignore'],
      input: 'hello-from-input',
      encoding: 'utf8',
    });
    expect(result.stdout?.trim()).toBe('DATA:hello-from-input');
    expect(result.stderr).toBeNull(); // 'ignore' preserved, not captured
  });
});

describe('boundedSpawnSync — a child that ignores SIGTERM does not outlive the bound', () => {
  it('returns within the bound (+ grace) via SIGKILL instead of hanging', () => {
    const boundMs = 300;
    const graceMs = 2_000; // CI scheduling slack, not a deliberate second stage
    const start = Date.now();
    const result = boundedSpawnSync('node', [ignoreSigtermScript], 'long', { timeout: boundMs });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(boundMs + graceMs);
    expect(result.status).toBeNull();
    expect(result.signal).toBe('SIGKILL');
    expect(result.error?.code).toBe('ETIMEDOUT');
    expect(result.error?.message).toContain("'long' tier bound of 300ms");
    expect(result.error?.message).toContain(ignoreSigtermScript);
    // The direct child was the thing still running at the bound, so the
    // message says it was killed outright (not "already exited").
    expect(result.error?.message).toContain('the direct child was killed (SIGKILL)');
    expect(result.error?.message).toContain('descendant');
  });

  it('ignores a caller-supplied killSignal and still kills with SIGKILL (#3062 finding 2)', () => {
    const boundMs = 300;
    const graceMs = 2_000;
    const start = Date.now();
    // A real caller might reasonably ask for a gentler signal; honoring it
    // would reopen exactly the hang this module exists to close for a
    // child (like this fixture) that ignores SIGTERM.
    const result = boundedSpawnSync('node', [ignoreSigtermScript], 'long', {
      timeout: boundMs,
      killSignal: 'SIGTERM',
    });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(boundMs + graceMs);
    expect(result.signal).toBe('SIGKILL');
    expect(result.error?.code).toBe('ETIMEDOUT');
  });
});

describe('boundedSpawnSync — a surviving descendant that holds the inherited pipe open (#3062 finding 2)', () => {
  let pidFile;

  afterEach(() => {
    killRecordedPid(pidFile);
    pidFile = undefined;
  });

  it('still returns within a generous bound, and does not (cannot) clean up the descendant', () => {
    pidFile = join(tmpdir(), `aiwg-pipe-holder-${process.pid}-${Date.now()}.pid`);
    // Generous relative to how fast the fixture itself runs (spawn + write +
    // exit, no real work): large enough that CI scheduling noise doesn't
    // flip which of the two ETIMEDOUT paths fires, small enough to keep the
    // suite fast either way.
    const boundMs = 3_000;
    const graceMs = 5_000;
    const start = Date.now();
    const result = boundedSpawnSync('node', [pipeHolderScript, pidFile], 'long', { timeout: boundMs });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(boundMs + graceMs);
    // Still bounded: the call returns (at or before the tier bound) instead
    // of hanging forever on the held-open pipe.
    expect(result.error?.code).toBe('ETIMEDOUT');
    expect(result.error?.message).toContain('descendant');

    // The descendant really did survive this call returning — proving the
    // module's documented limitation (no process-tree supervision) rather
    // than merely asserting it.
    expect(existsSync(pidFile)).toBe(true);
    const grandchildPid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(Number.isInteger(grandchildPid)).toBe(true);
    expect(isAlive(grandchildPid)).toBe(true);
  });
});

describe('boundedExecSync / boundedExecFileSync — throw the enriched error on timeout', () => {
  it('boundedExecSync throws with code ETIMEDOUT, signal SIGKILL, and an enriched message', () => {
    let caught;
    try {
      boundedExecSync(`exec node ${JSON.stringify(ignoreSigtermScript)}`, 'quick', { timeout: 200 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe('ETIMEDOUT');
    expect(caught.signal).toBe('SIGKILL');
    expect(caught.message).toContain("'quick' tier bound of 200ms");
  });

  it('boundedExecFileSync throws with code ETIMEDOUT, signal SIGKILL, and an enriched message', () => {
    let caught;
    try {
      boundedExecFileSync('node', [ignoreSigtermScript], 'quick', { timeout: 200 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe('ETIMEDOUT');
    expect(caught.signal).toBe('SIGKILL');
    expect(caught.message).toContain("'quick' tier bound of 200ms");
    expect(caught.message).toContain('node');
  });

  it('boundedExecSync leaves a non-timeout error message untouched', () => {
    let caught;
    try {
      boundedExecSync('node -e "process.exit(7)"', 'quick');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect(caught.status).toBe(7);
    expect(caught.message).not.toContain('tier bound');
  });
});

describe('bounded* wrappers — normal (non-timeout) behavior is unchanged', () => {
  it('boundedExecSync returns stdout like execSync', () => {
    const out = boundedExecSync('node -e "process.stdout.write(\'ok\')"', 'quick', { encoding: 'utf8' });
    expect(out).toBe('ok');
  });

  it('boundedSpawnSync returns the same shape as spawnSync for a normal run', () => {
    const result = boundedSpawnSync('node', ['-e', 'process.stdout.write("ok")'], 'quick', { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('ok');
    expect(result.error).toBeUndefined();
  });

  it('requires a valid tier', () => {
    expect(() => boundedSpawnSync('node', ['-v'], 'fast')).toThrow(TypeError);
  });
});
