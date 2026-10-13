import { urlCarriesUserinfo, credentialLikeArgs, credentialLikeQueryParams, credentialLikeFragmentParams, isCredentialReferenceValue } from './credentials.mjs';
import { access, lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { getMcpInjectionDefinition, resolveMcpConfigPath } from '../providers/provider-definitions.mjs';

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

/** True when the resolved destination lives inside the project directory. */
export function isPathInsideDir(file, dir) {
  const root = resolve(dir);
  const rel = relative(root, resolve(file));
  return Boolean(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Refuse a `--scope user` request the provider cannot honour: when the
 * resolved destination is still the project file, the request would silently
 * write secrets to a shareable location. Providers whose destination is
 * genuinely outside the project (home configs, explicit user paths) pass.
 */
export function assertSupportedScope(provider, scope, configPath, projectDir = '.') {
  if (scope !== 'user') return;
  if (!isPathInsideDir(configPath, projectDir)) return;
  throw new Error(`Provider "${provider}" has no user-scope destination: --scope user would still write the project file ${configPath}. Use --scope project with --header-env/--env-from references instead of literal credentials.`);
}

/**
 * The single place every MCP config writer - `inject`, `install`, and OMP's
 * `install`/`uninject` - decides whether a destination is a project write.
 * The decision follows the RESOLVED destination, never the requested scope
 * string and never a provider's home-directory override (e.g.
 * `PI_CODING_AGENT_DIR`, `CODEX_HOME`, `GROK_HOME`): a destination that still
 * resolves inside the project directory gets project containment rules
 * (ancestor-symlink checks, literal-credential refusal) regardless of what
 * scope was requested or which environment variable produced the path.
 * `userScope: true` from this function means the destination is genuinely
 * outside the project; callers must never override it with a flag of their
 * own, and must never derive it from `scope` again downstream.
 *
 * Throws via `assertSupportedScope` when `--scope user` was requested but the
 * destination is still inside the project (no private destination exists).
 */
export function classifyMcpDestination(provider, scope, configPath, projectDir = '.') {
  assertSupportedScope(provider, scope, configPath, projectDir);
  const inProject = isPathInsideDir(configPath, projectDir);
  return { userScope: !inProject, projectRoot: inProject ? projectDir : undefined };
}

/**
 * Remediation for a project-scope literal refusal that names the provider's
 * real private destination when it has one, instead of always naming
 * ~/.claude.json. Providers without a user-scope destination get reference
 * guidance instead.
 */
export function projectCredentialRemedy(provider, projectDir = '.') {
  try {
    const userPath = resolveMcpConfigPath(provider, projectDir, { scope: 'user' });
    const projectPath = resolveMcpConfigPath(provider, projectDir, { scope: 'project' });
    if (userPath && userPath !== projectPath && !isPathInsideDir(userPath, projectDir)) {
      return `Use --scope user to write private ${userPath} instead, or move secrets into environment variables with --header-env/--env-from references.`;
    }
  } catch {
    // An unresolvable user destination means references are the only remedy.
  }
  return `Move secrets into environment variables with --header-env/--env-from references instead; --scope user has no private destination for provider "${provider}".`;
}

/** Reject non-string env/headers values with a schema-style error. */
function assertStringMap(server, field) {
  const entries = server[field];
  if (entries === undefined || entries === null) return {};
  if (typeof entries !== 'object' || Array.isArray(entries)) {
    throw new Error(`Invalid MCP server "${server.name}": ${field} must be an object`);
  }
  for (const [key, value] of Object.entries(entries)) {
    if (typeof value !== 'string') {
      throw new Error(`Invalid MCP server "${server.name}": ${field}["${key}"] must be a string`);
    }
  }
  return entries;
}

export function assertProjectCredentials(servers, configPath, remedy) {
  const literals = servers.flatMap(server => {
    const reasons = [];
    // A value is shareable only when it is empty or a supported reference
    // form (${VAR}, ${env:VAR}, {env:VAR}); any other string is a literal.
    for (const field of ['env', 'headers']) {
      const entries = assertStringMap(server, field);
      const literalKeys = Object.entries(entries)
        .filter(([, value]) => value !== '' && !isCredentialReferenceValue(value))
        .map(([key]) => key);
      if (literalKeys.length) reasons.push(`${server.name} has literal ${field} values (${literalKeys.join(', ')})`);
    }
    // OMP persists auth/oauth beside env/headers, so the same refusal covers
    // any secret-bearing value there; `type` alone selects a flow, not a secret.
    // This deliberately includes all URL fields (tokenUrl/redirectUri/resource),
    // so OAuth query and fragment credentials cannot bypass project protection.
    for (const field of ['auth', 'oauth']) {
      const section = server[field];
      if (section !== undefined && section !== null) {
        if (typeof section !== 'object' || Array.isArray(section)) {
          throw new Error(`Invalid MCP server "${server.name}": ${field} must be an object`);
        }
        const literalKeys = Object.keys(section).filter(key =>
          key !== 'type' && section[key] !== '' && section[key] !== undefined && section[key] !== null);
        if (literalKeys.length) reasons.push(`${server.name} has literal ${field} values (${literalKeys.join(', ')})`);
      }
    }
    if (urlCarriesUserinfo(server.url)) reasons.push(`${server.name} has URL userinfo`);
    if (credentialLikeQueryParams(server.url).length) reasons.push(`${server.name} has URL query credentials`);
    if (credentialLikeFragmentParams(server.url).length) reasons.push(`${server.name} has URL fragment credentials`);
    // A flag like --token=... or --password <value> almost always carries the secret
    // in argv, visible to every process listing on the host; the same literal-credential
    // refusal that applies to env/headers applies here for a shareable project file.
    // Name only the flag, never the "--flag=value" form's value half.
    const argFlags = credentialLikeArgs(server.args).map(arg => arg.split('=')[0].split(' ')[0]);
    if (argFlags.length) reasons.push(`${server.name} has credential-like args (${argFlags.join(', ')})`);
    return reasons;
  });
  if (literals.length) {
    throw new Error(`Refusing to write project MCP config ${configPath}: ${literals.join('; ')}. ${remedy || 'Use --scope user to write to a private destination instead.'}`);
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
