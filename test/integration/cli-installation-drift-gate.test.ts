/**
 * Launcher-level coverage for the installation identity gate (#2559).
 *
 * `assertCanonicalInstallation` has unit coverage, but the gate lives in
 * bin/aiwg.mjs before any handler is dispatched. These tests spawn the real
 * launcher against a temporary user-config directory whose installation.json
 * disagrees with the executing checkout, in both mismatch directions, and
 * verify that read-only recovery commands still return evidence while a
 * representative mutation stays fail-closed.
 *
 * @source bin/aiwg.mjs
 * @source src/installation/manager.mjs
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const BIN = path.join(REPO_ROOT, 'bin', 'aiwg.mjs');
const temporary: string[] = [];

function tempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aiwg-${label}-`));
  temporary.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function runCli(args: string[], configDir: string, cwd = REPO_ROOT) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, AIWG_CONFIG: configDir, AIWG_ARTIFACTS_PATH: path.join(configDir, 'artifacts'),
      NO_UPDATE_NOTIFIER: '1', AIWG_TELEMETRY_DISABLED: '1' },
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', exitCode: result.status ?? 1 };
}

function writeIdentity(configDir: string, identity: Record<string, unknown>): void {
  fs.writeFileSync(path.join(configDir, 'installation.json'), JSON.stringify({
    schemaVersion: 1,
    runMode: 'normal',
    channel: 'stable',
    edgePath: null,
    checkOnStartup: false,
    lastUpdateCheck: null,
    updateCheckInterval: 86_400_000,
    recordedAt: '2026-09-14T00:00:00.000Z',
    ...identity,
  }, null, 2));
}

/** The executing checkout is a git source tree, but the record claims npm-global. */
function npmRecordedSourceActual(): string {
  const configDir = tempDir('drift-npm-to-source');
  writeIdentity(configDir, {
    method: 'npm',
    root: REPO_ROOT,
    updateStrategy: 'npm-global',
    managerExecutable: process.execPath,
  });
  return configDir;
}

/** The record claims a source checkout elsewhere; the executing root is this one. */
function sourceRecordedElsewhere(): string {
  const configDir = tempDir('drift-source-to-npm');
  const otherCheckout = tempDir('drift-other-checkout');
  fs.mkdirSync(path.join(otherCheckout, '.git'));
  fs.writeFileSync(path.join(otherCheckout, 'package.json'), JSON.stringify({ name: 'aiwg', version: '0.0.0' }));
  writeIdentity(configDir, {
    method: 'source',
    root: otherCheckout,
    updateStrategy: 'source-git',
    managerExecutable: process.execPath,
  });
  return configDir;
}

const DRIFT_WARNING = 'installation identity drift detected';
// Each case spawns the full launcher; under a loaded runner that exceeds vitest's 5s default.
const CLI_TEST_TIMEOUT = 90_000;

describe('installation drift gate (#2559)', () => {
  it('keeps public reporting entrypoints read-only on a fresh home while ordinary changes initialize state', { timeout: CLI_TEST_TIMEOUT }, () => {
    const root = tempDir('public-report-readonly');
    const project = path.join(root, 'project');
    fs.mkdirSync(project);
    const commands = [
      ['doctor', '--decision-offload', '--json'],
      ['steward', 'decision-offload', '--json'],
      ['rules', 'inventory', '--json'],
      ['rules', 'list', '--json'],
    ];
    for (const [index, args] of commands.entries()) {
      const user = path.join(root, `user-${index}`);
      const env = { ...process.env, HOME: path.join(user, 'home'), XDG_CONFIG_HOME: path.join(user, 'xdg'),
        AIWG_CONFIG: path.join(user, 'config'), AIWG_USER_REGISTRY_PATH: path.join(user, 'registry.json'),
        NO_UPDATE_NOTIFIER: '1', AIWG_NO_UPDATE_CHECK: '1', AIWG_TELEMETRY_DISABLED: '1' };
      delete env.AIWG_ROOT;
      delete env.AIWG_DECISION_JEV_API_KEY;
      delete env.JEV_API_KEY;
      const result = spawnSync(process.execPath, [BIN, ...args], { cwd: project, env, encoding: 'utf8', timeout: 30_000 });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
      expect(fs.existsSync(user) ? fs.readdirSync(user, { recursive: true }) : []).toEqual([]);
      expect(fs.readdirSync(project)).toEqual([]);
    }
    const user = path.join(root, 'mutating-user');
    const env = { ...process.env, HOME: path.join(user, 'home'), XDG_CONFIG_HOME: path.join(user, 'xdg'),
      AIWG_CONFIG: path.join(user, 'config'), NO_UPDATE_NOTIFIER: '1', AIWG_TELEMETRY_DISABLED: '1' };
    delete env.AIWG_ROOT;
    const result = spawnSync(process.execPath, [BIN, 'config', 'set', '--project', 'parallelism.worker_dispatch', 'false'],
      { cwd: project, env, encoding: 'utf8', timeout: 30_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(path.join(user, 'config', 'installation.json'))).toBe(true);
    expect(fs.existsSync(path.join(project, '.aiwg', 'aiwg.config'))).toBe(true);
  });

  describe.each([
    ['npm recorded, source executing', npmRecordedSourceActual, 'actual method source differs from canonical method npm'],
    ['source recorded elsewhere, this checkout executing', sourceRecordedElsewhere, 'differs from canonical root'],
  ])('%s', (_label, makeConfig, expectedReason) => {
    it('allows the scoped reports through drift without modifying installation identity', { timeout: CLI_TEST_TIMEOUT }, () => {
      const configDir = makeConfig();
      const identity = fs.readFileSync(path.join(configDir, 'installation.json'));
      for (const args of [['doctor', '--decision-offload', '--json'], ['steward', 'decision-offload', '--json'], ['rules', 'inventory', '--json']]) {
        const result = runCli(args, configDir);
        expect(result.stderr).toContain(DRIFT_WARNING);
        expect(result.stderr).not.toContain('update and refresh are blocked');
        // An absent registered source can still make the report itself fail;
        // the recovery gate must let it run without rewriting the identity.
        if (_label === 'npm recorded, source executing') expect(result.exitCode, result.stderr).toBe(0);
        if (result.exitCode === 0) expect(() => JSON.parse(result.stdout)).not.toThrow();
        expect(fs.readFileSync(path.join(configDir, 'installation.json'))).toEqual(identity);
      }
    });
    it('keeps aiwg version reachable and names the drift', { timeout: CLI_TEST_TIMEOUT }, () => {
      const result = runCli(['version'], makeConfig());
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain(DRIFT_WARNING);
      expect(result.stderr).toContain(expectedReason);
      expect(result.stdout).toContain('aiwg');
      expect(result.stdout).toMatch(/installation identity|canonical install declares/);
    });

    it('keeps aiwg version --json reachable with the inspected state', { timeout: CLI_TEST_TIMEOUT }, () => {
      const result = runCli(['version', '--json'], makeConfig());
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(['mismatch', 'stale']).toContain(parsed.installation.state);
      expect(parsed.installation.drift.join(' ')).toContain(expectedReason);
    });

    it('keeps aiwg status --probe --json reachable and reports the identity', { timeout: CLI_TEST_TIMEOUT }, () => {
      const result = runCli(['status', '--probe', '--json'], makeConfig());
      expect(result.stderr).toContain(DRIFT_WARNING);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.schema).toBe('aiwg.status.probe.v1');
      expect(parsed.installation.mutations_blocked).toBe(true);
      expect(parsed.installation.drift.join(' ')).toContain(expectedReason);
    });

    it('keeps aiwg runtime-info reachable', { timeout: CLI_TEST_TIMEOUT }, () => {
      const result = runCli(['runtime-info'], makeConfig());
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain(DRIFT_WARNING);
      expect(result.stdout).toContain('Runtime Environment Summary');
    });

    it('blocks a representative mutation with AIWG_INSTALLATION_DRIFT semantics', { timeout: CLI_TEST_TIMEOUT }, () => {
      const result = runCli(['use', 'all', '--dry-run'], makeConfig());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('update and refresh are blocked');
      expect(result.stderr).toContain(expectedReason);
      expect(result.stderr).not.toContain('is read-only and continues');
    });
  });

  it('keeps the documented local-backend discovery fallback working, flag-first', { timeout: CLI_TEST_TIMEOUT }, () => {
    const result = runCli(
      ['discover', '--backend', 'local', 'steward repair AIWG setup', '--type', 'skill', '--limit', '1', '--json'],
      npmRecordedSourceActual(),
    );
    expect(result.stderr).toContain(DRIFT_WARNING);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.query.phrase).toBe('steward repair AIWG setup');
    expect(parsed.query.backend).toBe('local');
  });

  it('keeps index inspection reachable but treats index build as a mutation', { timeout: CLI_TEST_TIMEOUT }, () => {
    const configDir = npmRecordedSourceActual();
    const stats = runCli(['index', 'stats', '--json'], configDir);
    expect(stats.stderr).toContain(DRIFT_WARNING);
    // The gate lets the command run; whether an index exists in this checkout
    // (it does not on a fresh CI runner) is the command's own concern.
    expect(stats.stderr).not.toContain('update and refresh are blocked');

    const build = runCli(['index', 'build', '--dry-run'], configDir);
    expect(build.exitCode).toBe(1);
    expect(build.stderr).toContain('update and refresh are blocked');
  });

  it('does not warn when the recorded identity matches the executing checkout', { timeout: CLI_TEST_TIMEOUT }, () => {
    const configDir = tempDir('aligned');
    writeIdentity(configDir, {
      method: 'source',
      root: REPO_ROOT,
      updateStrategy: 'source-git',
      managerExecutable: process.execPath,
    });
    const result = runCli(['version'], configDir);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain(DRIFT_WARNING);
  });
});
