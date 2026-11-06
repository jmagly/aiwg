/**
 * Decision-offload checkpoint execution and offline adoption reporting.
 *
 * Opportunity records describe only checkpoints that called this contract.
 * Generic activity-log prose is deliberately not interpreted as a precise
 * opportunity denominator. Completed-call records remain in ledger.ts; the
 * shared correlation id joins the two append-only journals.
 */

import { randomUUID } from 'node:crypto';
import { constants as fsConstants, createReadStream } from 'node:fs';
import { lstat, mkdir, open, type FileHandle } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { projectAiwgPath, projectAiwgWritePath } from '../config/project-artifacts.js';
import { resolveDecisionEnablement } from '../config/decision-config.js';
import { readAiwgConfig } from '../config/aiwg-config.js';
import { resolveActiveProvider, type ProviderResolution } from '../cli/provider-resolution.js';
import { askDecision, DecisionAskUsageError, type DecisionAskInput, type DecisionAskResult, type DecisionAskRuntimeOptions } from './ask.js';
import { inspectJevCredential } from './jev-credentials.js';
import { inspectDecisionOffloadActivation } from './offload-activation.js';
import {
  ATTRIBUTION_FIELD_PATTERN,
  decisionLedgerHistory,
  DECISION_LEDGER_RECORD_TIMEOUT_MS,
  recordDecisionAsk,
  resolveDecisionSession,
  type DecisionLedgerRecord,
  type DecisionLedgerTransport,
  type RecordDecisionAskOptions,
} from './ledger.js';

export const DECISION_OPPORTUNITY_SCHEMA = 'aiwg-decision-opportunity/v1' as const;
export const DECISION_OFFLOAD_SNAPSHOT_SCHEMA = 'aiwg-decision-offload-snapshot/v1' as const;
const OPPORTUNITY_FILE = 'opportunities.jsonl';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_OPPORTUNITY_RECORD_BYTES = 4000;
export const DECISION_OPPORTUNITY_RECORD_TIMEOUT_MS = DECISION_LEDGER_RECORD_TIMEOUT_MS;
const TIMED_OUT = Symbol('decision-offload-timeout');

export type DecisionOffloadCategory = 'organic' | 'diagnostic' | 'setup' | 'benchmark' | 'unattributed';
export type DecisionOpportunityOutcome = 'answered' | 'fallback' | 'skipped' | 'unknown';
export type DecisionOpportunitySkipReason =
  | 'disabled'
  | 'missing-addon'
  | 'privacy-excluded'
  | 'budget-excluded'
  | 'action-excluded'
  | 'usage-rejected'
  | 'checkpoint-unsupported'
  | 'other-exclusion';

export interface DecisionOpportunityRecord {
  schema: typeof DECISION_OPPORTUNITY_SCHEMA;
  correlationId: string;
  timestamp: string;
  phase: 'started' | 'completed' | 'skipped';
  provider: string;
  sessionId: string;
  sessionSource: string;
  transport: DecisionLedgerTransport | 'internal';
  caller: string;
  category: DecisionOffloadCategory;
  eligible: boolean;
  attempted: boolean;
  outcome: DecisionOpportunityOutcome;
  reason: string;
  ledgerRecorded: boolean | null;
}

export interface DecisionCheckpointEligibility {
  eligible: boolean;
  reason?: DecisionOpportunitySkipReason;
}

export interface RunDecisionOffloadCheckpointOptions extends Omit<RecordDecisionAskOptions, 'id' | 'caller'> {
  caller: string;
  /** Preserve the public ask ledger's optional caller while the opportunity keeps an executable checkpoint identity. */
  ledgerCaller?: string | null;
  category?: DecisionOffloadCategory;
  eligibility?: DecisionCheckpointEligibility;
  askRuntime?: DecisionAskRuntimeOptions;
  id?: () => string;
  ask?: typeof askDecision;
  recordAsk?: typeof recordDecisionAsk;
  appendOpportunity?: (record: DecisionOpportunityRecord, projectRoot: string, warn?: (message: string) => void) => Promise<boolean>;
  /** Bounds each opportunity append independently; test override, defaults to the ledger's 250ms bound. */
  opportunityTimeoutMs?: number;
  /** Bounds provider attribution before the pre-call record; test override, defaults to 250ms. */
  providerTimeoutMs?: number;
}

export type DecisionOffloadCheckpointResult =
  | { outcome: 'answered' | 'fallback'; result: DecisionAskResult; opportunity: DecisionOpportunityRecord; attemptRecorded: boolean | null; opportunityRecorded: boolean | null }
  | { outcome: 'skipped'; result: null; opportunity: DecisionOpportunityRecord; opportunityRecorded: boolean | null }
  | { outcome: 'unknown'; result: null; opportunity: DecisionOpportunityRecord; attemptRecorded: boolean | null; opportunityRecorded: boolean | null; error: unknown };

export interface DecisionOffloadActivationEvidence {
  ruleSourceAvailable?: boolean | null;
  addon: 'installed' | 'missing' | 'unknown';
  ruleDelivery: 'present' | 'missing' | 'unknown';
  startupAnchor: 'present' | 'missing' | 'unknown';
  nativeActivation: 'verified' | 'not-claimed' | 'unknown';
  source?: string;
}

export interface DecisionOffloadThresholds {
  minimumEligible: number;
  minimumAttemptRate: number;
  repeatedFallbacks: number;
}

export interface BuildDecisionOffloadSnapshotOptions {
  projectRoot: string;
  /** Package/framework root used by the activation inspector during final integration. */
  frameworkRoot?: string;
  sessionId?: string;
  windowHours?: number;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  activationEvidence?: Partial<DecisionOffloadActivationEvidence>;
  thresholds?: Partial<DecisionOffloadThresholds>;
}

export const DECISION_OFFLOAD_CHECKPOINT_COVERAGE = [
  'address-issues:worker-pick', 'address-issues:failure-triage', 'address-issues:review-verdict',
  'address-issues:minor-triage', 'aiwg-mission:worker-pick', 'aiwg-mission:failure-triage',
  'subagent-scoping:worker-pick', 'subagent-scoping:failure-triage',
].map(caller => ({ caller, coverage: 'instruction-only' as const }));

export const DECISION_OFFLOAD_EXECUTABLE_COVERAGE = [
  { entrypoint: 'aiwg decision ask', transport: 'cli' as const, coverage: 'shared-contract-generic' as const },
  { entrypoint: 'decision-ask', transport: 'mcp' as const, coverage: 'shared-contract-generic' as const },
];

function safeCaller(caller: string): string {
  if (!ATTRIBUTION_FIELD_PATTERN.test(caller)) throw new DecisionAskUsageError('invalid-caller', 'checkpoint caller must be a valid attribution tag');
  return caller;
}

export function decisionOffloadCategory(caller: string | null | undefined): DecisionOffloadCategory {
  if (!caller) return 'unattributed';
  const prefix = caller.split(':', 1)[0].toLowerCase();
  if (['diagnosis', 'diagnostic', 'control'].includes(prefix)) return 'diagnostic';
  if (['setup', 'verify'].includes(prefix)) return 'setup';
  if (['benchmark', 'bench', 'qualification', 'eval'].includes(prefix)) return 'benchmark';
  return 'organic';
}

async function providerFor(options: RunDecisionOffloadCheckpointOptions): Promise<string> {
  const work = (async () => {
    const resolve = options.resolveProvider ?? resolveActiveProvider;
    const resolution: ProviderResolution = await resolve({ cwd: options.projectRoot, explicitProvider: options.explicitProvider, env: options.env ?? process.env });
    return resolution.provider ?? 'unknown';
  })().catch(() => 'unknown');
  const outcome = await bounded(work, options.providerTimeoutMs ?? DECISION_OPPORTUNITY_RECORD_TIMEOUT_MS);
  return outcome === TIMED_OUT ? 'unknown' : outcome;
}

async function bounded<T>(work: Promise<T>, timeoutMs: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>(resolve => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    // Keep this timer referenced: it is the only liveness guarantee when an
    // injected resolver or filesystem promise never settles in a standalone
    // CLI process. Unref would let Node exit before the ask can run.
  });
  try {
    const outcome = await Promise.race([work, timeout]);
    if (outcome === TIMED_OUT) work.catch(() => undefined);
    return outcome;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function boundedAppend(
  append: NonNullable<RunDecisionOffloadCheckpointOptions['appendOpportunity']>,
  record: DecisionOpportunityRecord,
  projectRoot: string,
  timeoutMs: number,
  warn: (message: string) => void,
): Promise<boolean | null> {
  let work: Promise<boolean>;
  try { work = Promise.resolve(append(record, projectRoot, warn)); }
  catch (error) {
    warn(`warning: failed to record decision opportunity: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  const outcome = await bounded(work.catch(error => {
    warn(`warning: failed to record decision opportunity: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }), timeoutMs);
  if (outcome === TIMED_OUT) {
    warn(`warning: decision opportunity recording exceeded ${timeoutMs}ms; completion unknown`);
    return null;
  }
  return outcome;
}

function recordFor(
  options: RunDecisionOffloadCheckpointOptions,
  fields: Pick<DecisionOpportunityRecord, 'phase' | 'eligible' | 'attempted' | 'outcome' | 'reason' | 'ledgerRecorded'>,
  correlationId: string,
  provider: string,
): DecisionOpportunityRecord {
  const session = resolveDecisionSession(options.explicitSessionId, options.env ?? process.env);
  const caller = safeCaller(options.caller);
  return {
    schema: DECISION_OPPORTUNITY_SCHEMA,
    correlationId,
    timestamp: new Date(options.now?.() ?? Date.now()).toISOString(),
    provider,
    ...session,
    transport: options.transport,
    caller,
    category: options.category ?? decisionOffloadCategory(caller),
    ...fields,
  };
}

const RECORD_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{3}Z$/;

function isStrictTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !RECORD_TIMESTAMP_PATTERN.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function validOpportunity(value: unknown): value is DecisionOpportunityRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return v.schema === DECISION_OPPORTUNITY_SCHEMA
    && typeof v.correlationId === 'string' && v.correlationId.length > 0
    && isStrictTimestamp(v.timestamp)
    && ['started', 'completed', 'skipped'].includes(String(v.phase))
    && typeof v.provider === 'string'
    && typeof v.sessionId === 'string' && typeof v.sessionSource === 'string'
    && ['cli', 'mcp', 'internal'].includes(String(v.transport))
    && typeof v.caller === 'string' && ATTRIBUTION_FIELD_PATTERN.test(v.caller)
    && ['organic', 'diagnostic', 'setup', 'benchmark', 'unattributed'].includes(String(v.category))
    && typeof v.eligible === 'boolean' && typeof v.attempted === 'boolean'
    && ['answered', 'fallback', 'skipped', 'unknown'].includes(String(v.outcome))
    && typeof v.reason === 'string'
    && (typeof v.ledgerRecorded === 'boolean' || v.ledgerRecorded === null);
}

async function writeFully(handle: FileHandle, buffer: Buffer): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer.subarray(offset));
    if (!Number.isFinite(bytesWritten) || bytesWritten <= 0) throw new Error('decision opportunity: write made no progress');
    offset += bytesWritten;
  }
}

export async function appendDecisionOpportunity(
  record: DecisionOpportunityRecord,
  projectRoot: string,
  warn: (message: string) => void = message => process.stderr.write(`${message}\n`),
): Promise<boolean> {
  if (!validOpportunity(record)) return false;
  const line = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(line, 'utf8') > MAX_OPPORTUNITY_RECORD_BYTES) {
    warn(`warning: decision opportunity exceeds the ${MAX_OPPORTUNITY_RECORD_BYTES}-byte size cap and was not written`);
    return false;
  }
  let handle;
  try {
    const directory = projectAiwgWritePath(projectRoot, 'decision');
    const file = path.join(directory, OPPORTUNITY_FILE);
    await mkdir(directory, { recursive: true, mode: DIR_MODE });
    const dirStat = await lstat(directory);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || (dirStat.mode & 0o077) !== 0) throw new Error('unsafe opportunity directory');
    try {
      const fileStat = await lstat(file);
      if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.nlink !== 1 || (fileStat.mode & 0o077) !== 0) throw new Error('unsafe opportunity file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    handle = await open(file, fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0), FILE_MODE);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || (opened.mode & 0o077) !== 0) throw new Error('unsafe opened opportunity file');
    await writeFully(handle, Buffer.from(line, 'utf8'));
    return true;
  } catch (error) {
    warn(`warning: failed to record decision opportunity: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function runDecisionOffloadCheckpoint(
  input: DecisionAskInput,
  options: RunDecisionOffloadCheckpointOptions,
): Promise<DecisionOffloadCheckpointResult> {
  const correlationId = (options.id ?? randomUUID)();
  const provider = await providerFor(options);
  const append = options.appendOpportunity ?? appendDecisionOpportunity;
  let warned = false;
  let pendingOpportunityWarning: string | undefined;
  const warn = (message: string) => {
    if (warned) return;
    warned = true;
    (options.warn ?? (value => process.stderr.write(`${value}\n`)))(message);
  };
  const queueOpportunityWarning = (message: string) => { pendingOpportunityWarning ??= message; };
  const flushOpportunityWarning = () => {
    if (pendingOpportunityWarning) warn(pendingOpportunityWarning);
  };
  const eligibility = options.eligibility ?? { eligible: true };
  const appendBounded = (record: DecisionOpportunityRecord, appendWarn: (message: string) => void) => boundedAppend(
    append, record, options.projectRoot,
    options.opportunityTimeoutMs ?? DECISION_OPPORTUNITY_RECORD_TIMEOUT_MS,
    appendWarn,
  );
  if (!eligibility.eligible) {
    const opportunity = recordFor(options, { phase: 'skipped', eligible: false, attempted: false, outcome: 'skipped', reason: eligibility.reason ?? 'other-exclusion', ledgerRecorded: null }, correlationId, provider);
    return { outcome: 'skipped', result: null, opportunity, opportunityRecorded: await appendBounded(opportunity, warn) };
  }
  // Persist the eligible, attempted checkpoint before invoking the backend.
  // If the process dies in the call, the offline snapshot retains an unknown
  // attempt rather than incorrectly reporting that no opportunity existed.
  const started = recordFor(options, {
    phase: 'started', eligible: true, attempted: true, outcome: 'unknown',
    reason: 'attempt-started', ledgerRecorded: null,
  }, correlationId, provider);
  const attemptRecorded = await appendBounded(started, queueOpportunityWarning);
  let result: DecisionAskResult;
  try {
    const ask = options.ask ?? askDecision;
    result = await ask(input, options.askRuntime ?? { cwd: options.projectRoot, env: options.env ?? process.env });
  } catch (error) {
    const usage = error instanceof DecisionAskUsageError;
    const opportunity = recordFor(options, {
      phase: 'completed',
      eligible: true, attempted: !usage, outcome: usage ? 'skipped' : 'unknown',
      reason: usage ? 'usage-rejected' : 'execution-unknown', ledgerRecorded: false,
    }, correlationId, provider);
    const opportunityRecorded = await appendBounded(opportunity, queueOpportunityWarning);
    flushOpportunityWarning();
    if (usage) throw error;
    return { outcome: 'unknown', result: null, opportunity, attemptRecorded, opportunityRecorded, error };
  }
  let ledger = null;
  try {
    ledger = await (options.recordAsk ?? recordDecisionAsk)(input, result, {
      ...options,
      warn,
      caller: options.ledgerCaller === undefined ? safeCaller(options.caller) : options.ledgerCaller,
      id: () => correlationId,
    });
  } catch (error) {
    warn(`warning: failed to record decision ledger: ${error instanceof Error ? error.message : String(error)}`);
  }
  const opportunity = recordFor(options, {
    phase: 'completed',
    eligible: true, attempted: result.reason !== 'not-configured', outcome: result.status,
    reason: result.reason, ledgerRecorded: ledger ? true : null,
  }, correlationId, provider);
  const opportunityRecorded = await appendBounded(opportunity, queueOpportunityWarning);
  flushOpportunityWarning();
  return { outcome: result.status, result, opportunity, attemptRecorded, opportunityRecorded };
}

/** Collapse append-only started/completed events to one current state per checkpoint. */
function collapseOpportunities(records: DecisionOpportunityRecord[]): DecisionOpportunityRecord[] {
  const byId = new Map<string, DecisionOpportunityRecord>();
  for (const record of records) byId.set(record.correlationId, record);
  return [...byId.values()];
}

async function readOpportunities(projectRoot: string): Promise<{ records: DecisionOpportunityRecord[]; invalid: number; status: 'available' | 'absent' | 'unreadable' }> {
  const file = projectAiwgPath(projectRoot, 'decision', OPPORTUNITY_FILE);
  const records: DecisionOpportunityRecord[] = [];
  let invalid = 0;
  try {
    const input = createReadStream(file, { encoding: 'utf8' });
    for await (const line of createInterface({ input, crlfDelay: Infinity })) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line);
        if (validOpportunity(value)) records.push(value); else invalid += 1;
      } catch { invalid += 1; }
    }
    return { records, invalid, status: 'available' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { records, invalid, status: 'absent' };
    return { records, invalid: invalid + 1, status: 'unreadable' };
  }
}

const ACTIVITY_LINE_PATTERN = /^##\s+\[(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\]\s+[a-z]+\s+\|\s+(.+?)\s*$/;
const ORCHESTRATION_ACTIVITY_PATTERN = /\b(?:worker[- ]dispatch|dispatch(?:ed|ing)?\s+(?:a\s+)?worker|address-issues(?:\s+cycle)?|orchestration\s+worker)\b/i;

async function readOrchestrationActivity(projectRoot: string, since: Date) {
  const root = projectAiwgPath(projectRoot);
  const candidates = [path.join(root, 'activity.log'), path.join(root, 'activity-log', 'activity.log')];
  for (const candidate of candidates) {
    try {
      let recognizable = 0;
      let valid = 0;
      const input = createReadStream(candidate, { encoding: 'utf8' });
      for await (const line of createInterface({ input, crlfDelay: Infinity })) {
        const match = ACTIVITY_LINE_PATTERN.exec(line);
        if (!match) continue;
        const timestamp = Date.parse(`${match[1]}T${match[2]}:00.000Z`);
        if (!Number.isFinite(timestamp) || timestamp < since.getTime()) continue;
        valid += 1;
        if (ORCHESTRATION_ACTIVITY_PATTERN.test(match[3])) recognizable += 1;
      }
      return { status: 'available' as const, source: path.relative(projectRoot, candidate), valid, recognizable };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return { status: 'unreadable' as const, source: path.relative(projectRoot, candidate), valid: 0, recognizable: 0 };
    }
  }
  return { status: 'absent' as const, source: null, valid: 0, recognizable: 0 };
}

function filterScope<T extends { timestamp: string; sessionId: string }>(records: T[], sessionId: string | undefined, since: Date): T[] {
  return records.filter(record => sessionId ? record.sessionId === sessionId : Date.parse(record.timestamp) >= since.getTime());
}

function completedCalls(records: DecisionLedgerRecord[]) {
  const fallbackReasons: Record<string, number> = {};
  let answered = 0; let fallback = 0; let llmTokensAvoided = 0; let jevTokens = 0;
  for (const record of records) {
    if (record.status === 'answered') answered += 1;
    else { fallback += 1; const reason = record.fallbackReason ?? 'unknown'; fallbackReasons[reason] = (fallbackReasons[reason] ?? 0) + 1; }
    llmTokensAvoided += record.llm_tokens_avoided ?? record.estimatedLlmTokensAvoided;
    jevTokens += record.jev_tokens ?? (record.usage?.inputTokens ?? 0) + (record.usage?.outputTokens ?? 0);
  }
  return { completed: records.length, answered, fallback, fallbackReasons, llmTokensAvoided, jevTokens };
}

function opportunityCounts(records: DecisionOpportunityRecord[]) {
  const reasons: Record<string, number> = {};
  for (const record of records) reasons[record.reason] = (reasons[record.reason] ?? 0) + 1;
  return {
    observed: records.length,
    eligible: records.filter(record => record.eligible).length,
    attempted: records.filter(record => record.attempted).length,
    answered: records.filter(record => record.outcome === 'answered').length,
    fallback: records.filter(record => record.outcome === 'fallback').length,
    skipped: records.filter(record => record.outcome === 'skipped').length,
    unknown: records.filter(record => record.outcome === 'unknown').length,
    usageRejected: records.filter(record => record.reason === 'usage-rejected').length,
    ledgerRecordingUnknown: records.filter(record => record.ledgerRecorded === null && record.outcome !== 'skipped').length,
    reasons,
  };
}

function activationEvidence(input: Partial<DecisionOffloadActivationEvidence> | undefined): DecisionOffloadActivationEvidence {
  return { ...(input?.ruleSourceAvailable !== undefined ? { ruleSourceAvailable: input.ruleSourceAvailable } : {}), addon: input?.addon ?? 'unknown', ruleDelivery: input?.ruleDelivery ?? 'unknown',
    startupAnchor: input?.startupAnchor ?? 'unknown', nativeActivation: input?.nativeActivation ?? 'not-claimed',
    ...(input?.source ? { source: input.source } : {}) };
}

function askReadinessState(configured: boolean | null, latest?: DecisionOpportunityRecord) {
  if (configured === null) return 'unknown' as const;
  if (!configured) return 'disabled' as const;
  if (latest?.outcome === 'answered') return 'reachable' as const;
  if (latest?.outcome === 'fallback' && latest.attempted) return 'fallback' as const;
  if (latest?.outcome === 'unknown') return 'unknown' as const;
  return 'configured-unprobed' as const;
}

export async function buildDecisionOffloadSnapshot(options: BuildDecisionOffloadSnapshotOptions) {
  const projectRoot = path.resolve(options.projectRoot);
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  let projectConfig: Awaited<ReturnType<typeof readAiwgConfig>> | null = null;
  let configReadable = true;
  try { projectConfig = await readAiwgConfig(projectRoot); } catch { configReadable = false; }
  const configuredThresholds = projectConfig?.decision?.offload_report;
  const windowHours = options.windowHours ?? configuredThresholds?.window_hours ?? 24;
  const since = new Date(now.getTime() - windowHours * 60 * 60 * 1000);
  const detectedSession = resolveDecisionSession(options.sessionId, env);
  const sessionId = options.sessionId ?? (detectedSession.sessionId === 'unknown' ? undefined : detectedSession.sessionId);
  const thresholds: DecisionOffloadThresholds = {
    minimumEligible: configuredThresholds?.minimum_eligible ?? 1,
    minimumAttemptRate: configuredThresholds?.minimum_attempt_rate ?? 0.5,
    repeatedFallbacks: configuredThresholds?.repeated_fallbacks ?? 3,
    ...options.thresholds,
  };
  let enablement: ReturnType<typeof resolveDecisionEnablement> | null = null;
  try { enablement = resolveDecisionEnablement({ cwd: projectRoot, env }); }
  catch { configReadable = false; }
  let credential: Awaited<ReturnType<typeof inspectJevCredential>>;
  try { credential = await inspectJevCredential({ cwd: projectRoot, env }); }
  catch { credential = { configured: null, enabled: null, source: 'unknown' }; }
  const [opportunitiesRead, ledger, activity] = await Promise.all([
    readOpportunities(projectRoot),
    decisionLedgerHistory(projectRoot),
    readOrchestrationActivity(projectRoot, since),
  ]);
  const opportunityEvents = filterScope(opportunitiesRead.records, sessionId, since);
  const opportunities = collapseOpportunities(opportunityEvents);
  const calls = filterScope(ledger.records, sessionId, since);
  const organicOpportunities = opportunities.filter(record => record.category === 'organic');
  const diagnosticOpportunities = opportunities.filter(record => record.category !== 'organic');
  const organic = opportunityCounts(organicOpportunities);
  const diagnostics = opportunityCounts(diagnosticOpportunities);
  const opportunityIds = new Set(opportunities.filter(record => record.attempted).map(record => record.correlationId));
  const callIds = new Set(calls.map(record => record.id));
  const organicOpportunityIds = new Set(organicOpportunities.filter(record => record.attempted).map(record => record.correlationId));
  const organicCallIds = new Set(calls.filter(record => decisionOffloadCategory(record.caller) === 'organic').map(record => record.id));
  const latestObserved = [...opportunities].sort((a, b) => a.timestamp.localeCompare(b.timestamp)).at(-1);
  const latestTransportEvidence = [...opportunities].filter(record => record.attempted)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp)).at(-1);
  const askConfigured = credential.configured === null || credential.enabled === null
    ? null : credential.configured && credential.enabled;
  const evaluateState = configReadable && enablement
    ? (enablement.enabled ? 'configured-unprobed' : 'disabled') : 'unknown';
  let inspectedActivation: Partial<DecisionOffloadActivationEvidence> | undefined;
  if (!options.activationEvidence) {
    try {
      const inspected = await inspectDecisionOffloadActivation({ cwd: projectRoot, frameworkRoot: options.frameworkRoot, env });
      inspectedActivation = {
        addon: inspected.installed === true ? 'installed' : inspected.installed === false ? 'missing' : 'unknown',
        ruleSourceAvailable: inspected.ruleSourcePresent,
        ruleDelivery: inspected.ruleDelivery,
        startupAnchor: inspected.startupAnchorPresent === true ? 'present'
          : inspected.startupAnchorPresent === false ? 'missing' : 'unknown',
        nativeActivation: inspected.nativeActivation,
        source: 'local-configuration-and-startup-pointer; source availability is not delivery',
      };
    } catch { /* unavailable inspection remains unknown, never a loading claim */ }
  }
  const activation = activationEvidence(options.activationEvidence ?? inspectedActivation);
  const organicCalls = calls.filter(record => decisionOffloadCategory(record.caller) === 'organic');
  const activityCandidate = activity.recognizable > 0 && organicCalls.length === 0;
  const activitySuppressionReason = !activityCandidate ? null
    : activation.addon === 'unknown' ? 'activation-unknown'
      : activation.addon === 'missing' ? 'addon-missing'
        : askConfigured === null ? 'ask-readiness-unknown'
          : askConfigured === false ? 'ask-disabled-or-unconfigured'
            : null;
  const activityGap = activityCandidate && activitySuppressionReason === null;
  const driftReasons: string[] = [];
  const attemptedWithoutLedger = [...opportunityIds].filter(id => !callIds.has(id)).length;
  const organicAttemptedWithoutLedger = [...organicOpportunityIds].filter(id => !organicCallIds.has(id)).length;
  if (!configReadable || opportunitiesRead.status === 'unreadable' || opportunitiesRead.invalid > 0 || organic.unknown > 0) driftReasons.push('observation-unknown');
  if (organic.ledgerRecordingUnknown > 0 || ledger.skipped > 0) driftReasons.push('recording-failure-or-unknown');
  if (organicAttemptedWithoutLedger > 0) driftReasons.push('attempted-without-completed-ledger');
  if (organic.usageRejected > 0) driftReasons.push('usage-rejection');
  if (activation.addon === 'missing') driftReasons.push('missing-addon');
  else if (activation.addon === 'unknown') driftReasons.push('activation-evidence-unknown');
  if (activation.ruleDelivery === 'missing') driftReasons.push('missing-rule-delivery');
  if (activation.startupAnchor === 'missing') driftReasons.push('missing-activation-anchor');
  if (askConfigured === false) driftReasons.push('disabled-or-unconfigured');
  else if (askConfigured === null) driftReasons.push('ask-readiness-unknown');
  if (organic.eligible > 0 && organic.eligible >= thresholds.minimumEligible) {
    const rate = organic.eligible ? organic.attempted / organic.eligible : 0;
    if (organic.attempted === 0) driftReasons.push('observed-eligible-zero-attempts');
    else if (rate < thresholds.minimumAttemptRate) driftReasons.push('observed-eligible-low-attempt-rate');
  }
  if (organic.fallback >= thresholds.repeatedFallbacks) driftReasons.push('repeated-fallback');
  const unknown = !configReadable || askConfigured === null || activation.addon === 'unknown' || activation.startupAnchor === 'unknown'
    || opportunitiesRead.status === 'unreadable' || opportunitiesRead.invalid > 0
    || organic.unknown > 0 || organic.ledgerRecordingUnknown > 0 || ledger.skipped > 0 || organicAttemptedWithoutLedger > 0;
  const driftStatus = unknown ? 'unknown' : organic.eligible === 0 ? 'not-applicable' : driftReasons.length ? 'advisory' : 'ok';
  return {
    schema: DECISION_OFFLOAD_SNAPSHOT_SCHEMA,
    scope: { projectRoot, mode: sessionId ? 'session' : 'window', sessionId: sessionId ?? null,
      since: sessionId ? null : since.toISOString(), windowHours: sessionId ? null : windowHours, generatedAt: now.toISOString() },
    readiness: {
      ask: { state: askReadinessState(askConfigured, latestTransportEvidence), configured: credential.configured,
        enabled: credential.enabled, source: credential.source, probed: false },
      evaluate: { state: evaluateState, enabled: enablement?.enabled ?? null,
        source: configReadable && enablement ? enablement.source : 'unknown', probed: false },
      observed: latestObserved ? {
        timestamp: latestObserved.timestamp, transport: latestObserved.transport,
        category: latestObserved.category, outcome: latestObserved.outcome,
        reason: latestObserved.reason,
      } : null,
    },
    activation,
    coverage: { executable: DECISION_OFFLOAD_EXECUTABLE_COVERAGE,
      instructionOnly: DECISION_OFFLOAD_CHECKPOINT_COVERAGE, unsupportedObservation: 'unknown' },
    opportunities: { organic, excluded: diagnostics, journalEvents: opportunityEvents.length, invalidRecords: opportunitiesRead.invalid,
      journal: opportunitiesRead.status },
    calls: { organic: completedCalls(organicCalls),
      excluded: completedCalls(calls.filter(record => decisionOffloadCategory(record.caller) !== 'organic')), invalidRecords: ledger.skipped },
    activityHint: {
      status: activityGap ? 'advisory' : 'none',
      reason: activityGap ? 'orchestration-without-organic-completed-calls' : null,
      suppressionReason: activitySuppressionReason,
      recognizableOrchestrationEvents: activity.recognizable,
      eligibleCount: 'unknown',
      confidence: 'low',
      scope: 'recent-window',
      source: activity.source,
      journal: activity.status,
      note: 'Generic activity is a low-confidence signal only; it is not a measured eligible-opportunity denominator.',
    },
    correlation: { matched: [...opportunityIds].filter(id => callIds.has(id)).length,
      attemptedWithoutLedger,
      organicAttemptedWithoutLedger,
      ledgerWithoutOpportunity: [...callIds].filter(id => !opportunityIds.has(id)).length },
    drift: { status: driftStatus, advisory: driftStatus === 'advisory', reasons: [...new Set(driftReasons)], thresholds,
      thresholdSource: options.thresholds ? 'options' : configuredThresholds ? 'project' : 'default',
      note: organic.eligible === 0 ? 'No observed eligible checkpoints; this is not evidence of healthy adoption.' : null },
  };
}
