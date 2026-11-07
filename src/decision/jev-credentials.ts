import { resolveDecisionEnablement } from '../config/decision-config.js';
import { constants } from 'node:fs';
import { access, chmod, lstat, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { JevCredentialError } from './adapters/jev.js';
import { readPrivateValueFile } from '../auth/sensitive-input.js';
import { readJevReference } from '../config/jev-credential-reference.js';
import { JevReferenceUnavailable, resolveOpenBaoJev } from './openbao-runtime.js';

export interface JevCredentialRecord {
  token: string;
  region: string;
  endpoint?: string;
  enabled?: boolean;
}

export interface JevCredentialLookupResult {
  source: 'env' | 'file' | 'openbao';
  token: string;
  region: string;
  endpoint?: string;
  enabled: boolean;
}

export interface JevCredentialInspection {
  configured: boolean | null;
  enabled: boolean | null;
  source: 'env' | 'file' | 'openbao' | 'none' | 'unknown';
  path?: string;
}

export interface JevCredentialOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  configHome?: string;
  homeDir?: string;
  credentialPath?: string;
}

export const JEV_CREDENTIAL_REF = 'typesafe-api';
export const JEV_DEFAULT_REGION = 'us';

function env(options: JevCredentialOptions): NodeJS.ProcessEnv {
  return options.env ?? process.env;
}

export function jevCredentialPath(options: JevCredentialOptions = {}): string {
  if (options.credentialPath) return options.credentialPath;
  const configuredHome = options.configHome ?? env(options).XDG_CONFIG_HOME;
  const base = configuredHome && configuredHome.trim() ? configuredHome : path.join(options.homeDir ?? os.homedir(), '.config');
  return path.join(base, 'aiwg', 'credentials', 'jev.json');
}

function isInsecureMode(mode: number): boolean {
  return (mode & 0o077) !== 0;
}

function parseRecord(raw: string): JevCredentialRecord {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new JevCredentialError('configuration');
  const record = parsed as Record<string, unknown>;
  if (typeof record.token !== 'string' || !record.token.trim()) throw new JevCredentialError('configuration');
  if (record.region !== undefined && (typeof record.region !== 'string' || !record.region.trim())) {
    throw new JevCredentialError('configuration');
  }
  if (record.endpoint !== undefined && (typeof record.endpoint !== 'string' || !record.endpoint.trim())) {
    throw new JevCredentialError('configuration');
  }
  if (record.enabled !== undefined && typeof record.enabled !== 'boolean') throw new JevCredentialError('configuration');
  return {
    token: record.token,
    region: typeof record.region === 'string' ? record.region : JEV_DEFAULT_REGION,
    ...(typeof record.endpoint === 'string' ? { endpoint: record.endpoint } : {}),
    ...(typeof record.enabled === 'boolean' ? { enabled: record.enabled } : {}),
  };
}

async function readCredentialFile(options: JevCredentialOptions = {}): Promise<JevCredentialRecord | null> {
  const credentialPath = jevCredentialPath(options);
  try {
    // Preserve the missing-file result and the existing directory requirement.
    // The shared reader validates the opened descriptor, including ownership
    // and link checks, before any credential record is parsed.
    const [, parentStat] = await Promise.all([lstat(credentialPath), stat(path.dirname(credentialPath))]);
    if (isInsecureMode(parentStat.mode)) {
      throw Object.assign(new JevCredentialError('denied'), { message: 'Jev credential directory must not allow group or other access (chmod 700).' });
    }
    let raw: string;
    try { raw = await readPrivateValueFile(credentialPath, 'Jev credential file'); }
    catch (error) {
      // Shared private-file diagnostics contain no path or credential bytes.
      throw Object.assign(new JevCredentialError('denied'), { message: (error as Error).message });
    }
    return parseRecord(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof JevCredentialError) throw error;
    if (error instanceof SyntaxError) throw new JevCredentialError('configuration');
    throw error;
  }
}

export async function lookupJevCredential(options: JevCredentialOptions = {}): Promise<JevCredentialLookupResult | null> {
  const environment = env(options);
  const forced = environment.AIWG_DECISION_ENABLED;
  const envToken = environment.JEV_API_KEY?.trim() || environment.AIWG_DECISION_JEV_API_KEY?.trim();
  if (!envToken) {
    try {
      const reference = readJevReference(options);
      if (reference) {
        const { enabled } = resolveDecisionEnablement(options);
        return { source: 'openbao', token: enabled ? await resolveOpenBaoJev(reference, environment) : '', enabled,
          region: environment.AIWG_DECISION_JEV_REGION?.trim() || JEV_DEFAULT_REGION,
          ...(environment.AIWG_DECISION_JEV_ENDPOINT?.trim() ? { endpoint: environment.AIWG_DECISION_JEV_ENDPOINT.trim() } : {}) };
      }
    } catch { throw new JevReferenceUnavailable(); }
  }
  const fileRecord = envToken && (forced === '0' || forced === '1') ? null : await readCredentialFile(options);
  const enablement = resolveDecisionEnablement(options);
  const enabled = enablement.source === 'default' ? fileRecord?.enabled === true : enablement.enabled;
  if (envToken) return {
    source: 'env',
    token: envToken,
    region: environment.AIWG_DECISION_JEV_REGION?.trim() || fileRecord?.region || JEV_DEFAULT_REGION,
    ...(environment.AIWG_DECISION_JEV_ENDPOINT?.trim() ? { endpoint: environment.AIWG_DECISION_JEV_ENDPOINT.trim() }
      : fileRecord?.endpoint ? { endpoint: fileRecord.endpoint } : {}),
    enabled,
  };
  if (!fileRecord) return null;
  return { source: 'file', token: fileRecord.token, region: fileRecord.region, ...(fileRecord.endpoint ? { endpoint: fileRecord.endpoint } : {}), enabled };
}

/** Offline metadata-only inspection. Never probes Jev and never returns credential bytes. */
export async function inspectJevCredential(options: JevCredentialOptions = {}): Promise<JevCredentialInspection> {
  try {
    const environment = env(options);
    if (!(environment.JEV_API_KEY?.trim() || environment.AIWG_DECISION_JEV_API_KEY?.trim())) {
      const reference = readJevReference(options);
      if (reference) return { configured: true, enabled: resolveDecisionEnablement(options).enabled, source: 'openbao', path: reference.path };
    }
    const credential = await lookupJevCredential(options);
    if (!credential) return { configured: false, enabled: false, source: 'none' };
    return { configured: true, enabled: credential.enabled, source: credential.source };
  } catch {
    return { configured: null, enabled: null, source: 'unknown' };
  }
}

export async function resolveJevCredentialBytes(logicalRef: string, options: JevCredentialOptions = {}): Promise<Uint8Array> {
  if (logicalRef !== JEV_CREDENTIAL_REF) throw new JevCredentialError('configuration');
  const credential = await lookupJevCredential(options);
  if (!credential?.enabled) throw new JevCredentialError('denied');
  if (!credential.token) throw new JevCredentialError('missing');
  return new TextEncoder().encode(credential.token);
}

export async function writeJevCredentialFile(record: JevCredentialRecord, options: JevCredentialOptions = {}): Promise<string> {
  const credentialPath = jevCredentialPath(options);
  const directory = path.dirname(credentialPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const tmp = path.join(directory, `.jev.${process.pid}.${randomUUID()}.tmp`);
  const body = `${JSON.stringify(record, null, 2)}\n`;
  try {
    await writeFile(tmp, body, { mode: 0o600, flag: 'wx' });
    await chmod(tmp, 0o600);
    await rename(tmp, credentialPath);
    await chmod(credentialPath, 0o600);
    return credentialPath;
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function removeJevCredentialFile(options: JevCredentialOptions = {}): Promise<boolean> {
  const credentialPath = jevCredentialPath(options);
  try {
    await access(credentialPath, constants.F_OK);
  } catch {
    return false;
  }
  await rm(credentialPath, { force: true });
  return true;
}
