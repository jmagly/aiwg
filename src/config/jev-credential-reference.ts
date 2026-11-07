// Validate and load reference-only Jev configuration in the existing decision scope.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseYamlSimple } from './user-config.js';
import { resolveUserConfigDir } from './user-config-dir.mjs';
import type { DecisionEnablementOptions } from './decision-config.js';

export interface JevOpenBaoReference {
  source: 'openbao';
  /** Persist the OpenBao HTTPS origin when sessions do not inherit BAO_ADDR. */
  addr?: string;
  path: string;
  field: string;
  auth: { method: 'approle'; role: string };
}

const segment = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const only = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));

function validOrigin(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/';
  } catch { return false; }
}

export function validJevReference(value: unknown): value is JevOpenBaoReference {
  if (!object(value) || !only(value, ['source', 'addr', 'path', 'field', 'auth']) || value.source !== 'openbao'
    || (value.addr !== undefined && !validOrigin(value.addr))) return false;
  const parts = typeof value.path === 'string' ? value.path.split('/') : [];
  return parts.length >= 3 && parts[1] === 'data' && parts.every(part => segment.test(part))
    && typeof value.field === 'string' && segment.test(value.field)
    && object(value.auth) && only(value.auth, ['method', 'role']) && value.auth.method === 'approle'
    && typeof value.auth.role === 'string' && segment.test(value.auth.role);
}

export function validateJevConfig(value: unknown): string[] {
  if (value === undefined) return [];
  return object(value) && only(value, ['credential']) && validJevReference(value.credential)
    ? [] : ['decision.jev.credential must be an OpenBao KV v2 reference with field and AppRole; values and extra keys are forbidden'];
}

export function readJevReference(options: DecisionEnablementOptions = {}): JevOpenBaoReference | undefined {
  const read = (file: string, yaml = false) => {
    let raw: string;
    try { raw = readFileSync(file, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    const config = (yaml ? parseYamlSimple(raw) : JSON.parse(raw)) as { decision?: { jev?: unknown } };
    const value = config.decision?.jev;
    if (validateJevConfig(value).length) throw new Error('credential-unavailable');
    return (value as { credential?: JevOpenBaoReference } | undefined)?.credential;
  };
  return read(path.join(options.cwd ?? process.cwd(), '.aiwg', 'aiwg.config'))
    ?? read(path.join(resolveUserConfigDir(options), 'config.yaml'), true);
}
