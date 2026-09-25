import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { canonicalJson } from '../security/artifact-trust.js';
import { admitEntry } from './entry.js';

/** Versioned offline contract. Provider dispatch is not enabled by the job layer. */
export const ITEM_STATES = [
  'queued', 'running', 'succeeded', 'abstained', 'review', 'unsupported', 'retryable-failed',
  'permanent-failed', 'canceled', 'expired', 'execution-unknown',
] as const;
export type ItemState = typeof ITEM_STATES[number];
export type JobState = 'validating' | 'queued' | 'running' | 'partially-completed' |
  'completed' | 'cancel-requested' | 'canceled' | 'expired' | 'failed';
/**
 * D16 resolution of an `execution-unknown` attempt (#2722): a verified effect
 * whose D03 receipt digest matched the ledger's recorded digest. Only
 * `digest-match` is accepted; the receipt digest must equal the attempt's.
 */
export interface DecisionJobAttemptResolution {
  method: 'effect-ledger'; effectId: string; reason: 'digest-match'; receiptDigest: `sha256:${string}`;
}
export interface DecisionJobItem {
  id: string; fingerprint: `sha256:${string}`; subjectDigest: `sha256:${string}`;
  definitionDigest: `sha256:${string}`; bindingDigest: `sha256:${string}`; rulesetDigest?: `sha256:${string}`;
  state: ItemState;
  attempts: Array<{ id: string; requestDigest: `sha256:${string}`; receiptDigest?: `sha256:${string}`;
    reservedTokens?: number; reservedCostMicros?: number;
    outcome: 'dispatched' | 'succeeded' | 'failed' | 'execution-unknown';
    resolution?: DecisionJobAttemptResolution }>;
  resultDigest?: `sha256:${string}`; errorCode?: string;
}
export interface DecisionJob {
  schemaVersion: 'decision-job/v1'; id: string;
  scope: { tenantId: string; projectId: string; workspaceId: string; principalId: string };
  fingerprint: `sha256:${string}`; state: JobState; items: DecisionJobItem[];
  summary: Record<ItemState, number>;
  createdAtEpochMs: number; expiresAtEpochMs: number;
  budget: { maxAttempts: number; maxTokens: number; maxCostMicros: number; maxConcurrency: number };
}
export class DecisionJobContractError extends Error {
  constructor(message: string) { super(message); this.name = 'DecisionJobContractError'; }
}
const here = dirname(fileURLToPath(import.meta.url));
const dir = [resolve(here, '../../schemas/decision'), resolve(here, '../../../schemas/decision')]
  .find(path => existsSync(resolve(path, 'DecisionJob.v1.schema.json')));
if (!dir) throw new Error('Decision job schema directory is unavailable');
const schema = JSON.parse(readFileSync(resolve(dir, 'DecisionJob.v1.schema.json'), 'utf8')) as object;
const check = new Ajv2020({ strict: false, allErrors: true }).compile(schema);
const reject = (message: string): never => { throw new DecisionJobContractError(message); };
const transitions: Record<JobState, readonly JobState[]> = {
  validating: ['queued', 'failed', 'canceled', 'expired'],
  queued: ['running', 'cancel-requested', 'expired', 'failed'],
  running: ['running', 'partially-completed', 'completed', 'cancel-requested', 'expired', 'failed'],
  'partially-completed': ['partially-completed', 'completed', 'cancel-requested', 'expired', 'failed'],
  'cancel-requested': ['canceled', 'partially-completed', 'failed', 'expired'],
  completed: [], canceled: [], expired: [], failed: [],
};
const itemTransitions: Record<ItemState, readonly ItemState[]> = {
  queued: ['running', 'canceled', 'expired'],
  running: ['succeeded', 'abstained', 'review', 'unsupported', 'retryable-failed',
    'permanent-failed', 'execution-unknown', 'canceled', 'expired'],
  'retryable-failed': ['queued', 'running', 'canceled', 'expired'],
  succeeded: [], abstained: [], review: [], unsupported: [], 'permanent-failed': [],
  canceled: [], expired: [], 'execution-unknown': [],
};
const RESULT_STATES: readonly ItemState[] = ['succeeded', 'abstained', 'review'];
type Attempt = DecisionJobItem['attempts'][number];
function validResolution(attempt: Attempt): boolean {
  const resolution = attempt.resolution;
  return !resolution || (resolution.method === 'effect-ledger' && resolution.reason === 'digest-match' &&
    attempt.outcome === 'succeeded' && !!attempt.receiptDigest && resolution.receiptDigest === attempt.receiptDigest);
}
/**
 * The one gated transition out of `execution-unknown` (D16 opt-in resolver,
 * #2722): the latest attempt moves from `execution-unknown` to `succeeded`
 * with a receipt digest bound by a `digest-match` resolution, the item gains
 * its result digest, and nothing else changes.
 */
export function isExecutionUnknownResolution(previous: DecisionJobItem, item: DecisionJobItem): boolean {
  const before = previous.attempts.at(-1);
  const after = item.attempts.at(-1);
  if (previous.state !== 'execution-unknown' || !RESULT_STATES.includes(item.state) || !before || !after ||
      item.attempts.length !== previous.attempts.length || before.outcome !== 'execution-unknown' ||
      before.receiptDigest !== undefined || before.resolution !== undefined ||
      previous.resultDigest !== undefined || !item.resultDigest || item.errorCode !== previous.errorCode) return false;
  if (previous.attempts.slice(0, -1).some((attempt, index) => canonicalJson(attempt) !== canonicalJson(item.attempts[index])))
    return false;
  const { receiptDigest, resolution, outcome, ...rest } = after;
  const { outcome: _previousOutcome, ...previousRest } = before;
  return outcome === 'succeeded' && !!receiptDigest && !!resolution && validResolution(after) &&
    canonicalJson(rest) === canonicalJson(previousRest);
}
function sameItem(previous: DecisionJobItem, item: DecisionJobItem | undefined): boolean {
  return !!item && canonicalJson(previous) === canonicalJson(item);
}
export function validateDecisionJob(value: unknown): asserts value is DecisionJob {
  try { admitEntry(value); } catch { return reject('job admission denied'); }
  if (!check(value)) return reject('invalid decision job schema');
  const job = value as DecisionJob;
  if (job.expiresAtEpochMs <= job.createdAtEpochMs) return reject('invalid job expiry');
  const ids = new Set<string>();
  let reservedTokens = 0; let reservedCostMicros = 0;
  const actual = Object.fromEntries(ITEM_STATES.map(state => [state, 0])) as Record<ItemState, number>;
  for (const item of job.items) {
    if (ids.has(item.id)) return reject('duplicate job item ID');
    ids.add(item.id); actual[item.state]++;
    if (item.attempts.length > job.budget.maxAttempts ||
        new Set(item.attempts.map(attempt => attempt.id)).size !== item.attempts.length) return reject('invalid item attempts');
    if (['succeeded', 'abstained', 'review'].includes(item.state) &&
        (!item.resultDigest || !item.attempts.some(attempt => attempt.outcome === 'succeeded' && attempt.receiptDigest)))
      return reject('result item lacks validated receipt');
    if (item.resultDigest && !['succeeded', 'abstained', 'review'].includes(item.state)) return reject('invalid item result');
    if (item.state === 'execution-unknown' && !item.attempts.some(attempt => attempt.outcome === 'execution-unknown')) return reject('unreconciled item missing attempt');
    for (const attempt of item.attempts) {
      if ((attempt.reservedTokens === undefined) !== (attempt.reservedCostMicros === undefined))
        return reject('incomplete job reservation');
      reservedTokens += attempt.reservedTokens ?? 0;
      reservedCostMicros += attempt.reservedCostMicros ?? 0;
      if (!Number.isSafeInteger(reservedTokens) || !Number.isSafeInteger(reservedCostMicros)) return reject('job reservation overflow');
      if (!validResolution(attempt)) return reject('unbound execution-unknown resolution');
    }
  }
  if (reservedTokens > job.budget.maxTokens || reservedCostMicros > job.budget.maxCostMicros)
    return reject('job budget reservation exceeded');
  if (Object.keys(job.summary).length !== ITEM_STATES.length ||
      ITEM_STATES.some(state => job.summary[state] !== actual[state])) return reject('job summary mismatch');
  if (['validating', 'queued'].includes(job.state) && (actual.running || actual.succeeded || actual['execution-unknown']))
    return reject('unstarted job contains dispatched items');
  if (job.state === 'canceled' && (actual.running || actual.queued || actual['execution-unknown']))
    return reject('canceled job conceals in-flight ambiguity');
  if (job.state === 'completed' && (actual.running || actual.queued || actual['retryable-failed'] || actual['execution-unknown']))
    return reject('completed job conceals unfinished items');
}
/** A same-state job revision whose only changes are gated `execution-unknown` resolutions. */
function resolutionOnly(before: DecisionJob, after: DecisionJob): boolean {
  if (before.state !== after.state || before.items.length !== after.items.length) return false;
  let resolved = 0;
  for (const [index, previous] of before.items.entries()) {
    const item = after.items[index];
    if (!item || item.id !== previous.id) return false;
    if (isExecutionUnknownResolution(previous, item)) resolved++;
    else if (!sameItem(previous, item)) return false;
  }
  return resolved > 0;
}
export function assertJobTransition(before: DecisionJob, after: DecisionJob): void {
  validateDecisionJob(before); validateDecisionJob(after);
  if (before.id !== after.id || before.fingerprint !== after.fingerprint ||
      canonicalJson(before.scope) !== canonicalJson(after.scope) ||
      before.createdAtEpochMs !== after.createdAtEpochMs || before.expiresAtEpochMs !== after.expiresAtEpochMs ||
      canonicalJson(before.budget) !== canonicalJson(after.budget) ||
      !(transitions[before.state].includes(after.state) || resolutionOnly(before, after)))
    return reject('illegal job transition or changed identity');
  const next = new Map(after.items.map(item => [item.id, item]));
  if (next.size !== before.items.length || after.items.length !== before.items.length) return reject('job items changed');
  for (const [index, previous] of before.items.entries()) {
    const item = after.items[index];
    if (item?.id !== previous.id) return reject('job item order changed');
    if (!item || previous.fingerprint !== item.fingerprint || previous.subjectDigest !== item.subjectDigest ||
        previous.definitionDigest !== item.definitionDigest || previous.bindingDigest !== item.bindingDigest ||
        previous.rulesetDigest !== item.rulesetDigest) return reject('illegal item transition, mutated pins or attempt history');
    if (isExecutionUnknownResolution(previous, item)) continue;
    if ((previous.state !== item.state && !itemTransitions[previous.state].includes(item.state)) ||
        item.attempts.length < previous.attempts.length || item.attempts.length > previous.attempts.length + 1 ||
        (item.attempts.length > previous.attempts.length &&
          !(item.state === 'running' && ['queued', 'retryable-failed'].includes(previous.state) &&
            item.attempts.at(-1)?.outcome === 'dispatched')) ||
        (['succeeded', 'abstained', 'review', 'unsupported', 'permanent-failed', 'canceled', 'expired', 'execution-unknown'].includes(previous.state) &&
          item.attempts.length !== previous.attempts.length) ||
        (previous.state === 'running' && item.state === 'canceled' && previous.attempts.some(attempt => attempt.outcome === 'dispatched')) ||
        (previous.resultDigest !== undefined && item.resultDigest !== previous.resultDigest) ||
        (previous.errorCode !== undefined && item.errorCode !== previous.errorCode) ||
        (previous.state === item.state &&
          (previous.resultDigest !== item.resultDigest || previous.errorCode !== item.errorCode)) ||
        previous.attempts.some((attempt, index) => canonicalJson(attempt) !== canonicalJson(item.attempts[index]) &&
          !(previous.state === 'running' && index === previous.attempts.length - 1 &&
            attempt.outcome === 'dispatched' &&
            (item.attempts[index]?.outcome === 'execution-unknown' && item.state === 'execution-unknown' ||
             item.attempts[index]?.outcome === 'succeeded' && ['succeeded', 'abstained', 'review'].includes(item.state) && !!item.attempts[index]?.receiptDigest ||
             item.attempts[index]?.outcome === 'failed' && ['retryable-failed', 'permanent-failed', 'unsupported'].includes(item.state)) &&
            attempt.id === item.attempts[index]?.id && attempt.requestDigest === item.attempts[index]?.requestDigest &&
            attempt.reservedTokens === item.attempts[index]?.reservedTokens &&
            attempt.reservedCostMicros === item.attempts[index]?.reservedCostMicros &&
            (item.attempts[index]?.outcome === 'execution-unknown' ? !item.attempts[index]?.receiptDigest : true))))
      return reject('illegal item transition, mutated pins or attempt history');
  }
}
