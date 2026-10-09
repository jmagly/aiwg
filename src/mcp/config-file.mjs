import { urlCarriesUserinfo } from './credentials.mjs';
import { access, lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { getMcpInjectionDefinition } from '../providers/provider-definitions.mjs';

export async function assertNoSymlinkParents(file, configRoot = dirname(resolve(file))) {
  const root = resolve(configRoot);
  const rel = relative(root, resolve(file));
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`MCP config ${file} must be beneath the config directory ${root}`);
  }
  let parent = dirname(resolve(file));
  while (parent !== root) {
    try {
      if ((await lstat(parent)).isSymbolicLink()) {
        throw new Error(`Refusing to write MCP config ${file}: parent directory is a symlink`);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    parent = dirname(parent);
  }
}

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

export async function writeConfigAtomic(file, content, { userScope = false, projectRoot, newFileMode, mode: restoreMode, rejectSymlinkParents = false, symlinkRoot } = {}) {
  if (rejectSymlinkParents) await assertNoSymlinkParents(file, symlinkRoot);
  const info = await assertConfigDestination(file, projectRoot);
  const mode = restoreMode ?? (userScope ? 0o600 : info ? info.mode & 0o7777 : newFileMode ?? 0o666);
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', mode);
    await handle.writeFile(content, 'utf-8');
    if (userScope || info || restoreMode !== undefined || newFileMode !== undefined) await handle.chmod(mode);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (rejectSymlinkParents) await assertNoSymlinkParents(file, symlinkRoot);
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

/** Resolve existing parent aliases without creating directories during a dry run. */
export async function canonicalConfigPath(file) {
  let parent = dirname(resolve(file));
  const missing = [];
  while (true) {
    try {
      return resolve(await realpath(parent), ...missing, basename(file));
    } catch (error) {
      if (error.code !== 'ENOENT' || dirname(parent) === parent) throw error;
      missing.unshift(basename(parent));
      parent = dirname(parent);
    }
  }
}

/** Check the destination and the nearest existing parent before a multi-file write. */
export async function prepareConfigWrite(file, options = {}) {
  await assertConfigDestination(file, options.projectRoot);
  let parent = dirname(resolve(file));
  while (true) {
    try {
      // Follow a root/home alias, just as assertConfigDestination does.
      const actual = await realpath(parent);
      if (!(await lstat(actual)).isDirectory()) throw new Error(`Config parent ${parent} must be a directory`);
      await access(actual, constants.W_OK | constants.X_OK);
      return;
    } catch (error) {
      if (error.code !== 'ENOENT' || dirname(parent) === parent) {
        throw new Error(`Cannot prepare config destination ${file}: ${error.message}`);
      }
      parent = dirname(parent);
    }
  }
}

/** Write MCP, settings and ownership in the supplied order, restoring earlier files on failure. */
export async function writeConfigTransaction(writes) {
  const originals = [];
  for (const { file, options = {} } of writes) {
    await prepareConfigWrite(file, options);
    const info = await assertConfigDestination(file, options.projectRoot);
    originals.push(info ? { content: await readFile(file), mode: info.mode & 0o7777 } : null);
  }
  let completed = 0;
  try {
    for (const { file, content, options } of writes) {
      await writeConfigAtomic(file, content, options);
      completed++;
    }
  } catch (error) {
    const failures = [];
    for (let index = completed - 1; index >= 0; index--) {
      const { file, options = {} } = writes[index];
      try {
        if (originals[index]) {
          await writeConfigAtomic(file, originals[index].content, { ...options, mode: originals[index].mode });
        } else {
          await assertConfigDestination(file, options.projectRoot);
          await unlink(file);
        }
      } catch (rollbackError) {
        failures.push(`${file}: ${rollbackError.message}`);
      }
    }
    if (failures.length) throw new Error(`${error.message}; config rollback failed: ${failures.join('; ')}`);
    throw error;
  }
}
