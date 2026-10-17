import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { assertConfigDestination, assertConfigObject } from './config-file.mjs';

/** Desktop is a user-level surface, independent of the Code project config. */
export function claudeDesktopConfigPath(platform = process.platform, env = process.env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const base = platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
    : platform === 'win32' ? (env.APPDATA || path.join(home, 'AppData', 'Roaming'))
      : path.join(home, '.config');
  return path.join(base, 'Claude', 'claude_desktop_config.json');
}

export function resolveClaudeInstallTarget(target, scope, env = process.env) {
  if (target !== 'claude') return target;
  return scope === 'user' || env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT || env.CLAUDE_CODE_DESKTOP_APP_VERSION
    ? 'claude-code' : 'claude-desktop';
}

/** Plan removal only of the exact legacy built-in stanza, never custom servers. */
export async function legacyClaudeMigration(projectDir) {
  const file = path.resolve(projectDir, '.claude/settings.local.json');
  await assertConfigDestination(file, projectDir);
  let settings;
  try {
    settings = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  assertConfigObject(settings, 'mcpServers');
  const server = settings.mcpServers?.aiwg;
  if (!server || server.command !== 'aiwg' || JSON.stringify(server.args) !== '["mcp","serve"]'
    || Object.keys(server).some(key => !['command', 'args', 'env'].includes(key))
    || (server.env !== undefined && (!server.env || typeof server.env !== 'object' || Array.isArray(server.env)
      || Object.keys(server.env).some(key => key !== 'AIWG_ROOT')))) return [];
  delete settings.mcpServers.aiwg;
  if (Object.keys(settings.mcpServers).length === 0) delete settings.mcpServers;
  return [{ file, content: JSON.stringify(settings, null, 2), options: { projectRoot: projectDir } }];
}
