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
export interface DecisionJobItem {
  id: string; fingerprint: `sha256:${string}`; subjectDigest: `sha256:${string}`;
  definitionDigest: `sha256:${string}`; bindingDigest: `sha256:${string}`;
  state: ItemState;
  attempts: Array<{ id: string; requestDigest: `sha256:${string}`; receiptDigest?: `sha256:${string}`;
    outcome: 'dispatched' | 'succeeded' | 'failed' | 'execution-unknown' }>;
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
  running: ['partially-completed', 'completed', 'cancel-requested', 'expired', 'failed'],
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
export function validateDecisionJob(value: unknown): asserts value is DecisionJob {
  try { admitEntry(value); } catch { return reject('job admission denied'); }
  if (!check(value)) return reject('invalid decision job schema');
  const job = value as DecisionJob;
  if (job.expiresAtEpochMs <= job.createdAtEpochMs) return reject('invalid job expiry');
  const ids = new Set<string>();
  const actual = Object.fromEntries(ITEM_STATES.map(state => [state, 0])) as Record<ItemState, number>;
  for (const item of job.items) {
    if (ids.has(item.id)) return reject('duplicate job item ID');
    ids.add(item.id); actual[item.state]++;
    if (item.attempts.length > job.budget.maxAttempts ||
        new Set(item.attempts.map(attempt => attempt.id)).size !== item.attempts.length) return reject('invalid item attempts');
    if (item.state === 'succeeded' && (!item.resultDigest || !item.attempts.some(attempt => attempt.outcome === 'succeeded' && attempt.receiptDigest)))
      return reject('successful item lacks validated receipt');
    if (item.resultDigest && !['succeeded', 'abstained', 'review'].includes(item.state)) return reject('invalid item result');
    if (item.state === 'execution-unknown' && !item.attempts.some(attempt => attempt.outcome === 'execution-unknown')) return reject('unreconciled item missing attempt');
  }
  if (Object.keys(job.summary).length !== ITEM_STATES.length ||
      ITEM_STATES.some(state => job.summary[state] !== actual[state])) return reject('job summary mismatch');
  if (['validating', 'queued'].includes(job.state) && (actual.running || actual.succeeded || actual['execution-unknown']))
    return reject('unstarted job contains dispatched items');
  if (job.state === 'canceled' && (actual.running || actual.queued || actual['execution-unknown']))
    return reject('canceled job conceals in-flight ambiguity');
  if (job.state === 'completed' && (actual.running || actual.queued || actual['retryable-failed'] || actual['execution-unknown']))
    return reject('completed job conceals unfinished items');
}
export function assertJobTransition(before: DecisionJob, after: DecisionJob): void {
  validateDecisionJob(before); validateDecisionJob(after);
  if (before.id !== after.id || before.fingerprint !== after.fingerprint ||
      canonicalJson(before.scope) !== canonicalJson(after.scope) ||
      before.createdAtEpochMs !== after.createdAtEpochMs || before.expiresAtEpochMs !== after.expiresAtEpochMs ||
      canonicalJson(before.budget) !== canonicalJson(after.budget) ||
      !transitions[before.state].includes(after.state)) return reject('illegal job transition or changed identity');
  const next = new Map(after.items.map(item => [item.id, item]));
  if (next.size !== before.items.length || after.items.length !== before.items.length) return reject('job items changed');
  for (const [index, previous] of before.items.entries()) {
    const item = after.items[index];
    if (item?.id !== previous.id) return reject('job item order changed');
    if (!item || previous.fingerprint !== item.fingerprint || previous.subjectDigest !== item.subjectDigest ||
        previous.definitionDigest !== item.definitionDigest || previous.bindingDigest !== item.bindingDigest ||
        (previous.state !== item.state && !itemTransitions[previous.state].includes(item.state)) ||
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
            (item.attempts[index]?.outcome === 'execution-unknown' ? !item.attempts[index]?.receiptDigest : true))))
      return reject('illegal item transition, mutated pins or attempt history');
  }
}
