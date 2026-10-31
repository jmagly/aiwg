// Parse remote MCP configuration and enforce credential and DNS-rebinding policy.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';

export function parseHttpOptions(args) {
  const values = new Map();
  const booleans = new Set(['allow-remote-bind']);
  const known = new Set(['transport', 'project', 'token-env', 'token-file', 'host', 'allowed-host', 'port', 'max-sessions', 'tools', 'toolsets']);
  for (let i = 0; i < args.length; i++) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(args[i]);
    if (!match) throw new Error('Expected an HTTP serve option');
    const [, name, inline] = match;
    if (booleans.has(name)) {
      if (inline !== undefined) throw new Error(`--${name} takes no value`);
      values.set(name, [true]);
      continue;
    }
    if (!known.has(name)) throw new Error(`Unknown HTTP serve option --${name}`);
    const value = inline ?? args[++i];
    if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`);
    if (values.has(name) && name !== 'allowed-host') throw new Error(`--${name} may only be supplied once`);
    values.set(name, [...(values.get(name) ?? []), value]);
  }
  const one = name => values.get(name)?.[0];
  const csv = name => one(name)?.split(',').map(value => value.trim()).filter(Boolean);
  return {
    projectDir: one('project'), tokenEnv: one('token-env'), tokenFile: one('token-file'),
    host: one('host') ?? '127.0.0.1', port: one('port') ?? 3100,
    maxSessions: one('max-sessions') ?? 8, tools: csv('tools'), toolsets: one('toolsets') ?? '',
    allowedHosts: values.get('allowed-host') ?? [], allowRemoteBind: !!one('allow-remote-bind'),
  };
}

export function boundedInteger(value, name, minimum, maximum) {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))
    || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return Number(value);
}

export function tokenDigest(token) {
  return createHash('sha256').update(token).digest();
}

export async function tokenSource({ tokenEnv, tokenFile }) {
  if (!!tokenEnv === !!tokenFile) throw new Error('HTTP requires exactly one of --token-env or --token-file');
  if (tokenEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) throw new Error('Invalid --token-env name');
  const filename = tokenFile && path.resolve(tokenFile);
  const environmentToken = tokenEnv && process.env[tokenEnv];
  const read = async () => {
    let value;
    try { value = filename ? await fs.readFile(filename, 'utf8') : environmentToken; }
    catch { throw new Error('HTTP token source is unavailable'); }
    value = value?.trim();
    if (!value || value.length > 4096 || !/^[A-Za-z0-9\-._~+/]+=*$/.test(value)) {
      throw new Error('HTTP token source must contain a nonempty bearer token');
    }
    return tokenDigest(value);
  };
  await read(); // Refuse startup with a missing/empty/unreadable credential.
  return async authorization => {
    const match = typeof authorization === 'string' && /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i.exec(authorization);
    if (!match || match[1].length > 4096) return undefined;
    try {
      const actual = tokenDigest(match[1]);
      return timingSafeEqual(actual, await read()) ? actual : undefined;
    } catch { return undefined; }
  };
}

function authority(value) {
  if (typeof value !== 'string' || !/^(?:\[[a-fA-F0-9:]+\]|[A-Za-z0-9.-]+)(?::\d+)?$/.test(value)) {
    throw new Error('Invalid allowed host');
  }
  const url = new URL(`http://${value}`);
  return { hostname: url.hostname.toLowerCase(), port: /:\d+$/.test(value) ? String(Number(value.match(/:(\d+)$/)[1])) : undefined };
}

export function hostPolicy(host, additional = []) {
  const bindHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const aliases = host === '127.0.0.1' ? ['localhost'] : [];
  const allowed = [bindHost, ...aliases, ...additional].map(authority);
  const accepts = value => {
    try {
      const candidate = authority(value);
      return allowed.some(entry => candidate.hostname === entry.hostname
        && (entry.port === undefined || candidate.port === entry.port));
    } catch { return false; }
  };
  return headers => {
    if (!accepts(headers.host)) return false;
    if (headers.origin === undefined) return true;
    try {
      const origin = new URL(headers.origin);
      return ['http:', 'https:'].includes(origin.protocol) && !origin.username && !origin.password
        && origin.pathname === '/' && !origin.search && !origin.hash && accepts(origin.host);
    } catch { return false; }
  };
}
