// Covers signed grant storage, bounded validation, index repair and fail-closed reads.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertAuthorizationGrant, authorizationGrantIdentity } from '../../../src/effects/authorization-grant.js';
import { readAuthorizationGrants, recordAuthorizationGrant, verifyAuthorizationGrants } from '../../../src/effects/authorization-store.js';
import { recordIntent, initLedgerKeyring, openEffectLedger } from '../../../src/effects/ledger.js';
import { decodeSegmentLine } from '../../../src/effects/records.js';
import { payloadDigest } from '../../../src/effects/identity.js';
import { verifyLedger } from '../../../src/effects/verify.js';
import { grantFixture } from '../../fixtures/effects/build-grant-fixtures.js';
import { harness, type Harness } from './helpers.js';

let h: Harness;
beforeEach(() => { h = harness(); });
afterEach(() => { vi.unstubAllEnvs(); h.cleanup(); });
const index = () => join(h.ledger().paths().root, 'authorization-index.json');
const segment = () => join(h.ledger().paths().segments, 'writer-a.jsonl');

describe('signed authorization grants', () => {
  it('signs all grant fields with the existing ledger key and returns idempotent receipts', async () => {
    const ledger = h.ledger(); await initLedgerKeyring(ledger);
    const grant = grantFixture();
    const first = await recordAuthorizationGrant(ledger, grant, { operatorDecisionEventId: `sha256:${'d'.repeat(64)}` });
    expect(first.idempotent).toBe(false);
    expect((await recordAuthorizationGrant(ledger, grant)).idempotent).toBe(true);
    const raw = await readFile(segment(), 'utf8'); const decoded = decodeSegmentLine(raw.trim());
    if ('failure' in decoded) throw new Error(decoded.failure);
    expect(decoded.statement.predicate).toMatchObject({ kind: 'x.aiwg.authorization-grant', authorizationGrant: grant, links: { operatorDecisionEventId: `sha256:${'d'.repeat(64)}` } });
    expect((await verifyLedger(ledger)).ok).toBe(true);
    const readOnly = openEffectLedger({ projectDir: h.dir, scope: ledger.scope, writer: 'reader', sink: h.sink });
    expect(await readAuthorizationGrants(readOnly)).toMatchObject({ grants: [{ grant, effectId: first.effectId }], failures: [] });
    expect((await verifyAuthorizationGrants(readOnly)).indexChanged).toBe(false);
    expect((await stat(index())).mode & 0o777).toBe(0o600);
    const changed = grantFixture(); changed.scope.resources = ['other/**'];
    await expect(recordAuthorizationGrant(ledger, changed)).rejects.toMatchObject({ exitCode: 5 });
  });

  it.each(['signature', 'hash', 'payload'] as const)('ignores grants and reports a changed %s', async mutation => {
    const ledger = h.ledger(); await recordAuthorizationGrant(ledger, grantFixture());
    const line = JSON.parse((await readFile(segment(), 'utf8')).trim());
    if (mutation === 'signature') {
      const signature = line.envelope.signatures[0].sig;
      line.envelope.signatures[0].sig = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
    } else if (mutation === 'hash') line.recordHash = `sha256:${'0'.repeat(64)}`;
    else {
      const bytes = Buffer.from(line.envelope.payload, 'base64');
      const offset = bytes.indexOf('tracker.write'); expect(offset).toBeGreaterThan(0);
      bytes[offset] = 'b'.charCodeAt(0); // Mutate exactly one signed payload byte on disk.
      line.envelope.payload = bytes.toString('base64');
    }
    await writeFile(segment(), `${JSON.stringify(line)}\n`);
    expect((await readAuthorizationGrants(ledger)).grants).toEqual([]);
    const result = await verifyAuthorizationGrants(ledger);
    expect(result).toMatchObject({ ok: false, exitCode: 6, grants: 0 });
    expect(result.failures.length).toBeGreaterThan(0);
    expect(JSON.parse(await readFile(index(), 'utf8')).entries).toEqual([]);
    await expect(recordAuthorizationGrant(ledger, { ...grantFixture(), grantId: 'next' })).rejects.toMatchObject({ exitCode: 6 });
  });

  it('rebuilds a missing index and reports/repairs a forged index without trusting it', async () => {
    const ledger = h.ledger(); await recordAuthorizationGrant(ledger, grantFixture());
    const expected = await readFile(index(), 'utf8'); await rm(index());
    expect(await verifyAuthorizationGrants(ledger)).toMatchObject({ ok: true, indexChanged: true, grants: 1 });
    await writeFile(index(), '{"entries":["forged"]}\n');
    expect((await readAuthorizationGrants(ledger)).grants).toHaveLength(1);
    expect(await verifyAuthorizationGrants(ledger)).toMatchObject({ ok: false, exitCode: 6, indexChanged: true, grants: 1 });
    expect(await readFile(index(), 'utf8')).toBe(expected);
    expect((await verifyAuthorizationGrants(ledger)).ok).toBe(true);
    const outside = join(h.dir, 'unrelated-index.json'); await writeFile(outside, 'unchanged');
    await rm(index()); await symlink(outside, index());
    expect((await verifyAuthorizationGrants(ledger)).ok).toBe(false);
    expect(await readFile(outside, 'utf8')).toBe('unchanged');
    expect((await stat(index())).mode & 0o777).toBe(0o600);
  });

  it('keeps expired and revoked history without implementing grant resolution', async () => {
    const ledger = h.ledger();
    const grant = grantFixture(); grant.expiresAt = 'until-revoked';
    await recordAuthorizationGrant(ledger, grant);
    const revoked = grantFixture(); revoked.grantId = 'revoked'; revoked.revokes = grant.grantId;
    revoked.revocation = { state: 'revoked', revokedAt: '2026-09-24T11:00:00.000Z', decisionEventId: `sha256:${'a'.repeat(64)}` };
    await recordAuthorizationGrant(ledger, revoked);
    expect((await readAuthorizationGrants(ledger)).grants).toHaveLength(2);
  });

  it('serializes index refreshes across writers without losing grants', async () => {
    await Promise.all(['a', 'b', 'c'].map(writer => recordAuthorizationGrant(h.ledger({ writer: `writer-${writer}` }), { ...grantFixture(), grantId: `grant-${writer}` })));
    expect((await readAuthorizationGrants(h.ledger())).grants).toHaveLength(3);
    expect(await verifyAuthorizationGrants(h.ledger())).toMatchObject({ ok: true, grants: 3, indexChanged: false });
  });

  it('uses the configured external artifact root and fails closed when it disappears', async () => {
    const artifacts = join(h.dir, 'external'); await mkdir(artifacts);
    await writeFile(join(h.dir, '.aiwg-location'), artifacts);
    await recordAuthorizationGrant(h.ledger(), grantFixture());
    expect(index().startsWith(artifacts)).toBe(true);
    await rm(artifacts, { recursive: true });
    await expect(readAuthorizationGrants(h.ledger())).rejects.toMatchObject({ exitCode: 7 });
  });

  it('generic effect writers cannot omit grant data or forge its digest binding', async () => {
    const ledger = h.ledger(); const grant = grantFixture();
    const input = { ...authorizationGrantIdentity(grant.grantId), payloadDigest: payloadDigest('wrong') };
    await expect(recordIntent(ledger, input)).rejects.toThrow();
    await expect(recordIntent(ledger, { ...input, authorizationGrant: grant })).rejects.toMatchObject({ reason: 'authorization-grant-binding' });
    expect((await readAuthorizationGrants(ledger)).grants).toEqual([]);
  });
});

describe('grant safety bounds', () => {
  it.each(['secret.access', 'destructive', 'production.deploy', 'policy-override', 'credential.read', 'delete'])('rejects prohibited category %s', category => {
    const grant = grantFixture(); grant.scope.categories = [category];
    expect(() => assertAuthorizationGrant(grant)).toThrow('prohibited');
  });
  it.each(['*', 'tracker.*', 'all actions'])('rejects unbounded action class %s', category => {
    const grant = grantFixture(); grant.scope.categories = [category];
    expect(() => assertAuthorizationGrant(grant)).toThrow();
  });
  it.each(['equal-expiry', 'early-expiry', 'early-revocation', 'leap-second', 'self-link', 'token', 'unknown-field'])('rejects %s without echoing input', edge => {
    const grant = grantFixture();
    if (edge === 'equal-expiry') grant.expiresAt = grant.createdAt;
    if (edge === 'early-expiry') grant.expiresAt = '2026-09-23T00:00:00Z';
    if (edge === 'leap-second') grant.expiresAt = '2026-12-31T23:59:60Z';
    if (edge === 'early-revocation') grant.revocation = { state: 'revoked', revokedAt: '2026-09-23T00:00:00Z', decisionEventId: `sha256:${'a'.repeat(64)}` };
    if (edge === 'self-link') grant.supersedes = grant.grantId;
    if (edge === 'token') grant.constraints.conditions = ['Bearer synthetic-token-material-0000'];
    if (edge === 'unknown-field') Object.assign(grant, { confirmed: true });
    expect(() => assertAuthorizationGrant(grant)).toThrow();
  });
});
