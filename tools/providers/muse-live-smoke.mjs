#!/usr/bin/env node
/**
 * Opt-in Muse Code live smoke (evidence-gated; distinct from the
 * Ralph/headless provider adapter in #230).
 *
 * Muse IS a CLI (`muse` / `muse exec`), so this smoke exercises the real
 * AIWG deploy/doctor/status surface against the ADR-verified Muse roots
 * instead of a model inference path:
 *
 *   - `use all --provider muse --dry-run`               (project scope, zero writes)
 *   - `use all --provider muse`                         (project deploy -> .agents/skills)
 *   - `use all --provider muse --scope user --dry-run`  (user scope, zero writes)
 *   - `use all --provider muse --scope user`            (user deploy -> $XDG_CONFIG_HOME/muse/skills)
 *   - `doctor --provider muse`
 *   - `status --probe --provider muse`
 *   - optional non-destructive `muse --version` probe (evidence only)
 *
 * Default CI skips unless AIWG_MUSE_LIVE_SMOKE=1 AND a real `muse` executable
 * is on PATH. The sandbox redirects HOME and XDG_CONFIG_HOME into a temp
 * dir, so only the verified roots are ever written: project
 * `<target>/.agents/skills` and `$XDG_CONFIG_HOME/muse/skills`. Never
 * `.cursor/`, never `~/.muse`, never `~/.agents/skills`.
 *
 * @issue #237
 * @see docs/architecture/adr-muse-provider-target.md
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const LIVE_GATE = 'AIWG_MUSE_LIVE_SMOKE';
export const MUSE_BIN = 'muse';

/** ADR-verified write targets. Everything else in the sandbox is forbidden. */
export const VERIFIED_ROOTS = {
  project: '<target>/.agents/skills',
  user: '$XDG_CONFIG_HOME/muse/skills',
};

/** Paths the smoke must never create (mirrors the ADR fail-closed policy). */
export const NEVER_WRITES = ['.cursor/', '~/.muse', '~/.agents/skills'];

export function checkContract(env = process.env) {
  return {
    live: false,
    normalCiCostUsd: 0,
    requiredGate: `${LIVE_GATE}=1`,
    requiresCli: `${MUSE_BIN} on PATH`,
    skillRoots: VERIFIED_ROOTS,
    modes: ['dry-run-deploy', 'deploy', 'user-scope-deploy', 'doctor', 'status', 'cli-probe', 'muse-skills-list'],
    neverWrites: NEVER_WRITES,
  };
}

/**
 * Non-destructive `muse --version` probe. Presence means the binary launched
 * (no ENOENT); the version string is evidence only and never asserted.
 * Injectable `spawn` keeps this unit-testable.
 */
export function findMuseCli(env = process.env, spawn = spawnSync) {
  const childEnv = { PATH: env.PATH ?? '' };
  if (process.platform === 'win32' && env.SystemRoot) childEnv.SystemRoot = env.SystemRoot;
  const result = spawn(MUSE_BIN, ['--version'], {
    env: childEnv,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 16_384,
  });
  if (result.error || result.status !== 0) {
    // Missing, unrunnable, timed out, or an unrelated `muse` binary that
    // rejects --version: none of these is evidence of Muse Code.
    return { found: false, version: null };
  }
  const version = String(result.stdout || '').split('\n')[0].trim().slice(0, 120) || null;
  return { found: true, version };
}

/**
 * Run the real `muse` CLI. Used only for offline commands (`skills list`),
 * which make no model call.
 */
function runMuse(args, cwd, env) {
  return spawnSync(MUSE_BIN, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

/**
 * True when Muse's own `skills list` reports every skill AIWG deployed to the
 * project `.agents/skills` root, each without diagnostics.
 */
export function museLoadsDeployedSkills(listing, project) {
  const deployedRoot = join(project, '.agents', 'skills');
  const deployed = existsSync(deployedRoot)
    ? readdirSync(deployedRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    : [];
  const skills = Array.isArray(listing?.skills) ? listing.skills : [];
  // Muse reports project skill paths relative to the workspace.
  const loaded = new Map(skills
    .filter((skill) => typeof skill?.path === 'string'
      && resolve(project, skill.path).startsWith(`${deployedRoot}/`))
    .map((skill) => [skill.id, skill]));
  const ok = deployed.length > 0 && deployed.every((name) => {
    const skill = loaded.get(name);
    return skill && (!Array.isArray(skill.diagnostics) || skill.diagnostics.length === 0);
  });
  return { ok, deployed: deployed.length, loaded: loaded.size };
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

/**
 * Walk the sandbox and flag every forbidden write: any `.cursor` tree, an
 * invented `~/.muse` home, a `~/.agents` tree (Muse reads it but AIWG must
 * never write it), or `$XDG_CONFIG_HOME` content outside `muse/skills`.
 * Returns a list of human-readable violations (empty when clean).
 */
export function findForbiddenWrites(sandbox, layout) {
  const violations = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.name === '.cursor') {
        violations.push(`forbidden .cursor tree: ${relative(sandbox, full)}`);
      }
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(full);
    }
  };
  visit(sandbox);
  const { home, xdgConfig } = layout;
  if (existsSync(join(home, '.muse'))) violations.push('invented ~/.muse tree');
  if (existsSync(join(home, '.agents'))) violations.push('~/.agents tree (Muse reads it; AIWG must not write it)');
  if (existsSync(xdgConfig)) {
    for (const entry of readdirSync(xdgConfig, { withFileTypes: true })) {
      if (entry.name !== 'muse') {
        violations.push(`unexpected $XDG_CONFIG_HOME entry: ${entry.name}`);
        continue;
      }
      const museDir = join(xdgConfig, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        for (const sub of readdirSync(museDir, { withFileTypes: true })) {
          if (sub.name !== 'skills') {
            violations.push(`unexpected $XDG_CONFIG_HOME/muse entry: ${sub.name}`);
          }
        }
      }
    }
  }
  return violations;
}

export function runLiveSmoke(options = {}, baseEnv = process.env, dependencies = {}) {
  const checkOnly = Boolean(options.check);
  const probeCli = dependencies.probeCli || findMuseCli;
  const run = dependencies.runAiwg || runAiwg;
  const muse = dependencies.runMuse || runMuse;
  const auditWrites = dependencies.findForbiddenWrites || findForbiddenWrites;
  const cli = probeCli(baseEnv);
  const contract = checkContract(baseEnv);
  const report = {
    schemaVersion: 1,
    mode: checkOnly ? 'check' : 'live',
    status: 'not-ready',
    reason: 'PREREQUISITES_MISSING',
    checks: {
      optedIn: baseEnv[LIVE_GATE] === '1',
      cliPresent: cli.found,
      cliVersion: cli.version,
      dryRun: false,
      deploy: false,
      userDryRun: false,
      userDeploy: false,
      doctor: false,
      status: false,
      forbiddenWrites: [],
    },
    contract,
  };

  if (checkOnly) {
    report.status = report.checks.optedIn && report.checks.cliPresent ? 'ready' : 'not-ready';
    report.reason = report.status === 'ready'
      ? 'PREREQUISITES_VERIFIED_NO_MODEL_CALLS'
      : 'PREREQUISITES_MISSING';
    return report;
  }

  if (!report.checks.optedIn) {
    report.reason = `Live Muse smoke disabled; set ${LIVE_GATE}=1 explicitly`;
    return report;
  }
  if (!report.checks.cliPresent) {
    report.reason = 'MUSE_CLI_ABSENT';
    return report;
  }

  const combined = (result) => `${result.stdout ?? ''}${result.stderr ?? ''}`;
  let sandbox;
  try {
    sandbox = mkdtempSync(join(tmpdir(), 'aiwg-muse-live-smoke-'));
    const project = join(sandbox, 'project');
    const home = join(sandbox, 'home');
    const xdgConfig = join(sandbox, 'xdg-config');
    mkdirSync(project, { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(xdgConfig, { recursive: true });
    writeFileSync(join(project, 'README.md'), '# Muse live smoke fixture\n');

    // Sandbox the operator home so the XDG user root resolves inside the
    // temp dir; the real home is never touched.
    // Every XDG root points into the sandbox and operator AIWG_* overrides
    // are dropped, so no write can land outside the audited temp dir.
    const env = Object.fromEntries(Object.entries(baseEnv).filter(([key]) => !key.startsWith('AIWG_')));
    Object.assign(env, {
      HOME: home,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_DATA_HOME: join(sandbox, 'xdg-data'),
      XDG_STATE_HOME: join(sandbox, 'xdg-state'),
      XDG_CACHE_HOME: join(sandbox, 'xdg-cache'),
      NO_COLOR: '1',
    });

    const dry = run(['use', 'all', '--provider', 'muse', '--dry-run'], project, env);
    report.checks.dryRun = dry.status === 0
      && combined(dry).includes('.agents/skills')
      && !combined(dry).includes('.cursor/');
    if (!report.checks.dryRun) {
      report.status = 'failed';
      report.reason = 'DRY_RUN_FAILED';
      return report;
    }
    // Dry-run performs zero writes: no .agents tree may exist yet.
    if (existsSync(join(project, '.agents'))) {
      report.status = 'failed';
      report.reason = 'DRY_RUN_WROTE';
      return report;
    }

    const deploy = run(['use', 'all', '--provider', 'muse'], project, env);
    report.checks.deploy = deploy.status === 0
      && existsSync(join(project, '.agents', 'skills'));
    if (!report.checks.deploy) {
      report.status = 'failed';
      report.reason = 'DEPLOY_FAILED';
      return report;
    }

    const userDry = run(['use', 'all', '--provider', 'muse', '--scope', 'user', '--dry-run'], project, env);
    report.checks.userDryRun = userDry.status === 0 && !combined(userDry).includes('.cursor/');
    if (!report.checks.userDryRun) {
      report.status = 'failed';
      report.reason = 'USER_DRY_RUN_FAILED';
      return report;
    }

    const userDeploy = run(['use', 'all', '--provider', 'muse', '--scope', 'user'], project, env);
    report.checks.userDeploy = userDeploy.status === 0
      && existsSync(join(xdgConfig, 'muse', 'skills'));
    if (!report.checks.userDeploy) {
      report.status = 'failed';
      report.reason = 'USER_DEPLOY_FAILED';
      return report;
    }

    const doctor = run(['doctor', '--provider', 'muse'], project, env);
    report.checks.doctor = doctor.status === 0
      && !combined(doctor).includes('Unknown provider');
    if (!report.checks.doctor) {
      report.status = 'failed';
      report.reason = 'DOCTOR_FAILED';
      return report;
    }

    const status = run(['status', '--probe', '--provider', 'muse'], project, env);
    report.checks.status = status.status === 0;
    if (!report.checks.status) {
      report.status = 'failed';
      report.reason = 'STATUS_CHECK_FAILED';
      return report;
    }

    const violations = auditWrites(sandbox, { home, xdgConfig });
    report.checks.forbiddenWrites = violations;
    if (violations.length > 0) {
      report.status = 'failed';
      report.reason = 'FORBIDDEN_PATH_WRITE';
      return report;
    }

    // Muse itself must load what AIWG deployed. `skills list` is offline (no
    // model call); Muse's own state goes to separate sandbox dirs so the write
    // audit above stays about AIWG.
    const museEnv = {
      ...env,
      XDG_CONFIG_HOME: join(sandbox, 'muse-config'),
      XDG_DATA_HOME: join(sandbox, 'muse-data'),
    };
    const listing = muse(
      ['skills', 'list', '--source', 'project', '--workspace', project, '--trust-workspace', '--json'],
      project,
      museEnv,
    );
    let parsed = null;
    try { parsed = JSON.parse(listing.stdout || ''); } catch { /* reported below */ }
    const loadCheck = listing.status === 0 ? museLoadsDeployedSkills(parsed, project) : { ok: false, deployed: 0, loaded: 0 };
    report.checks.museLoadsSkills = loadCheck.ok;
    report.checks.museSkillCount = { deployed: loadCheck.deployed, loaded: loadCheck.loaded };
    if (!loadCheck.ok) {
      report.status = 'failed';
      report.reason = 'MUSE_SKILLS_NOT_LOADED';
      return report;
    }

    report.status = 'passed';
    report.reason = 'LIVE_CHECKS_PASSED';
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
  const outputIndex = args.indexOf('--output');
  const output = outputIndex >= 0 ? args[outputIndex + 1] : null;
  const rest = args.filter((arg, index) => arg !== '--check'
    && (outputIndex < 0 || (index !== outputIndex && index !== outputIndex + 1)));
  if (rest.length > 0 || (outputIndex >= 0 && !output)) {
    process.stdout.write(`${JSON.stringify({ status: 'failed', reason: 'INVALID_ARGUMENTS' })}\n`);
    return 1;
  }
  if (process.env[LIVE_GATE] !== '1' && !check) {
    process.stderr.write(
      `Skipping Muse live smoke: set ${LIVE_GATE}=1 with a real \`muse\` CLI on PATH to enable.\n`,
    );
    process.stdout.write(`${JSON.stringify(checkContract(), null, 2)}\n`);
    return 0;
  }
  if (process.env[LIVE_GATE] === '1' && !check && !findMuseCli().found) {
    process.stderr.write('Skipping Muse live smoke: `muse` CLI not found on PATH.\n');
    process.stdout.write(`${JSON.stringify(checkContract(), null, 2)}\n`);
    return 0;
  }
  const report = runLiveSmoke({ check });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (output) {
    const dest = resolve(output);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, serialized, { mode: 0o600 });
  }
  process.stdout.write(serialized);
  if (check) return 0;
  return report.status === 'passed' ? 0 : 1;
}

const isDirect = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirect) process.exitCode = main();
