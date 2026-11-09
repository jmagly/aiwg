import { usePlatformSimulation } from '../../helpers/windows-simulation.mjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createInstallationIdentity,
  inspectInstallationCopies,
  installationFile,
  saveInstallationIdentity,
} from '../../../src/installation/manager.mjs';

const simulatePlatform = usePlatformSimulation({ afterEach });

const temporary: string[] = [];
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-path-copies-'));
  temporary.push(home);
  const configDir = path.join(home, 'config');
  function install(prefix: string) {
    const root = path.join(prefix, 'lib/node_modules/aiwg');
    const executable = path.join(prefix, 'bin/aiwg');
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'aiwg', version: '1.0.0' }));
    fs.writeFileSync(path.join(root, 'bin/aiwg.mjs'), '#!/usr/bin/env node\nthrow new Error("must not execute");\n', { mode: 0o755 });
    fs.symlinkSync(path.join(root, 'bin/aiwg.mjs'), executable);
    return { root, executable, bin: path.dirname(executable) };
  }
  const registered = install(path.join(home, 'registered'));
  const identity = createInstallationIdentity({ actualRoot: registered.root, managerExecutable: process.execPath });
  saveInstallationIdentity(identity, { configDir });
  return { home, configDir, registered, identity, install };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('installation copy inspection', () => {
  it('finds all PATH copies in resolution order and deduplicates symlink aliases', () => {
    const f = fixture();
    const foreign = f.install(path.join(f.home, 'foreign'));
    const alias = path.join(f.home, 'alias');
    fs.mkdirSync(alias);
    fs.symlinkSync(foreign.executable, path.join(alias, 'aiwg'));
    const before = fs.readFileSync(installationFile(f), 'utf8');
    const copies = inspectInstallationCopies({
      ...f, homeDir: f.home,
      env: { PATH: [foreign.bin, f.registered.bin, alias, foreign.bin].join(path.delimiter) },
    });
    expect(copies).toEqual([
      { root: foreign.root, executables: [foreign.executable, path.join(alias, 'aiwg')], onPath: true, registered: false },
      { root: f.registered.root, executables: [f.registered.executable], onPath: true, registered: true },
    ]);
    expect(fs.readFileSync(installationFile(f), 'utf8')).toBe(before);
  });

  it('finds other nvm Node versions outside PATH in the default nvm home', () => {
    const f = fixture();
    const active = f.install(path.join(f.home, '.nvm/versions/node/v24.0.0'));
    const inactive = f.install(path.join(f.home, '.nvm/versions/node/v25.0.0'));
    const copies = inspectInstallationCopies({ ...f, homeDir: f.home, env: { PATH: active.bin } });
    expect(copies).toContainEqual({ root: active.root, executables: [active.executable], onPath: true, registered: false });
    expect(copies).toContainEqual({ root: inactive.root, executables: [inactive.executable], onPath: false, registered: false });
  });

  it.each(['NVM_DIR', 'NVM_BIN', 'actualRoot', 'PATH', 'identity'])('finds custom nvm homes from %s', source => {
    const f = fixture();
    const nvm = path.join(f.home, 'custom-nvm');
    const active = f.install(path.join(nvm, 'versions/node/v24.0.0'));
    const inactive = f.install(path.join(nvm, 'versions/node/v25.0.0'));
    const options = {
      identity: f.identity, homeDir: f.home,
      actualRoot: source === 'actualRoot' ? active.root : f.registered.root,
      env: { PATH: source === 'PATH' ? active.bin : f.registered.bin,
        ...(source === 'NVM_DIR' ? { NVM_DIR: nvm } : {}),
        ...(source === 'NVM_BIN' ? { NVM_BIN: active.bin } : {}),
      },
    };
    if (source === 'identity') options.identity = { ...f.identity, root: active.root };
    expect(inspectInstallationCopies(options)).toContainEqual({
      root: inactive.root, executables: [inactive.executable], onPath: false, registered: false,
    });
  });

  it('ignores broken links, non-executable files, and unrelated executables', () => {
    const f = fixture();
    const bin = path.join(f.home, 'broken');
    fs.mkdirSync(bin);
    fs.symlinkSync(path.join(f.home, 'missing'), path.join(bin, 'aiwg'));
    const disabled = f.install(path.join(f.home, 'disabled'));
    fs.chmodSync(path.join(disabled.root, 'bin/aiwg.mjs'), 0o644);
    const unrelated = path.join(f.home, 'unrelated');
    fs.mkdirSync(unrelated);
    fs.writeFileSync(path.join(unrelated, 'aiwg'), '', { mode: 0o755 });
    expect(inspectInstallationCopies({
      ...f, homeDir: f.home, env: { PATH: [bin, disabled.bin, unrelated].join(path.delimiter) },
    })).toEqual([]);
  });

  it('recognizes npm Windows command shims without executing them', () => {
    const f = fixture();
    const prefix = path.join(f.home, 'windows-prefix');
    const root = path.join(prefix, 'node_modules/aiwg');
    const executable = path.join(prefix, 'aiwg.cmd');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'aiwg' }));
    fs.writeFileSync(executable, '@echo off\nexit /b 99\n');
    simulatePlatform('win32');
    expect(inspectInstallationCopies({ ...f, homeDir: f.home, env: { PATH: prefix } })).toEqual([
      { root, executables: [executable], onPath: true, registered: false },
    ]);
  });

  it('keeps declared edge launchers registered and does not create a missing identity', () => {
    const f = fixture();
    const launcher = f.install(path.join(f.home, 'launcher'));
    const copies = inspectInstallationCopies({
      homeDir: f.home, env: { PATH: launcher.bin },
      identity: { ...f.identity, channel: 'edge', edgePath: f.registered.root },
    });
    expect(copies[0].registered).toBe(true);
    fs.rmSync(installationFile(f));
    expect(inspectInstallationCopies({
      configDir: f.configDir, homeDir: f.home, env: { PATH: launcher.bin },
    })[0].registered).toBe(false);
    expect(fs.existsSync(installationFile(f))).toBe(false);
  });
});
