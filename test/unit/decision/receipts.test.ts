import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { containsPortableSecretMaterial } from '../../../src/decision/portable-secrets.js';
import { DecisionPreDispatchError, DecisionReceiptIntegrityError, FileDecisionReceiptStore, MemoryDecisionReceiptStore, decisionInvocationFingerprint, nextReceipt } from '../../../src/decision/receipts.js';
import { evaluateDecisionRuleset } from '../../../src/decision/evaluate.js';
import { artifactPin } from '../../../src/decision/validate.js';
import type { AdapterObservation, DecisionAdapter, DecisionBinding, DecisionDefinition, DecisionRuleset, DecisionReceiptStore, RulesetResult } from '../../../src/decision/types.js';
import { readFileSync } from 'node:fs';

const fixture = <T>(name: string): T => JSON.parse(readFileSync(`examples/decision/${name}`, 'utf8')) as T;
const temp: string[] = [];
afterEach(async () => { await Promise.all(temp.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function stores(): Promise<DecisionReceiptStore[]> {
  const directory = await mkdtemp(join(tmpdir(), 'decision-receipt-'));
  temp.push(directory);
  return [new MemoryDecisionReceiptStore(), new FileDecisionReceiptStore(directory, { integrityKey: randomBytes(32) })];
}
function request(store: DecisionReceiptStore, adapter: DecisionAdapter, invocationId = 'atomic') {
  return {
    ruleset: fixture<DecisionRuleset>('ruleset.json'), binding: fixture<DecisionBinding>('binding-jev.json'),
    definitions: { category: fixture<DecisionDefinition>('decision-category.json'), severity: fixture<DecisionDefinition>('decision-severity.json'), core: fixture<DecisionDefinition>('decision-core_unavailable.json') },
    input: fixture('input.json'), runId: 'run', invocationId, adapters: { jev: adapter }, receiptStore: store,
  };
}
function adapter(gate?: Promise<void>): DecisionAdapter {
  return {
    id: 'jev', version: '1.0.0',
    capabilities: async () => ({ answerKinds: ['choice', 'ordinal-score', 'truth-probability'], features: ['choice', 'ordinal-score', 'truth-probability'], maxOptions: 255, maxLevels: 10, confidenceProfiles: ['typesafe-distribution-v1', 'typesafe-truth-v1'], executable: true, egress: { mode: 'none' as const } }),
    evaluate: vi.fn(async ({ alias }) => {
      await gate;
      const observation: AdapterObservation = { status: 'success', reason: 'none', value: alias === 'category' ? 'documentation' : alias === 'severity' ? 0.25 : 0.05,
        uncertainty: { source: 'provider', profile: alias === 'core_unavailable' ? 'typesafe-truth-v1' : 'typesafe-distribution-v1', calibration: 'vendor-claimed', confidence: 0.9, distribution: null, calibrationRef: null },
        actualModel: 'model', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 }, requestId: 'request' };
      return observation;
    }),
  };
}

describe('REC-ATOMIC store conformance', () => {
  it('acquires one owner and rejects stale CAS in both stores', async () => {
    for (const store of await stores()) {
      const fingerprint = `sha256:${'a'.repeat(64)}`;
      const [a, b] = await Promise.all([store.acquire('id', 'project', fingerprint), store.acquire('id', 'project', fingerprint)]);
      expect([a.owner, b.owner].sort()).toEqual([false, true]);
      const next = nextReceipt(a.receipt, 'dispatched');
      expect(await store.compareAndSwap('id', 'project', 1, next)).toBe(true);
      expect(await store.compareAndSwap('id', 'project', 1, next)).toBe(false);
      await expect(store.read('id', 'other-project')).rejects.toThrow();
    }
  });

  it('races equivalent callers behind an adapter barrier and returns the identical result', async () => {
    for (const store of await stores()) {
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const worker = adapter(gate);
      const base = request(store, worker);
      const first = evaluateDecisionRuleset(base);
      const second = evaluateDecisionRuleset(base);
      release();
      const [one, two] = await Promise.all([first, second]);
      expect(one).toEqual(two);
      expect(one.spec.status).toBe('completed');
      expect(vi.mocked(worker.evaluate).mock.calls).toHaveLength(3);
      const mismatch = await evaluateDecisionRuleset({ ...base, input: { message: 'changed' } });
      expect(mismatch.spec.reason).toBe('replay-mismatch');
      const policy = { id: 'policy', version: '1', digest: `sha256:${'b'.repeat(64)}` as const };
      expect((await evaluateDecisionRuleset({ ...base, policyPin: policy })).spec.reason).toBe('replay-mismatch');
      expect((await evaluateDecisionRuleset({ ...base, calibrationPin: policy })).spec.reason).toBe('replay-mismatch');
      expect(vi.mocked(worker.evaluate).mock.calls).toHaveLength(3);
    }
  });

  it('rejects each changed definition, ruleset, and binding pin before dispatch', async () => {
    for (const store of await stores()) {
      const worker = adapter();
      const base = request(store, worker, 'pin-replay');
      expect((await evaluateDecisionRuleset(base)).spec.status).toBe('completed');
      const initialCalls = vi.mocked(worker.evaluate).mock.calls.length;
      const binding = structuredClone(base.binding);
      binding.metadata.version = '1.0.1';
      expect((await evaluateDecisionRuleset({ ...base, binding })).spec.reason).toBe('replay-mismatch');
      const ruleset = structuredClone(base.ruleset);
      ruleset.metadata.version = '1.0.1';
      const matchingBinding = structuredClone(base.binding);
      matchingBinding.spec.ruleset = artifactPin(ruleset);
      expect((await evaluateDecisionRuleset({ ...base, ruleset, binding: matchingBinding })).spec.reason).toBe('replay-mismatch');
      const definitions = structuredClone(base.definitions);
      definitions.category!.metadata.version = '1.0.1';
      const changedRuleset = structuredClone(base.ruleset);
      changedRuleset.spec.evaluations[0]!.decision = artifactPin(definitions.category!);
      const changedBinding = structuredClone(base.binding);
      changedBinding.spec.ruleset = artifactPin(changedRuleset);
      expect((await evaluateDecisionRuleset({ ...base, definitions, ruleset: changedRuleset, binding: changedBinding })).spec.reason).toBe('replay-mismatch');
      expect(vi.mocked(worker.evaluate).mock.calls).toHaveLength(initialCalls);
    }
  });

  it('returns immutable timestamps, attempts, model, usage, and outcome on completed replay', async () => {
    for (const store of await stores()) {
      const worker = adapter();
      const base = request(store, worker, 'immutable-replay');
      const first = await evaluateDecisionRuleset(base);
      const original = await store.read(base.invocationId, 'default');
      expect(original?.state).toBe('completed');
      expect(original?.completedAtEpochMs).toBeGreaterThanOrEqual(original!.acquiredAtEpochMs);
      expect(original?.result).toEqual(first);
      expect(original?.result?.spec.evaluations.category?.spec.attempts[0]).toMatchObject({ actualModel: 'model', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 } });
      expect(original?.result?.spec.outcome).toBe('docs-review');
      expect(await evaluateDecisionRuleset(base)).toEqual(first);
      expect(await store.read(base.invocationId, 'default')).toEqual(original);
      expect(vi.mocked(worker.evaluate).mock.calls).toHaveLength(3);
    }
  });

  it('rejects modified durable records before reuse', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'decision-receipt-tamper-'));
    temp.push(directory);
    const store = new FileDecisionReceiptStore(directory, { integrityKey: randomBytes(32) });
    const receipt = await store.acquire('id', 'project', `sha256:${'a'.repeat(64)}`);
    expect(receipt.owner).toBe(true);
    const name = (await readdir(directory)).find(file => file.endsWith('.json'))!;
    const path = join(directory, name);
    const body = (await readFile(path, 'utf8')).replace('acquired', 'completed');
    await writeFile(path, body);
    await expect(store.read('id', 'project')).rejects.toThrow(/integrity/);
  });

  it('rejects a valid record substituted at another invocation filename', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'decision-receipt-index-'));
    temp.push(directory);
    const store = new FileDecisionReceiptStore(directory, { integrityKey: randomBytes(32) });
    await store.acquire('original', 'project', `sha256:${'a'.repeat(64)}`);
    const file = (id: string) => join(directory, `${createHash('sha256').update(id).digest('hex')}.r1.json`);
    await copyFile(file('original'), file('substituted'));
    await expect(store.read('substituted', 'project')).rejects.toThrow(/Invalid decision receipt/);
    await expect(store.acquire('substituted', 'project', `sha256:${'a'.repeat(64)}`)).rejects.toThrow(/Invalid decision receipt/);
  });

  it('accepts only one simultaneous next revision and rejects gaps or corrupted highest revisions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'decision-receipt-revisions-'));
    temp.push(directory);
    const key = randomBytes(32);
    const first = new FileDecisionReceiptStore(directory, { integrityKey: key });
    const second = new FileDecisionReceiptStore(directory, { integrityKey: key });
    const fingerprint = `sha256:${'a'.repeat(64)}`;
    const acquired = (await first.acquire('revisions', 'project', fingerprint)).receipt;
    const candidates = [nextReceipt(acquired, 'dispatched'), nextReceipt(acquired, 'dispatched')];
    const [a, b] = await Promise.all([
      first.compareAndSwap('revisions', 'project', 1, candidates[0]!),
      second.compareAndSwap('revisions', 'project', 1, candidates[1]!),
    ]);
    expect([a, b].sort()).toEqual([false, true]);
    expect((await first.read('revisions', 'project'))?.revision).toBe(2);
    const prefix = createHash('sha256').update('revisions').digest('hex');
    const highest = join(directory, `${prefix}.r2.json`);
    const original = await readFile(highest, 'utf8');
    await writeFile(highest, original.replace('dispatched', 'completed'));
    await expect(first.read('revisions', 'project')).rejects.toThrow(/integrity/);
    await writeFile(highest, original);
    await rm(join(directory, `${prefix}.r1.json`));
    await expect(first.read('revisions', 'project')).rejects.toThrow(/revision gap/);
  });

  it('elects exactly one owner across two processes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'decision-receipt-process-'));
    temp.push(directory);
    const key = randomBytes(32).toString('hex');
    const start = () => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'test/fixtures/decision/receipt-process.mjs', directory, key, 'process-race'],
        { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      let errors = '';
      let ready!: () => void;
      const initialized = new Promise<void>(resolve => { ready = resolve; });
      child.stdout.on('data', chunk => { output += String(chunk); if (output.includes('ready\n')) ready(); });
      child.stderr.on('data', chunk => { errors += String(chunk); });
      const result = new Promise<{ owner: boolean; revision: number }>((resolve, reject) => child.on('exit', code => {
        if (code !== 0) reject(new Error(errors));
        else resolve(JSON.parse(output.trim().split('\n').at(-1)!) as { owner: boolean; revision: number });
      }));
      return { child, initialized, result };
    };
    const a = start();
    const b = start();
    await Promise.all([a.initialized, b.initialized]);
    a.child.stdin.write('go\n');
    b.child.stdin.write('go\n');
    const results = await Promise.all([a.result, b.result]);
    expect(results.map(result => result.owner).sort()).toEqual([false, true]);
    expect(results.map(result => result.revision)).toEqual([1, 1]);
  });

  it('allows one owner while another writer pauses before atomic publication', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'decision-receipt-paused-writer-'));
    temp.push(directory);
    const key = randomBytes(32);
    let entered!: () => void;
    let release!: () => void;
    const paused = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = new FileDecisionReceiptStore(directory, { integrityKey: key,
      onPublish: async stage => { if (stage === 'before-link') { entered(); await gate; } } });
    const second = new FileDecisionReceiptStore(directory, { integrityKey: key });
    const fingerprint = `sha256:${'a'.repeat(64)}`;
    const pending = first.acquire('paused', 'project', fingerprint);
    await paused;
    const winner = await second.acquire('paused', 'project', fingerprint);
    release();
    const loser = await pending;
    expect(winner.owner).toBe(true);
    expect(loser.owner).toBe(false);
    expect(loser.receipt).toEqual(winner.receipt);
  });

  it.each(['before-link', 'after-link'] as const)('recovers after SIGKILL at %s publication', async stage => {
    const directory = await mkdtemp(join(tmpdir(), 'decision-receipt-publish-crash-'));
    temp.push(directory);
    const key = randomBytes(32);
    const child = spawn(process.execPath, ['--import', 'tsx', 'test/fixtures/decision/receipt-process.mjs',
      directory, key.toString('hex'), `publish-${stage}`, `publish-hold-${stage}`],
    { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let ready!: () => void;
    let published!: () => void;
    const isReady = new Promise<void>(resolve => { ready = resolve; });
    const didPublish = new Promise<void>(resolve => { published = resolve; });
    child.stdout.on('data', chunk => {
      output += String(chunk);
      if (output.includes('ready\n')) ready();
      if (output.includes(`publish-${stage}\n`)) published();
    });
    await isReady;
    child.stdin.write('go\n');
    await didPublish;
    child.kill('SIGKILL');
    await new Promise<void>(resolve => child.once('exit', () => resolve()));
    const store = new FileDecisionReceiptStore(directory, { integrityKey: key });
    const acquisition = await store.acquire(`publish-${stage}`, 'project', `sha256:${'a'.repeat(64)}`);
    expect(acquisition.owner).toBe(stage === 'before-link');
    expect(acquisition.receipt.state).toBe('acquired');
  });

  it('retains a dispatched receipt after its owner process is killed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'decision-receipt-crash-'));
    temp.push(directory);
    const key = randomBytes(32);
    const child = spawn(process.execPath, ['--import', 'tsx', 'test/fixtures/decision/receipt-process.mjs', directory, key.toString('hex'), 'crash', 'dispatch'],
      { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let ready!: () => void;
    let dispatched!: () => void;
    const isReady = new Promise<void>(resolve => { ready = resolve; });
    const didDispatch = new Promise<void>(resolve => { dispatched = resolve; });
    child.stdout.on('data', chunk => {
      output += String(chunk);
      if (output.includes('ready\n')) ready();
      if (output.includes('dispatched\n')) dispatched();
    });
    await isReady;
    child.stdin.write('go\n');
    await didDispatch;
    child.kill('SIGKILL');
    await new Promise<void>(resolve => child.once('exit', () => resolve()));
    const restarted = new FileDecisionReceiptStore(directory, { integrityKey: key });
    const receipt = await restarted.acquire('crash', 'project', `sha256:${'a'.repeat(64)}`);
    expect(receipt.owner).toBe(false);
    expect(receipt.receipt.state).toBe('dispatched');
    expect(receipt.receipt.revision).toBe(2);
  });

  it('survives a real process kill and restart at every receipt state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'decision-receipt-process-matrix-'));
    temp.push(directory);
    const key = randomBytes(32);
    const reopen = () => new FileDecisionReceiptStore(directory, { integrityKey: key });
    async function crashAt(invocationId: string, state: string): Promise<void> {
      const child = spawn(process.execPath, ['--import', 'tsx', 'test/fixtures/decision/receipt-process.mjs',
        directory, key.toString('hex'), invocationId, 'transition', state],
      { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      let errors = '';
      let ready!: () => void;
      let transitioned!: () => void;
      const isReady = new Promise<void>(resolve => { ready = resolve; });
      const didTransition = new Promise<void>(resolve => { transitioned = resolve; });
      child.stdout.on('data', chunk => {
        output += String(chunk);
        if (output.includes('ready\n')) ready();
        if (output.includes(`\n${state}\n`)) transitioned();
      });
      child.stderr.on('data', chunk => { errors += String(chunk); });
      await isReady;
      child.stdin.write('go\n');
      await didTransition;
      child.kill('SIGKILL');
      await new Promise<void>(resolve => child.once('exit', () => resolve()));
      expect(errors).toBe('');
      expect((await reopen().read(invocationId, 'project'))?.state).toBe(state);
    }
    for (const state of ['acquired', 'dispatched', 'remote-handle-known', 'observation-received', 'composed', 'completed']) {
      await crashAt('matrix', state);
    }
    await crashAt('failed-branch', 'acquired');
    await crashAt('failed-branch', 'failed');
    await crashAt('uncertain-branch', 'acquired');
    await crashAt('uncertain-branch', 'execution-uncertain');
  }, 30_000);

  it('restarts the evaluator after each killed state without duplicate remote dispatch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'decision-receipt-evaluator-restart-'));
    temp.push(directory);
    const key = randomBytes(32);
    const store = new FileDecisionReceiptStore(directory, { integrityKey: key });
    for (const state of ['acquired', 'dispatched', 'remote-handle-known', 'observation-received', 'composed', 'completed']) {
      const invocationId = `restart-${state}`;
      const worker = adapter();
      const base = request(store, worker, invocationId);
      const fingerprint = decisionInvocationFingerprint({ invocationId, value: base.input,
        definitions: base.ruleset.spec.evaluations.map(item => item.decision),
        ruleset: artifactPin(base.ruleset), binding: artifactPin(base.binding) });
      const child = spawn(process.execPath, ['--import', 'tsx', 'test/fixtures/decision/receipt-process.mjs',
        directory, key.toString('hex'), invocationId, 'transition', state, fingerprint],
      { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      let ready!: () => void;
      let transitioned!: () => void;
      const isReady = new Promise<void>(resolve => { ready = resolve; });
      const didTransition = new Promise<void>(resolve => { transitioned = resolve; });
      child.stdout.on('data', chunk => {
        output += String(chunk);
        if (output.includes('ready\n')) ready();
        if (output.includes(`\n${state}\n`)) transitioned();
      });
      await isReady;
      child.stdin.write('go\n');
      await didTransition;
      child.kill('SIGKILL');
      await new Promise<void>(resolve => child.once('exit', () => resolve()));
      const restarted: DecisionReceiptStore = { read: store.read.bind(store), acquire: store.acquire.bind(store),
        compareAndSwap: store.compareAndSwap.bind(store), waitForTerminal: async () => { throw new Error('owner terminated'); } };
      const result = await evaluateDecisionRuleset({ ...base, receiptStore: restarted, receiptProjectId: 'project' });
      if (state === 'completed') expect(result).toEqual((await store.read(invocationId, 'project'))?.result);
      else expect(result.spec.reason, state).toBe('execution-uncertain');
      expect(vi.mocked(worker.evaluate)).not.toHaveBeenCalled();
    }
  }, 30_000);

  it('canonicalizes input keys and binds ordered pins', () => {
    const pin = { id: 'x', version: '1', digest: `sha256:${'a'.repeat(64)}` as const };
    const base = { invocationId: 'x', ruleset: pin, binding: pin, definitions: [pin], value: { é: 1.5, a: -0 } };
    expect(decisionInvocationFingerprint(base)).toBe(decisionInvocationFingerprint({ ...base, value: { a: 0, é: 1.5 } }));
    expect(decisionInvocationFingerprint(base)).not.toBe(decisionInvocationFingerprint({ ...base, policy: pin }));
  });

  it('checks access on reads and waits', async () => {
    let permitted = true;
    const store = new MemoryDecisionReceiptStore(() => permitted);
    await store.acquire('id', 'project', `sha256:${'a'.repeat(64)}`);
    permitted = false;
    await expect(store.read('id', 'project')).rejects.toThrow(/access denied/);
    await expect(store.waitForTerminal('id', 'project', `sha256:${'a'.repeat(64)}`)).rejects.toThrow(/access denied/);
  });

  it('rechecks authorization immediately before remote reconciliation', async () => {
    let permitted = true;
    const underlying = new MemoryDecisionReceiptStore(() => permitted);
    const worker = adapter();
    const base = request(underlying, worker, 'revoked-reconcile');
    const fingerprint = decisionInvocationFingerprint({ invocationId: base.invocationId, value: base.input,
      definitions: base.ruleset.spec.evaluations.map(item => item.decision),
      ruleset: artifactPin(base.ruleset), binding: artifactPin(base.binding) });
    let receipt = (await underlying.acquire(base.invocationId, 'default', fingerprint)).receipt;
    let next = nextReceipt(receipt, 'dispatched', { pending: { alias: 'category', targetIndex: 0, ordinal: 1, attempts: [] } });
    await underlying.compareAndSwap(base.invocationId, 'default', receipt.revision, next);
    receipt = next;
    next = nextReceipt(receipt, 'remote-handle-known', { remoteHandles: ['remote-1'] });
    await underlying.compareAndSwap(base.invocationId, 'default', receipt.revision, next);
    let reads = 0;
    const wrapped: DecisionReceiptStore = {
      acquire: underlying.acquire.bind(underlying), compareAndSwap: underlying.compareAndSwap.bind(underlying),
      waitForTerminal: async () => { throw new Error('owner stopped'); },
      read: async (id, project) => {
        const value = await underlying.read(id, project);
        reads += 1;
        if (reads === 1) permitted = false;
        return value;
      },
    };
    const reconciler = vi.fn(async () => null);
    const result = await evaluateDecisionRuleset({ ...base, receiptStore: wrapped, reconcileRemote: reconciler });
    expect(result.spec.reason).toBe('persistence-error');
    expect(reconciler).not.toHaveBeenCalled();
    expect(vi.mocked(worker.evaluate)).not.toHaveBeenCalled();
  });

  it('blocks outcomes when receipt persistence fails after inference', async () => {
    const delegate = new MemoryDecisionReceiptStore();
    const broken: DecisionReceiptStore = {
      read: delegate.read.bind(delegate), acquire: delegate.acquire.bind(delegate),
      waitForTerminal: delegate.waitForTerminal.bind(delegate),
      compareAndSwap: async (id, project, revision, next) => next.state === 'completed'
        ? Promise.reject(new Error('disk full')) : delegate.compareAndSwap(id, project, revision, next),
    };
    const worker = adapter();
    const result = await evaluateDecisionRuleset(request(broken, worker, 'disk-full'));
    expect(result.spec.reason).toBe('persistence-error');
    expect(result.spec.outcome).toBeUndefined();
    expect(vi.mocked(worker.evaluate).mock.calls).toHaveLength(3);
  });

  it('never retries an incomplete dispatched receipt', async () => {
    for (const store of await stores()) {
      const worker = adapter();
      const base = request(store, worker, 'crashed');
      // Use the evaluator to create a legitimate fingerprint, then inject a crash at dispatch.
      const failStore: DecisionReceiptStore = {
        read: store.read.bind(store), acquire: store.acquire.bind(store), waitForTerminal: store.waitForTerminal.bind(store),
        compareAndSwap: async (id, project, revision, next) => {
          const saved = await store.compareAndSwap(id, project, revision, next);
          if (next.state === 'dispatched') throw new Error('process stopped');
          return saved;
        },
      };
      const first = await evaluateDecisionRuleset({ ...base, receiptStore: failStore });
      expect(first.spec.reason).toBe('persistence-error');
      const restarted: DecisionReceiptStore = { read: store.read.bind(store), acquire: store.acquire.bind(store),
        compareAndSwap: store.compareAndSwap.bind(store), waitForTerminal: async () => { throw new Error('owner disappeared'); } };
      const second = await evaluateDecisionRuleset({ ...base, receiptStore: restarted });
      expect(second.spec.reason).toBe('execution-uncertain');
      expect(vi.mocked(worker.evaluate)).not.toHaveBeenCalled();
    }
  });

  it('makes ambiguous post-dispatch failures uncertain without retry or fallback', async () => {
    for (const store of await stores()) {
      const worker = adapter();
      worker.evaluate = vi.fn(async () => { throw new Error('socket closed after write'); });
      const base = request(store, worker, 'ambiguous-throw');
      base.binding.spec.evaluations.category!.targets[0]!.retry.maxRetries = 1;
      const result = await evaluateDecisionRuleset(base);
      expect(result.spec.reason).toBe('execution-uncertain');
      expect(result.spec.outcome).toBeUndefined();
      expect(vi.mocked(worker.evaluate)).toHaveBeenCalledTimes(1);
      expect((await store.read(base.invocationId, 'default'))?.state).toBe('execution-uncertain');
    }
    for (const store of await stores()) {
      const worker = adapter();
      worker.evaluate = vi.fn(async () => ({ status: 'error', reason: 'network-transient', uncertainty: null,
        actualModel: null, usage: { inputTokens: null, outputTokens: null, costUsd: null }, requestId: null,
        dispatchCertainty: 'unknown' } satisfies AdapterObservation));
      const base = request(store, worker, 'ambiguous-observation');
      base.binding.spec.evaluations.category!.targets[0]!.retry.maxRetries = 1;
      const result = await evaluateDecisionRuleset(base);
      expect(result.spec.reason).toBe('execution-uncertain');
      expect(vi.mocked(worker.evaluate)).toHaveBeenCalledTimes(1);
    }
  });

  it('retries only when transport proves a terminal response or no remote send', async () => {
    for (const certainty of ['terminal-response', 'not-sent'] as const) {
      const store = new MemoryDecisionReceiptStore();
      const worker = adapter();
      const original = worker.evaluate.bind(worker);
      let calls = 0;
      worker.evaluate = vi.fn(async request => {
        calls += 1;
        if (request.alias === 'category' && calls === 1) {
          if (certainty === 'not-sent') throw new DecisionPreDispatchError('request not sent');
          return { status: 'error', reason: 'rate-limited', uncertainty: null,
            actualModel: null, usage: { inputTokens: null, outputTokens: null, costUsd: null }, requestId: null,
            dispatchCertainty: certainty } satisfies AdapterObservation;
        }
        return original(request);
      });
      const base = request(store, worker, `proved-${certainty}`);
      base.binding.spec.evaluations.category!.targets[0]!.retry.maxRetries = 1;
      base.binding.spec.maxAttempts = 5;
      const result = await evaluateDecisionRuleset({ ...base, delay: async () => undefined });
      expect(result.spec.status).toBe('completed');
      expect(vi.mocked(worker.evaluate).mock.calls.filter(([call]) => call.alias === 'category')).toHaveLength(2);
    }
  });

  it('reconciles a known successful handle and composes without redispatching that evaluation', async () => {
    for (const store of await stores()) {
      const worker = adapter();
      const base = request(store, worker, 'reconcile');
      const fingerprint = decisionInvocationFingerprint({ invocationId: base.invocationId, value: base.input,
        definitions: base.ruleset.spec.evaluations.map(item => item.decision),
        ruleset: artifactPin(base.ruleset), binding: artifactPin(base.binding) });
      let receipt = (await store.acquire(base.invocationId, 'default', fingerprint)).receipt;
      let next = nextReceipt(receipt, 'dispatched', { pending: { alias: 'category', targetIndex: 0, ordinal: 1, attempts: [] } });
      expect(await store.compareAndSwap(base.invocationId, 'default', receipt.revision, next)).toBe(true);
      receipt = next;
      next = nextReceipt(receipt, 'remote-handle-known', { remoteHandles: ['remote-1'] });
      expect(await store.compareAndSwap(base.invocationId, 'default', receipt.revision, next)).toBe(true);
      const restarted: DecisionReceiptStore = { read: store.read.bind(store), acquire: store.acquire.bind(store),
        compareAndSwap: store.compareAndSwap.bind(store), waitForTerminal: async () => { throw new Error('owner process stopped'); } };
      const reconciler = vi.fn(async () => ({ status: 'success', reason: 'none', value: 'documentation',
        uncertainty: { source: 'provider', profile: 'typesafe-distribution-v1', calibration: 'vendor-claimed', confidence: 0.9, distribution: null, calibrationRef: null },
        actualModel: 'model', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 }, requestId: 'remote-1' } satisfies AdapterObservation));
      const result = await evaluateDecisionRuleset({ ...base, receiptStore: restarted, reconcileRemote: reconciler });
      expect(result.spec.status).toBe('completed');
      expect(result.spec.outcome).toBe('docs-review');
      expect(reconciler).toHaveBeenCalledWith('remote-1', expect.any(AbortSignal));
      expect(vi.mocked(worker.evaluate).mock.calls.map(([call]) => call.alias)).toEqual(['severity', 'core_unavailable']);
      expect((await store.read(base.invocationId, 'default'))?.result).toEqual(result);
    }
  });

  it('survives a store restart after every transition and preserves terminal immutability', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'decision-receipt-transitions-'));
    temp.push(directory);
    const key = randomBytes(32);
    const reopen = () => new FileDecisionReceiptStore(directory, { integrityKey: key });
    const invocationId = 'transitions';
    let current = (await reopen().acquire(invocationId, 'project', `sha256:${'a'.repeat(64)}`)).receipt;
    for (const state of ['dispatched', 'remote-handle-known', 'observation-received', 'dispatched', 'observation-received', 'composed'] as const) {
      const extra = state === 'remote-handle-known' ? { remoteHandles: ['handle-1'] } : {};
      const next = nextReceipt(current, state, extra);
      expect(await reopen().compareAndSwap(invocationId, 'project', current.revision, next)).toBe(true);
      current = (await reopen().read(invocationId, 'project'))!;
      expect(current).toEqual(next);
    }
    const result = fixture<RulesetResult>('ruleset-result.json');
    result.spec.invocationId = invocationId;
    const completed = nextReceipt(current, 'completed', { result });
    expect(await reopen().compareAndSwap(invocationId, 'project', current.revision, completed)).toBe(true);
    expect((await reopen().acquire(invocationId, 'project', current.fingerprint)).receipt).toEqual(completed);
    expect((await reopen().read(invocationId, 'project'))?.acquiredAtEpochMs).toBe(current.acquiredAtEpochMs);
    expect((await reopen().read(invocationId, 'project'))?.completedAtEpochMs).toBe(completed.completedAtEpochMs);
    expect(() => nextReceipt(completed, 'dispatched')).toThrow(/Illegal receipt transition/);
  });
});

// Canaries are assembled at runtime so no literal secret-shaped string lives in the source tree.
const canary = 'CANARY' + 'x9Q7'.repeat(6);
const secretFixtures: Array<[string, unknown]> = [
  ['bearer value', `Bearer ${canary}`],
  ['PEM private key', `-----BEGIN ${'PRIVATE'} KEY-----\n${canary}\n-----END ${'PRIVATE'} KEY-----`],
  ['vault locator', `vault://kv/decision/${canary}`],
  ['Vault KV-v2 path', `secret/data/decision/${canary}`],
  ['secret-derived hash key', { tokenSha256Hash: `sha256:${canary}` }],
  ['embedded API key value', { apiKeyValue: canary }],
];

describe('SEC-PORTABLE shared secret-material detector', () => {
  it('SEC-PORTABLE-01 detects each forbidden fixture', () => {
    for (const [label, value] of secretFixtures) expect(containsPortableSecretMaterial({ nested: [value] }), label).toBe(true);
    expect(containsPortableSecretMaterial(`-----BEGIN ENCRYPTED ${'PRIVATE'} KEY-----`)).toBe(true);
  });

  it('SEC-PORTABLE-02 benign control: logical refs, token counts, and prose pass', () => {
    expect(containsPortableSecretMaterial({
      credentialRef: 'typesafe.jev.playground', usage: { inputTokens: 1, outputTokens: 2 },
      rationale: 'the bearer of the message was a reviewer', handle: 'jev:job/abc-123',
      digest: `sha256:${'a'.repeat(64)}`, maxTokens: 2048, secretary: 'ok', path: 'docs/secret/data.md',
    })).toBe(false);
  });
});

describe('PRV-EGRESS-RECEIPT portable decision receipts', () => {
  const fingerprint = `sha256:${'a'.repeat(64)}`;
  const evaluation = (extra: Record<string, unknown>) => ({ a: { spec: { alias: 'a', invocationId: 'egress', ...extra } } }) as never;

  it('PRV-EGRESS-RECEIPT-01 rejects secret material in remote handles without echoing it', async () => {
    const { receipt } = await new MemoryDecisionReceiptStore().acquire('egress', 'project', fingerprint);
    const dispatched = nextReceipt(receipt, 'dispatched');
    for (const [label, value] of secretFixtures) {
      const handle = typeof value === 'string' ? value : JSON.stringify(value);
      let caught: unknown;
      try { nextReceipt(dispatched, 'remote-handle-known', { remoteHandles: [handle] }); } catch (error) { caught = error; }
      expect(caught, label).toBeInstanceOf(DecisionReceiptIntegrityError);
      expect((caught as Error).message).not.toContain(canary);
    }
  });

  it('PRV-EGRESS-RECEIPT-02 rejects secret material in evaluations, pending attempts, and results', async () => {
    const { receipt } = await new MemoryDecisionReceiptStore().acquire('egress', 'project', fingerprint);
    const dispatched = nextReceipt(receipt, 'dispatched');
    for (const [label, value] of secretFixtures) {
      expect(() => nextReceipt(dispatched, 'observation-received', { evaluations: evaluation({ value }) }), label)
        .toThrow(DecisionReceiptIntegrityError);
      expect(() => nextReceipt(dispatched, 'observation-received', {
        pending: { alias: 'a', targetIndex: 0, ordinal: 1, attempts: [{ detail: value }] } as never,
      }), label).toThrow(DecisionReceiptIntegrityError);
    }
    const composed = nextReceipt(nextReceipt(dispatched, 'observation-received'), 'composed');
    expect(() => nextReceipt(composed, 'completed', {
      result: { spec: { invocationId: 'egress', status: 'completed', note: `Bearer ${canary}` } } as never,
    })).toThrow(/forbidden credential or private-locator material/);
  });

  it('PRV-EGRESS-RECEIPT-03 stores never persist a receipt carrying secret material', async () => {
    for (const store of await stores()) {
      const { receipt } = await store.acquire('egress', 'project', fingerprint);
      const dispatched = nextReceipt(receipt, 'dispatched');
      expect(await store.compareAndSwap('egress', 'project', 1, dispatched)).toBe(true);
      const forged = { ...structuredClone(dispatched), state: 'remote-handle-known' as const, revision: 3,
        remoteHandles: [`vault://kv/${canary}`] };
      const failure = await store.compareAndSwap('egress', 'project', 2, forged).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(DecisionReceiptIntegrityError);
      expect((failure as Error).message).not.toContain(canary);
      const current = await store.read('egress', 'project');
      expect(current?.revision).toBe(2);
      expect(JSON.stringify(current)).not.toContain(canary);
    }
  });

  it('PRV-EGRESS-RECEIPT-04 benign control: opaque handles and logical credential refs are accepted', async () => {
    const { receipt } = await new MemoryDecisionReceiptStore().acquire('egress', 'project', fingerprint);
    const known = nextReceipt(nextReceipt(receipt, 'dispatched'), 'remote-handle-known', { remoteHandles: ['jev:job/0f3c-7a1e'] });
    const observed = nextReceipt(known, 'observation-received', {
      evaluations: evaluation({ credentialRef: 'typesafe.jev.playground', usage: { inputTokens: 3 } }),
    });
    expect(observed.remoteHandles).toEqual(['jev:job/0f3c-7a1e']);
  });
});
