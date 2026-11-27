/**
 * Local shape hints only; never return or log credential material.
 * Source: https://launchdarkly.com/docs/home/account/environment/keys.md
 * Management tokens: https://launchdarkly.com/docs/home/account/api.md
 * AIWG guidance: shapes do not establish authenticity, region or permissions.
 */
export function classifyCredential(value, intendedUse) {
  let kind = 'unknown';
  let placement = 'unknown';
  if (typeof value === 'string' && !/\s/.test(value)) {
    if (/^sdk-\S+$/.test(value)) { kind = 'server-sdk-key'; placement = 'server'; }
    else if (/^mob-\S+$/.test(value)) { kind = 'mobile-key'; placement = 'mobile'; }
    else if (/^api-\S+$/.test(value)) { kind = 'api-access-token'; placement = 'api'; }
    else if (/^[a-fA-F0-9]{24}$/.test(value)) { kind = 'client-side-id'; placement = 'client'; }
  }
  const knownUse = ['server', 'mobile', 'client', 'api'].includes(intendedUse);
  return { kind, placement, mismatch: !knownUse || placement === 'unknown' || placement !== intendedUse };
}
