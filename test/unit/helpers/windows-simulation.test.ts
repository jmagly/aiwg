// Exercise portable Windows fixtures and restoration, including exceptional exits.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os, { homedir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  withPlatform, withWindows, useWindowsSimulation, usePlatformSimulation, windowsPath, uncPath,
  createJunction, assertWindowsCommandSafe,
} from '../../helpers/windows-simulation.mjs';
import { verifiedHookCommand } from '../../../src/extensions/verified-hook-command.js';

const envKeys = ['USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP'];
const snapshot = () => ({ platform: Object.getOwnPropertyDescriptor(process, 'platform'),
  home: Object.getOwnPropertyDescriptor(os, 'homedir'), namedHome: homedir(),
  temp: Object.getOwnPropertyDescriptor(os, 'tmpdir'),
  env: Object.fromEntries(envKeys.map(key => [key, process.env[key]])) });

it.each(['win32', 'darwin', 'linux'])('restores the exact descriptor after a %s synchronous throw', platform => {
  const before = snapshot();
  expect(() => withPlatform(platform, () => {
    expect(process.platform).toBe(platform);
    throw new Error('synthetic failure');
  })).toThrow('synthetic failure');
  expect(snapshot()).toEqual(before);
});

it('restores environment and both homedir imports after an asynchronous rejection', async () => {
  const before = snapshot(), profile = 'D:\\Users\\A Space';
  const hostTemp = os.tmpdir();
  await expect(withWindows(async () => {
    await Promise.resolve();
    expect(process.platform).toBe('win32');
    expect(os.homedir()).toBe(profile);
    expect(homedir()).toBe(profile);
    expect(os.tmpdir()).toBe(hostTemp);
    expect(Object.fromEntries(envKeys.map(key => [key, process.env[key]]))).toEqual({
      USERPROFILE: profile, HOMEDRIVE: 'D:', HOMEPATH: '\\Users\\A Space',
      APPDATA: `${profile}\\AppData\\Roaming`, LOCALAPPDATA: `${profile}\\AppData\\Local`,
      TEMP: `${profile}\\AppData\\Local\\Temp`, TMP: `${profile}\\AppData\\Local\\Temp`,
    });
    throw new Error('async failure');
  }, { profile })).rejects.toThrow('async failure');
  expect(snapshot()).toEqual(before);
});

it('preserves sync return values and awaits async values through nested scopes', async () => {
  const before = snapshot();
  expect(withWindows(() => withPlatform('darwin', () => process.platform))).toBe('darwin');
  await withWindows(async () => {
    const outer = snapshot();
    expect(await withPlatform('linux', async () => process.platform)).toBe('linux');
    expect(snapshot()).toEqual(outer);
  });
  expect(snapshot()).toEqual(before);
});

describe('describe-scoped Windows simulation', () => {
  const before = snapshot();
  // Vitest runs afterEach in reverse registration order (its default stack mode).
  afterEach(() => { expect(snapshot()).toEqual(before); });
  useWindowsSimulation({ beforeEach, afterEach }, { profile: 'C:\\Users\\Scoped Profile' });
  it('applies the profile before each test', () => {
    expect(process.platform).toBe('win32');
    expect(os.homedir()).toBe('C:\\Users\\Scoped Profile');
  });
});

it('registers teardown before activation and unwinds repeated overrides after a test throws', () => {
  const before = snapshot();
  let cleanup = () => {};
  const simulatePlatform = usePlatformSimulation({ afterEach: fn => { cleanup = fn; } });
  try {
    expect(() => {
      simulatePlatform('win32');
      simulatePlatform('darwin');
      throw new Error('test threw');
    }).toThrow('test threw');
  } finally { cleanup(); }
  expect(snapshot()).toEqual(before);
});

it('builds drive and UNC paths without depending on the native path module', () => {
  expect(windowsPath('d', 'Program Files', 'AIWG', 'hook.cjs')).toBe('D:\\Program Files\\AIWG\\hook.cjs');
  expect(uncPath('server', 'share name', 'a folder', 'file')).toBe('\\\\server\\share name\\a folder\\file');
});

it('creates an absolute directory junction target like the staged provider reference', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-simulation-junction-'));
  try {
    const target = path.join(root, 'target directory'), link = path.join(root, 'link');
    fs.mkdirSync(target);
    createJunction(path.relative(process.cwd(), target), link);
    expect(path.isAbsolute(fs.readlinkSync(link))).toBe(true);
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(target));
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    fs.writeFileSync(path.join(target, 'fixture'), 'junction contents');
    expect(fs.readFileSync(path.join(link, 'fixture'), 'utf8')).toBe('junction contents');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('accepts real generated hooks with encoded paths and arguments for both Windows shells', () => {
  withWindows(() => {
    const profile = windowsPath('c', 'Users', 'A Space $HOME %USERPROFILE% `tick`');
    const command = verifiedHookCommand(profile, '.claude/hooks/trace.cjs', Buffer.from('fixture'), ['a space', '$VAR', '%VAR%']);
    assert.doesNotThrow(() => assertWindowsCommandSafe(command));
    assert.doesNotThrow(() => assertWindowsCommandSafe('node "C:\\Program Files\\AIWG\\hook.cjs"'));
  });
});

it.each([
  "node 'C:\\Program Files\\AIWG\\hook.cjs'",
  'node C:\\Program Files\\AIWG\\hook.cjs',
  'node "%USERPROFILE%\\hook.cjs"',
  "node '%USERPROFILE%\\hook.cjs'",
  'node "$HOME\\hook.cjs"',
  'node "${env:USERPROFILE}\\hook.cjs"',
  'node "$env:USERPROFILE\\hook.cjs"',
  'node "`whoami`"',
  'node "unterminated',
])('rejects a nonportable Windows command: %s', command => {
  expect(() => assertWindowsCommandSafe(command)).toThrow();
});
