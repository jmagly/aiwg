// Exercises durable authorization through real temporary projects and signed ledgers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { emptyConfig } from '../../../src/config/aiwg-config.js';
import { authorizationCli } from '../../../src/config/authorization-cli.js';
import { effectSession, openLedger } from '../../../src/effects/host.js';
import { recordAuthorizationGrant } from '../../../src/effects/authorization-store.js';
import { checkHitlAuthorization } from '../../../src/policy/hitl-check.js';
import { grantFixture } from '../../fixtures/effects/build-grant-fixtures.js';
import { action, policy } from '../../fixtures/policy/hitl.js';
import { recordOutcome } from '../../../src/effects/ledger.js';
import { purgeEffect } from '../../../src/effects/lifecycle.js';
import { readAllSegments } from '../../../src/effects/reader.js';
import { DECISION_LIFECYCLE_SURFACES, DECISION_LIFECYCLE_VERSION, type DecisionLifecyclePolicy } from '../../../src/decision/lifecycle.js';
import { present } from '../effects/helpers.js';
import * as durableStore from '../../../src/policy/hitl-durable-store.js';

const retention = (): DecisionLifecyclePolicy => ({ version: DECISION_LIFECYCLE_VERSION,
  surfaces: Object.fromEntries(DECISION_LIFECYCLE_SURFACES.map(s => [s, { classification: 'restricted',
    accessScopes: ['effect-ledger'], retentionMs: 1, export: 'denied', deletion: 'tombstone', backup: 'expire-with-primary' }])) as DecisionLifecyclePolicy['surfaces'] });

describe('lookup before ask', () => {
  let dir: string;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-27T01:00:00Z'));
    vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('AIWG_EFFECT_LEDGER_TEST_KEY', 'a'.repeat(64));
    dir = await mkdtemp(join(tmpdir(), 'aiwg-hitl-durable-'));
    await mkdir(join(dir, '.aiwg'));
    await writeFile(join(dir, '.aiwg', 'aiwg.config'), JSON.stringify(emptyConfig()));
  });
  afterEach(async () => {
    vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });
  const ledger = async () => openLedger(await effectSession(dir, 'custom'));
  const grant = () => {
    const g = grantFixture();
    g.scope = { categories: ['repo.edit'], targets: ['repo:example/testnet', `workspace:${dir}`],
      environments: ['testnet'], resources: ['src/**'], verbs: ['edit'] };
    g.constraints.conditions = []; delete g.constraints.maxUses;
    g.expiresAt = '2026-10-28T00:00:00Z';
    return g;
  };
  it('authorizes through the CLI without a config profile and links the signed grant in its receipt', async () => {
    const g = grant(); const stored = await recordAuthorizationGrant(await ledger(), g);
    const file = join(dir, 'action.json'); await writeFile(file, JSON.stringify(action()));
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    await authorizationCli(['check', '--action-file', file], dir);
    const checked = JSON.parse(String(output.mock.calls.at(-1)![0]));
    expect(checked).toMatchObject({ decision: 'auto-authorized', provenance: 'durable-user',
      authorizationGrant: { grantId: g.grantId, effectId: stored.effectId, recordHash: stored.recordHash },
      receipt: { effectId: expect.any(String) } });
    expect(JSON.parse(await readFile(checked.receipt.file, 'utf8'))).toMatchObject({
      provenance: 'durable-user', authorizationGrant: checked.authorizationGrant,
    });
  });
  it.each(['repo', 'workspace', 'environment', 'category', 'resources', 'verb'])('reports the nearest grant and mismatched %s', async field => {
    const g = grant();
    if (field === 'workspace') g.scope.targets[1] = `workspace:${dir}/elsewhere`;
    if (field === 'verb') g.scope.verbs = ['read'];
    await recordAuthorizationGrant(await ledger(), g);
    const a = { ...action(), ...(field === 'repo' ? { repo: 'other/repo' } : {}),
      ...(field === 'environment' ? { environment: 'development' } : {}),
      ...(field === 'category' ? { category: 'docs.edit' } : {}),
      ...(field === 'resources' ? { resources: ['docs/index.md'] } : {}) };
    const checked = await checkHitlAuthorization(dir, a);
    expect(checked).toMatchObject({ decision: 'escalate', nearestGrant: { grantId: g.grantId, fields: expect.arrayContaining([field]) } });
    expect(checked.reason).toContain(g.grantId); expect(checked.reason).toContain(field);
  });
  it('applies a signed revocation at the very next check, including an existing receipt', async () => {
    const g = grant(); await recordAuthorizationGrant(await ledger(), g);
    const checked = await checkHitlAuthorization(dir, action());
    expect(checked.decision).toBe('auto-authorized');
    const revocation = { ...grant(), grantId: 'revocation-1', revokes: g.grantId,
      revocation: { state: 'revoked' as const, revokedAt: '2026-10-27T01:00:00Z', decisionEventId: `sha256:${'d'.repeat(64)}` } };
    await recordAuthorizationGrant(await ledger(), revocation);
    expect(await checkHitlAuthorization(dir, action())).toMatchObject({ decision: 'escalate' });
    expect(await checkHitlAuthorization(dir, action(), { receipt: checked.receipt })).toMatchObject({ decision: 'escalate' });
  });
  it.each(['destructive', 'secret.access', 'production.deploy', 'threat.override'])('always escalates %s with grants and a profile', async category => {
    await recordAuthorizationGrant(await ledger(), grant());
    const config = emptyConfig();
    config.authorization = { version: '1', default_effect: 'deny', resources: {}, permissions: {}, roles: {}, assignments: [], hitl: policy() };
    await writeFile(join(dir, '.aiwg', 'aiwg.config'), JSON.stringify(config));
    expect(await checkHitlAuthorization(dir, { ...action(), category })).toMatchObject({ decision: 'escalate' });
  });
  it('exhausts maxUses across checks even when the action and clock are unchanged', async () => {
    const g = grant(); g.constraints.maxUses = 1;
    await recordAuthorizationGrant(await ledger(), g);
    expect(await checkHitlAuthorization(dir, action())).toMatchObject({ decision: 'auto-authorized' });
    expect(await checkHitlAuthorization(dir, action())).toMatchObject({ decision: 'escalate', nearestGrant: { fields: ['maxUses'] } });
  });
  it('does not fall back to a matching profile when the grant ledger is damaged', async () => {
    await recordAuthorizationGrant(await ledger(), grant());
    const segment = join((await ledger()).paths().segments, 'cli.jsonl');
    await writeFile(segment, (await readFile(segment, 'utf8')).replace('"recordHash":"sha256:', '"recordHash":"sha256:0'));
    const config = emptyConfig();
    config.authorization = { version: '1', default_effect: 'deny', resources: {}, permissions: {}, roles: {}, assignments: [], hitl: policy() };
    await writeFile(join(dir, '.aiwg', 'aiwg.config'), JSON.stringify(config));
    expect(await checkHitlAuthorization(dir, action())).toMatchObject({ decision: 'escalate', reason: 'authorization-ledger-invalid' });
  });
  it.each(['expiresAt', 'createdAt', 'revocation', 'conditions', 'impact'])('refuses the %s boundary', async field => {
    const g = grant();
    if (field === 'expiresAt') g.expiresAt = '2026-10-27T01:00:00Z';
    if (field === 'createdAt') g.createdAt = '2026-10-27T02:00:00Z';
    if (field === 'revocation') g.revocation = { state: 'revoked', revokedAt: '2026-10-27T01:00:00Z', decisionEventId: `sha256:${'d'.repeat(64)}` };
    if (field === 'conditions') g.constraints.conditions = ['Requires independent review'];
    await recordAuthorizationGrant(await ledger(), g);
    expect(await checkHitlAuthorization(dir, { ...action(), ...(field === 'impact' ? { impact: 'medium' } : {}) }))
      .toMatchObject({ decision: 'escalate', nearestGrant: { fields: [field] } });
  });
  it('matches extensible categories, exact targets and verbs, including until-revoked grants', async () => {
    const g = grant(); g.expiresAt = 'until-revoked'; g.scope.categories = ['tracker.write'];
    g.scope.targets.push('tracker:example/testnet#42'); g.scope.verbs = ['create'];
    g.scope.environments = ['staging'];
    await recordAuthorizationGrant(await ledger(), g);
    const a = { ...action(), category: 'tracker.write', target: 'tracker:example/testnet#42', verb: 'create', environment: 'staging' };
    expect(await checkHitlAuthorization(dir, a)).toMatchObject({ decision: 'auto-authorized', provenance: 'durable-user' });
    expect(await checkHitlAuthorization(dir, { ...a, target: 'tracker:example/testnet#43' }))
      .toMatchObject({ decision: 'escalate', nearestGrant: { fields: ['target'] } });
  });
  it('chooses matching and equally near grants by grantId rather than insertion order', async () => {
    for (const grantId of ['z-last', 'a-first']) await recordAuthorizationGrant(await ledger(), { ...grant(), grantId });
    expect(await checkHitlAuthorization(dir, action())).toMatchObject({ authorizationGrant: { grantId: 'a-first' } });
    expect(await checkHitlAuthorization(dir, { ...action(), resources: ['elsewhere/index.ts'] }))
      .toMatchObject({ nearestGrant: { grantId: 'a-first', fields: ['resources'] } });
    await recordAuthorizationGrant(await ledger(), { ...grant(), grantId: '0-further',
      scope: { ...grant().scope, categories: ['repo.read'], resources: ['elsewhere/**'] } });
    expect(await checkHitlAuthorization(dir, { ...action(), repo: 'other/repo' }))
      .toMatchObject({ nearestGrant: { grantId: 'a-first' } });
  });
  it('binds a copied ledger to its original canonical workspace', async () => {
    await recordAuthorizationGrant(await ledger(), grant());
    const other = await mkdtemp(join(tmpdir(), 'aiwg-hitl-copy-'));
    try {
      await cp(join(dir, '.aiwg'), join(other, '.aiwg'), { recursive: true });
      await writeFile(join(other, '.aiwg', 'aiwg.config'), JSON.stringify({ ...emptyConfig(), effects: { project: basename(dir) } }));
      expect(await checkHitlAuthorization(other, action()))
        .toMatchObject({ decision: 'escalate', nearestGrant: { fields: ['workspace'] } });
    } finally { await rm(other, { recursive: true, force: true }); }
  });
  it('counts receipt consumption once per check and prevents replay after exhaustion', async () => {
    const g = grant(); g.constraints.maxUses = 2;
    await recordAuthorizationGrant(await ledger(), g);
    const checked = await checkHitlAuthorization(dir, action());
    expect(checked.decision).toBe('auto-authorized');
    expect(await checkHitlAuthorization(dir, action(), { receipt: checked.receipt })).toMatchObject({ decision: 'auto-authorized' });
    expect(await checkHitlAuthorization(dir, action(), { receipt: checked.receipt }))
      .toMatchObject({ decision: 'escalate', nearestGrant: { fields: ['maxUses'] } });
    const records = (await readAllSegments((await ledger()).paths())).flatMap(s => s.lines.map(l => l.decoded!.statement.predicate));
    expect(records.filter(r => r.kind === 'x.aiwg.authorization-use')).toHaveLength(2);
  });
  it('serializes competing consumers at the last available use', async () => {
    const g = grant(); g.constraints.maxUses = 2;
    await recordAuthorizationGrant(await ledger(), g);
    const checked = await checkHitlAuthorization(dir, action());
    const results = await Promise.all([1, 2, 3].map(() => checkHitlAuthorization(dir, action(), { receipt: checked.receipt })));
    expect(results.filter(r => r.decision === 'auto-authorized')).toHaveLength(1);
    expect(results.filter(r => r.decision === 'escalate')).toHaveLength(2);
  });
  it('never restores a tombstoned grant', async () => {
    const l = await ledger(); const stored = await recordAuthorizationGrant(l, grant());
    await recordOutcome(l, stored.effectId, { phase: 'completed', payloadDigest: stored.payloadDigest,
      verification: present('x.aiwg.authorization-grant', new Date().toISOString()) });
    vi.setSystemTime(new Date(Date.now() + 1000));
    await purgeEffect(l, stored.effectId, { lifecycle: retention() });
    expect(await checkHitlAuthorization(dir, action())).toMatchObject({ decision: 'escalate' });
  });
  it('does not replenish maxUses after a use record is tombstoned', async () => {
    const g = grant(); g.constraints.maxUses = 2;
    const l = await ledger(); await recordAuthorizationGrant(l, g);
    expect(await checkHitlAuthorization(dir, action())).toMatchObject({ decision: 'auto-authorized' });
    const use = (await readAllSegments(l.paths())).flatMap(s => s.lines.map(line => line.decoded!.statement.predicate))
      .find(p => p.kind === 'x.aiwg.authorization-use')!;
    await recordOutcome(l, use.effectId, { phase: 'completed', payloadDigest: use.payloadDigest,
      verification: present(use.kind, new Date().toISOString()) });
    vi.setSystemTime(new Date(Date.now() + 1000));
    await purgeEffect(l, use.effectId, { lifecycle: retention() });
    expect(await checkHitlAuthorization(dir, action()))
      .toMatchObject({ decision: 'escalate', nearestGrant: { fields: ['maxUses'] } });
  });
  it('does not authorize if persisting the use fails after receipt verification', async () => {
    await recordAuthorizationGrant(await ledger(), grant());
    vi.spyOn(durableStore, 'recordDurableUse').mockRejectedValue(new Error('synthetic signing failure'));
    expect(await checkHitlAuthorization(dir, action())).toMatchObject({ decision: 'escalate', reason: 'authorization-check-unavailable' });
  });
  it('rejects threat.override even if its signed grant exactly matches', async () => {
    const g = grant(); g.scope.categories = ['threat.override']; g.scope.verbs = ['override'];
    await recordAuthorizationGrant(await ledger(), g);
    expect(await checkHitlAuthorization(dir, { ...action(), category: 'threat.override' }))
      .toMatchObject({ decision: 'escalate', reason: 'safety-category-requires-explicit-review' });
  });
  it('requires every affected resource to match the durable grant', async () => {
    await recordAuthorizationGrant(await ledger(), grant());
    expect(await checkHitlAuthorization(dir, { ...action(), resources: ['src/one.ts', 'outside/two.ts'] }))
      .toMatchObject({ decision: 'escalate', nearestGrant: { fields: ['resources'] } });
  });
  it.each(['deny', 'review', 'disabled'])('keeps governing %s ahead of durable authority', async mode => {
    await recordAuthorizationGrant(await ledger(), grant());
    const p = policy();
    if (mode === 'deny') p.deny = [{ categories: ['repo.edit'] }];
    if (mode === 'review') p.requireReview = [{ categories: ['repo.edit'] }];
    if (mode === 'disabled') p.enabled = false;
    const config = emptyConfig();
    config.authorization = { version: '1', default_effect: 'deny', resources: {}, permissions: {}, roles: {}, assignments: [], hitl: p };
    await writeFile(join(dir, '.aiwg', 'aiwg.config'), JSON.stringify(config));
    expect(await checkHitlAuthorization(dir, action())).toMatchObject({ decision: mode === 'deny' ? 'deny' : 'escalate' });
  });
  it.each([{ environment: 'production' }, { reversible: false }, { impact: 'high' }, { resources: ['.env'] }])
  ('keeps unsafe effects behind review: %j', async changes => {
    const g = grant(); g.scope.resources = ['**'];
    await recordAuthorizationGrant(await ledger(), g);
    expect(await checkHitlAuthorization(dir, { ...action(), ...changes })).toMatchObject({ decision: 'escalate' });
  });
});
