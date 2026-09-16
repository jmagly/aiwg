#!/usr/bin/env node
/**
 * Opt-in Grok Bot live smoke (desktop runtime — not a CLI spawn).
 *
 * Default CI skips unless AIWG_GROKBOT_LIVE_SMOKE=1 and an absolute
 * AIWG_GROKBOT_SKILLS_DIR is configured. Never invents ~/.grokbot or writes
 * .cursor/ paths.
 *
 * @issue #220
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);

export const LIVE_GATE = 'AIWG_GROKBOT_LIVE_SMOKE';
export const GROKBOT_SKILLS_DIR_ENV = 'AIWG_GROKBOT_SKILLS_DIR';

function resolveSkillsDir(env = process.env) {
  try {
    // Prefer compiled dist when present; fall back to a minimal absolute-path check.
    const mod = require(join(root, 'dist/src/providers/grokbot-paths.js'));
    return mod.resolveGrokbotSkillsDirResult(env);
  } catch {
    const raw = (env[GROKBOT_SKILLS_DIR_ENV] || '').trim();
    if (!raw) {
      return {
        ok: false,
        reason: 'unset',
        message: `${GROKBOT_SKILLS_DIR_ENV} is unset`,
      };
    }
    if (!isAbsolute(raw) || raw === '~' || raw.startsWith('~/')) {
      return {
        ok: false,
        reason: 'not-absolute',
        message: `${GROKBOT_SKILLS_DIR_ENV} must be an absolute path`,
      };
    }
    return { ok: true, path: resolve(raw), source: 'env' };
  }
}

export function checkContract(env = process.env) {
  const skills = resolveSkillsDir(env);
  return {
    live: false,
    normalCiCostUsd: 0,
    requiredGate: `${LIVE_GATE}=1`,
    skillsDirEnv: GROKBOT_SKILLS_DIR_ENV,
    skillsDirConfigured: skills.ok === true,
    skillsDir: skills.ok ? skills.path : null,
    modes: ['dry-run-deploy', 'doctor', 'status'],
    neverWrites: ['.cursor/', '~/.grokbot', '~/grokbot-skills'],
  };
}

function runAiwg(args, cwd, env) {
  return spawnSync('node', [join(root, 'bin/aiwg.mjs'), ...args], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
}

export function runLiveSmoke(options = {}, baseEnv = process.env) {
  const checkOnly = Boolean(options.check);
  const contract = checkContract(baseEnv);
  const report = {
    schemaVersion: 1,
    mode: checkOnly ? 'check' : 'live',
    status: 'not-ready',
    reason: 'PREREQUISITES_MISSING',
    checks: {
      optedIn: baseEnv[LIVE_GATE] === '1',
      skillsDirConfigured: contract.skillsDirConfigured,
      dryRun: false,
      doctor: false,
      status: false,
      wroteCursor: false,
      wroteInventedHome: false,
    },
    contract,
  };

  if (checkOnly) {
    report.status = report.checks.optedIn && report.checks.skillsDirConfigured ? 'ready' : 'not-ready';
    report.reason = report.status === 'ready'
      ? 'PREREQUISITES_VERIFIED_NO_LIVE_CALLS'
      : 'PREREQUISITES_MISSING';
    return report;
  }

  if (!report.checks.optedIn) {
    report.reason = `Live Grok Bot smoke disabled; set ${LIVE_GATE}=1 explicitly`;
    return report;
  }
  if (!report.checks.skillsDirConfigured) {
    report.reason = `${GROKBOT_SKILLS_DIR_ENV} must be an absolute configured skill root`;
    return report;
  }

  const skillsDir = contract.skillsDir;
  let sandbox;
  try {
    sandbox = mkdtempSync(join(tmpdir(), 'aiwg-grokbot-live-smoke-'));
    const project = join(sandbox, 'project');
    mkdirSync(project, { recursive: true });
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(project, 'README.md'), '# Grok Bot live smoke fixture\n');

    const env = {
      ...baseEnv,
      [GROKBOT_SKILLS_DIR_ENV]: skillsDir,
      NO_COLOR: '1',
    };

    const dry = runAiwg(['use', 'all', '--provider', 'grokbot', '--dry-run'], project, env);
    report.checks.dryRun = dry.status === 0 && !`${dry.stdout}${dry.stderr}`.includes('.cursor/');
    if (!report.checks.dryRun) {
      report.status = 'failed';
      report.reason = 'DRY_RUN_FAILED';
      return report;
    }

    const doctor = runAiwg(['doctor', '--provider', 'grokbot'], project, env);
    report.checks.doctor = doctor.status === 0
      && !`${doctor.stdout}${doctor.stderr}`.includes("Unknown provider 'grokbot'");
    if (!report.checks.doctor) {
      report.status = 'failed';
      report.reason = 'DOCTOR_FAILED';
      return report;
    }

    const status = runAiwg(['status', '--probe'], project, env);
    report.checks.status = status.status === 0;
    report.checks.wroteCursor = existsSync(join(project, '.cursor'));
    report.checks.wroteInventedHome = existsSync(join(sandbox, '.grokbot'))
      || existsSync(join(sandbox, 'grokbot-skills'));

    if (report.checks.wroteCursor || report.checks.wroteInventedHome) {
      report.status = 'failed';
      report.reason = 'FORBIDDEN_PATH_WRITE';
      return report;
    }

    report.status = report.checks.status ? 'passed' : 'failed';
    report.reason = report.status === 'passed' ? 'LIVE_CHECKS_PASSED' : 'STATUS_CHECK_FAILED';
  } catch {
    report.status = 'failed';
    report.reason = 'SMOKE_EXECUTION_FAILED';
  } finally {
    if (sandbox) rmSync(sandbox, { recursive: true, force: true });
  }
  return report;
}

export function main(args = process.argv.slice(2)) {
  const check = args.includes('--check');
  if (args.some((arg) => arg !== '--check' && arg !== '--json')) {
    process.stdout.write(`${JSON.stringify({ status: 'failed', reason: 'INVALID_ARGUMENTS' })}\n`);
    return 1;
  }
  if (process.env[LIVE_GATE] !== '1' && !check) {
    process.stderr.write(
      `Skipping Grok Bot live smoke: set ${LIVE_GATE}=1 and absolute ${GROKBOT_SKILLS_DIR_ENV} to enable.\n`,
    );
    process.stdout.write(`${JSON.stringify(checkContract(), null, 2)}\n`);
    return 0;
  }
  const report = runLiveSmoke({ check });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (check) return 0;
  return report.status === 'passed' ? 0 : 1;
}

const isDirect = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirect) process.exitCode = main();
