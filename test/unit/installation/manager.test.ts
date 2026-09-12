import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  adoptInstallation,
  assertCanonicalInstallation,
  createInstallationIdentity,
  inspectInstallation,
  installationFile,
  loadInstallationIdentity,
  saveInstallationIdentity,
  switchInstallation,
} from '../../../src/installation/manager.mjs';
import { resolveUserConfigDir } from '../../../src/config/user-config-dir.mjs';

const temporary: string[] = [];

function tempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aiwg-${label}-`));
  temporary.push(dir);
  return dir;
}

function packageRoot(name = 'aiwg', source = false): string {
  const root = tempDir('installation-root');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name }));
  if (source) fs.mkdirSync(path.join(root, '.git'));
  return root;
}

afterEach(() => {
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('canonical installation identity', () => {
  it('permits an explicitly read-only unrecorded inspection without creating identity', () => {
    const configDir = tempDir('config');
    const root = packageRoot('aiwg', true);
    const status = assertCanonicalInstallation({
      configDir,
      actualRoot: root,
      createIfMissing: false,
      allowUnrecorded: true,
    });
    expect(status.state).toBe('unrecorded');
    expect(fs.existsSync(installationFile({ configDir }))).toBe(false);
  });

  it('honors config override and both legacy user-config locations', () => {
    const home = tempDir('home');
    const override = tempDir('override');
    expect(resolveUserConfigDir({ env: { AIWG_CONFIG: override }, homeDir: home })).toBe(override);

    const xdg = path.join(home, '.config', 'aiwg');
    fs.mkdirSync(xdg, { recursive: true });
    expect(resolveUserConfigDir({ env: {}, homeDir: home })).toBe(xdg);
    fs.mkdirSync(path.join(home, '.aiwg'));
    expect(resolveUserConfigDir({ env: {}, homeDir: home })).toBe(path.join(home, '.aiwg'));
  });

  it('migrates legacy channel state without losing update-check or dev fields', () => {
    const configDir = tempDir('config');
    const root = packageRoot('aiwg', true);
    fs.writeFileSync(path.join(configDir, 'channel.json'), JSON.stringify({
      channel: 'edge',
      devMode: true,
      edgePath: root,
      lastUpdateCheck: 1234,
      updateCheckInterval: 9876,
      checkOnStartup: false,
    }));
    const identity = loadInstallationIdentity({ configDir, actualRoot: root });
    expect(identity).toMatchObject({
      schemaVersion: 1,
      channel: 'edge',
      runMode: 'development',
      method: 'source',
      root,
      edgePath: root,
      lastUpdateCheck: 1234,
      updateCheckInterval: 9876,
      checkOnStartup: false,
    });
    expect(fs.existsSync(installationFile({ configDir }))).toBe(true);
  });

  it.each([
    ['aiwg', 'npm'],
    ['@aiwg/cli', 'web'],
  ])('records %s as a provider-neutral %s installation', (name, method) => {
    const configDir = tempDir('config');
    const root = packageRoot(name);
    const identity = createInstallationIdentity({ actualRoot: root });
    saveInstallationIdentity(identity, { configDir });
    expect(loadInstallationIdentity({ configDir, actualRoot: root })).toMatchObject({ method, root });
  });

  it('reports PATH/root inversion rather than silently adopting it', () => {
    const configDir = tempDir('config');
    const nvmRoot = packageRoot();
    const brewRoot = packageRoot();
    const manager = path.join(nvmRoot, 'npm');
    fs.writeFileSync(manager, '');
    fs.chmodSync(manager, 0o755);
    saveInstallationIdentity(createInstallationIdentity({
      actualRoot: nvmRoot,
      managerExecutable: manager,
    }), { configDir });
    const status = inspectInstallation({ configDir, actualRoot: brewRoot });
    expect(status.state).toBe('mismatch');
    expect(status.drift.join(' ')).toContain('differs from canonical root');
  });

  it('treats an edge launcher redirect as aligned, not drift (#2505)', () => {
    const configDir = tempDir('config');
    // The framework root: a local clone the operator develops against.
    const clone = packageRoot('aiwg', true);
    // The launcher: a real npm-global package directory whose bin redirects to
    // the clone. This is what `channel: edge` + `edgePath` is for.
    const npmGlobal = packageRoot();
    const git = path.join(clone, 'git');
    fs.writeFileSync(git, '');
    fs.chmodSync(git, 0o755);
    saveInstallationIdentity(createInstallationIdentity({
      actualRoot: clone,
      method: 'source',
      channel: 'edge',
      edgePath: clone,
      managerExecutable: git,
    }), { configDir });

    const status = inspectInstallation({ configDir, actualRoot: npmGlobal });

    // Before #2505 this reported `mismatch` with two drift entries, while
    // `aiwg doctor` — running from the clone — reported aligned for the very
    // same workspace. The steward gates its repair ladder on this state.
    expect(status.state).toBe('aligned');
    expect(status.drift).toEqual([]);
    // Launcher and framework root are reported separately, and only the
    // framework root drives state.
    expect(status.frameworkRoot).toBe(status.canonicalRoot);
    expect(status.launcher).toEqual({ root: status.actualRoot, method: 'npm' });
  });

  it('still reports drift when the launcher redirect is not what the identity declares (#2505)', () => {
    const configDir = tempDir('config');
    const clone = packageRoot('aiwg', true);
    const npmGlobal = packageRoot();
    const unrelated = packageRoot();
    const git = path.join(clone, 'git');
    fs.writeFileSync(git, '');
    fs.chmodSync(git, 0o755);
    // edgePath points somewhere other than the canonical root, so the running
    // executable is not the declared launcher for this framework root.
    saveInstallationIdentity(createInstallationIdentity({
      actualRoot: clone,
      method: 'source',
      channel: 'edge',
      edgePath: unrelated,
      managerExecutable: git,
    }), { configDir });

    const status = inspectInstallation({ configDir, actualRoot: npmGlobal });

    expect(status.state).toBe('mismatch');
    expect(status.drift.join(' ')).toContain('differs from canonical root');
    expect(status.launcher).toBeNull();
    expect(status.frameworkRoot).toBe(status.actualRoot);
  });

  it('reports a stale canonical root and supports explicit recovery', () => {
    const configDir = tempDir('config');
    const oldRoot = packageRoot();
    const newRoot = packageRoot();
    const manager = path.join(newRoot, 'npm');
    fs.writeFileSync(manager, '');
    fs.chmodSync(manager, 0o755);
    const identity = createInstallationIdentity({ actualRoot: oldRoot });
    fs.rmSync(oldRoot, { recursive: true, force: true });
    saveInstallationIdentity(identity, { configDir });
    expect(inspectInstallation({ configDir, actualRoot: newRoot }).state).toBe('stale');
    expect(adoptInstallation({ configDir, actualRoot: newRoot, managerExecutable: manager }).state).toBe('aligned');
    expect(switchInstallation({ configDir, root: newRoot, method: 'npm', managerExecutable: manager }).state).toBe('aligned');
  });

  it('records source/development strategy without an npm fallback', () => {
    const configDir = tempDir('config');
    const root = packageRoot('aiwg', true);
    const git = path.join(root, 'git');
    fs.writeFileSync(git, '');
    fs.chmodSync(git, 0o755);
    const status = adoptInstallation({ configDir, actualRoot: root, method: 'source', managerExecutable: git });
    expect(status.identity).toMatchObject({
      method: 'source',
      runMode: 'development',
      updateStrategy: 'source-git',
    });
  });

  it('reports a manager that exists but cannot be invoked', () => {
    const root = packageRoot();
    const manager = path.join(root, 'npm');
    fs.writeFileSync(manager, '');
    fs.chmodSync(manager, 0o755);
    const identity = createInstallationIdentity({ actualRoot: root, managerExecutable: manager });

    const status = inspectInstallation({
      actualRoot: root,
      identity,
      probeManager: true,
      executeManager: () => { throw new Error('spawn failed'); },
    });

    expect(status.state).toBe('mismatch');
    expect(status.managerProbe).toEqual({ state: 'failed', error: 'spawn failed' });
    expect(status.drift).toContain('recorded manager executable cannot be invoked: spawn failed');
  });
});
