import { assertConfigDestination, writeConfigAtomic } from './config-file.mjs';
import { readFile, mkdir, lstat, unlink, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
async function readObject(file, projectRoot) {
  await assertConfigDestination(file, projectRoot);
  try {
    if ((await lstat(file)).isSymbolicLink()) throw new Error('OMP MCP configuration cannot be a symbolic link');
    const data = JSON.parse(await readFile(file, 'utf8'));
    if (!record(data)) throw new Error('OMP MCP configuration must be an object');
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    if (error instanceof SyntaxError) throw new Error('OMP MCP configuration is invalid JSON; repair it before injection');
    throw error;
  }
}
async function atomic(file, data, options) {
  await writeConfigAtomic(file, JSON.stringify(data, null, 2) + '\n', options);
}

export function ompServerConfig(server) {
  const config = {};
  for (const field of ['command', 'args', 'env', 'cwd', 'url', 'headers', 'enabled', 'timeout', 'requestIdFormat', 'auth', 'oauth', 'type']) {
    if (server[field] !== undefined) config[field] = server[field];
  }
  if (!config.command && !config.url && config.enabled !== false) throw new Error(`OMP MCP server ${server.name} needs command or url`);
  if (config.type !== undefined && !['stdio', 'http', 'sse'].includes(config.type)) throw new Error('Invalid OMP MCP transport');
  if (config.command && config.url) throw new Error('OMP MCP server must choose command or url');
  if (config.enabled !== false && (config.type === 'stdio' && !config.command || ['http', 'sse'].includes(config.type) && !config.url)) throw new Error('OMP MCP transport does not match endpoint');
  for (const field of ['command', 'cwd', 'url']) {
    if (config[field] !== undefined && typeof config[field] !== 'string') throw new Error(`Invalid OMP MCP ${field}`);
  }
  if (config.args !== undefined && (!Array.isArray(config.args) || config.args.some(x => typeof x !== 'string'))) throw new Error('Invalid OMP MCP args');
  for (const field of ['env', 'headers']) {
    if (config[field] !== undefined && (!record(config[field]) || Object.values(config[field]).some(x => typeof x !== 'string'))) throw new Error(`Invalid OMP MCP ${field}`);
  }
  if (config.requestIdFormat !== undefined && !['string', 'number'].includes(config.requestIdFormat)) throw new Error('Invalid OMP MCP requestIdFormat');
  if (config.auth !== undefined && (!record(config.auth) || !['oauth', 'apikey'].includes(config.auth.type))) throw new Error('Invalid OMP MCP auth');
  if (config.oauth !== undefined && !record(config.oauth)) throw new Error('Invalid OMP MCP oauth');
  if (config.timeout !== undefined && (!Number.isFinite(config.timeout) || config.timeout < 0)) throw new Error('Invalid OMP MCP timeout');
  if (config.enabled !== undefined && typeof config.enabled !== 'boolean') throw new Error('Invalid OMP MCP enabled flag');
  for (const field of ['envPolicy', 'envLiteralKeys', 'headerPolicy']) {
    if (server[field] !== undefined) throw new Error(`OMP native mcp.json does not enforce ${field}; this control requires the native SDK/plugin interface`);
  }
  for (const field of ['auth', 'oauth']) {
    if (config[field]) for (const [key, value] of Object.entries(config[field])) {
      if (key === 'callbackPort') { if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error('Invalid OMP MCP callbackPort'); }
      else if (['type', 'credentialId', 'tokenUrl', 'clientId', 'clientSecret', 'resource', 'scope', 'redirectUri', 'callbackPath', 'prompt'].includes(key) && typeof value !== 'string') throw new Error(`Invalid OMP MCP ${field}.${key}`);
    }
  }
  if (server.headerEnv) {
    config.headers = { ...config.headers };
    for (const [header, variable] of Object.entries(server.headerEnv)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) throw new Error('Invalid MCP header environment reference');
      config.headers[header] = '${' + variable + '}';
    }
  }
  return config;
}

/** Hash-only receipt: never saves an extra copy of operator configuration. */
async function manageLockedOmpMcp(configPath, servers, { dryRun = false, remove = [], userScope = true, projectRoot } = {}) {
  const receiptPath = `${configPath}.aiwg-ownership.json`;
  const existing = await readObject(configPath, projectRoot);
  const receipt = await readObject(receiptPath, projectRoot);
  if (receipt.servers !== undefined && (!record(receipt.servers) || receipt.schema !== 'aiwg.omp-mcp-ownership.v1')) throw new Error('Invalid OMP MCP ownership receipt');
  if (existing.mcpServers !== undefined && !record(existing.mcpServers)) throw new Error('Invalid OMP mcpServers object');
  const next = { ...(existing.mcpServers || {}) };
  const owned = { ...(receipt.servers || {}) };
  const result = { configPath, serversInjected: [], alreadyPresent: [], removed: [] };
  // Validate all collisions before the first write.
  for (const name of [...servers.map(s => s.name), ...remove]) {
    if (typeof name !== 'string' || !name || ['__proto__', 'constructor', 'prototype'].includes(name)) throw new Error('Invalid OMP MCP server name');
    if (Object.hasOwn(next, name) && owned[name] !== hash(next[name])) {
      throw new Error(`OMP MCP server ${name} is operator-owned or modified; preserve it and choose a different name`);
    }
  }
  for (const server of servers) {
    if (!server.name || ['__proto__', 'constructor', 'prototype'].includes(server.name)) throw new Error('Invalid OMP MCP server name');
    if (Object.hasOwn(next, server.name)) result.alreadyPresent.push(server.name);
    next[server.name] = ompServerConfig(server);
    owned[server.name] = hash(next[server.name]);
    result.serversInjected.push(server.name);
  }
  for (const name of remove) {
    if (owned[name]) { delete next[name]; delete owned[name]; result.removed.push(name); }
  }
  if (!dryRun) {
    if (hash(await readObject(configPath, projectRoot)) !== hash(existing) || hash(await readObject(receiptPath, projectRoot)) !== hash(receipt)) throw new Error('OMP MCP configuration changed during injection; retry after reviewing the operator edit');
    // If interrupted between writes, a retry fails closed on the hash mismatch.
    await atomic(configPath, { ...existing, mcpServers: next }, { userScope, projectRoot });
    await atomic(receiptPath, { schema: 'aiwg.omp-mcp-ownership.v1', servers: owned }, { userScope: true, projectRoot });
  }
  return result;
}

/** Serialize AIWG writers; operator edits detected before committing a replacement. */
export async function manageOmpMcp(configPath, servers, options = {}) {
  if (options.dryRun) return manageLockedOmpMcp(configPath, servers, options);
  await assertConfigDestination(configPath, options.projectRoot);
  const lockPath = `${configPath}.aiwg-lock`;
  await assertConfigDestination(lockPath, options.projectRoot);
  await mkdir(dirname(configPath), { recursive: true });
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('OMP MCP injection already locked; wait for the active writer or review a stale lock before retrying'); throw error; }
  try { return await manageLockedOmpMcp(configPath, servers, options); }
  finally { await lock.close(); await unlink(lockPath); }
}
