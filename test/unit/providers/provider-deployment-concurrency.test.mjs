// Protect parallel worktree deployments and provider-specific preimage failures (#3802).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { acquireProviderDeploymentLock, withProviderDeploymentLock } from '../../../src/providers/deployment-lock.js';
import { deployEachProvider, resultForProvider } from '../../../src/cli/handlers/use-provider-results.js';
import { prepareRuleDeployment, commitRuleDeploymentPlan } from '../../../tools/agents/providers/rule-delivery.mjs';

const roots = [];
const children = new Set();
afterEach(async () => {
  await Promise.all([...children].map(child => new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', resolve); child.kill('SIGKILL');
  })));
  children.clear();
  vi.unstubAllEnvs();
  roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
});
const write = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-concurrent-deploy-')); roots.push(root);
  const home = path.join(root, 'home'), source = path.join(root, 'source');
  fs.mkdirSync(home); fs.mkdirSync(source);
  const env = { ...process.env, HOME: home, USERPROFILE: home, HERMES_HOME: path.join(home, '.hermes'),
    CODEX_HOME: path.join(home, '.codex'), XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local/share'), XDG_STATE_HOME: path.join(home, '.local/state'),
    XDG_CACHE_HOME: path.join(home, '.cache'), AIWG_CONFIG: path.join(home, '.aiwg'),
    AIWG_USER_REGISTRY_PATH: path.join(home, '.config/aiwg/installed.json'),
    AIWG_PROJECT_MEMORY_HOME: path.join(root, 'memory'), AIWG_RESOLVE_IMPL_FROM: 'dist' };
  for (const key of ['AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR', 'AIWG_ROOT', 'AIWG_HOME']) delete env[key];
  for (const key of ['HOME', 'XDG_STATE_HOME']) vi.stubEnv(key, env[key]);
  write(path.join(source, 'skills/kernel-demo/SKILL.md'), '---\nname: kernel-demo\ndescription: Synthetic kernel skill\nkernel: true\n---\nDemo.\n');
  write(path.join(source, 'rules/guard.md'), '---\nname: guard\nactivation: kernel\nsummary: Guard fixture.\n---\nGuard.\n');
  return { root, home, source, env };
}

it.each(['serial', 'deferred', 'prepared'])('runs two %s deployments in parallel against one fake HOME', async mode => {
  const f = fixture();
  // An unverified marker (including a bare boolean) grants no ownership.
  f.env.AIWG_PROVIDER_DEPLOYMENT_LOCK_OWNER = '1';
  // Hold the actual advisory lease until both processes are waiting, making
  // contention deterministic rather than depending on scheduling luck.
  const release = await acquireProviderDeploymentLock();
  const runner = fileURLToPath(new URL('../../fixtures/providers/provider-deployment-concurrency-runner.mjs', import.meta.url));
  const runs = [0, 1].map(index => {
    const target = path.join(f.root, `project-${index}`); fs.mkdirSync(target);
    const child = fork(runner, [mode, f.source, target], { env: f.env, execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    children.add(child);
    let stderr = '';
    let waiting;
    const contended = new Promise(resolve => { waiting = resolve; });
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.includes('Waiting for shared user-home')) waiting(); });
    const ready = new Promise(resolve => child.once('message', () => { child.send({ start: true }); resolve(); }));
    const done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => { children.delete(child); resolve({ code, signal, stderr, target }); });
    });
    return { ready, contended, done };
  });
  try {
    await Promise.all(runs.map(run => run.ready));
    await Promise.all(runs.map(run => Promise.race([run.contended, run.done.then(result => { throw new Error(result.stderr || 'Exited without waiting'); })])));
  } finally { await release(); }
  for (const result of await Promise.all(runs.map(run => run.done))) {
    expect(result.code, result.stderr).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stderr).toContain('Waiting for shared user-home provider deployment lock');
    expect(fs.existsSync(path.join(result.target, '.claude/skills/kernel-demo/SKILL.md'))).toBe(true);
  }
  expect(fs.existsSync(path.join(f.home, '.hermes/skills/kernel-demo/SKILL.md'))).toBe(true);
  expect(fs.existsSync(path.join(f.env.XDG_STATE_HOME, 'aiwg/provider-deployment.lock'))).toBe(false);
}, 60_000);

it('reenters an explicitly held operation without releasing its outer lease', async () => {
  const f = fixture();
  const release = await acquireProviderDeploymentLock();
  const owner = path.join(f.env.XDG_STATE_HOME, 'aiwg/provider-deployment.lock/owner');
  try {
    const token = fs.readFileSync(owner, 'utf8');
    await release.run(() => withProviderDeploymentLock(async () => {
      expect(fs.readFileSync(owner, 'utf8')).toBe(token);
    }));
    expect(fs.readFileSync(owner, 'utf8')).toBe(token);
  } finally { await release(); }
  await expect(release.run(async () => {})).rejects.toThrow('lock is released');
});

it('retains the preimage guard and fails only its owning provider while deploying later providers', async () => {
  const f = fixture(), target = path.join(f.root, 'project'); fs.mkdirSync(target);
  const shared = path.join(f.home, '.hermes/skills');
  fs.mkdirSync(shared, { recursive: true });
  const opts = { srcRoot: f.source, target, mode: 'all', ruleSources: [], bindingEntries: [], deployBehaviors: false,
    pinConfigs: { project: {}, user: {} }, quiet: true };
  const owner = { name: 'hermes', paths: { rules: '.hermes/rules', skills: shared }, kernelSkillsPath: shared, assertContextBudget() {} };
  const plan = await prepareRuleDeployment(opts, owner, async () => {});
  write(path.join(shared, 'external.txt'), 'concurrent edit');
  const deployed = [];
  const result = await deployEachProvider(['muse', 'hermes', 'codex', 'claude'], async provider => {
    if (provider === 'hermes') commitRuleDeploymentPlan(plan);
    deployed.push(provider); return { exitCode: 0 };
  });
  expect(result.exitCode).toBe(1);
  expect(resultForProvider(result, 'hermes')).toMatchObject({ exitCode: 1, message: expect.stringContaining(shared) });
  for (const provider of ['muse', 'codex', 'claude']) expect(resultForProvider(result, provider).exitCode).toBe(0);
  expect(deployed).toEqual(['muse', 'codex', 'claude']);
  expect(fs.readFileSync(path.join(shared, 'external.txt'), 'utf8')).toBe('concurrent edit');
});
