import { useFixtureProcesses } from '../../helpers/fixture-processes.mjs';
/**
 * Regression test for #3062 finding 17: a `long`-tier bounded-helper
 * timeout must not be silently lost by EvalHarness's default command
 * runner. Before the fix, the catch block only captured `err.stdout` /
 * `err.stderr` — never `err.message`, which is the only place the bounded
 * helper's enriched explanation (naming the tier, the bound, and the
 * AIWG_SYNC_LONG_TIMEOUT_MS override) lives.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EvalHarness } from '../../../tools/ralph-external/eval-harness.mjs';
import { AIWG_SYNC_LONG_TIMEOUT_MS_ENV } from '../../../src/process/bounded-child-process.mjs';

useFixtureProcesses();

const here = dirname(fileURLToPath(import.meta.url));
const ignoreSigtermScript = join(here, '../../fixtures/process/ignore-sigterm.mjs');
const pipeHolderScript = join(here, '../../fixtures/process/spawn-detached-pipe-holder.mjs');

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

describe('EvalHarness default runner — long-tier timeout diagnostics (#3062 finding 17)', () => {
  const originalEnv = process.env[AIWG_SYNC_LONG_TIMEOUT_MS_ENV];
  let iterationDir;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[AIWG_SYNC_LONG_TIMEOUT_MS_ENV];
    else process.env[AIWG_SYNC_LONG_TIMEOUT_MS_ENV] = originalEnv;
    if (iterationDir) rmSync(iterationDir, { recursive: true, force: true });
    iterationDir = undefined;
  });

  it('surfaces the enriched timeout message in the private diagnostics instead of dropping it', () => {
    // Lower the (otherwise fixed 10-minute) long-tier bound so the lint
    // instrument — a child that ignores SIGTERM — times out quickly.
    process.env[AIWG_SYNC_LONG_TIMEOUT_MS_ENV] = '300';
    iterationDir = mkdtempSync(join(tmpdir(), 'aiwg-eval-harness-timeout-'));

    const harness = new EvalHarness({
      lint: { command: `exec node ${JSON.stringify(ignoreSigtermScript)}`, void_on_violation: false },
    });
    harness.run({ iterationDir });

    const privateDiagnostics = JSON.parse(readFileSync(join(iterationDir, 'eval-harness-private.json'), 'utf8'));
    const lintText = privateDiagnostics.instruments.lint?.raw_text ?? '';

    expect(lintText).toContain("'long' tier bound of 300ms");
    expect(lintText).toContain(AIWG_SYNC_LONG_TIMEOUT_MS_ENV);
  });

  it('forces a nonzero code even when the timed-out helper call reports status 0 (#3062 B/C finding 13)', () => {
    // A surviving, pipe-holding descendant can produce ETIMEDOUT with
    // err.status === 0 (the direct child itself exited successfully) —
    // `?? 1` only replaces null/undefined, so a naive `err.status ?? 1`
    // would read this timed-out run as a clean exit.
    process.env[AIWG_SYNC_LONG_TIMEOUT_MS_ENV] = '1500';
    iterationDir = mkdtempSync(join(tmpdir(), 'aiwg-eval-harness-timeout-status0-'));
    const pidFile = join(tmpdir(), `aiwg-eval-harness-pipe-holder-${process.pid}-${Date.now()}.pid`);

    try {
      const harness = new EvalHarness({
        lint: {
          command: `node ${JSON.stringify(pipeHolderScript)} ${JSON.stringify(pidFile)}`,
          void_on_violation: false,
        },
      });
      harness.run({ iterationDir });

      const privateDiagnostics = JSON.parse(readFileSync(join(iterationDir, 'eval-harness-private.json'), 'utf8'));
      const lintInstrument = privateDiagnostics.instruments.lint;

      expect(lintInstrument.code).not.toBe(0);
      expect(lintInstrument.raw_text ?? '').toContain('descendant');
    } finally {
      killRecordedPid(pidFile);
    }
  });
});
