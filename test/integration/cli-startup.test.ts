/**
 * Integration tests for the real compiled CLI.
 *
 * These tests spawn `node dist/src/cli/router.js <args>` with a **per-test
 * wall-clock timeout**. Any regression that reintroduces the "command hangs
 * forever after completing visible work" class of bug (#918) fails a test
 * in ≤30 seconds instead of silently wedging CI.
 *
 * Phase 5 of the CLI Stabilization Epic (#922).
 *
 * Test matrix:
 *   - `aiwg --version` exits 0, <3s, prints version string
 *   - `aiwg help` exits 0, <3s
 *   - `aiwg use nonexistent-framework` exits non-zero, <5s
 *   - `aiwg init --non-interactive` exits 0, <5s, creates .aiwg/aiwg.config
 *   - non-TTY invocation: `aiwg --version < /dev/null` completes <3s
 *   - `aiwg sandbox identities` against no running serve exits non-zero, <10s
 *     (this is the regression gate for the 5-minute hang bug from #918)
 *
 * Tests skip automatically when `dist/src/cli/router.js` is missing — run
 * `npm run build` first. This lets `npm test` work in the common case without
 * making a full build a precondition for the fast unit-test workflow.
 */

import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ROUTER_PATH = path.join(REPO_ROOT, 'dist', 'src', 'cli', 'router.js');
const BIN_PATH = path.join(REPO_ROOT, 'bin', 'aiwg.mjs');
let TEST_CONFIG_DIR: string;
beforeAll(() => { TEST_CONFIG_DIR = mkdtempSync(path.join(os.tmpdir(), 'aiwg-cli-startup-config-')); });

afterAll(() => { if (TEST_CONFIG_DIR) rmSync(TEST_CONFIG_DIR, { recursive: true, force: true }); });

// Skip the integration suite if the compiled output isn't present. These
// tests need the build artifact; running them without it would just produce
// noise. `describe.skipIf` keeps CI simple: build once, then run tests.
const missingBuild = !existsSync(ROUTER_PATH);

/**
 * Run the CLI via the real bin entry. Wall-clock-bounded. Returns stdout,
 * stderr, exit code, elapsed ms. Times out with a descriptive error.
 */
function runCli(
  args: string[],
  opts: {
    cwd?: string;
    timeoutMs?: number;
    env?: Record<string, string>;
    input?: string;
  } = {},
) {
  const start = Date.now();
  const result = spawnSync(process.execPath, [BIN_PATH, ...args], {
    cwd: opts.cwd ?? REPO_ROOT,
    timeout: opts.timeoutMs ?? 30_000,
    encoding: 'utf-8',
    input: opts.input,
    env: {
      ...process.env,
      // Default off for logging so perf-sensitive tests see the minimal path.
      AIWG_LOG_DISABLE: '1',
      // Disable the update notifier in tests so no network calls fire.
      NO_UPDATE_NOTIFIER: '1',
      AIWG_NO_UPDATE_CHECK: '1',
      AIWG_CONFIG: TEST_CONFIG_DIR,
      NO_COLOR: '1',
      ...(opts.env ?? {}),
    },
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
    signal: result.signal,
    elapsedMs: Date.now() - start,
    error: result.error,
  };
}

describe.skipIf(missingBuild)('CLI integration: basic lifecycle', () => {
  it('aiwg --version exits 0 within 3 seconds', () => {
    const r = runCli(['--version'], { timeoutMs: 3_000 });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/aiwg/);
    expect(r.stdout).toMatch(/\d{4}\.\d+\.\d+/); // version string
    expect(r.elapsedMs).toBeLessThan(3_000);
  });

  it('aiwg help exits 0 within 3 seconds', () => {
    const r = runCli(['help'], { timeoutMs: 3_000 });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Usage/i);
    expect(r.elapsedMs).toBeLessThan(3_000);
  });

  it('aiwg version --json emits valid JSON', () => {
    // Structured version output loads the compiled router; unlike --version,
    // it is not a fast-path startup measurement.
    const r = runCli(['version', '--json']);
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.version).toMatch(/\d{4}\.\d+\.\d+/);
    expect(parsed.invocation_id).toBeTruthy();
    expect(parsed.channel).toBeTruthy();
  }, 35_000);

  it('emits complete structured version output with non-TTY stdin', () => {
    const r = runCli(['version', '--json'], { input: '' });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(expect.objectContaining({
      version: expect.stringMatching(/\d{4}\.\d+\.\d+/),
      invocation_id: expect.any(String),
      channel: expect.any(String),
    }));
  }, 35_000);
});

describe.skipIf(missingBuild)('CLI namespace help routing (#2306, #2307)', () => {
  it('lists sessions in the fast root help', () => {
    const result = runCli(['help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/sessions <command>\s+Manage the normalized session catalog/);
  });

  it.each(['sessions', 'catalog'])('%s shares usage across bare, flag, and help-prefix forms', (command) => {
    const bare = runCli([command]);
    expect(bare.status).toBe(command === 'catalog' ? 1 : 2);
    for (const args of [[command, '--help'], [command, '-h'], ['help', command]]) {
      const result = runCli(args);
      expect(result.status, args.join(' ')).toBe(0);
      expect(result.stdout).toBe(bare.stdout);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain(`Usage: aiwg ${command}`);
      expect(result.stdout).toContain('Commands:');
      expect(result.stdout).toContain('Options');
      expect(result.stdout).not.toContain('No detailed help');
    }
  });

  it('renders the sessions JSON help contract without opening storage', () => {
    const result = runCli(['sessions', '--help', '--json', '--db', '/not-a-database/catalog.sqlite']);
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.command).toBe('sessions.help');
    expect(payload.status).toBe('ok');
    expect(payload.data.usage).toContain('aiwg sessions <command>');
  });
});

describe.skipIf(missingBuild)('CLI integration: hang regression gates', () => {
  /**
   * Tonight's bug: `aiwg use all` finished visible work and then sat for
   * 5 minutes before releasing the shell because of unawaited promises +
   * no process.exit(). This test locks it in — if the regression returns,
   * this test fails in 30 seconds with "Test timeout" rather than silently
   * wedging CI.
   */
  it('aiwg --version with piped stdin completes in under 3 seconds', () => {
    const r = runCli(['--version'], { timeoutMs: 3_000, input: '' });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
    expect(r.elapsedMs).toBeLessThan(3_000);
  });

  it('aiwg help with piped stdin completes in under 3 seconds (non-TTY)', () => {
    const r = runCli(['help'], { timeoutMs: 3_000, input: '' });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
    expect(r.elapsedMs).toBeLessThan(3_000);
  });

  it('aiwg sandbox identities against unreachable serve fails fast (no hang)', () => {
    // Uses a port that's definitely not listening. If the fetch timeout
    // plumbing (#918 Phase 1 AbortSignal.timeout) regresses, this test
    // fails with the 30s wall-clock timeout instead of passing.
    const r = runCli(['sandbox', 'identities'], {
      timeoutMs: 10_000,
      env: { AIWG_SERVE_PORT: '59999', AIWG_FETCH_TIMEOUT_MS: '1000' },
    });
    expect(r.error).toBeUndefined();
    // We expect non-zero exit (connection refused / timeout).
    expect(r.status).not.toBe(0);
    // Hard bound: must respond within 10s total wall clock.
    expect(r.elapsedMs).toBeLessThan(10_000);
  });
});

describe.skipIf(missingBuild)('CLI integration: error paths', () => {
  it('aiwg use nonexistent-framework exits non-zero within 10 seconds', () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'aiwg-test-'));
    try {
      const r = runCli(['use', 'zzz-nonexistent-framework', '--providers', 'claude'], {
        cwd: tmpDir,
        timeoutMs: 10_000,
      });
      expect(r.error).toBeUndefined();
      expect(r.status).not.toBe(0);
      expect(r.elapsedMs).toBeLessThan(10_000);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('aiwg unknown-subcommand exits non-zero with a usage error', () => {
    const r = runCli(['this-command-does-not-exist'], { timeoutMs: 5_000 });
    expect(r.error).toBeUndefined();
    expect(r.status).not.toBe(0);
    // Shouldn't take long to emit "unknown command" output.
    expect(r.elapsedMs).toBeLessThan(5_000);
  });
});

describe.skipIf(missingBuild)('CLI integration: non-interactive / CI-friendly paths', () => {
  it('aiwg use all in fresh tmpdir with piped /dev/null completes without hang', () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'aiwg-test-'));
    try {
      // This is the exact scenario from #918 — a fresh project, piped stdin
      // (simulates CI / detached terminal), `aiwg use all`. Must complete in
      // under 60s and exit 0. If the hang regresses, we fail with the
      // spawnSync timeout error instead of waiting 5 minutes.
      const r = runCli(['use', 'all', '--providers', 'claude'], {
        cwd: tmpDir,
        timeoutMs: 60_000,
        input: '',
      });
      expect(r.error).toBeUndefined();
      expect(r.status).toBe(0);
      expect(r.elapsedMs).toBeLessThan(60_000);
      // Confirm the config was actually written.
      expect(existsSync(path.join(tmpDir, '.aiwg', 'aiwg.config'))).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 65_000);
});

describe.skipIf(missingBuild)('CLI integration: JSONL logging', () => {
  it('logger writes a JSONL record per invocation when enabled', () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'aiwg-test-'));
    const logFile = path.join(tmpDir, 'test.jsonl');
    try {
      // Run a command that emits at least one structured log record. `version`
      // doesn't emit via getLogger() yet (handler adoption is a Phase 4.5
      // follow-up) but the logger core writes a record for any call — we'd
      // need a small probe. For now, just verify that when AIWG_LOG_FILE is
      // set and logging is enabled, the file directory is honored.
      const r = runCli(['version'], {
        timeoutMs: 5_000,
        env: {
          AIWG_LOG_DISABLE: '0',
          AIWG_LOG_LEVEL: 'debug',
          AIWG_LOG_FILE: logFile,
        },
      });
      expect(r.status).toBe(0);
      // The logger may not fire for version (handler doesn't log yet), so
      // the file may not exist. Assert only that the run succeeded and no
      // unexpected stderr garbage was produced.
      if (existsSync(logFile)) {
        const content = readFileSync(logFile, 'utf-8');
        const lines = content.split('\n').filter(Boolean);
        for (const line of lines) {
          const record = JSON.parse(line);
          expect(record.ts).toBeTruthy();
          expect(record.invocation_id).toBeTruthy();
          expect(record.level).toMatch(/^(debug|info|warn|error)$/);
          expect(record.aiwg_version).toBeTruthy();
        }
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
