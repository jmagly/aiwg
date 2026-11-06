import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson } from '../security/artifact-trust.js';
import { assertNoPortableSecretMaterial } from './portable-secrets.js';
import type { ArtifactPin, DecisionReceipt, DecisionReceiptAcquireOptions, DecisionReceiptState, DecisionReceiptStore } from './types.js';
import { assertDecisionResultWriterVersion } from './validate.js';
import { isTraceparent } from './telemetry/context.js';

export function decisionInvocationFingerprint(input: {
  invocationId: string;
  value: unknown;
  definitions: ArtifactPin[];
  ruleset: ArtifactPin;
  binding: ArtifactPin;
  policy?: ArtifactPin | null;
  calibration?: ArtifactPin | null;
}): string {
  return `sha256:${createHash('sha256').update(canonicalJson({
    invocationId: input.invocationId, input: input.value, definitions: input.definitions,
    ruleset: input.ruleset, binding: input.binding,
    policy: input.policy ?? null, calibration: input.calibration ?? null,
  })).digest('hex')}`;
}

const terminal = new Set<DecisionReceiptState>(['completed', 'failed', 'execution-uncertain']);
const allowed: Record<DecisionReceiptState, DecisionReceiptState[]> = {
  acquired: ['dispatched', 'observation-received', 'composed', 'failed', 'execution-uncertain'],
  dispatched: ['remote-handle-known', 'observation-received', 'execution-uncertain'],
  'remote-handle-known': ['observation-received', 'execution-uncertain'],
  'observation-received': ['observation-received', 'dispatched', 'composed', 'failed', 'execution-uncertain'],
  composed: ['completed', 'failed', 'execution-uncertain'],
  completed: [], failed: [], 'execution-uncertain': [],
};

export class DecisionReceiptIntegrityError extends Error {}
export class DecisionReceiptAccessError extends Error {}
/** A transport may throw this only before it has attempted remote dispatch. */
export class DecisionPreDispatchError extends Error {}

export function validateReceipt(receipt: DecisionReceipt, invocationId: string, projectId: string): void {
  if (!receipt || receipt.schema !== 'decision-receipt/v2' || receipt.invocationId !== invocationId || receipt.projectId !== projectId
    || !Number.isSafeInteger(receipt.revision) || receipt.revision < 1
    || !Number.isSafeInteger(receipt.acquiredAtEpochMs) || receipt.acquiredAtEpochMs < 0
    || !Number.isSafeInteger(receipt.updatedAtEpochMs) || receipt.updatedAtEpochMs < receipt.acquiredAtEpochMs
    || (receipt.state === 'completed' ? !Number.isSafeInteger(receipt.completedAtEpochMs)
      || receipt.completedAtEpochMs! < receipt.acquiredAtEpochMs
      : receipt.completedAtEpochMs !== undefined)
    || !/^sha256:[a-f0-9]{64}$/.test(receipt.fingerprint)
    || !Object.hasOwn(allowed, receipt.state) || !Array.isArray(receipt.remoteHandles)
    || receipt.remoteHandles.some(handle => typeof handle !== 'string' || !handle.length)
    || !receipt.evaluations || typeof receipt.evaluations !== 'object' || Array.isArray(receipt.evaluations)
    || Object.entries(receipt.evaluations).some(([alias, result]) => result.spec.alias !== alias || result.spec.invocationId !== invocationId)
    || (receipt.pending !== null && (!receipt.pending || typeof receipt.pending.alias !== 'string'
      || !Number.isSafeInteger(receipt.pending.targetIndex) || receipt.pending.targetIndex < 0
      || !Number.isSafeInteger(receipt.pending.ordinal) || receipt.pending.ordinal < 1
      || !Array.isArray(receipt.pending.attempts)))
    || (receipt.state === 'completed' && (!receipt.result || receipt.result.spec.invocationId !== invocationId
      || receipt.result.spec.status === 'error' && receipt.result.spec.reason === 'execution-uncertain'))
    || (receipt.state !== 'completed' && receipt.result !== undefined)
    || (receipt.traceParent !== undefined && !isTraceparent(receipt.traceParent))) {
    throw new DecisionReceiptIntegrityError('Invalid decision receipt');
  }
  assertReceiptPortable(receipt);
}

/** Receipts are portable artifacts: handles and payloads must never carry secret material. */
function assertReceiptPortable(receipt: DecisionReceipt): void {
  const reject = (message: string): Error => new DecisionReceiptIntegrityError(message);
  receipt.remoteHandles.forEach(handle => assertNoPortableSecretMaterial(handle, 'Decision receipt remote handle', reject));
  assertNoPortableSecretMaterial(receipt.evaluations, 'Decision receipt evaluations', reject);
  assertNoPortableSecretMaterial(receipt.pending, 'Decision receipt pending evaluation', reject);
  if (receipt.result !== undefined) assertNoPortableSecretMaterial(receipt.result, 'Decision receipt result', reject);
}

export function nextReceipt(previous: DecisionReceipt, state: DecisionReceiptState, extra: Partial<Pick<DecisionReceipt, 'result' | 'remoteHandles' | 'evaluations' | 'pending' | 'updatedAtEpochMs' | 'completedAtEpochMs'>> = {}): DecisionReceipt {
  if (!allowed[previous.state].includes(state)) throw new DecisionReceiptIntegrityError('Illegal receipt transition');
  // Receipt payloads are result writers: newly written results pass the v1alpha2 writer gate.
  if (extra.result !== undefined) assertDecisionResultWriterVersion(extra.result);
  for (const [alias, result] of Object.entries(extra.evaluations ?? {})) {
    if (!Object.hasOwn(previous.evaluations, alias)) assertDecisionResultWriterVersion(result);
  }
  const updatedAtEpochMs = Math.max(previous.updatedAtEpochMs, extra.updatedAtEpochMs ?? Date.now());
  const next = { ...structuredClone(previous), ...structuredClone(extra), state, revision: previous.revision + 1,
    updatedAtEpochMs, ...(state === 'completed' ? { completedAtEpochMs: extra.completedAtEpochMs ?? updatedAtEpochMs } : {}) };
  if (next.remoteHandles.length < previous.remoteHandles.length || previous.remoteHandles.some((handle, index) => next.remoteHandles[index] !== handle)) {
    throw new DecisionReceiptIntegrityError('Remote handle lineage changed');
  }
  if (Object.entries(previous.evaluations).some(([alias, result]) => canonicalJson(next.evaluations[alias]) !== canonicalJson(result))) {
    throw new DecisionReceiptIntegrityError('Completed evaluation lineage changed');
  }
  validateReceipt(next, previous.invocationId, previous.projectId);
  return next;
}

function initial(invocationId: string, projectId: string, fingerprint: string, options: DecisionReceiptAcquireOptions = {}): DecisionReceipt {
  const acquiredAtEpochMs = Date.now();
  // traceParent is fixed at acquisition: nextReceipt() copies it and transitions cannot supply it.
  const receipt: DecisionReceipt = { schema: 'decision-receipt/v2', revision: 1, acquiredAtEpochMs, updatedAtEpochMs: acquiredAtEpochMs,
    projectId, invocationId, fingerprint, state: 'acquired', remoteHandles: [], evaluations: {}, pending: null,
    ...(options.traceParent !== undefined ? { traceParent: options.traceParent } : {}) };
  validateReceipt(receipt, invocationId, projectId);
  return receipt;
}

function assertTransition(previous: DecisionReceipt, next: DecisionReceipt): void {
  const expected = nextReceipt(previous, next.state, {
    ...(next.result !== undefined ? { result: next.result } : {}), remoteHandles: next.remoteHandles,
    evaluations: next.evaluations, pending: next.pending, updatedAtEpochMs: next.updatedAtEpochMs,
    ...(next.completedAtEpochMs !== undefined ? { completedAtEpochMs: next.completedAtEpochMs } : {}),
  });
  if (canonicalJson(expected) !== canonicalJson(next)) throw new DecisionReceiptIntegrityError('Receipt mutation outside legal transition');
}

export class MemoryDecisionReceiptStore implements DecisionReceiptStore {
  private readonly receipts = new Map<string, DecisionReceipt>();
  constructor(private readonly authorize: (projectId: string) => boolean | Promise<boolean> = () => true) {}
  private async check(projectId: string): Promise<void> {
    if (!await this.authorize(projectId)) throw new DecisionReceiptAccessError('Decision receipt access denied');
  }
  async read(invocationId: string, projectId = 'default'): Promise<DecisionReceipt | null> {
    await this.check(projectId);
    const receipt = this.receipts.get(invocationId);
    if (!receipt) return null;
    validateReceipt(receipt, invocationId, projectId);
    return structuredClone(receipt);
  }
  async acquire(invocationId: string, projectId: string, fingerprint: string,
    options: DecisionReceiptAcquireOptions = {}): Promise<{ owner: boolean; receipt: DecisionReceipt }> {
    await this.check(projectId);
    const existing = this.receipts.get(invocationId);
    if (existing) {
      validateReceipt(existing, invocationId, projectId);
      return { owner: false, receipt: structuredClone(existing) };
    }
    const receipt = initial(invocationId, projectId, fingerprint, options);
    this.receipts.set(invocationId, receipt);
    return { owner: true, receipt: structuredClone(receipt) };
  }
  async compareAndSwap(invocationId: string, projectId: string, expectedRevision: number, next: DecisionReceipt): Promise<boolean> {
    await this.check(projectId);
    const current = this.receipts.get(invocationId);
    if (!current) throw new DecisionReceiptIntegrityError('Missing decision receipt');
    validateReceipt(current, invocationId, projectId);
    if (current.revision !== expectedRevision) return false;
    assertTransition(current, next);
    this.receipts.set(invocationId, structuredClone(next));
    return true;
  }
  async waitForTerminal(invocationId: string, projectId: string, fingerprint: string, signal?: AbortSignal): Promise<DecisionReceipt> {
    for (;;) {
      const receipt = await this.read(invocationId, projectId);
      if (!receipt || receipt.fingerprint !== fingerprint) throw new DecisionReceiptIntegrityError('Receipt fingerprint mismatch');
      if (terminal.has(receipt.state)) return receipt;
      if (signal?.aborted) throw signal.reason ?? new Error('Aborted');
      await sleep(20, signal);
    }
  }
}

interface FileStoreOptions {
  integrityKey: Uint8Array;
  authorize?: (projectId: string) => boolean | Promise<boolean>;
  /** Test seam for pausing before or just after atomic publication. */
  onPublish?: (stage: 'before-link' | 'after-link', receipt: DecisionReceipt) => Promise<void>;
}

export class FileDecisionReceiptStore implements DecisionReceiptStore {
  constructor(private readonly directory: string, private readonly options: FileStoreOptions) {
    if (options.integrityKey.length < 32) throw new Error('Decision receipt integrity key must be at least 32 bytes');
  }
  private async check(projectId: string): Promise<void> {
    if (this.options.authorize && !await this.options.authorize(projectId)) throw new DecisionReceiptAccessError('Decision receipt access denied');
  }
  private prefixFor(invocationId: string): string {
    return createHash('sha256').update(invocationId).digest('hex');
  }
  private pathFor(invocationId: string, revision: number): string {
    return join(this.directory, `${this.prefixFor(invocationId)}.r${revision}.json`);
  }
  private mac(receipt: DecisionReceipt): string {
    return createHmac('sha256', this.options.integrityKey).update(canonicalJson(receipt)).digest('hex');
  }
  async read(invocationId: string, projectId = 'default'): Promise<DecisionReceipt | null> {
    await this.check(projectId);
    let names: string[];
    try { names = await readdir(this.directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const prefix = `${this.prefixFor(invocationId)}.r`;
    const revisions = names.filter(name => name.startsWith(prefix) && name.endsWith('.json'))
      .map(name => Number(name.slice(prefix.length, -'.json'.length)));
    if (!revisions.length) return null;
    // A previous writer may have died after link() but before directory sync().
    // Synchronize any observed publication before treating it as ownership evidence.
    const dir = await open(this.directory, 'r');
    try { await dir.sync(); } finally { await dir.close(); }
    if (revisions.some(revision => !Number.isSafeInteger(revision) || revision < 1)) throw new DecisionReceiptIntegrityError('Corrupt decision receipt revision index');
    revisions.sort((a, b) => a - b);
    let previous: DecisionReceipt | null = null;
    for (let index = 0; index < revisions.length; index += 1) {
      const revision = revisions[index]!;
      if (revision !== index + 1) throw new DecisionReceiptIntegrityError('Decision receipt revision gap');
      let document: { receipt: DecisionReceipt; mac: string };
      try { document = JSON.parse(await readFile(this.pathFor(invocationId, revision), 'utf8')) as typeof document; }
      catch { throw new DecisionReceiptIntegrityError('Corrupt decision receipt'); }
      if (!document || typeof document.mac !== 'string' || !/^[a-f0-9]{64}$/.test(document.mac)) throw new DecisionReceiptIntegrityError('Corrupt decision receipt envelope');
      if (!timingSafeEqual(Buffer.from(document.mac, 'hex'), Buffer.from(this.mac(document.receipt), 'hex'))) {
        throw new DecisionReceiptIntegrityError('Decision receipt integrity check failed');
      }
      validateReceipt(document.receipt, invocationId, projectId);
      if (document.receipt.revision !== revision || (revision === 1 && document.receipt.state !== 'acquired')) {
        throw new DecisionReceiptIntegrityError('Decision receipt revision mismatch');
      }
      if (previous) assertTransition(previous, document.receipt);
      previous = document.receipt;
    }
    return structuredClone(previous);
  }
  async acquire(invocationId: string, projectId: string, fingerprint: string,
    options: DecisionReceiptAcquireOptions = {}): Promise<{ owner: boolean; receipt: DecisionReceipt }> {
    await this.check(projectId);
    const existing = await this.read(invocationId, projectId);
    if (existing) return { owner: false, receipt: existing };
    const receipt = initial(invocationId, projectId, fingerprint, options);
    if (await this.persist(invocationId, receipt)) return { owner: true, receipt };
    const winner = await this.read(invocationId, projectId);
    if (!winner) throw new DecisionReceiptIntegrityError('Missing winning receipt');
    return { owner: false, receipt: winner };
  }
  async compareAndSwap(invocationId: string, projectId: string, expectedRevision: number, next: DecisionReceipt): Promise<boolean> {
    await this.check(projectId);
    const current = await this.read(invocationId, projectId);
    if (!current) throw new DecisionReceiptIntegrityError('Missing decision receipt');
    if (current.revision !== expectedRevision) return false;
    assertTransition(current, next);
    return this.persist(invocationId, next);
  }
  async waitForTerminal(invocationId: string, projectId: string, fingerprint: string, signal?: AbortSignal): Promise<DecisionReceipt> {
    for (;;) {
      const receipt = await this.read(invocationId, projectId);
      if (!receipt || receipt.fingerprint !== fingerprint) throw new DecisionReceiptIntegrityError('Receipt fingerprint mismatch');
      if (terminal.has(receipt.state)) return receipt;
      if (signal?.aborted) throw signal.reason ?? new Error('Aborted');
      await sleep(30, signal);
    }
  }
  private async persist(invocationId: string, receipt: DecisionReceipt): Promise<boolean> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const destination = this.pathFor(invocationId, receipt.revision);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(`${JSON.stringify({ receipt, mac: this.mac(receipt) })}\n`); await file.sync(); }
      finally { await file.close(); }
      await this.options.onPublish?.('before-link', receipt);
      try { await link(temporary, destination); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw error;
      }
      await this.options.onPublish?.('after-link', receipt);
      const dir = await open(this.directory, 'r');
      try { await dir.sync(); } finally { await dir.close(); }
      return true;
    } finally { await rm(temporary, { force: true }); }
  }
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason ?? new Error('Aborted')); }, { once: true });
  });
}
