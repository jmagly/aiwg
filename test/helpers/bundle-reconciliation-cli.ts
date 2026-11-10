// Share isolated deployment baselines and the compiled CLI across reconciliation cases.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertFreshCliBuild } from './compiled-cli-freshness.js';
import { bundleReconciliationSource } from './bundle-reconciliation-source.js';
import { afterAll, afterEach, beforeAll, expect } from 'vitest';
export const ROOT = path.resolve(import.meta.dirname, '../..');
export const temporary: string[] = [];
const retained: string[] = [];
const baselines = new Map<string, { fixture: ReturnType<typeof setup>; saved: string }>();
const sourceFixtures = new Map<boolean, string>();
let cliCompileCache: string | undefined;
beforeAll(() => assertFreshCliBuild(ROOT));
afterEach(() => { for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
afterAll(() => { for (const dir of retained.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
export function setup(frameworkRoot = ROOT, freshHome = false) {
  if (!cliCompileCache) { cliCompileCache = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-bundle-bytecode-')); retained.push(cliCompileCache); }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-bundle-cli-')); temporary.push(scratch);
  const project = path.join(scratch, 'project'), home = path.join(scratch, 'home');
  fs.mkdirSync(project, { recursive: true }); fs.mkdirSync(home, { recursive: true });
  if (!freshHome) {
    fs.mkdirSync(path.join(home, '.aiwg'), { recursive: true });
    fs.writeFileSync(path.join(home, '.aiwg/channel.json'), JSON.stringify({ channel: 'edge', edgePath: frameworkRoot, devMode: true, checkOnStartup: false }));
  }
  const env = { ...process.env, HOME: home, USERPROFILE: home, AIWG_CONFIG: path.join(home, '.aiwg'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
    XDG_CACHE_HOME: path.join(home, '.cache'), XDG_STATE_HOME: path.join(home, '.state'),
    AIWG_ROOT: frameworkRoot, AIWG_RESOLVE_IMPL_FROM: 'dist', AIWG_SKIP_ACTIVITY_LOG: '1', NO_UPDATE_NOTIFIER: '1' };
  for (const key of ['AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR', 'AIWG_USER_REGISTRY_PATH']) delete env[key];
  // Cache compilation in this run's TMPDIR; every CLI still starts a fresh process.
  Object.assign(env, { NODE_COMPILE_CACHE: cliCompileCache }); delete env.NODE_DISABLE_COMPILE_CACHE;
  // Each copied corpus owns its indexes; the lane's immutable cache is for ROOT.
  if (frameworkRoot !== ROOT) Object.assign(env, {
    AIWG_RULE_BINDING_INDEX_CACHE: path.join(frameworkRoot, '.cache/bindings'),
    AIWG_FRAMEWORK_INDEX_CACHE: path.join(frameworkRoot, '.cache/framework'),
    AIWG_FRAMEWORK_INDEX_CACHE_SOURCE: frameworkRoot,
  });
  const command = (...args: string[]) => {
    const result = spawnSync(process.execPath, [path.join(ROOT, 'bin/aiwg.mjs'), ...args], {
      cwd: project, env, encoding: 'utf8', timeout: 600_000, maxBuffer: 16 * 1024 * 1024,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}\n${result.error || ''}`).toBe(0);
    expect(result.stderr).not.toContain('Source checkout detected');
    if (frameworkRoot !== ROOT && args[0] === 'refresh' && !args.includes('--dry-run')) {
      expect(result.stdout).toContain('Reconciliation fixture: doctor covered separately');
    }
    if (args[0] === 'use' && args.includes('--json')) {
      expect(JSON.parse(result.stdout).frameworkRoot).toBe(frameworkRoot);
      expect(fs.realpathSync(path.join(frameworkRoot, 'dist'))).toBe(path.join(ROOT, 'dist'));
    }
    return `${result.stdout}\n${result.stderr}`;
  };
  const readConfig = () => JSON.parse(fs.readFileSync(path.join(project, '.aiwg/aiwg.config'), 'utf8'));
  const writeConfig = (config: unknown) => fs.writeFileSync(path.join(project, '.aiwg/aiwg.config'), JSON.stringify(config, null, 2));
  const plans = (provider: string) => ['refresh', 'update'].map(action => command(action, '--dry-run', '--provider', provider, action === 'update' ? '--skip-check' : '--skip-update'));
  const snapshot = () => {
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
    return Object.fromEntries(walk(project).map(file => [path.relative(project, file), fs.readFileSync(file).toString('base64')]));
  };
  return { scratch, home, project, command, plans, readConfig, writeConfig, snapshot };
}
export function focusedSource(fullCorpus = false) {
  let fixture = sourceFixtures.get(fullCorpus);
  if (!fixture) {
    fixture = bundleReconciliationSource(ROOT, fullCorpus);
    sourceFixtures.set(fullCorpus, fixture); retained.push(fixture);
  }
  return fixture;
}
// Restore project AND isolated HOME at their original absolute paths.
function restoreBaseline(key: string) {
  const existing = baselines.get(key);
  if (existing) {
    for (const name of ['project', 'home'] as const) {
      fs.rmSync(existing.fixture[name], { recursive: true, force: true });
      fs.cpSync(path.join(existing.saved, name), existing.fixture[name], { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    }
    return existing.fixture;
  }
  return undefined;
}
function saveBaseline(key: string, fixture: ReturnType<typeof setup>) {
  const saved = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-bundle-baseline-')); retained.push(saved);
  for (const name of ['project', 'home'] as const) fs.cpSync(fixture[name], path.join(saved, name), { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  baselines.set(key, { fixture, saved });
  return fixture;
}
// Build lazily inside the existing case timeout; beforeAll stays a freshness check.
export function sdlcSetup(provider: string, fullCorpus = false) {
  const key = `${provider}:${fullCorpus}`;
  const existing = restoreBaseline(key);
  if (existing) return existing;
  const fixture = setup(focusedSource(fullCorpus));
  temporary.splice(temporary.indexOf(fixture.scratch), 1); retained.push(fixture.scratch);
  fixture.command('use', 'sdlc', '--provider', provider, '--no-project-local', '--yes', ...(fullCorpus ? ['--json'] : []));
  return saveBaseline(key, fixture);
}
export function voiceSetup(provider: string, fixture: ReturnType<typeof setup>) {
  const key = `voice:${provider}`;
  if (restoreBaseline(key)) return;
  fixture.command('use', 'voice-framework', '--provider', provider, '--declare');
  fixture.command('use', 'voice-framework', '--provider', provider, '--yes');
  saveBaseline(key, fixture);
}
