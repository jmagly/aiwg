import { constants } from 'node:fs';
import { access, lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { replaceServer } from './toml-editor.mjs';

const START = name => `# >>> AIWG-managed Grok MCP: ${name}`;
const END = name => `# <<< AIWG-managed Grok MCP: ${name}`;
const ENV_REF = /^(?:[^$]|\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\})*$/;

function string(value) {
  if (typeof value !== 'string') throw new Error('Grok MCP string fields must be strings');
  return JSON.stringify(value).replace(/\u007f/g, '\\u007f');
}

function key(value) {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : string(value);
}

function inline(values = {}) {
  return `{ ${Object.entries(values).map(([name, value]) => `${key(name)} = ${string(value)}`).join(', ')} }`;
}

export function renderGrokMcpServer(server) {
  if (!server?.name) throw new Error('Grok MCP server name is required');
  const lines = [`[mcp_servers.${key(server.name)}]`];
  if (server.type === 'stdio') {
    if (!server.command) throw new Error(`Grok MCP stdio server "${server.name}" requires command`);
    lines.push(`command = ${string(server.command)}`);
    if (server.args?.length) lines.push(`args = [${server.args.map(string).join(', ')}]`);
    if (server.env && Object.keys(server.env).length) lines.push(`env = ${inline(server.env)}`);
  } else {
    if (!server.url) throw new Error(`Grok MCP HTTP server "${server.name}" requires url`);
    lines.push(`url = ${string(server.url)}`);
    const headers = { ...(server.headers || {}) };
    for (const [header, envName] of Object.entries(server.headerEnv || {})) {
      headers[header] = `\${${envName}}`;
    }
    if (Object.keys(headers).length) lines.push(`headers = ${inline(headers)}`);
  }
  if (server.enabled === false) lines.push('enabled = false');
  for (const value of [server.command, server.url, ...(server.args || []), ...Object.values(server.env || {}), ...Object.values(server.headers || {})]) {
    if (typeof value === 'string' && value.includes('$') && !ENV_REF.test(value)) {
      throw new Error(`Grok MCP server "${server.name}" contains an invalid environment reference`);
    }
  }
  lines.push('startup_timeout_sec = 30', 'tool_timeout_sec = 6000');
  return lines.join('\n');
}

function managedRange(text, name) {
  let start = text.indexOf(START(name));
  const endMarker = END(name);
  const end = text.indexOf(endMarker);
  if (start < 0 && end < 0) return null;
  if (start < 0 || end < start) throw new Error(`Malformed AIWG ownership markers for Grok MCP server "${name}"`);
  // Deployment owns the single blank separator it adds before its marker.
  if (start > 0 && text.slice(start - 2, start) === '\n\n') start -= 1;
  return [start, end + endMarker.length + (text[end + endMarker.length] === '\n' ? 1 : 0)];
}

export function mergeGrokMcpServers(text, servers) {
  let output = text;
  const seen = new Set();
  for (const server of servers) {
    if (seen.has(server.name)) throw new Error(`Duplicate Grok MCP server name "${server.name}"`);
    seen.add(server.name);
    const section = renderGrokMcpServer(server);
    const range = managedRange(output, server.name);
    const probeText = range ? output.slice(0, range[0]) + output.slice(range[1]) : output;
    const probe = replaceServer(probeText, server.name, section);
    if (!range && probe.alreadyPresent) {
      throw new Error(`Grok MCP server "${server.name}" is operator-managed; refusing to replace it`);
    }
    const prefix = range ? output.slice(0, range[0]) : `${output}${output && !output.endsWith('\n') ? '\n' : ''}`;
    const block = `${prefix ? '\n' : ''}${START(server.name)}\n${section}\n${END(server.name)}\n`;
    output = range ? prefix + block + output.slice(range[1]) : prefix + block;
    // Parse and validate the completed document without exposing its content.
    replaceServer(output, '__aiwg_validation_probe__', '[mcp_servers.__aiwg_validation_probe__]\ncommand = "true"');
  }
  return output;
}

export function removeGrokMcpServers(text, names) {
  let output = text;
  const removed = [];
  for (const name of names) {
    const range = managedRange(output, name);
    if (!range) continue;
    output = output.slice(0, range[0]) + output.slice(range[1]);
    removed.push(name);
  }
  if (output) replaceServer(output, '__aiwg_validation_probe__', '[mcp_servers.__aiwg_validation_probe__]\ncommand = "true"');
  return { text: output, removed };
}

async function assertSafeTarget(configPath, root) {
  const absolute = resolve(configPath);
  const base = resolve(root);
  const rel = relative(base, absolute);
  if (!rel || rel.startsWith('..') || rel.startsWith('/') || rel.includes('\0')) {
    throw new Error('Grok MCP config path must be a file beneath the selected configuration root');
  }
  for (let current = dirname(absolute); current !== base; current = dirname(current)) {
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error('Refusing Grok MCP path through a symbolic link');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  try {
    const info = await lstat(absolute);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('Refusing unsafe Grok MCP config target');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function atomicWrite(file, content) {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.aiwg-${process.pid}-${Date.now()}.tmp`;
  try {
    const handle = await open(temp, 'wx', 0o600);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

export async function manageGrokBuildMcp(configPath, servers, options = {}) {
  const root = options.root || dirname(dirname(configPath));
  if (options.blockedByPolicy) return { configPath, state: 'blocked-by-policy', serversInjected: [], alreadyPresent: [], error: options.blockedByPolicy };
  await assertSafeTarget(configPath, root);
  let before = '';
  try { before = await readFile(configPath, 'utf8'); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const alreadyPresent = servers.filter(server => managedRange(before, server.name)).map(server => server.name);
  const after = mergeGrokMcpServers(before, servers);
  if (!options.dryRun && after !== before) await atomicWrite(configPath, after);
  return { configPath, state: options.disabled ? 'disabled' : 'configured', serversInjected: servers.map(server => server.name), alreadyPresent };
}

export async function unmanageGrokBuildMcp(configPath, names, options = {}) {
  const root = options.root || dirname(dirname(configPath));
  await assertSafeTarget(configPath, root);
  let before;
  try { before = await readFile(configPath, 'utf8'); } catch (error) { if (error?.code === 'ENOENT') return { configPath, state: 'absent', removed: [] }; throw error; }
  const result = removeGrokMcpServers(before, names);
  if (!options.dryRun && result.text !== before) await atomicWrite(configPath, result.text);
  return { configPath, state: result.removed.length ? 'configured' : 'absent', removed: result.removed };
}

function runJson(binary, args, cwd, env) {
  const run = spawnSync(binary, args, { cwd, env, encoding: 'utf8', timeout: 30_000 });
  if (run.error || run.status !== 0) return { ok: false, detail: run.error?.message || run.stderr || `exit ${run.status}` };
  try { return { ok: true, value: JSON.parse(run.stdout || '{}') }; }
  catch { return { ok: false, detail: 'Grok returned malformed JSON' }; }
}

export async function inspectGrokBuildNative(options = {}) {
  const configPath = options.configPath || resolve(options.projectDir || '.', '.grok/config.toml');
  let config = '';
  try { config = await readFile(configPath, 'utf8'); } catch (error) { if (error?.code === 'ENOENT') return { mcp: 'absent', hooks: 'absent', diagnostics: [] }; throw error; }
  const disabled = /\benabled\s*=\s*false\b/.test(config);
  const names = [...config.matchAll(/# >>> AIWG-managed Grok MCP: ([^\n]+)/g)].map(match => match[1]);
  let mcp = names.length ? (disabled ? 'disabled' : 'configured') : 'absent';
  const diagnostics = [];
  if (options.blockedByPolicy) mcp = 'blocked-by-policy';
  if (options.binary && names.length) {
    const inspected = runJson(options.binary, ['inspect', '--json'], options.projectDir || '.', options.env || process.env);
    if (!inspected.ok || !names.every(name => JSON.stringify(inspected.value || {}).includes(name))) {
      mcp = 'unhealthy';
      diagnostics.push(inspected.ok ? 'grok inspect did not expose every AIWG-managed MCP server' : inspected.detail);
    }
    const listed = runJson(options.binary, ['mcp', 'list', '--json'], options.projectDir || '.', options.env || process.env);
    if (!listed.ok) { mcp = 'unhealthy'; diagnostics.push(listed.detail); }
    for (const name of names) {
      const doctor = runJson(options.binary, ['mcp', 'doctor', name, '--json'], options.projectDir || '.', options.env || process.env);
      if (!doctor.ok) { mcp = 'unhealthy'; diagnostics.push(`${name}: ${doctor.detail}`); }
    }
  }
  const hooksDir = resolve(options.projectDir || '.', '.grok/hooks');
  let hooks = 'absent';
  try { await access(hooksDir, constants.R_OK); hooks = options.trusted === true ? 'configured' : 'untrusted'; } catch { /* absent */ }
  return { mcp, hooks, servers: names, diagnostics };
}
