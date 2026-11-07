/**
 * Never-logging OpenBao KV v2 credential resolver for the #2680 egress qualification.
 *
 * It maps logical references (for example `jev-api-scoped`) to host-only KV locators
 * from a private config file, authenticates once with a scoped AppRole token, and
 * performs only exact-path GET reads of KV data. It has no list, metadata or KV write
 * operation, so it cannot enumerate; its only other call revokes its own token on dispose. Errors carry a `category` only; values, tokens, locators and
 * response bodies never appear in errors or in the sanitized audit.
 *
 * Shared behavior (#2798): token acquisition, TLS refusal, request options, the bounded HTTPS
 * GET use the implementation in
 * `tools/decision/jev-openbao-credential.mjs`, imported below. The host-only config schema,
 * logical-ref mapping, caching, audit and dispose policy is shared with runtime callers in
 * `src/decision/openbao-kv-resolver.mjs`. `jev-openbao-credential.mjs` must not import this file: the D12 runner
 * loads that file through a digest-pinned `data:` import, where a relative import would fail.
 */
import { readFile } from 'node:fs/promises';
import { isTlsVerificationDisabled, openBaoHttpsGet, openBaoHttpsOptions, runApproleTokenHelper } from './jev-openbao-credential.mjs';

import { importImpl } from '../_resolve-impl.mjs';
const { createOpenBaoKvResolver: createResolver, CredentialResolutionError, validateResolverConfig } =
  await importImpl(import.meta.url, 'decision/openbao-kv-resolver.mjs');
export { CredentialResolutionError, validateResolverConfig };
const MAX_BODY_BYTES = 64 * 1024;

/** Runs the host token helper. Only stdout is read; stderr is discarded, never logged. */
export function appRoleTokenProvider(config) {
  return async () => {
    let token;
    try {
      token = await runApproleTokenHelper(config.tokenScript, config.appRole, { timeoutMs: 15_000, maxBuffer: 16 * 1024 });
    } catch { throw new CredentialResolutionError('failed'); }
    if (/\s/.test(token)) throw new CredentialResolutionError('failed');
    return token;
  };
}

/** Certificate verification is always explicit; a CA file may only add trust, never disable it. */
export function httpsRequestOptions(method, headers, ca) {
  return openBaoHttpsOptions(method, headers, ca, 10_000);
}

const assertTlsVerification = () => {
  if (isTlsVerificationDisabled()) throw new CredentialResolutionError('configuration');
};

/** Minimal HTTPS request with bounded body and timeout. Returns status and parsed JSON (or null). */
export function httpsGetJson(config) {
  let ca;
  return async (url, headers, method = 'GET') => {
    assertTlsVerification();
    if (config.caFile && ca === undefined) ca = await readFile(config.caFile);
    let result;
    try {
      result = await openBaoHttpsGet(url, { method, headers, ca, timeoutMs: 10_000, maxBodyBytes: MAX_BODY_BYTES });
    } catch { throw new CredentialResolutionError('failed'); }
    let json = null;
    try { json = JSON.parse(result.body.toString('utf8')); } catch { json = null; }
    return { status: result.status, json };
  };
}

/** Preserve the qualification defaults around the shared exact-path policy. */
export function createOpenBaoKvResolver(config, seams = {}) {
  assertTlsVerification();
  return createResolver(config, { tokenProvider: seams.tokenProvider ?? appRoleTokenProvider(config),
    request: seams.request ?? httpsGetJson(config) });
}
