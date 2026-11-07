import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { loadDagLiveResolver } from '../../../src/decision/graph-live-qualification.js';
// @ts-expect-error untyped trusted resolver module (digest-pinned, not compiled)
import { createOpenBaoJevResolver, isTlsVerificationDisabled, JEV_SECRET_REFERENCE, kvEnvelopeData,
  openBaoHttpsGet, openBaoHttpsOptions, runApproleTokenHelper } from '../../../tools/decision/jev-openbao-credential.mjs';
// @ts-expect-error untyped host resolver module (not compiled)
import { appRoleTokenProvider, createOpenBaoKvResolver, CredentialResolutionError,
  httpsRequestOptions } from '../../../tools/decision/openbao-kv-credential-resolver.mjs';

const BAO_ORIGIN = 'https://bao.example.invalid';
const SECRET_PATH = 'kv_internal/data/typesafe/jev/api-key';
const SECRET_SERVICE = { origin: BAO_ORIGIN,
  secretPathDigest: `sha256:${createHash('sha256').update(SECRET_PATH).digest('hex')}` };

/** A host token helper that records its exact argv and prints HELPER_TOKEN. */
async function helperScript(dir: string, body: string) {
  const log = join(dir, 'argv.log');
  const path = join(dir, 'token-helper.sh');
  await writeFile(path, `#!/bin/bash\nprintf '%s\\n' "helper argv: $*" >> ${JSON.stringify(log)}\n${body}\n`);
  return { path, log };
}
const argvLines = async (log: string) => (await readFile(log, 'utf8')).split('\n').filter(Boolean);

describe('OpenBao shared mechanisms (single implementation, #2798)', () => {
  it('runs the AppRole helper as `bash HELPER approle NAME` and returns trimmed stdout only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openbao-shared-'));
    try {
      const { path, log } = await helperScript(dir, 'printf \'  spaced-token \\n\'');
      const token = await runApproleTokenHelper(path, 'aiwg-jev-reader', { timeoutMs: 5_000 });
      expect(token).toBe('spaced-token');
      expect(await argvLines(log)).toEqual(['helper argv: approle aiwg-jev-reader']);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('maps helper failure and empty output to a fixed neutral error without helper text', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openbao-shared-'));
    try {
      const failing = await helperScript(dir, 'echo helper-boom >&2; exit 3');
      const error = await runApproleTokenHelper(failing.path, 'aiwg-jev-reader', { timeoutMs: 5_000 }).then(
        () => { throw new Error('expected rejection'); }, value => value as Error);
      expect(error.message).toBe('openbao-token-helper-failed');
      expect(String(error.stack ?? '')).not.toMatch(/helper-boom|spaced-token/);
      const empty = await helperScript(dir, 'printf \'  \\n\'');
      await expect(runApproleTokenHelper(empty.path, 'aiwg-jev-reader', { timeoutMs: 5_000 }))
        .rejects.toThrow('openbao-token-helper-failed');
      const slow = await helperScript(dir, 'sleep 30');
      await expect(runApproleTokenHelper(slow.path, 'aiwg-jev-reader', { timeoutMs: 100 }))
        .rejects.toThrow('openbao-token-helper-failed');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('refuses disabled TLS verification for exactly `0`, and nothing else', () => {
    expect(isTlsVerificationDisabled({})).toBe(false);
    expect(isTlsVerificationDisabled({ NODE_TLS_REJECT_UNAUTHORIZED: '1' })).toBe(false);
    expect(isTlsVerificationDisabled({ NODE_TLS_REJECT_UNAUTHORIZED: '0' })).toBe(true);
    expect(isTlsVerificationDisabled()).toBe(process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0');
  });

  it('builds request options with verification always on and an additive CA only', () => {
    const headers = { 'X-Vault-Token': 'fixture' };
    expect(openBaoHttpsOptions('GET', headers, undefined, 10_000)).toEqual(
      { method: 'GET', headers, timeout: 10_000, rejectUnauthorized: true });
    const ca = Buffer.from('fixture-ca');
    expect(openBaoHttpsOptions('POST', headers, ca, 15_000)).toEqual(
      { method: 'POST', headers, timeout: 15_000, rejectUnauthorized: true, ca });
    expect(httpsRequestOptions('GET', headers, undefined)).toEqual(openBaoHttpsOptions('GET', headers, undefined, 10_000));
    expect(httpsRequestOptions('POST', headers, ca)).toEqual(openBaoHttpsOptions('POST', headers, ca, 10_000));
  });

  it('reads one KV v2 envelope without interpreting the secret', () => {
    expect(kvEnvelopeData({ data: { data: { token: 'x' } } })).toEqual({ token: 'x' });
    expect(kvEnvelopeData({ data: {} })).toBeUndefined();
    expect(kvEnvelopeData(null)).toBeUndefined();
    expect(kvEnvelopeData({ data: { data: 'not-an-object' } })).toBe('not-an-object');
  });
});

describe('shared bounded HTTPS core (offline transport seam)', () => {
  function fakeTransport() {
    const seen: Array<{ url: unknown; options: any }> = [];
    const req = new EventEmitter() as EventEmitter & { destroyed: boolean; destroy(): void; end(): void };
    req.destroyed = false;
    req.destroy = () => { req.destroyed = true; };
    req.end = () => {};
    const requestImpl = vi.fn((url: unknown, options: any, onResponse: (response: EventEmitter) => void) => {
      seen.push({ url, options });
      (req as any).respond = onResponse;
      return req;
    });
    const respond = (status: number, chunks: Array<string | Buffer>) => {
      const response = new EventEmitter() as EventEmitter & { statusCode: number };
      response.statusCode = status;
      (req as any).respond(response);
      for (const chunk of chunks) response.emit('data', Buffer.from(chunk));
      response.emit('end');
    };
    return { seen, req, requestImpl, respond };
  }

  it('returns status with the full bounded body and verified options', async () => {
    const { seen, requestImpl, respond } = fakeTransport();
    const pending = openBaoHttpsGet('https://bao.example.invalid/v1/x', { method: 'GET',
      headers: { accept: 'application/json' }, timeoutMs: 1_000, maxBodyBytes: 64, requestImpl });
    respond(200, ['{"a":', '1}']);
    const result = await pending as { status: number; body: Buffer };
    expect(result.status).toBe(200);
    expect(result.body.toString('utf8')).toBe('{"a":1}');
    expect(seen).toHaveLength(1);
    expect(seen[0].options).toMatchObject({ method: 'GET', timeout: 1_000, rejectUnauthorized: true });
  });

  it('destroys the request and rejects with a neutral error past the body bound', async () => {
    const { req, requestImpl, respond } = fakeTransport();
    const pending = openBaoHttpsGet('https://bao.example.invalid/v1/x', { maxBodyBytes: 4, requestImpl });
    respond(200, ['abcde']);
    await expect(pending).rejects.toThrow('too large');
    expect(req.destroyed).toBe(true);
  });

  it.each([
    ['timeout', (transport: ReturnType<typeof fakeTransport>) => { transport.req.emit('timeout'); }],
    ['request', (transport: ReturnType<typeof fakeTransport>) => { transport.req.emit('error', new Error('socket')); }],
  ])('rejects neutrally on %s without leaking transport text', async (_name, fire) => {
    const transport = fakeTransport();
    const pending = openBaoHttpsGet('https://bao.example.invalid/v1/x', { requestImpl: transport.requestImpl });
    (transport.req as any).respond(new EventEmitter());
    fire(transport);
    const error = await pending.then(() => { throw new Error('expected rejection'); }, value => value as Error);
    expect(error.message).toMatch(/^(timeout|request)$/);
    expect(String(error.stack ?? '')).not.toMatch(/socket/);
  });
});

describe('both live-run paths delegate to the one implementation (#2798)', () => {
  it('loads the shared KV policy from an installed dist-only package', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openbao-installed-'));
    try {
      await mkdir(join(dir, 'tools', 'decision'), { recursive: true });
      await mkdir(join(dir, 'dist', 'src', 'decision'), { recursive: true });
      await writeFile(join(dir, 'package.json'), '{"name":"aiwg","type":"module"}');
      for (const relative of ['tools/_resolve-impl.mjs', 'tools/decision/openbao-kv-credential-resolver.mjs', 'tools/decision/jev-openbao-credential.mjs']) {
        await copyFile(new URL(`../../../${relative}`, import.meta.url), join(dir, relative));
      }
      await copyFile(new URL('../../../src/decision/openbao-kv-resolver.mjs', import.meta.url), join(dir, 'dist', 'src', 'decision', 'openbao-kv-resolver.mjs'));
      const script = 'const module=await import(process.argv[1]);process.stdout.write(typeof module.createOpenBaoKvResolver);';
      const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script,
        pathToFileURL(join(dir, 'tools', 'decision', 'openbao-kv-credential-resolver.mjs')).href], {
        env: { PATH: process.env.PATH, HOME: dir, AIWG_RESOLVE_IMPL_FROM: 'dist' },
      });
      expect(result.stdout).toBe('function');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('invokes the host helper with identical argv through the D10 and D12 default providers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openbao-delegation-'));
    try {
      const { path, log } = await helperScript(dir, 'printf \'%s\' "$HELPER_TOKEN"');
      vi.stubEnv('HELPER_TOKEN', 'delegated-token');
      vi.stubEnv('HELPER_LOG', log);
      try {
        const kvToken = await appRoleTokenProvider({ tokenScript: path, appRole: 'aiwg-jev-reader' })();
        expect(kvToken).toBe('delegated-token');
        const request = vi.fn(async (url: string) => url.endsWith('/revoke-self')
          ? { status: 204, body: Buffer.alloc(0) }
          : { status: 200, body: Buffer.from(JSON.stringify({ data: { data: { token: 'delegated-key' } } })) });
        const resolveD12 = createOpenBaoJevResolver({ pin: SECRET_SERVICE,
          env: { BAO_ADDR: BAO_ORIGIN, AIWG_OPENBAO_TOKEN_HELPER: path, HELPER_TOKEN: 'delegated-token', HELPER_LOG: log },
          request });
        expect(new TextDecoder().decode(await resolveD12(JEV_SECRET_REFERENCE))).toBe('delegated-key');
        expect(await argvLines(log)).toEqual([
          'helper argv: approle aiwg-jev-reader',
          'helper argv: approle aiwg-jev-reader']);
      } finally { vi.unstubAllEnvs(); }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('maps helper failure to each path’s fixed category before any secret read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openbao-delegation-'));
    try {
      const { path } = await helperScript(dir, 'exit 3');
      await expect(appRoleTokenProvider({ tokenScript: path, appRole: 'aiwg-jev-reader' })())
        .rejects.toMatchObject({ name: 'CredentialResolutionError', category: 'failed' });
      const request = vi.fn();
      const resolveD12 = createOpenBaoJevResolver({ pin: SECRET_SERVICE,
        env: { BAO_ADDR: BAO_ORIGIN, AIWG_OPENBAO_TOKEN_HELPER: path }, request });
      await expect(resolveD12(JEV_SECRET_REFERENCE)).rejects.toThrow('(login)');
      expect(request).not.toHaveBeenCalled();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('both paths refuse disabled TLS verification with a fixed category', async () => {
    vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0');
    const config = { schemaVersion: 'openbao-kv-resolver-config/v1', addr: 'https://bao.example.invalid:8200/',
      appRole: 'aiwg-jev-reader', tokenScript: '/opt/fixture/openbao-token.sh', mount: 'kv_fixture',
      refs: { 'jev-api-scoped': { path: 'fixture/scoped' } } };
    try {
      expect(() => createOpenBaoKvResolver(config, { tokenProvider: async () => 't', request: vi.fn() }))
        .toThrow(CredentialResolutionError);
    } finally { vi.unstubAllEnvs(); }
    const request = vi.fn();
    const resolveD12 = createOpenBaoJevResolver({ pin: SECRET_SERVICE,
      env: { BAO_ADDR: BAO_ORIGIN, NODE_TLS_REJECT_UNAUTHORIZED: '0' }, request });
    await expect(resolveD12(JEV_SECRET_REFERENCE)).rejects.toThrow('(configuration)');
    expect(request).not.toHaveBeenCalled();
  });
});

describe('digest-pinned resolver loading still holds for the consolidated file', () => {
  const resolverPath = fileURLToPath(new URL('../../../tools/decision/jev-openbao-credential.mjs', import.meta.url));

  it('loads the same bytes it digests and refuses any pin mismatch', async () => {
    const bytes = await readFile(resolverPath, 'utf8');
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const loaded = await loadDagLiveResolver(resolverPath, digest, digest) as {
      createOpenBaoJevResolver: unknown; JEV_SECRET_REFERENCE: unknown };
    expect(typeof loaded.createOpenBaoJevResolver).toBe('function');
    await expect(loadDagLiveResolver(resolverPath, digest, `sha256:${'c'.repeat(64)}`)).rejects.toThrow('resolver-pin');
  });

  it('keeps the D12 reference and approval checks on the consolidated module', async () => {
    const bytes = await readFile(resolverPath, 'utf8');
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const loaded = await loadDagLiveResolver(resolverPath, digest, digest) as {
      createOpenBaoJevResolver: (options: never) => (reference: string) => Promise<Uint8Array> };
    const resolveCredential = loaded.createOpenBaoJevResolver({ pin: SECRET_SERVICE,
      env: { BAO_ADDR: BAO_ORIGIN }, acquireToken: async () => 't', request: vi.fn() } as never);
    await expect(resolveCredential('openbao.other.secret')).rejects.toThrow('(reference)');
    const unpinned = loaded.createOpenBaoJevResolver({ env: { BAO_ADDR: BAO_ORIGIN } } as never);
    await expect(unpinned(JEV_SECRET_REFERENCE as string)).rejects.toThrow('(configuration)');
  });
});
