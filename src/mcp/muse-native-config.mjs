import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import os from 'node:os';
import { resolveMuseXdgSkillsDir } from '../providers/muse-paths.js';
import { helperEnvironment } from '../process/cli-command.mjs';

// Mirrors tools/agents/providers/muse-hooks.mjs. src/ cannot import tools/:
// tools/ is not part of the compiled dist/ tree.
const MUSE_HOOKS_REL = join('.muse', 'hooks.json');
const MUSE_HOOKS_SIDECAR_REL = join('.muse', '.aiwg-hooks.json');

const MUSE_VERSION_TIMEOUT_MS = 5_000;

import { parseJson } from './json-document.mjs';

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function inspectMuseCli(env) {
  const result = spawnSync('muse', ['--version'], {
    env: helperEnvironment(env),
    encoding: 'utf8',
    timeout: MUSE_VERSION_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  if (result.error?.code === 'ENOENT') return 'absent';
  if (result.error?.code === 'ETIMEDOUT') return 'present (version timeout)';
  if (result.error) return 'absent';
  const firstLine = String(result.stdout || result.stderr || '').split(/\r?\n/).find((line) => line.trim());
  return firstLine ? `present (${firstLine.trim()})` : 'present (version unavailable)';
}

async function inspectMuseHooks(projectDir) {
  const hooksPath = join(projectDir, MUSE_HOOKS_REL);
  try {
    await access(hooksPath, constants.F_OK);
  } catch {
    return 'absent';
  }

  try {
    const doc = parseJson(await readFile(hooksPath, 'utf8'));
    const sessionStartGroups = Array.isArray(doc?.hooks?.SessionStart) ? doc.hooks.SessionStart : [];
    // AIWG records every group it manages in the sidecar on deploy; a group
    // counts as managed only when that recorded payload is present.
    const sidecar = parseJson(await readFile(join(projectDir, MUSE_HOOKS_SIDECAR_REL), 'utf8'));
    const recorded = Array.isArray(sidecar?.hooks)
      ? sidecar.hooks.filter((hook) => hook?.event === 'SessionStart' && hook.group)
      : [];
    return recorded.some((hook) => sessionStartGroups.some((group) => deepEqual(group, hook.group)))
      ? 'managed'
      : 'operator-only';
  } catch {
    // Unreadable hooks or a missing/malformed sidecar: nothing proves AIWG
    // owns these groups.
    return 'operator-only';
  }
}

async function inspectMuseMcp(options) {
  // <xdg>/muse/skills -> <xdg>/muse/settings.json; bad XDG metadata yields
  // no path (never ~/.muse).
  const skillsDir = resolveMuseXdgSkillsDir(options.env || process.env, options.userHome || os.homedir());
  if (!skillsDir) return 'unreadable';
  const settingsPath = join(dirname(skillsDir), 'settings.json');
  try {
    const settings = parseJson(await readFile(settingsPath, 'utf8'));
    return settings?.mcp_servers && typeof settings.mcp_servers === 'object'
      && Object.prototype.hasOwnProperty.call(settings.mcp_servers, 'aiwg')
      ? 'configured'
      : 'absent';
  } catch (error) {
    if (error?.code === 'ENOENT') return 'absent';
    return 'unreadable';
  }
}

export async function inspectMuseNative(options = {}) {
  return {
    cli: inspectMuseCli(options.env || process.env),
    hooks: await inspectMuseHooks(options.projectDir || process.cwd()),
    mcp: await inspectMuseMcp(options),
  };
}

export async function isMuseDeployedProject(projectDir = process.cwd()) {
  try {
    const raw = await readFile(join(projectDir, '.aiwg', 'aiwg.config'), 'utf8');
    const config = parseJson(raw);
    if (Array.isArray(config?.providers) && config.providers.includes('muse')) return true;
    return Object.values(config?.installed || {}).some((entry) => entry?.deployedTo?.muse);
  } catch {
    return false;
  }
}
