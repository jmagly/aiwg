import { urlCarriesUserinfo } from './credentials.mjs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getMcpInjectionDefinition } from '../providers/provider-definitions.mjs';

export async function assertConfigDestination(file, projectRoot) {
  if (projectRoot) {
    const root = resolve(projectRoot);
    const rel = relative(root, resolve(file));
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`MCP config ${file} must be beneath the project directory`);
    }
    let current = root;
    for (const component of rel.split(sep).slice(0, -1)) {
      current = resolve(current, component);
      try {
        if ((await lstat(current)).isSymbolicLink()) {
          throw new Error(`Refusing to write MCP config ${file}: parent directory is a symlink`);
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink()) throw new Error(`Refusing to write MCP config ${file}: destination is a symlink`);
    return info;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function isUserMcpScope(provider, scope) {
  return scope === 'user' || getMcpInjectionDefinition(provider)?.configPath.scope === 'home';
}

export function assertProjectCredentials(servers, configPath) {
  const literals = servers.flatMap(server => {
    const keys = [...Object.keys(server.env || {}), ...Object.keys(server.headers || {})];
    const reasons = keys.length ? [`${server.name} has literal env/header values (${keys.join(', ')})`] : [];
    if (urlCarriesUserinfo(server.url)) reasons.push(`${server.name} has URL userinfo`);
    return reasons;
  });
  if (literals.length) {
    throw new Error(`Refusing to write project MCP config ${configPath}: ${literals.join('; ')}. Use --scope user to write private ~/.claude.json instead.`);
  }
}

export function assertConfigObject(config, serversKey) {
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!isObject(config) || (Object.hasOwn(config, serversKey) && !isObject(config[serversKey]))) {
    throw new Error('MCP configuration must contain an object root and an object server map');
  }
}

export async function writeConfigAtomic(file, content, { userScope = false, projectRoot } = {}) {
  const info = await assertConfigDestination(file, projectRoot);
  const mode = userScope ? 0o600 : info ? info.mode & 0o7777 : 0o666;
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', mode);
    await handle.writeFile(content, 'utf-8');
    if (userScope || info) await handle.chmod(mode);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertConfigDestination(file, projectRoot);
    await rename(temporary, file);
  } finally {
    try {
      if (handle) await handle.close();
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
}
