import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LIVE_GATE,
  checkContract,
  findMuseCli,
  findForbiddenWrites,
  runLiveSmoke,
} from '../../../tools/providers/muse-live-smoke.mjs';

const script = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../tools/providers/muse-live-smoke.mjs',
);

const noSpawn = () => {
  throw new Error('must not spawn a child process');
};
const cliAbsent = () => ({ found: false, version: null });
const cliPresent = () => ({ found: true, version: 'muse 0.0.0-test' });

describe('muse opt-in live smoke (#237)', () => {
  it('publishes an evidence-gated contract with muse-only roots', () => {
    const contract = checkContract({});
    expect(contract.live).toBe(false);
    expect(contract.normalCiCostUsd).toBe(0);
    expect(contract.requiredGate).toBe(`${LIVE_GATE}=1`);
    expect(contract.requiresCli).toContain('muse');
    expect(contract.skillRoots.project).toBe('<target>/.agents/skills');
    expect(contract.skillRoots.user).toBe('$XDG_CONFIG_HOME/muse/skills');
    expect(contract.modes).toEqual(
      expect.arrayContaining(['dry-run-deploy', 'deploy', 'doctor', 'status']),
    );
    for (const forbidden of ['.cursor/', '~/.muse', '~/.agents/skills']) {
      expect(contract.neverWrites).toContain(forbidden);
    }
  });

  it('stays not-ready without the gate and never spawns', () => {
    const report = runLiveSmoke({}, {}, { probeCli: cliAbsent, runAiwg: noSpawn });
    expect(report.status).toBe('not-ready');
    expect(report.reason).toContain(LIVE_GATE);
    expect(report.checks.optedIn).toBe(false);
  });

  it('stays not-ready when the gate is set but the muse CLI is absent', () => {
    const report = runLiveSmoke(
      {},
      { [LIVE_GATE]: '1' },
      { probeCli: cliAbsent, runAiwg: noSpawn },
    );
    expect(report.status).toBe('not-ready');
    expect(report.reason).toBe('MUSE_CLI_ABSENT');
    expect(report.checks.optedIn).toBe(true);
    expect(report.checks.cliPresent).toBe(false);
  });

  it('--check verifies prerequisites without spawning aiwg', () => {
    const ready = runLiveSmoke(
      { check: true },
      { [LIVE_GATE]: '1' },
      { probeCli: cliPresent, runAiwg: noSpawn },
    );
    expect(ready.mode).toBe('check');
    expect(ready.status).toBe('ready');
    expect(ready.reason).toBe('PREREQUISITES_VERIFIED_NO_MODEL_CALLS');

    const missing = runLiveSmoke({ check: true }, {}, { probeCli: cliAbsent, runAiwg: noSpawn });
    expect(missing.status).toBe('not-ready');
    expect(missing.reason).toBe('PREREQUISITES_MISSING');
  });

  it('findMuseCli treats ENOENT as absent and captures the version string', () => {
    expect(findMuseCli({}, () => {
      const error = new Error('spawn muse ENOENT');
      error.code = 'ENOENT';
      return { error, stdout: '', stderr: '' };
    })).toEqual({ found: false, version: null });

    expect(findMuseCli({}, () => ({ status: 0, stdout: 'muse 1.2.3\n', stderr: '' })))
      .toEqual({ found: true, version: 'muse 1.2.3' });

    // An unrelated `muse` binary that rejects --version is not Muse Code.
    expect(findMuseCli({}, () => ({ status: 2, stdout: '', stderr: 'unknown flag' })))
      .toEqual({ found: false, version: null });
  });

  it('findForbiddenWrites flags .cursor trees, invented homes, and XDG siblings', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'aiwg-muse-smoke-test-'));
    try {
      const home = join(sandbox, 'home');
      const xdg = join(sandbox, 'xdg');
      mkdirSync(join(sandbox, 'project', '.cursor'), { recursive: true });
      mkdirSync(join(home, '.muse'), { recursive: true });
      mkdirSync(join(home, '.agents'), { recursive: true });
      mkdirSync(join(xdg, 'muse', 'settings'), { recursive: true });
      const violations = findForbiddenWrites(sandbox, { home, xdgConfig: xdg });
      expect(violations.some((v) => v.includes('.cursor'))).toBe(true);
      expect(violations.some((v) => v.includes('~/.muse'))).toBe(true);
      expect(violations.some((v) => v.includes('~/.agents'))).toBe(true);
      expect(violations.some((v) => v.includes('settings'))).toBe(true);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('findForbiddenWrites accepts the verified roots only', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'aiwg-muse-smoke-test-'));
    try {
      const home = join(sandbox, 'home');
      const xdg = join(sandbox, 'xdg');
      mkdirSync(join(sandbox, 'project', '.agents', 'skills'), { recursive: true });
      mkdirSync(join(xdg, 'muse', 'skills'), { recursive: true });
      expect(findForbiddenWrites(sandbox, { home, xdgConfig: xdg })).toEqual([]);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('fails fast when dry-run fails, before any deploy', () => {
    let calls = 0;
    const report = runLiveSmoke(
      {},
      { [LIVE_GATE]: '1' },
      {
        probeCli: cliPresent,
        runAiwg: () => {
          calls += 1;
          return { status: 1, stdout: 'boom', stderr: '' };
        },
      },
    );
    expect(report.status).toBe('failed');
    expect(report.reason).toBe('DRY_RUN_FAILED');
    expect(calls).toBe(1);
  });

  it('passes the full path with a stubbed aiwg and cleans up the sandbox', () => {
    let project;
    const report = runLiveSmoke(
      {},
      { [LIVE_GATE]: '1' },
      {
        probeCli: cliPresent,
        runAiwg: (args, cwd, env) => {
          project = cwd;
          if (!args.includes('--dry-run')) {
            if (args.includes('--scope')) {
              mkdirSync(join(env.XDG_CONFIG_HOME, 'muse', 'skills'), { recursive: true });
            } else {
              mkdirSync(join(cwd, '.agents', 'skills'), { recursive: true });
            }
          }
          return { status: 0, stdout: 'deployed to .agents/skills', stderr: '' };
        },
      },
    );
    expect(report.status).toBe('passed');
    expect(report.reason).toBe('LIVE_CHECKS_PASSED');
    expect(report.checks.dryRun).toBe(true);
    expect(report.checks.deploy).toBe(true);
    expect(report.checks.userDryRun).toBe(true);
    expect(report.checks.userDeploy).toBe(true);
    expect(report.checks.doctor).toBe(true);
    expect(report.checks.status).toBe(true);
    expect(report.checks.forbiddenWrites).toEqual([]);
    expect(report.checks.cliVersion).toBe('muse 0.0.0-test');
    expect(existsSync(project)).toBe(false);
  });
});

describe('muse live smoke entrypoint', () => {
  function runScript(args, env) {
    return spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8', timeout: 60_000 });
  }

  function envWithoutGate() {
    const env = { ...process.env };
    delete env[LIVE_GATE];
    return env;
  }

  it('skips cleanly (exit 0) when the gate is unset', () => {
    const result = runScript([], envWithoutGate());
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/Skipping Muse live smoke/);
    expect(result.stderr).toContain(LIVE_GATE);
    const contract = JSON.parse(result.stdout);
    expect(contract.requiredGate).toBe(`${LIVE_GATE}=1`);
  });

  it('skips cleanly (exit 0) when the gate is set but muse is absent from PATH', () => {
    const result = runScript([], { ...process.env, [LIVE_GATE]: '1', PATH: '/nonexistent-dir' });
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/not found on PATH/);
    const contract = JSON.parse(result.stdout);
    expect(contract.requiredGate).toBe(`${LIVE_GATE}=1`);
  });

  it('--check exits 0 and reports readiness without the gate', () => {
    const result = runScript(['--check'], envWithoutGate());
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.mode).toBe('check');
    expect(report.status).toBe('not-ready');
  });

  it('rejects unknown arguments', () => {
    const result = runScript(['--bogus'], envWithoutGate());
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).reason).toBe('INVALID_ARGUMENTS');
  });
});
