// Own scoped platform, Windows environment, filesystem and command fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';

function simulate(platform, { profile = process.env.USERPROFILE || os.homedir() } = {}) {
  assert.ok(['win32', 'darwin', 'linux'].includes(platform), `Unsupported simulation: ${platform}`);
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const homeDescriptor = Object.getOwnPropertyDescriptor(os, 'homedir');
  const tempDescriptor = Object.getOwnPropertyDescriptor(os, 'tmpdir');
  const nativeTemp = os.tmpdir();
  const env = platform === 'win32' ? {
    USERPROFILE: profile,
    HOMEDRIVE: path.win32.parse(profile).root.replace(/[\\/]+$/, ''),
    HOMEPATH: profile.slice(path.win32.parse(profile).root.replace(/[\\/]+$/, '').length),
    APPDATA: path.win32.join(profile, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.win32.join(profile, 'AppData', 'Local'),
    TEMP: path.win32.join(profile, 'AppData', 'Local', 'Temp'),
    TMP: path.win32.join(profile, 'AppData', 'Local', 'Temp'),
  } : {};
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  const restore = () => {
    Object.defineProperty(process, 'platform', descriptor);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (platform === 'win32') {
      Object.defineProperty(os, 'homedir', homeDescriptor);
      Object.defineProperty(os, 'tmpdir', tempDescriptor);
      syncBuiltinESMExports();
    }
  };
  try {
    Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
    Object.assign(process.env, env);
    if (platform === 'win32') {
      // Linux's native homedir ignores USERPROFILE. Update named imports too.
      Object.defineProperty(os, 'homedir', { ...homeDescriptor, value: () => profile });
      // Real fixture I/O must still use the host temp directory on Linux.
      Object.defineProperty(os, 'tmpdir', { ...tempDescriptor, value: () => nativeTemp });
      syncBuiltinESMExports();
    }
    return restore;
  } catch (error) { restore(); throw error; }
}

/** Preserve synchronous return values; hold async simulations until settlement. */
export function withPlatform(platform, fn, options) {
  const restore = simulate(platform, options);
  try {
    const value = fn();
    if (value && typeof value.then === 'function') return Promise.resolve(value).finally(restore);
    restore();
    return value;
  } catch (error) { restore(); throw error; }
}

export function withWindows(fn, options) { return withPlatform('win32', fn, options); }

/** Register once in a file/describe; returned setter stays active until afterEach. */
export function usePlatformSimulation({ afterEach }) {
  const restorers = [];
  afterEach(() => { while (restorers.length) restorers.pop()(); });
  return (platform, options) => { restorers.push(simulate(platform, options)); };
}

/** Apply Windows before every test in the current describe, with guaranteed cleanup. */
export function useWindowsSimulation({ beforeEach, afterEach }, options) {
  const setPlatform = usePlatformSimulation({ afterEach });
  beforeEach(() => { setPlatform('win32', options); });
}

export function windowsPath(drive, ...segments) {
  assert.match(drive, /^[a-z]:?$/i, 'Use a drive letter such as C');
  return path.win32.join(`${drive[0].toUpperCase()}:\\`, ...segments);
}

export function uncPath(server, share, ...segments) {
  assert.ok(server && share && !/[\\/]/.test(server + share), 'Use a server and share name');
  return path.win32.join(`\\\\${server}\\${share}\\`, ...segments);
}

/** Linux makes a directory symlink; Windows makes the product's absolute junction. */
export function createJunction(target, link) {
  fs.symlinkSync(path.resolve(target), link, 'junction');
}

/** Check a portable literal command, not arbitrary cmd.exe/PowerShell programs. */
export function assertWindowsCommandSafe(command) {
  assert.equal(typeof command, 'string');
  assert.ok(command.trim(), 'Empty command');
  // cmd.exe expands %NAME% even inside quotes. PowerShell expands variables in
  // double quotes and treats backticks as escapes; portable loaders encode data.
  assert.doesNotMatch(command, /%[^%\r\n]+%/, 'cmd.exe environment expansion');
  assert.doesNotMatch(command, /\$(?:[\w{(])|`/, 'PowerShell expansion or escaping');
  let quoted = false;
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (char === '"') { quoted = !quoted; continue; }
    if (quoted) continue; // Single quotes here are literal JS source, as in node -e.
    assert.notEqual(char, "'", 'Single-quote shell quoting is not portable to cmd.exe');
    assert.doesNotMatch(char, /[&|<>^\r\n]/, 'Unquoted shell control character');
    assert.ok(!/^(?:[a-z]:[\\/]|\\\\)/i.test(command.slice(index)),
      'Quote Windows path operands, including paths with spaces');
  }
  assert.equal(quoted, false, 'Unbalanced double quotes');
}
