import { afterEach, describe, expect, it, vi } from 'vitest';
import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  commitRuleDeploymentPlan,
  createRuleDeploymentInputPool,
  describeRuleDeploymentInputPool,
  disposeRuleDeploymentInputPool,
  disposeRuleDeploymentPlan,
  prepareRuleDeployment,
} from '../../../tools/agents/providers/rule-delivery.mjs';
import { inputPools, verifyInputPool } from '../../../tools/agents/providers/rule-deployment-state.mjs';

const fixtureRoots = [];
const referenceNames = ['tools', 'dist', 'node_modules', 'src'];

function fixture() {
  // Each fixture is its own temp directory, never inside the repository checkout.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-provider-staging-'));
  fixtureRoots.push(root);
  const corpus = path.join(root, 'corpus');
  const sourceTree = path.join(corpus, 'agentic', 'code');
  const target = path.join(root, 'project');
  const home = path.join(root, 'home');
  const temp = path.join(root, 'temp');

  fs.mkdirSync(path.join(sourceTree, 'frameworks'), { recursive: true });
  fs.mkdirSync(path.join(sourceTree, 'addons'), { recursive: true });
  fs.writeFileSync(path.join(corpus, 'package.json'), JSON.stringify({ name: 'fixture-aiwg', version: '2026.11.1' }));
  fs.mkdirSync(path.join(corpus, 'prebuilt', 'framework-relations'), { recursive: true });
  fs.mkdirSync(path.join(corpus, 'schemas'), { recursive: true });
  for (const name of referenceNames) {
    fs.mkdirSync(path.join(corpus, name), { recursive: true });
    fs.writeFileSync(path.join(corpus, name, 'sentinel.txt'), `trusted fixture input: ${name}\n`);
  }

  fs.mkdirSync(path.join(target, '.aiwg', 'frameworks'), { recursive: true });
  fs.mkdirSync(path.join(target, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(target, '.aiwg', 'aiwg.config'), JSON.stringify({ installed: {} }, null, 2));
  fs.writeFileSync(path.join(target, '.aiwg', 'frameworks', 'registry.json'), JSON.stringify({ frameworks: [] }, null, 2));
  fs.mkdirSync(path.join(home, '.aiwg'), { recursive: true });
  fs.mkdirSync(path.join(home, '.config'), { recursive: true });
  fs.mkdirSync(path.join(home, '.local', 'share'), { recursive: true });
  fs.mkdirSync(path.join(temp, 'work'), { recursive: true });

  vi.stubEnv('AIWG_ROOT', corpus);
  vi.stubEnv('AIWG_USER_REGISTRY_PATH', path.join(home, '.aiwg', 'installed.json'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('APPDATA', path.join(home, 'AppData', 'Roaming'));
  vi.stubEnv('LOCALAPPDATA', path.join(home, 'AppData', 'Local'));
  vi.stubEnv('XDG_CONFIG_HOME', path.join(home, '.config'));
  vi.stubEnv('XDG_DATA_HOME', path.join(home, '.local', 'share'));
  vi.stubEnv('TEMP', temp);
  vi.stubEnv('TMP', temp);
  vi.stubEnv('TMPDIR', temp);

  const provider = { name: 'codex', paths: { rules: '.codex/rules' } };
  const opts = {
    srcRoot: corpus,
    target,
    mode: 'all',
    config: { installed: {} },
    ruleSources: [],
    bindingEntries: [],
    deployBehaviors: false,
    pinConfigs: { project: {}, user: {} },
    quiet: true,
  };
  return { root, corpus, sourceTree, target, home, temp, provider, opts };
}

function expectReferences(snapshotRoot, corpus) {
  for (const name of referenceNames) {
    const source = path.join(corpus, name);
    const staged = path.join(snapshotRoot, name);
    expect(fs.lstatSync(staged).isSymbolicLink(), `${name} should remain a directory reference`).toBe(true);
    expect(fs.realpathSync(staged), `${name} should resolve to the trusted source`).toBe(fs.realpathSync(source));
    expect(fs.readFileSync(path.join(staged, 'sentinel.txt'), 'utf8')).toBe(`trusted fixture input: ${name}\n`);
    if (process.platform === 'win32') expect(path.isAbsolute(fs.readlinkSync(staged))).toBe(true);
    else expect(fs.readlinkSync(staged)).toBe(source);
  }
}

function expectSourcesRemain(f) {
  for (const name of referenceNames) {
    expect(fs.readFileSync(path.join(f.corpus, name, 'sentinel.txt'), 'utf8')).toBe(`trusted fixture input: ${name}\n`);
  }
}

function injectedSecondReferenceFailure() {
  const original = fs.symlinkSync;
  const destinations = [];
  const spy = vi.spyOn(fs, 'symlinkSync').mockImplementation((from, to, type) => {
    if (referenceNames.includes(path.basename(String(to))) && String(to).includes('aiwg-rule-')) {
      destinations.push(String(to));
      if (destinations.length === 2) throw Object.assign(new Error('injected provider staging failure'), { code: 'EINJECTED' });
    }
    return original(from, to, type);
  });
  return { spy, destinations };
}

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  vi.unstubAllEnvs();
  for (const root of fixtureRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('provider staging directory references', () => {
  it('prepares and commits staged provider output through the direct snapshot path', async () => {
    const f = fixture();
    const plan = await prepareRuleDeployment(f.opts, f.provider, async ({ target: stage }) => {
      expectReferences(process.env.AIWG_ROOT, f.corpus);
      fs.mkdirSync(path.join(stage, '.codex', 'rules'), { recursive: true });
      fs.writeFileSync(path.join(stage, '.codex', 'rules', 'generated.md'), 'staged provider output\n');
    });

    expect(plan.poolSeal).toBeNull();
    expectReferences(plan.snapshotRoot, f.corpus);
    expect(fs.existsSync(path.join(f.target, '.codex', 'rules', 'generated.md'))).toBe(false);
    commitRuleDeploymentPlan(plan);
    expect(fs.readFileSync(path.join(f.target, '.codex', 'rules', 'generated.md'), 'utf8')).toBe('staged provider output\n');
    expect(fs.existsSync(plan.temp)).toBe(false);
    expectSourcesRemain(f);
  });

  it('creates a sealed shared input pool and disposes its references without deleting sources', () => {
    const f = fixture();
    const token = createRuleDeploymentInputPool(f.corpus);
    const pool = inputPools.get(token);
    try {
      const descriptor = describeRuleDeploymentInputPool(token);
      expect(descriptor.snapshotRoot).toBe(pool.snapshotRoot);
      expectReferences(pool.snapshotRoot, f.corpus);
      expect(() => verifyInputPool(pool)).not.toThrow();
      expect(pool.execAnchors.some(anchor => anchor.path === path.join(f.corpus, 'tools'))).toBe(true);
    } finally {
      disposeRuleDeploymentInputPool(token);
    }
    expect(fs.existsSync(path.dirname(pool.snapshotRoot))).toBe(false);
    expectSourcesRemain(f);
  });

  it('rejects a staged reference redirected outside the sealed input pool', () => {
    const f = fixture();
    const outside = path.join(f.root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'outside fixture\n');
    const token = createRuleDeploymentInputPool(f.corpus);
    const pool = inputPools.get(token);
    try {
      const staged = path.join(pool.snapshotRoot, 'tools');
      // The sealed pool is read-only on POSIX; open it just long enough to simulate tampering.
      const sealedMode = fs.statSync(pool.snapshotRoot).mode & 0o7777;
      fs.chmodSync(pool.snapshotRoot, sealedMode | 0o200);
      fs.unlinkSync(staged);
      fs.symlinkSync(process.platform === 'win32' ? path.resolve(outside) : outside, staged, process.platform === 'win32' ? 'junction' : 'dir');
      fs.chmodSync(pool.snapshotRoot, sealedMode);
      expect(() => verifyInputPool(pool)).toThrow(/Shared input pool changed/);
    } finally {
      disposeRuleDeploymentInputPool(token);
    }
    expect(fs.readFileSync(path.join(outside, 'sentinel.txt'), 'utf8')).toBe('outside fixture\n');
    expectSourcesRemain(f);
  });

  it.each(['shared input pool', 'direct provider plan'])('cleans a partially created %s after a later reference fails', async kind => {
    const f = fixture();
    const { spy, destinations } = injectedSecondReferenceFailure();
    let failure;
    try {
      if (kind === 'shared input pool') {
        try { createRuleDeploymentInputPool(f.corpus); } catch (error) { failure = error; }
      } else {
        try { await prepareRuleDeployment(f.opts, f.provider, async () => {}); } catch (error) { failure = error; }
      }
    } finally {
      spy.mockRestore();
    }

    expect(failure).toMatchObject({ code: 'EINJECTED', message: 'injected provider staging failure' });
    expect(destinations.map(destination => path.basename(destination))).toEqual(['tools', 'dist']);
    expect(fs.existsSync(path.dirname(path.dirname(destinations[0])))).toBe(false);
    expect(fs.existsSync(path.join(f.target, '.codex', 'rules'))).toBe(false);
    expectSourcesRemain(f);
  });

  it('surfaces cleanup failure and leaves every linked source intact', () => {
    const f = fixture();
    const token = createRuleDeploymentInputPool(f.corpus);
    const pool = inputPools.get(token);
    const tempRoot = path.dirname(pool.snapshotRoot);
    const original = fs.rmSync;
    const spy = vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
      if (path.resolve(String(target)) === path.resolve(tempRoot)) throw Object.assign(new Error('injected cleanup failure'), { code: 'EIO' });
      return original(target, options);
    });
    syncBuiltinESMExports();
    try {
      expect(() => disposeRuleDeploymentInputPool(token)).toThrow('injected cleanup failure');
    } finally {
      spy.mockRestore();
      syncBuiltinESMExports();
      original(tempRoot, { recursive: true, force: true });
    }
    expectSourcesRemain(f);
  });
});
