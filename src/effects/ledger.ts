/**
 * The effect ledger: intent, outcome, reconcile and lookup over per-writer
 * signed segments, with exclusive-create index files for cross-writer
 * idempotency (first writer wins).
 *
 * The ledger proves what AIWG recorded; it never authorizes or replays an
 * effect. A missing entry is not evidence that the effect did not happen.
 *
 * @see docs/contracts/effect-ledger.v1.md
 * @see docs/architecture/adr-effect-ledger.md
 */

import { canonicalJson } from '../security/artifact-trust.js';
import { gitRefCheckpointSink, type CheckpointSink } from './checkpoint-sinks.js';
import { conflictError, EFFECT_EXIT_CODES, EffectLedgerError, integrityError, usageError, type EffectExitCode } from './errors.js';
import {
  assertEffectId,
  assertEffectScope,
  assertPayloadDigest,
  assertWriterId,
  effectId as deriveEffectId,
  defaultDerivationFor,
} from './identity.js';
import { activeKey, assertKeyring, createGenesisKeyring, keyValidAt, rotateKeyring } from './keyring.js';
import type { LedgerKeyProvider, LedgerSigningKey } from './keys.js';
import { lineFailures, mergeOrder, readAllSegments, readKeyring, readWriterSegment } from './reader.js';
import { decodeSegmentLine, signSegmentLine, statementFor, type DecodedLine } from './records.js';
import { assertEffectSchema } from './schema.js';
import {
  appendSegmentLine,
  claimIndex,
  clearPending,
  ensureLedgerDirectories,
  indexName,
  loadIndexKey,
  readIndexEntry,
  readPending,
  readSegment,
  replaceFile,
  resolveLedgerPaths,
  withLedgerLock,
  writePending,
  type IndexEntry,
  type IndexRole,
  type LedgerPaths,
} from './store.js';
import { publishExclusive } from '../storage/protected-files.js';
import {
  ABSENT_REASONS,
  INDEX_SCHEMA_VERSION,
  PRESENT_REASONS,
  RECORD_SCHEMA_VERSION,
  UNKNOWN_REASONS,
  VERIFIER_RESULT_SCHEMA_VERSION,
  type EffectContext,
  type EffectFailure,
  type EffectIdDerivationName,
  type EffectKeyring,
  type EffectKeyRotationBody,
  type EffectLinks,
  type EffectPhase,
  type EffectPredicate,
  type EffectScope,
  type EffectSegmentLine,
  type EffectTombstone,
  type EffectVerification,
  type EffectVerifierResult,
  type UnknownReason,
  type VerificationResult,
} from './types.js';

// ---------------------------------------------------------------------------
// Verifier port (concrete verifiers arrive with #2718 and #2719)
// ---------------------------------------------------------------------------

export interface EffectVerifierRequest {
  effectId: string;
  scope: EffectScope;
  kind: string;
  target: string;
  context: EffectContext;
  payloadDigest: string;
  intentRecordedAt: string;
}

export interface EffectVerifierObservation {
  result: VerificationResult;
  reason: string;
  complete: boolean;
  evidenceDigest?: string;
}

export interface EffectVerifier {
  readonly kind: string;
  readonly version: string;
  readonly canReportAbsent: boolean;
  verify(request: EffectVerifierRequest): Promise<EffectVerifierObservation>;
}

export interface EffectVerifierRegistry {
  get(kind: string): EffectVerifier | undefined;
  kinds(): string[];
}

/** A registry keyed by kind. The default registry is empty: every reconcile is `unknown`. */
export function createVerifierRegistry(verifiers: EffectVerifier[] = []): EffectVerifierRegistry {
  const byKind = new Map<string, EffectVerifier>();
  for (const verifier of verifiers) {
    if (byKind.has(verifier.kind)) throw usageError('Only one verifier may be registered per kind', 'duplicate-verifier');
    if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(verifier.version)) throw usageError('Verifier version must be semver', 'invalid-verifier');
    byKind.set(verifier.kind, verifier);
  }
  return { get: kind => byKind.get(kind), kinds: () => [...byKind.keys()].sort() };
}

// ---------------------------------------------------------------------------
// Ledger handle
// ---------------------------------------------------------------------------

export interface OpenEffectLedgerOptions {
  projectDir: string;
  /** Host-configured scope. Never derived from model input. */
  scope: EffectScope;
  /** This process's segment writer ID. */
  writer: string;
  /** Required for writes; reads and verification need only public keys. */
  keyProvider?: LedgerKeyProvider;
  /** Epoch milliseconds. */
  clock?: () => number;
  /** Independent checkpoint sink. Defaults to the git ref sink on `projectDir`. */
  sink?: CheckpointSink;
  verifiers?: EffectVerifierRegistry;
  lockTimeoutMs?: number;
}

export class EffectLedger {
  readonly projectDir: string;
  readonly scope: EffectScope;
  readonly writer: string;
  readonly sink: CheckpointSink;
  readonly verifiers: EffectVerifierRegistry;
  readonly lockTimeoutMs: number;
  private keyProvider?: LedgerKeyProvider;
  private readonly clock: () => number;

  constructor(options: OpenEffectLedgerOptions) {
    if (!options || typeof options.projectDir !== 'string' || !options.projectDir) throw usageError('Effect ledger needs a project directory', 'invalid-project');
    assertEffectScope(options.scope);
    assertWriterId(options.writer);
    this.projectDir = options.projectDir;
    this.scope = structuredClone(options.scope);
    this.writer = options.writer;
    this.keyProvider = options.keyProvider;
    this.clock = options.clock ?? Date.now;
    this.sink = options.sink ?? gitRefCheckpointSink({ repoDir: options.projectDir, subsystem: options.scope.subsystem });
    this.verifiers = options.verifiers ?? createVerifierRegistry();
    this.lockTimeoutMs = options.lockTimeoutMs ?? 30_000;
  }

  /** Resolved on every call, so an artifact root that goes away fails closed (exit 7). */
  paths(): LedgerPaths { return resolveLedgerPaths(this.projectDir, this.scope.subsystem); }

  now(): string {
    const value = this.clock();
    if (!Number.isFinite(value)) throw new EffectLedgerError('internal', 'Effect ledger clock returned an invalid time');
    return new Date(value).toISOString();
  }

  async signingKey(): Promise<LedgerSigningKey> {
    if (!this.keyProvider) throw new EffectLedgerError('key-unavailable', 'Effect ledger writes need a key provider', 'key-unavailable');
    return this.keyProvider.load();
  }

  /** Switch to another key provider, for example after `rotateKey`. */
  useKeyProvider(provider: LedgerKeyProvider): void { this.keyProvider = provider; }

  toJSON(): { scope: EffectScope; writer: string } { return { scope: this.scope, writer: this.writer }; }
}

export function openEffectLedger(options: OpenEffectLedgerOptions): EffectLedger {
  return new EffectLedger(options);
}

// ---------------------------------------------------------------------------
// Receipts and lookup results
// ---------------------------------------------------------------------------

export interface EffectReceipt {
  effectId: string;
  idDerivation: EffectIdDerivationName;
  phase: Exclude<EffectPhase, 'tombstone'>;
  payloadDigest: string;
  writer: string;
  seq: number;
  recordHash: string;
  /** True when an existing record was returned and nothing was appended. */
  idempotent: boolean;
  exitCode: EffectExitCode;
}

export interface EffectRecordSummary {
  phase: EffectPhase;
  writer: string;
  seq: number;
  recordHash: string;
  recordedAt: string;
  payloadDigest: string;
  keyid: string;
  verification?: EffectVerification;
  failure?: EffectFailure;
  tombstone?: EffectTombstone;
}

export type EffectLookupStatus = 'none' | 'intent' | 'completed' | 'failed' | 'reconciled' | 'tombstoned';

export interface EffectLookup {
  effectId: string;
  found: boolean;
  status: EffectLookupStatus;
  result?: VerificationResult;
  kind?: string;
  target?: string;
  tombstoned: boolean;
  records: EffectRecordSummary[];
  exitCode: EffectExitCode;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function prepareWrite(ledger: EffectLedger): Promise<{ paths: LedgerPaths; indexKey: Buffer }> {
  const paths = ledger.paths();
  await ensureLedgerDirectories(paths);
  return { paths, indexKey: await loadIndexKey(paths) };
}

/** Load the keyring, creating the genesis keyring for this key on first use. */
async function ensureKeyring(ledger: EffectLedger, paths: LedgerPaths, key: LedgerSigningKey, at: string): Promise<EffectKeyring> {
  let stored = await readKeyring(paths);
  if (stored === null) {
    const genesis = createGenesisKeyring(ledger.scope, key, at);
    assertEffectSchema('keyring', genesis);
    await publishExclusive(paths.root, paths.keyring, `${JSON.stringify(genesis, null, 2)}\n`, 'keyring');
    stored = await readKeyring(paths);
  }
  assertKeyring(stored, ledger.scope);
  return stored;
}

function assertSigningKeyActive(keyring: EffectKeyring, key: LedgerSigningKey, at: string): void {
  const active = activeKey(keyring);
  if (active.keyid !== key.keyid || !keyValidAt(active, at)) {
    throw new EffectLedgerError('key-unavailable', 'The loaded signing key is not the active ledger key at this time', 'key-not-active');
  }
}

interface SegmentHead { count: number; hash: string | null }

async function segmentHead(paths: LedgerPaths, writer: string): Promise<SegmentHead> {
  const segment = await readSegment(paths, writer);
  if (!segment) return { count: 0, hash: null };
  if (segment.torn) throw integrityError('segment-torn', 'Effect ledger segment has a torn tail; run verify');
  if (!segment.lines.length) return { count: 0, hash: null };
  const last = decodeSegmentLine(segment.lines.at(-1)!);
  if ('failure' in last) throw integrityError(last.failure, 'Effect ledger segment head is malformed; run verify');
  return { count: segment.lines.length, hash: last.line.recordHash };
}

/** Finish an append that crashed between its index claim and the segment write. */
async function repairPending(paths: LedgerPaths, writer: string): Promise<void> {
  const pending = await readPending(paths, writer);
  if (!pending) return;
  const line = pending.line as EffectSegmentLine;
  const head = await segmentHead(paths, writer);
  const entry = await readIndexEntry(paths, pending.indexName).catch(() => null);
  const decoded = decodeSegmentLine(JSON.stringify(line));
  if (!('failure' in decoded) && entry && entry.recordHash === line.recordHash && entry.writer === writer
    && line.seq === head.count && decoded.statement.predicate.prev === head.hash) {
    await appendSegmentLine(paths, writer, line);
  }
  await clearPending(paths, writer);
}

interface AppendPlan {
  role?: IndexRole;
  build(seq: number, prev: string | null, recordedAt: string): EffectPredicate;
}

/**
 * Sign and append one record under this writer's lock. With a `role`, the
 * record is appended only after its exclusive index claim wins; a lost claim
 * returns the winning index entry instead.
 */
async function appendRecord(ledger: EffectLedger, plan: AppendPlan, effectIdValue: string): Promise<{ line: EffectSegmentLine; lost?: IndexEntry }> {
  const { paths, indexKey } = await prepareWrite(ledger);
  const key = await ledger.signingKey();
  return withLedgerLock(paths, `writer-${ledger.writer}`, ledger.lockTimeoutMs, async () => {
    // Read the clock after the keyring exists, so a genesis keyring published by
    // a concurrent process is never newer than this record.
    const keyring = await ensureKeyring(ledger, paths, key, ledger.now());
    const recordedAt = ledger.now();
    assertSigningKeyActive(keyring, key, recordedAt);
    await repairPending(paths, ledger.writer);
    const head = await segmentHead(paths, ledger.writer);
    const predicate = plan.build(head.count, head.hash, recordedAt);
    const line = signSegmentLine(statementFor(predicate), key);
    if (plan.role) {
      const name = indexName(indexKey, ledger.scope, effectIdValue, plan.role);
      const entry: IndexEntry = {
        schemaVersion: INDEX_SCHEMA_VERSION, role: plan.role, effectId: effectIdValue, payloadDigest: predicate.payloadDigest,
        phase: predicate.phase as IndexEntry['phase'], writer: ledger.writer, seq: predicate.seq, recordHash: line.recordHash,
      };
      await writePending(paths, ledger.writer, { indexName: name, line });
      if (!(await claimIndex(paths, name, entry))) {
        await clearPending(paths, ledger.writer);
        const winner = await readIndexEntry(paths, name);
        if (!winner) throw new EffectLedgerError('internal', 'Effect index claim was lost but no winner is readable');
        return { line, lost: winner };
      }
      await appendSegmentLine(paths, ledger.writer, line);
      await clearPending(paths, ledger.writer);
    } else {
      await appendSegmentLine(paths, ledger.writer, line);
    }
    return { line };
  });
}

function receiptFromEntry(entry: IndexEntry, idDerivation: EffectIdDerivationName, idempotent: boolean): EffectReceipt {
  return {
    effectId: entry.effectId, idDerivation, phase: entry.phase, payloadDigest: entry.payloadDigest,
    writer: entry.writer, seq: entry.seq, recordHash: entry.recordHash, idempotent, exitCode: EFFECT_EXIT_CODES.ok,
  };
}

function receiptFromLine(line: EffectSegmentLine, predicate: EffectPredicate): EffectReceipt {
  return {
    effectId: predicate.effectId, idDerivation: predicate.idDerivation, phase: predicate.phase as EffectReceipt['phase'],
    payloadDigest: predicate.payloadDigest, writer: line.writer, seq: line.seq, recordHash: line.recordHash,
    idempotent: false, exitCode: EFFECT_EXIT_CODES.ok,
  };
}

/** Decode and verify the intent record an index entry points at. */
async function intentRecord(ledger: EffectLedger, paths: LedgerPaths, entry: IndexEntry): Promise<DecodedLine> {
  const segment = await readWriterSegment(paths, entry.writer);
  const read = segment?.lines[entry.seq];
  if (!read?.decoded) throw integrityError('index-dangling', 'The effect index points at a missing intent record; run verify');
  const keyring = await readKeyring(paths);
  assertKeyring(keyring, ledger.scope);
  const previous = entry.seq === 0 ? null : segment!.lines[entry.seq - 1]?.decoded?.line.recordHash ?? null;
  const failures = lineFailures(keyring, ledger.scope, entry.writer, entry.seq, read.decoded, previous);
  if (failures.length || read.decoded.line.recordHash !== entry.recordHash || read.decoded.statement.predicate.effectId !== entry.effectId) {
    throw integrityError(failures[0] ?? 'index-segment-mismatch');
  }
  return read.decoded;
}

async function requireIntent(ledger: EffectLedger, id: string): Promise<{ paths: LedgerPaths; indexKey: Buffer; entry: IndexEntry; intent: EffectPredicate }> {
  assertEffectId(id);
  const { paths, indexKey } = await prepareWrite(ledger);
  const entry = await readIndexEntry(paths, indexName(indexKey, ledger.scope, id, 'intent'));
  if (!entry) throw usageError('No intent is recorded for this effect ID', 'intent-missing');
  const intent = (await intentRecord(ledger, paths, entry)).statement.predicate;
  if (intent.phase === 'tombstone') throw usageError('The intent for this effect ID has been purged', 'intent-purged');
  return { paths, indexKey, entry, intent };
}

function basePredicate(intent: EffectPredicate, phase: EffectPhase, payloadDigest: string, links: EffectLinks | undefined, writer: string, seq: number, prev: string | null, recordedAt: string): EffectPredicate {
  return {
    schemaVersion: RECORD_SCHEMA_VERSION, effectId: intent.effectId, idDerivation: intent.idDerivation,
    scope: intent.scope, kind: intent.kind, target: intent.target, context: intent.context, phase,
    payloadDigest, writer, seq, prev, recordedAt, links: structuredClone(links ?? {}),
  };
}

// ---------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------

export interface RecordIntentInput {
  kind: string;
  target: string;
  context: EffectContext;
  payloadDigest: string;
  derivation?: EffectIdDerivationName;
  links?: EffectLinks;
}

/**
 * Append a signed `intent` before the effect. The same ID with the same payload
 * digest returns the first receipt (`idempotent: true`); a different digest is
 * a conflict (exit 5). Nothing is appended in either case.
 */
export async function recordIntent(ledger: EffectLedger, input: RecordIntentInput): Promise<EffectReceipt> {
  const derivation = input?.derivation ?? defaultDerivationFor(input?.kind);
  const id = deriveEffectId({ scope: ledger.scope, kind: input.kind, target: input.target, context: input.context }, derivation);
  assertPayloadDigest(input.payloadDigest);
  const { paths, indexKey } = await prepareWrite(ledger);
  const existing = await readIndexEntry(paths, indexName(indexKey, ledger.scope, id, 'intent'));
  const settle = (entry: IndexEntry) => {
    if (entry.payloadDigest !== input.payloadDigest) throw conflictError();
    return receiptFromEntry(entry, derivation, true);
  };
  if (existing) return settle(existing);
  const { line, lost } = await appendRecord(ledger, {
    role: 'intent',
    build: (seq, prev, recordedAt) => ({
      schemaVersion: RECORD_SCHEMA_VERSION, effectId: id, idDerivation: derivation, scope: ledger.scope,
      kind: input.kind, target: input.target, context: structuredClone(input.context), phase: 'intent',
      payloadDigest: input.payloadDigest, writer: ledger.writer, seq, prev, recordedAt, links: structuredClone(input.links ?? {}),
    }),
  }, id);
  if (lost) return settle(lost);
  return receiptFromLine(line, JSON.parse(Buffer.from(line.envelope.payload, 'base64').toString('utf8')).predicate as EffectPredicate);
}

export interface RecordOutcomeInput {
  phase: 'completed' | 'failed';
  payloadDigest: string;
  /** Required for `completed`; its result must be `present`. */
  verification?: EffectVerification;
  /** Required for `failed`. */
  failure?: EffectFailure;
  links?: EffectLinks;
}

/**
 * Append the terminal outcome. The first outcome for an ID wins across writers;
 * repeating it returns the existing receipt, and a different terminal outcome
 * or payload digest is a conflict.
 */
export async function recordOutcome(ledger: EffectLedger, id: string, input: RecordOutcomeInput): Promise<EffectReceipt> {
  if (input?.phase !== 'completed' && input?.phase !== 'failed') throw usageError('Outcome phase must be completed or failed', 'invalid-phase');
  assertPayloadDigest(input.payloadDigest);
  if (input.phase === 'completed' && input.verification?.result !== 'present') throw usageError('A completed outcome needs a present verification', 'completed-without-present');
  if (input.phase === 'failed' && !input.failure) throw usageError('A failed outcome needs a failure reason', 'failed-without-reason');
  const { paths, indexKey, entry, intent } = await requireIntent(ledger, id);
  if (entry.payloadDigest !== input.payloadDigest) throw conflictError();
  const outcomeName = indexName(indexKey, ledger.scope, id, 'outcome');
  const settle = (winner: IndexEntry) => {
    if (winner.phase !== input.phase || winner.payloadDigest !== input.payloadDigest) {
      throw new EffectLedgerError('conflict', 'A different outcome is already recorded for this effect ID', 'outcome-conflict');
    }
    return receiptFromEntry(winner, intent.idDerivation, true);
  };
  const existing = await readIndexEntry(paths, outcomeName);
  if (existing) return settle(existing);
  const { line, lost } = await appendRecord(ledger, {
    role: 'outcome',
    build: (seq, prev, recordedAt) => ({
      ...basePredicate(intent, input.phase, input.payloadDigest, input.links, ledger.writer, seq, prev, recordedAt),
      ...(input.phase === 'completed' ? { verification: structuredClone(input.verification!) } : { failure: structuredClone(input.failure!) }),
    }),
  }, id);
  if (lost) return settle(lost);
  return receiptFromLine(line, { ...intent, phase: input.phase, writer: line.writer, seq: line.seq });
}

/** Append one `reconciled` record for one verifier attempt. History is never mutated. */
export async function recordReconciled(ledger: EffectLedger, id: string, verification: EffectVerification, links?: EffectLinks): Promise<EffectReceipt> {
  const { intent, entry } = await requireIntent(ledger, id);
  const { line } = await appendRecord(ledger, {
    build: (seq, prev, recordedAt) => ({
      ...basePredicate(intent, 'reconciled', entry.payloadDigest, links, ledger.writer, seq, prev, recordedAt),
      verification: structuredClone(verification),
    }),
  }, id);
  return receiptFromLine(line, { ...intent, phase: 'reconciled', writer: line.writer, seq: line.seq });
}

const EXIT_FOR_RESULT: Record<VerificationResult, 0 | 3 | 4> = { present: 0, absent: 3, unknown: 4 };

function unknownObservation(reason: UnknownReason): EffectVerifierObservation {
  return { result: 'unknown', reason, complete: false };
}

/** Enforce the tri-state rules: `absent` needs a capable verifier and a complete query. */
function normalizeObservation(verifier: EffectVerifier, observation: unknown): EffectVerifierObservation {
  const value = observation as EffectVerifierObservation;
  if (!value || typeof value !== 'object' || typeof value.complete !== 'boolean'
    || (value.evidenceDigest !== undefined && !/^sha256:[a-f0-9]{64}$/.test(value.evidenceDigest))) return unknownObservation('malformed-response');
  const evidence = value.evidenceDigest ? { evidenceDigest: value.evidenceDigest } : {};
  if (value.result === 'present') {
    return (PRESENT_REASONS as readonly string[]).includes(value.reason)
      ? { result: 'present', reason: value.reason, complete: value.complete, ...evidence }
      : unknownObservation('malformed-response');
  }
  if (value.result === 'absent') {
    if (!verifier.canReportAbsent) return unknownObservation('verifier-cannot-report-absent');
    if (!value.complete) return unknownObservation('paging-incomplete');
    if (!(ABSENT_REASONS as readonly string[]).includes(value.reason)) return unknownObservation('malformed-response');
    return { result: 'absent', reason: value.reason, complete: true, ...evidence };
  }
  if (value.result === 'unknown') {
    return (UNKNOWN_REASONS as readonly string[]).includes(value.reason)
      ? { result: 'unknown', reason: value.reason, complete: value.complete, ...evidence }
      : unknownObservation('malformed-response');
  }
  return unknownObservation('malformed-response');
}

export interface ReconcileOutcome {
  result: EffectVerifierResult;
  receipt: EffectReceipt;
}

/**
 * Reconcile one effect through its kind's verifier and append a `reconciled`
 * record. With no registered verifier the result is `unknown` /
 * `verifier-missing`. The ledger never replays the effect.
 */
export async function reconcileEffect(ledger: EffectLedger, id: string, options: { verifiers?: EffectVerifierRegistry; links?: EffectLinks } = {}): Promise<ReconcileOutcome> {
  const { intent, entry } = await requireIntent(ledger, id);
  const registry = options.verifiers ?? ledger.verifiers;
  const verifier = registry.get(intent.kind);
  let ref = { kind: intent.kind, version: '0.0.0', canReportAbsent: false };
  let observation: EffectVerifierObservation;
  if (!verifier) {
    observation = unknownObservation('verifier-missing');
  } else {
    ref = { kind: intent.kind, version: verifier.version, canReportAbsent: verifier.canReportAbsent };
    if (verifier.kind !== intent.kind) observation = unknownObservation('verifier-version-mismatch');
    else {
      try {
        observation = normalizeObservation(verifier, await verifier.verify({
          effectId: intent.effectId, scope: structuredClone(intent.scope), kind: intent.kind, target: intent.target!,
          context: structuredClone(intent.context!), payloadDigest: entry.payloadDigest, intentRecordedAt: intent.recordedAt,
        }));
      } catch { observation = unknownObservation('server-error'); }
    }
  }
  const verification: EffectVerification = { verifier: ref, ...observation, checkedAt: ledger.now() };
  const receipt = await recordReconciled(ledger, id, verification, options.links);
  const result: EffectVerifierResult = {
    schemaVersion: VERIFIER_RESULT_SCHEMA_VERSION, effectId: intent.effectId, kind: intent.kind,
    verification, exitCode: EXIT_FOR_RESULT[verification.result],
  };
  assertEffectSchema('verifierResult', result);
  return { result, receipt: { ...receipt, exitCode: result.exitCode } };
}

function summarize(decoded: DecodedLine): EffectRecordSummary {
  const predicate = decoded.statement.predicate;
  return {
    phase: predicate.phase, writer: decoded.line.writer, seq: decoded.line.seq, recordHash: decoded.line.recordHash,
    recordedAt: predicate.recordedAt, payloadDigest: predicate.payloadDigest, keyid: decoded.line.envelope.signatures[0].keyid,
    ...(predicate.verification ? { verification: structuredClone(predicate.verification) } : {}),
    ...(predicate.failure ? { failure: structuredClone(predicate.failure) } : {}),
    ...(predicate.tombstone ? { tombstone: structuredClone(predicate.tombstone) } : {}),
  };
}

/**
 * Look up everything recorded for an effect ID, merged across writers. Every
 * returned record is signature- and chain-checked; a failure is exit 6.
 * A tombstoned record is returned without its target, context or outcome body.
 */
export async function lookupEffect(ledger: EffectLedger, id: string): Promise<EffectLookup> {
  assertEffectId(id);
  const paths = ledger.paths();
  const keyring = await readKeyring(paths);
  const none: EffectLookup = { effectId: id, found: false, status: 'none', tombstoned: false, records: [], exitCode: EFFECT_EXIT_CODES.absent };
  if (keyring === null) return none;
  assertKeyring(keyring, ledger.scope);
  const matches: DecodedLine[] = [];
  for (const segment of await readAllSegments(paths)) {
    let previous: string | null = null;
    for (const read of segment.lines) {
      if (!read.decoded) throw integrityError(read.failure!);
      if (read.decoded.statement.predicate.effectId === id) {
        const failures = lineFailures(keyring, ledger.scope, segment.writer, read.index, read.decoded, previous);
        if (failures.length) throw integrityError(failures[0]);
        matches.push(read.decoded);
      }
      previous = read.decoded.line.recordHash;
    }
  }
  if (!matches.length) return none;
  matches.sort(mergeOrder);
  const records = matches.map(summarize);
  const live = matches.map(item => item.statement.predicate).filter(predicate => predicate.phase !== 'tombstone');
  const tombstoned = records.some(record => record.phase === 'tombstone');
  const identity = live[0];
  const base = { effectId: id, found: true, tombstoned, records, kind: matches[0].statement.predicate.kind, ...(identity?.target ? { target: identity.target } : {}) };
  const outcomes = records.filter(record => record.phase === 'completed' || record.phase === 'failed' || record.phase === 'reconciled');
  const latest = outcomes.at(-1);
  if (!latest) {
    if (!live.length) {
      const phases = records.map(record => record.tombstone!.originalPhase);
      const exitCode = phases.includes('completed') ? EFFECT_EXIT_CODES.ok : phases.includes('failed') ? EFFECT_EXIT_CODES.absent : EFFECT_EXIT_CODES.unknown;
      return { ...base, status: 'tombstoned', exitCode };
    }
    return { ...base, status: 'intent', exitCode: EFFECT_EXIT_CODES.unknown };
  }
  if (latest.phase === 'completed') return { ...base, status: 'completed', result: 'present', exitCode: EFFECT_EXIT_CODES.ok };
  if (latest.phase === 'failed') return { ...base, status: 'failed', exitCode: EFFECT_EXIT_CODES.absent };
  const result = latest.verification!.result;
  return { ...base, status: 'reconciled', result, exitCode: EXIT_FOR_RESULT[result] };
}

export interface RotateKeyOptions {
  effectiveAt?: string;
  reason?: EffectKeyRotationBody['reason'];
}

/**
 * Rotate the ledger key. The rotation is signed by the active (prior) key and
 * by the successor key; the prior key's window closes at `effectiveAt`. The
 * ledger handle switches to the successor provider.
 */
export async function rotateKey(ledger: EffectLedger, successorProvider: LedgerKeyProvider, options: RotateKeyOptions = {}): Promise<EffectKeyring> {
  const { paths } = await prepareWrite(ledger);
  const prior = await ledger.signingKey();
  const successor = await successorProvider.load();
  const effectiveAt = options.effectiveAt ?? ledger.now();
  const keyring = await withLedgerLock(paths, 'keyring', ledger.lockTimeoutMs, async () => {
    const current = await ensureKeyring(ledger, paths, prior, effectiveAt);
    const next = rotateKeyring(current, prior, successor, effectiveAt, options.reason ?? 'scheduled');
    assertEffectSchema('keyring', next);
    await replaceFile(paths.root, paths.keyring, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
  ledger.useKeyProvider(successorProvider);
  return keyring;
}

/** Stable JSON for CLI and API output; never contains key material. */
export function effectOutputJson(value: unknown): string {
  return canonicalJson(JSON.parse(JSON.stringify(value)) as unknown);
}
