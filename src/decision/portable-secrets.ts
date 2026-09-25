import { canonicalJson } from '../security/artifact-trust.js';

/**
 * Shared detector for secret material in portable decision artifacts
 * (receipts, batch receipts, result-cache entries).
 *
 * Detection runs over the canonical JSON serialization so that keys and
 * string values are both inspected, matching the projection policy guard.
 * Rules are deliberately conservative to avoid rejecting legitimate data:
 *
 * - bearer values: `Bearer <token>` where the token is at least 16 token
 *   characters (plain prose such as "bearer of news" does not match);
 * - PEM private keys: any `-----BEGIN ... PRIVATE KEY-----` armor header;
 * - private locators: `vault://` and `secret://` URIs, and string values that
 *   begin with a Vault KV-v2 data path (`secret/data/...` or `kv/data/...`);
 * - secret-derived hashes: keys such as `secretHash`, `tokenSha256Hash`,
 *   `apiKeyHash`, `credentialDigestHash`;
 * - embedded secret values: keys named exactly `secret`, `credential`,
 *   `token`, `apiKey`/`api_key`/`api-key`, or those names suffixed with
 *   `Value` or `Header`.
 *
 * Logical credential references (`credentialRef`, e.g. `typesafe.jev.x`) are
 * intentionally allowed: bindings carry them and batch target identities embed
 * them. A reference whose value is itself a vault/secret locator still fails
 * through the locator rule.
 */
const RULES: readonly RegExp[] = [
  /\bbearer\s+[a-z0-9._~+/-]{16,}=*/i,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /(?:vault|secret):\/\//i,
  /"(?:secret|kv)\/data\/[^"\s]/i,
  // Key rules also match keys inside JSON embedded in a string value (escaped quotes).
  /\\?"(?:secret|credential|token|api[_-]?key)[^"\\]*hash\\?"\s*:/i,
  /\\?"(?:secret|credential|token|api[_-]?key)(?:Value|Header)?\\?"\s*:/i,
];

function serialize(value: unknown): string {
  try { return canonicalJson(value); }
  catch { return JSON.stringify(value) ?? ''; }
}

export function containsPortableSecretMaterial(value: unknown): boolean {
  const serialized = serialize(value);
  return RULES.some(rule => rule.test(serialized));
}

/** Throws `makeError(message)`; the message never echoes the offending material. */
export function assertNoPortableSecretMaterial(value: unknown, name: string, makeError: (message: string) => Error): void {
  if (containsPortableSecretMaterial(value)) {
    throw makeError(`${name} contains forbidden credential or private-locator material`);
  }
}
