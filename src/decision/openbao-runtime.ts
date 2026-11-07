// Resolve Jev references through the shared KV policy and host native secret store.
import { request as httpsRequest } from 'node:https';
import { readFile } from 'node:fs/promises';
import { createSecretStore } from '../auth/credential-store.js';
import type { JevOpenBaoReference } from '../config/jev-credential-reference.js';
// @ts-expect-error Shared ESM policy also consumed directly by qualification tools.
import { createOpenBaoKvResolver } from './openbao-kv-resolver.mjs';

export class JevReferenceUnavailable extends Error {
  constructor() { super('credential-unavailable'); }
}

const cache = new Map<string, Promise<string>>();
const safeToken = (value: unknown): value is string => typeof value === 'string' && /^[\x21-\x7e]{1,4096}$/.test(value);

/** Fixed diagnostics, no redirects, bounded body and deadline, verified TLS only. */
function requestJson(url: URL, method: string, headers: Record<string, string>, ca?: Buffer, body?: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const fail = () => { reject(new JevReferenceUnavailable()); };
    const req = httpsRequest(url, { method, headers, ca, rejectUnauthorized: true, timeout: 10_000 }, res => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 64 * 1024) { req.destroy(); fail(); }
        else chunks.push(chunk);
      });
      res.on('error', fail);
      res.on('aborted', fail);
      res.on('end', () => {
        let json: unknown;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { json = null; }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    const deadline = setTimeout(() => { req.destroy(); fail(); }, 10_000);
    req.on('close', () => clearTimeout(deadline));
    req.on('error', fail);
    req.on('timeout', () => { req.destroy(); fail(); });
    req.end(body);
  });
}

export async function resolveOpenBaoJev(ref: JevOpenBaoReference, env: NodeJS.ProcessEnv): Promise<string> {
  try {
    const addr = new URL(env.BAO_ADDR?.trim() || ref.addr || '');
    if (addr.protocol !== 'https:' || addr.username || addr.password || addr.search || addr.hash || addr.pathname !== '/'
      || env.NODE_TLS_REJECT_UNAUTHORIZED === '0' || process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new JevReferenceUnavailable();
    const key = JSON.stringify([addr.href, env.BAO_CACERT, ref]);
    let pending = cache.get(key);
    if (!pending) {
      pending = resolveReference(ref, addr, env).catch(() => { cache.delete(key); throw new JevReferenceUnavailable(); });
      cache.set(key, pending);
    }
    return await pending;
  } catch { throw new JevReferenceUnavailable(); }
}

async function resolveReference(ref: JevOpenBaoReference, addr: URL, env: NodeJS.ProcessEnv): Promise<string> {
  const ca = env.BAO_CACERT ? await readFile(env.BAO_CACERT) : undefined;
  const [mount, , ...segments] = ref.path.split('/');
  const resolver = createOpenBaoKvResolver({ schemaVersion: 'openbao-kv-resolver-config/v1', addr: addr.href,
    appRole: ref.auth.role, tokenScript: '/unused-native-store', mount,
    refs: { jev: { path: segments.join('/'), field: ref.field } } }, {
    tokenProvider: async () => {
      const read = (suffix: string) => createSecretStore({ service: 'aiwg.openbao', account: `${addr.origin}/${ref.auth.role}:${suffix}` }).loadSecret();
      const [roleId, secretId] = await Promise.all([read('role-id'), read('secret-id')]);
      if (!safeToken(roleId) || !safeToken(secretId)) throw new JevReferenceUnavailable();
      const result = await requestJson(new URL('/v1/auth/approle/login', addr), 'POST', { 'content-type': 'application/json' }, ca,
        JSON.stringify({ role_id: roleId, secret_id: secretId }));
      const token = result.json?.auth?.client_token;
      if (result.status !== 200 || !safeToken(token)) throw new JevReferenceUnavailable();
      return token;
    },
    request: (url: URL, headers: Record<string, string>, method = 'GET') => requestJson(url, method, headers, ca),
  });
  try {
    const bytes = await resolver.resolveCredential('jev') as Uint8Array;
    try {
      const token = new TextDecoder().decode(bytes);
      if (!safeToken(token)) throw new JevReferenceUnavailable();
      return token;
    } finally { bytes.fill(0); }
  } finally { await resolver.dispose(); }
}
