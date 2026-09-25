/**
 * Effect verifier framework (#2718): registry, tri-state enforcement, error
 * mapping, file.digest, decision.receipt, the review placeholder, the
 * crash-window harness and append-only reconcile history. Offline only.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateDecisionRuleset } from '../../../src/decision/evaluate.js';
import type { JobSnapshot, JobStore } from '../../../src/decision/job-store.js';
import { FileDecisionReceiptStore } from '../../../src/decision/receipts.js';
import type { AdapterObservation, DecisionAdapter, DecisionBinding, DecisionDefinition, DecisionRuleset } from '../../../src/decision/types.js';
import { artifactDigest } from '../../../src/decision/validate.js';
import {
  EffectVerifierError,
  createBuiltinVerifierRegistry,
  createVerifierRegistry,
  decisionReceiptVerifier,
  effectId,
  evidenceDigest,
  fileDigestVerifier,
  isEffectSchemaValid,
  lookupEffect,
  payloadDigest,
  reconcileEffect,
  recordIntent,
  recordOutcome,
  runVerifier,
  verifyLedger,
  type EffectVerifier,
  type EffectVerifierExpectation,
  type EffectVerifierRequest,
} from '../../../src/effects/index.js';
import { comment, harness, scope, type Harness } from './helpers.js';

let h: Harness;
beforeEach(() => { h = harness(); });
afterEach(() => h.cleanup());

const ledgerRoot = () => join(h.dir, '.aiwg', 'effects', 'delivery');
const segmentText = (writer = 'writer-a') => readFileSync(join(ledgerRoot(), 'segments', `${writer}.jsonl`), 'utf8');
const phases = (writer = 'writer-a') => segmentText(writer).trim().split('\n')
  .map(line => JSON.parse(Buffer.from(JSON.parse(line).envelope.payload, 'base64').toString('utf8')).predicate.phase as string);

const sha = (text: string) => payloadDigest(text);
const request = (kind: string, target: string, expected: EffectVerifierExpectation = {}, context: Record<string, string | number | boolean> = {}): Omit<EffectVerifierRequest, 'signal'> => ({
  effectId: `eff1_${'a'.repeat(51)}q`, scope, kind, target, context,
  payloadDigest: sha('payload'), intentRecordedAt: '2026-09-24T10:00:00.000Z', expected,
});
const fake = (observe: EffectVerifier['verify'], overrides: Partial<EffectVerifier> = {}): EffectVerifier => ({
  kind: 'tracker.comment', version: '1.0.0', canReportAbsent: true, verify: observe, ...overrides,
});

describe('verifier registry', () => {
  it('EFF-VER-01 listKinds reports each built-in kind with its version and absent capability', () => {
    expect(createBuiltinVerifierRegistry().listKinds()).toEqual([
      { kind: 'decision.receipt', version: '1.0.0', canReportAbsent: true },
      { kind: 'decision.review.continuation', version: '0.1.0', canReportAbsent: false },
      { kind: 'file.digest', version: '1.0.0', canReportAbsent: true },
      { kind: 'git.commit', version: '1.0.0', canReportAbsent: true },
      { kind: 'git.tag', version: '1.0.0', canReportAbsent: true },
    ]);
  });

  it('EFF-VER-02 registration rejects invalid kinds, versions and duplicates; x.<vendor>.<name> extensions register', () => {
    const verify = async () => ({ result: 'unknown' as const, reason: 'timeout', complete: false });
    expect(() => createVerifierRegistry([fake(verify, { kind: 'custom.thing' })])).toThrow(/core kind or x\./);
    expect(() => createVerifierRegistry([fake(verify, { version: 'v1' })])).toThrow(/semver/);
    expect(() => createVerifierRegistry([fake(verify), fake(verify)])).toThrow(/one verifier/);
    expect(() => createBuiltinVerifierRegistry({}, [fake(verify, { kind: 'git.commit' })])).toThrow(/one verifier/);
    const registry = createBuiltinVerifierRegistry({}, [fake(verify, { kind: 'x.example.notify', canReportAbsent: false })]);
    expect(registry.kinds()).toContain('x.example.notify');
    expect(registry.listKinds().find(ref => ref.kind === 'x.example.notify')).toEqual({ kind: 'x.example.notify', version: '1.0.0', canReportAbsent: false });
  });

  it('EFF-VER-03 a kind with no registered verifier reconciles to unknown/verifier-missing with exit 4', async () => {
    const ledger = h.ledger();
    const intent = await recordIntent(ledger, comment());
    const outcome = await reconcileEffect(ledger, intent.effectId, { verifiers: createBuiltinVerifierRegistry() });
    expect(outcome.result).toMatchObject({ exitCode: 4, verification: { result: 'unknown', reason: 'verifier-missing', verifier: { kind: 'tracker.comment', canReportAbsent: false } } });
    expect(outcome.completed).toBeNull();
  });
});

describe('framework error mapping', () => {
  const cases: Array<{ name: string; verifier: EffectVerifier; options?: { timeoutMs?: number; verifierVersion?: string }; reason: string }> = [
    { name: 'plain throw', verifier: fake(async () => { throw new Error('boom'); }), reason: 'server-error' },
    { name: 'classified throw', verifier: fake(async () => { throw new EffectVerifierError('auth-denied'); }), reason: 'auth-denied' },
    { name: 'synchronous throw', verifier: fake((() => { throw new EffectVerifierError('rate-limited'); }) as never), reason: 'rate-limited' },
    { name: 'timeout', verifier: fake(() => new Promise(() => { /* never settles */ })), options: { timeoutMs: 20 }, reason: 'timeout' },
    { name: 'late absent after timeout', verifier: fake(signalAware), options: { timeoutMs: 20 }, reason: 'timeout' },
    { name: 'pinned version mismatch', verifier: fake(async () => ({ result: 'absent', reason: 'complete-query-no-match', complete: true })), options: { verifierVersion: '2.0.0' }, reason: 'verifier-version-mismatch' },
    { name: 'kind mismatch', verifier: fake(async () => ({ result: 'absent', reason: 'complete-query-no-match', complete: true }), { kind: 'tracker.pr.merged' }), reason: 'verifier-version-mismatch' },
    { name: 'absent from a verifier that cannot report it', verifier: fake(async () => ({ result: 'absent', reason: 'complete-query-no-match', complete: true }), { canReportAbsent: false }), reason: 'verifier-cannot-report-absent' },
    { name: 'partial absent', verifier: fake(async () => ({ result: 'absent', reason: 'complete-query-no-match', complete: false })), reason: 'paging-incomplete' },
    { name: 'heuristic absent', verifier: fake(async () => ({ result: 'absent', reason: 'heuristic-match', complete: true })), reason: 'malformed-response' },
    { name: 'unknown reason code', verifier: fake(async () => ({ result: 'unknown', reason: 'network', complete: false })), reason: 'malformed-response' },
    { name: 'non-object answer', verifier: fake(async () => null as never), reason: 'malformed-response' },
    { name: 'restricted evidence', verifier: fake(async () => ({ result: 'absent', reason: 'complete-query-no-match', complete: true, evidence: { password: 'x' } })), reason: 'malformed-response' },
    { name: 'evidence digest disagreement', verifier: fake(async () => ({ result: 'absent', reason: 'complete-query-no-match', complete: true, evidence: { a: 1 }, evidenceDigest: sha('other') })), reason: 'malformed-response' },
  ];

  function signalAware(req: EffectVerifierRequest) {
    return new Promise<never>((resolve) => {
      req.signal.addEventListener('abort', () => setTimeout(() => resolve({ result: 'absent', reason: 'complete-query-no-match', complete: true } as never), 5));
    });
  }

  it.each(cases)('EFF-VER-04 $name gives unknown/$reason, never absent', async ({ verifier, options, reason }) => {
    const run = await runVerifier(verifier, request('tracker.comment', 'gitea:example/repo#1'), options);
    expect(run.observation).toEqual({ result: 'unknown', reason, complete: false });
  });

  it('EFF-VER-05 a heuristic match may be present and evidence is digested, not recorded', async () => {
    const run = await runVerifier(fake(async () => ({ result: 'present', reason: 'heuristic-match', complete: false, evidence: { comment: 42, author: 'bot' } })), request('tracker.comment', 'gitea:example/repo#1'));
    expect(run.observation).toEqual({ result: 'present', reason: 'heuristic-match', complete: false, evidenceDigest: evidenceDigest({ comment: 42, author: 'bot' }) });
    expect(run.evidence).toEqual({ comment: 42, author: 'bot' });
  });
});

describe('file.digest', () => {
  const setup = () => {
    const root = join(h.dir, 'files');
    mkdirSync(join(root, 'sub'), { recursive: true });
    mkdirSync(join(h.dir, 'outside'), { recursive: true });
    writeFileSync(join(root, 'sub', 'out.txt'), 'expected bytes\n');
    writeFileSync(join(h.dir, 'outside', 'secret.txt'), 'expected bytes\n');
    symlinkSync(join(h.dir, 'outside', 'secret.txt'), join(root, 'escape.txt'));
    symlinkSync(join(h.dir, 'outside'), join(root, 'escape-dir'));
    symlinkSync(join(root, 'sub', 'out.txt'), join(root, 'inner-link.txt'));
    return { root, verifier: fileDigestVerifier({ root }) };
  };
  const check = (verifier: EffectVerifier, path: string, digest = sha('expected bytes\n')) => runVerifier(verifier, request('file.digest', `file:${path}@${digest}`));

  it('EFF-VER-FILE-01 a matching digest is present; a different digest or a missing file is absent', async () => {
    const { root, verifier } = setup();
    expect((await check(verifier, 'sub/out.txt')).observation).toMatchObject({ result: 'present', reason: 'digest-match', complete: true });
    expect((await check(verifier, join(root, 'sub', 'out.txt'))).observation).toMatchObject({ result: 'present' });
    expect((await check(verifier, 'inner-link.txt')).observation).toMatchObject({ result: 'present' });
    const different = await check(verifier, 'sub/out.txt', sha('other bytes\n'));
    expect(different.observation).toMatchObject({ result: 'absent', reason: 'complete-query-no-match', complete: true });
    expect(different.evidence).toMatchObject({ actualDigest: sha('expected bytes\n'), found: true });
    expect((await check(verifier, 'sub/missing.txt')).observation).toMatchObject({ result: 'absent' });
    expect((await check(verifier, 'new-dir/missing.txt')).observation).toMatchObject({ result: 'absent' });
  });

  it('EFF-VER-FILE-02 a path outside the root or a symlink escape is unknown/container-unreadable', async () => {
    const { verifier } = setup();
    for (const path of ['../outside/secret.txt', join(h.dir, 'outside', 'secret.txt'), 'escape.txt', 'escape-dir/secret.txt', 'escape-dir/missing.txt']) {
      expect((await check(verifier, path)).observation, path).toEqual({ result: 'unknown', reason: 'container-unreadable', complete: false });
    }
    expect((await check(fileDigestVerifier({ root: join(h.dir, 'no-root') }), 'x.txt')).observation).toMatchObject({ result: 'unknown', reason: 'container-unreadable' });
    expect((await check(verifier, 'sub')).observation).toMatchObject({ result: 'unknown', reason: 'evidence-conflict' });
    expect((await runVerifier(verifier, request('file.digest', 'file:sub/out.txt'))).observation).toMatchObject({ result: 'unknown', reason: 'malformed-response' });
  });
});

describe('decision.receipt', () => {
  const fixture = <T>(name: string): T => JSON.parse(readFileSync(`agentic/code/addons/decision-engine/examples/${name}`, 'utf8')) as T;
  const adapter = (): DecisionAdapter => ({
    id: 'jev', version: '1.0.0',
    capabilities: async () => ({ answerKinds: ['choice', 'ordinal-score', 'truth-probability'], features: ['choice', 'ordinal-score', 'truth-probability'], maxOptions: 255, maxLevels: 10, confidenceProfiles: ['typesafe-distribution-v1', 'typesafe-truth-v1'], executable: true, egress: { mode: 'none' as const } }),
    evaluate: vi.fn(async ({ alias }) => ({
      status: 'success', reason: 'none', value: alias === 'category' ? 'documentation' : alias === 'severity' ? 0.25 : 0.05,
      uncertainty: { source: 'provider', profile: alias === 'core_unavailable' ? 'typesafe-truth-v1' : 'typesafe-distribution-v1', calibration: 'vendor-claimed', confidence: 0.9, distribution: null, calibrationRef: null },
      actualModel: 'model', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 }, requestId: 'request',
    }) as AdapterObservation),
  });
  /** Perform one offline D03 evaluation; its durable receipt is the effect. */
  async function evaluate(store: FileDecisionReceiptStore, invocationId: string) {
    return evaluateDecisionRuleset({
      ruleset: fixture<DecisionRuleset>('ruleset.json'), binding: fixture<DecisionBinding>('binding-jev.json'),
      definitions: { category: fixture<DecisionDefinition>('decision-category.json'), severity: fixture<DecisionDefinition>('decision-severity.json'), core: fixture<DecisionDefinition>('decision-core_unavailable.json') },
      input: fixture('input.json'), runId: 'run', invocationId, adapters: { jev: adapter() }, receiptStore: store,
    });
  }
  const jobStore = (snapshot: JobSnapshot | null): JobStore => ({
    acquire: async () => { throw new Error('read-only'); }, compareAndSwap: async () => false, read: async () => structuredClone(snapshot),
  });
  const jobScope = { tenantId: 'local', projectId: 'default', workspaceId: 'ws', principalId: 'p' };
  const job = (attempt: Record<string, unknown> | null): JobSnapshot => ({
    revision: 3, deleted: false,
    job: { id: 'job-1', scope: jobScope, items: [{ id: 'item-1', state: 'execution-unknown', attempts: attempt ? [attempt] : [] }] } as never,
  });

  it('EFF-VER-DEC-01 D03 invocation receipts: completed with a matching digest is present, missing is absent, a MAC failure is unknown', async () => {
    const directory = join(h.dir, 'receipts');
    const store = new FileDecisionReceiptStore(directory, { integrityKey: randomBytes(32) });
    await evaluate(store, 'inv-1');
    const receipt = (await store.read('inv-1', 'default'))!;
    expect(receipt.state).toBe('completed');
    const verifier = decisionReceiptVerifier({ receipts: store, projectId: 'default' });
    const check = (target: string, expected: EffectVerifierExpectation = {}, context: Record<string, string> = {}) =>
      runVerifier(verifier, request('decision.receipt', target, expected, context));
    expect((await check('decision:invocation/inv-1', { digest: artifactDigest(receipt) })).observation).toMatchObject({ result: 'present', reason: 'digest-match', complete: true });
    expect((await check('decision:invocation/inv-1')).observation).toMatchObject({ result: 'present', reason: 'state-match' });
    expect((await check('decision:invocation/inv-1', { digest: sha('other') })).observation).toMatchObject({ result: 'unknown', reason: 'evidence-conflict' });
    expect((await check('decision:invocation/inv-1', {}, { fingerprint: sha('other') })).observation).toMatchObject({ result: 'unknown', reason: 'evidence-conflict' });
    expect((await check('decision:invocation/inv-missing')).observation).toMatchObject({ result: 'absent', reason: 'complete-query-no-match', complete: true });
    // Tamper with a stored revision: the MAC check fails and the result is unknown, never absent.
    const name = readdirSync(directory).find(file => file.endsWith('.r1.json'))!;
    const document = JSON.parse(readFileSync(join(directory, name), 'utf8'));
    document.mac = 'f'.repeat(64);
    writeFileSync(join(directory, name), JSON.stringify(document));
    expect((await check('decision:invocation/inv-1')).observation).toEqual({ result: 'unknown', reason: 'container-unreadable', complete: false });
    const denied = new FileDecisionReceiptStore(directory, { integrityKey: randomBytes(32), authorize: () => false });
    expect((await runVerifier(decisionReceiptVerifier({ receipts: denied, projectId: 'default' }), request('decision.receipt', 'decision:invocation/inv-1'))).observation).toMatchObject({ result: 'unknown', reason: 'auth-denied' });
    writeFileSync(join(h.dir, 'not-a-dir'), 'x');
    const unreadable = new FileDecisionReceiptStore(join(h.dir, 'not-a-dir'), { integrityKey: randomBytes(32) });
    expect((await runVerifier(decisionReceiptVerifier({ receipts: unreadable, projectId: 'default' }), request('decision.receipt', 'decision:invocation/inv-1'))).observation).toMatchObject({ result: 'unknown', reason: 'container-unreadable' });
    expect((await runVerifier(decisionReceiptVerifier(), request('decision.receipt', 'decision:invocation/inv-1'))).observation).toMatchObject({ result: 'unknown', reason: 'container-unreadable' });
  });

  it('EFF-VER-DEC-02 D16 job items resolve through the attempt receipt digest', async () => {
    const store = new FileDecisionReceiptStore(join(h.dir, 'receipts'), { integrityKey: randomBytes(32) });
    await evaluate(store, 'attempt-1');
    const digest = artifactDigest((await store.read('attempt-1', 'default'))!);
    const check = (snapshot: JobSnapshot | null, target = 'decision:job/job-1/item-1') =>
      runVerifier(decisionReceiptVerifier({ receipts: store, jobs: jobStore(snapshot), ...jobScope }), request('decision.receipt', target));
    const succeeded = await check(job({ id: 'attempt-1', requestDigest: sha('r'), receiptDigest: digest, outcome: 'succeeded' }));
    expect(succeeded.observation).toMatchObject({ result: 'present', reason: 'digest-match' });
    expect(succeeded.evidence).toMatchObject({ source: 'd16-job-item', attemptId: 'attempt-1', receiptDigest: digest });
    expect((await check(job({ id: 'attempt-1', requestDigest: sha('r'), receiptDigest: sha('x'), outcome: 'succeeded' }))).observation).toMatchObject({ result: 'unknown', reason: 'evidence-conflict' });
    // execution-unknown: no recorded digest, so a completed receipt is a state match the D16 resolver may not accept on its own.
    expect((await check(job({ id: 'attempt-1', requestDigest: sha('r'), outcome: 'execution-unknown' }))).observation).toMatchObject({ result: 'present', reason: 'state-match' });
    expect((await check(job({ id: 'attempt-2', requestDigest: sha('r'), outcome: 'execution-unknown' }))).observation).toMatchObject({ result: 'absent' });
    expect((await check(job(null))).observation).toMatchObject({ result: 'absent' });
    expect((await check(null)).observation).toMatchObject({ result: 'absent' });
    expect((await check(job(null), 'decision:job/job-1/item-9')).observation).toMatchObject({ result: 'absent' });
    expect((await check({ ...job(null), deleted: true })).observation).toMatchObject({ result: 'unknown', reason: 'container-unreadable' });
    expect((await check(job(null), 'decision:job/job-1')).observation).toMatchObject({ result: 'unknown', reason: 'malformed-response' });
  });

  it('EFF-VER-DEC-03 the review continuation placeholder is always unknown and can never report absent', async () => {
    const registry = createBuiltinVerifierRegistry();
    const verifier = registry.get('decision.review.continuation')!;
    expect(verifier.canReportAbsent).toBe(false);
    expect((await runVerifier(verifier, request('decision.review.continuation', 'review:local/example/repo/r-1'))).observation).toEqual({ result: 'unknown', reason: 'verifier-missing', complete: false });
  });
});

describe('reconcile', () => {
  it('EFF-VER-REC-01 crash window: an effect performed with no outcome is found present; reconciled and completed are appended; the effect ran once', async () => {
    const ledger = h.ledger();
    const root = join(h.dir, 'out');
    mkdirSync(root);
    const bytes = 'release manifest v1\n';
    const target = `file:manifest.json@${sha(bytes)}`;
    const perform = vi.fn(() => writeFileSync(join(root, 'manifest.json'), bytes));
    const intent = await recordIntent(ledger, { kind: 'file.digest', target, context: { release: 'v1' }, payloadDigest: sha(bytes) });
    perform();
    // Crash: the outcome write is dropped.
    const verifiers = createBuiltinVerifierRegistry({ file: { root } });
    const before = segmentText();
    const outcome = await reconcileEffect(ledger, intent.effectId, { verifiers });
    expect(outcome.result).toMatchObject({ exitCode: 0, verification: { result: 'present', reason: 'digest-match', verifier: { kind: 'file.digest', version: '1.0.0', canReportAbsent: true } } });
    expect(isEffectSchemaValid('verifierResult', outcome.result)).toBe(true);
    expect(outcome.completed).toMatchObject({ phase: 'completed', idempotent: false });
    expect(outcome.evidence).toMatchObject({ found: true });
    expect(phases()).toEqual(['intent', 'reconciled', 'completed']);
    expect(segmentText().startsWith(before)).toBe(true);
    expect(await lookupEffect(ledger, intent.effectId)).toMatchObject({ status: 'completed', result: 'present', exitCode: 0 });
    // A second reconcile appends another reconciled record; completed is already recorded (first outcome wins).
    const again = await reconcileEffect(ledger, intent.effectId, { verifiers });
    expect(again.completed).toMatchObject({ phase: 'completed', idempotent: true });
    expect(phases()).toEqual(['intent', 'reconciled', 'completed', 'reconciled']);
    expect(perform).toHaveBeenCalledTimes(1);
    expect((await verifyLedger(ledger, { sink: null })).ok).toBe(true);
  });

  it('EFF-VER-REC-02 every reconcile appends a signed record and never mutates earlier bytes', async () => {
    const ledger = h.ledger();
    const intent = await recordIntent(ledger, comment());
    const answers = [
      { result: 'unknown', reason: 'rate-limited', complete: false },
      { result: 'absent', reason: 'complete-query-no-match', complete: true },
    ] as const;
    let call = 0;
    const verifiers = createVerifierRegistry([fake(async () => answers[call++])]);
    let previous = segmentText();
    for (const exitCode of [4, 3]) {
      const outcome = await reconcileEffect(ledger, intent.effectId, { verifiers });
      expect(outcome.result.exitCode).toBe(exitCode);
      expect(outcome.completed).toBeNull();
      const now = segmentText();
      expect(now.startsWith(previous)).toBe(true);
      expect(now.trim().split('\n')).toHaveLength(previous.trim().split('\n').length + 1);
      previous = now;
    }
    expect(phases()).toEqual(['intent', 'reconciled', 'reconciled']);
    expect((await verifyLedger(ledger, { sink: null })).ok).toBe(true);
  });

  it('EFF-VER-REC-03 present after a recorded failed outcome appends only the reconciled record', async () => {
    const ledger = h.ledger();
    const intent = await recordIntent(ledger, comment());
    await recordOutcome(ledger, intent.effectId, { phase: 'failed', payloadDigest: comment().payloadDigest, failure: { reason: 'target-rejected' } });
    const verifiers = createVerifierRegistry([fake(async () => ({ result: 'present', reason: 'marker-match', complete: true }))]);
    const outcome = await reconcileEffect(ledger, intent.effectId, { verifiers });
    expect(outcome.result.exitCode).toBe(0);
    expect(outcome.completed).toBeNull();
    expect(phases()).toEqual(['intent', 'failed', 'reconciled']);
  });

  it('EFF-VER-REC-04 expectations reach the verifier and a pinned version mismatch is recorded as unknown', async () => {
    const ledger = h.ledger();
    const id = effectId({ scope, kind: 'tracker.comment', target: comment().target, context: comment().context });
    await recordIntent(ledger, comment());
    const seen: EffectVerifierRequest[] = [];
    const verifiers = createVerifierRegistry([fake(async req => { seen.push(req); return { result: 'present', reason: 'marker-match', complete: true }; })]);
    await reconcileEffect(ledger, id, { verifiers, expected: { digest: sha('x') } });
    expect(seen[0]).toMatchObject({ effectId: id, kind: 'tracker.comment', target: comment().target, expected: { digest: sha('x') }, payloadDigest: comment().payloadDigest });
    expect(seen[0].signal).toBeInstanceOf(AbortSignal);
    const pinned = await reconcileEffect(ledger, id, { verifiers, verifierVersion: '9.9.9' });
    expect(pinned.result.verification).toMatchObject({ result: 'unknown', reason: 'verifier-version-mismatch', verifier: { version: '1.0.0' } });
    expect(seen).toHaveLength(1);
  });
});
