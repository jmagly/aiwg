/** TV-12 collection-only composition. Never changes production rollout or promotes qualification. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, realpath, readdir, readFile, rm } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { canonicalJson } from '../security/artifact-trust.js';
import { admitEntry, DEFAULT_ENTRY_LIMITS } from './entry.js';
import { CanonicalJsonByteEstimator, ContextPlanError, planDecisionContext, type ContextPlanInput, type ContextProviderProfile } from './context-plan.js';
import { compareContextUsage } from './context-qualification.js';
import { compileJevQuestion, JevDecisionAdapter, JEV_ENDPOINT } from './adapters/jev.js';
import { projectDecisionState, partitionProjectedState, type DecisionProjectionPolicy } from './projection.js';
import { DecisionAdmissionRegistry } from './admission.js';
import { artifactPin, assertArtifactPin, validateDefinition, validateRuleset, validateBinding } from './validate.js';
import { executeQualificationPlan, writeQualificationEvidenceManifest } from './qualification/runner.js';
import type { DecisionDefinition, DecisionRuleset, DecisionBinding, DecisionAdapterRequest, DecisionSchedulerPolicy } from './types.js';

export const contextLiveDigest = (value: unknown): `sha256:${string}` => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
const estimator = new CanonicalJsonByteEstimator();
const subject = 'synthetic-tv12';
const liveHosts = new WeakSet<ContextLiveHost>();
export interface ContextLiveApproval {
  schemaVersion: 'context-live-approval/v1'; approved: true; reviewer: string; stagingWorkspace: string;
  runId: string; sourceCommit: string; exactHeadCi: string; model: string; apiRevision: 'v1'; region: string;
  secretServiceReference: string; credentialResolverDigest: string; corpusDigest: string; preregistrationDigest: string;
  budget: { requests: number; tokens: number; usd: number; wallClockMs: number };
  /** Reviewer-approved upper bound, not a claimed provider price. All requests reserve the full bound. */
  perRequestBound: { totalTokens: number; usd: number; approvalReference: string };
  marginRule: { extraReserveBps: number; maximumMarginBps: number };
}
export interface ContextLiveCase { id: string; input: { payload: unknown }; definitions: DecisionDefinition[]; dimension: string }
export interface ContextLiveCorpus { schemaVersion: 'context-live-corpus/v1'; syntheticOnly: true; profile: ContextProviderProfile; cases: ContextLiveCase[] }
export interface ContextLiveHost {
  /** Approved secret service integration; receives only the logical reference. */
  resolveCredential(reference: string): Promise<Uint8Array>;
  /** Metadata-only durable sink called before the next partition. */
  record?(record: ContextLiveRecord): Promise<void>;
  recordFailure?(failure: ContextLiveProviderFailure): Promise<void>;
  /** Zeroes host-held credential material; called once when a run ends, however it ends. */
  dispose?(): void;
}
/** Mirrors the DecisionBinding `credentialRef` pattern, so a reference that binding validation refuses is rejected at approval. */
export const CREDENTIAL_REF = /^[a-z][a-z0-9.-]+$/;
/** #2681 hard cap on all TV-12 provider spend: every collection and canary run, reserved amounts. */
export const TV12_ISSUE_USD_CAP = 2;
/** Fixed ledger location beneath the canonical artifact root; every run directory lives here. */
export const contextLiveRunsRoot = (artifactRoot: string): string => join(artifactRoot, 'research', 'qualification', '2681', 'runs');
const SPEND_LOCK = '.tv12-spend.lock';
const micros = (usd: number): number => Math.ceil(usd * 1_000_000);
/**
 * Sums earlier #2681 spend in the ledger: a run's charged reservation when its summary exists, otherwise
 * (a crash or an unfinished run) its full approved budget. Unrecognized or unreadable entries fail closed.
 */
export async function contextLivePriorSpendUsd(runsRoot: string): Promise<number> {
  let entries;
  try { entries = await readdir(runsRoot, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
  let total = 0;
  const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
  for (const entry of entries) {
    if (entry.name === SPEND_LOCK) continue;
    if (!entry.isDirectory()) throw new Error('TV-12 ledger contains an unrecognized entry');
    const dir = join(runsRoot, entry.name);
    const names = await readdir(dir);
    let spend: unknown;
    if (names.includes('summary.json')) spend = (await json(join(dir, 'summary.json')))?.reserved?.usd;
    else if (names.includes('approval.json')) spend = (await json(join(dir, 'approval.json')))?.budget?.usd;
    else if (names.includes('canary-approval.json')) spend = (await json(join(dir, 'canary-approval.json')))?.plan?.budget?.usd;
    if (!names.includes('approval.json') && !names.includes('canary-approval.json')) throw new Error('TV-12 ledger contains an unrecognized run');
    if (typeof spend !== 'number' || !Number.isFinite(spend) || spend < 0) throw new Error('TV-12 ledger spend is unreadable');
    total += micros(spend);
  }
  return total / 1_000_000;
}
/**
 * Holds the ledger lock while `run` executes. The run's USD ceiling is the smaller of its approval and
 * the issue cap minus all prior spend; no remaining budget refuses before any write or credential use.
 */
export async function withContextLiveSpendLedger<T>(artifactRoot: string, approvedUsd: number,
  run: (runsRoot: string, issueSpend: { capUsd: number; priorUsd: number; runUsdCeiling: number }) => Promise<T>): Promise<T> {
  const runsRoot = contextLiveRunsRoot(artifactRoot);
  await mkdir(runsRoot, { recursive: true, mode: 0o700 });
  const lock = join(runsRoot, SPEND_LOCK);
  try { await writeFile(lock, `${process.pid}\n`, { flag: 'wx', mode: 0o600 }); }
  catch { throw new Error('TV-12 spend ledger lock is held; inspect and remove a stale lock manually'); }
  try {
    const priorUsd = await contextLivePriorSpendUsd(runsRoot);
    const remaining = micros(TV12_ISSUE_USD_CAP) - micros(priorUsd);
    if (remaining <= 0) throw new Error('TV-12 issue spend cap exhausted');
    return await run(runsRoot, { capUsd: TV12_ISSUE_USD_CAP, priorUsd, runUsdCeiling: Math.min(micros(approvedUsd), remaining) / 1_000_000 });
  } finally { await rm(lock, { force: true }); }
}
const schema = { type: 'object' as const, properties: { payload: {} }, required: ['payload'], additionalProperties: false };
function definition(id: string, kind: 'choice' | 'ordinal-score' = 'choice', count = 2): DecisionDefinition {
  return { apiVersion: 'decision.aiwg.io/v1alpha1', kind: 'DecisionDefinition', metadata: { id, version: '1.0.0', description: 'TV-12 synthetic collection' },
    spec: { purpose: 'Synthetic TV-12 collection only.', inputSchema: schema, question: 'Assess this synthetic entry.',
      answer: kind === 'choice' ? { kind, options: Array.from({ length: count }, (_, i) => ({ id: `option_${i}`, description: `Synthetic category ${i}.` })) }
        : { kind, levels: Array.from({ length: count }, (_, i) => `Synthetic level ${i}.`) }, requiredCapabilities: [kind] } };
}
function projection(model: string, region: string): DecisionProjectionPolicy {
  return { version: 'tv12-v1', provider: 'jev', model, region, origin: new URL(JEV_ENDPOINT).origin, purpose: 'tv12', allowIncompleteContext: false,
    fields: [{ pointer: '/payload', output: 'payload', source: 'synthetic-corpus', subject, trust: 'untrusted', sensitivity: 'public', purpose: 'tv12',
      retentionClass: 'qualification', accessScopes: ['tv12-reviewer'], exportPolicy: 'denied', deletionPolicy: 'erase', backupPolicy: 'not-persisted',
      allowedProviders: ['jev'], allowedModels: [model], allowedOrigins: [new URL(JEV_ENDPOINT).origin], allowedRegions: [region] }] };
}
async function compiled(item: ContextLiveCase, model: string, region: string) {
  item.definitions.forEach(validateDefinition);
  const policy = projection(model, region);
  const projected = await projectDecisionState(item.input, policy);
  const input: ContextPlanInput = { subject, authorizedState: partitionProjectedState(projected.state, projected.evidence) as ContextPlanInput['authorizedState'],
    authorizationDigest: contextLiveDigest(policy), incompleteContext: false,
    questions: item.definitions.map((d, i) => ({ id: `q${i}`, subject, entry: JSON.parse(compileJevQuestion(d).question) })) };
  return { input, projected, policy };
}
/** Collection-only ruleset: one alias per compiled question, review outcome, no action execution. */
export function contextLiveRuleset(itemId: string, aliases: string[], definitions: DecisionDefinition[]): DecisionRuleset {
  return { apiVersion: 'decision.aiwg.io/v1alpha1', kind: 'DecisionRuleset', metadata: { id: `tv12-${itemId}`, version: '1.0.0', description: 'TV-12 synthetic collection' },
    spec: { purpose: 'TV-12 collection without action execution.', inputSchema: schema,
      evaluations: aliases.map((alias, i) => ({ alias, decision: artifactPin(definitions[i]!), inputPointer: '' })),
      rules: [{ id: 'review', priority: 1, when: { op: 'eq', left: { source: 'decision', alias: aliases[0]!, pointer: '/status' }, right: 'success' }, outcome: 'review' }],
      composition: 'first-match', conflict: 'review', defaultOutcome: 'review', failureOutcome: 'review', outputSchema: { enum: ['review'] } } };
}
/** Pinned Jev target: approved model and logical credential reference, no retries or fallbacks. */
export function contextLiveTarget(approval: Pick<ContextLiveApproval, 'model' | 'secretServiceReference'>, adapterVersion: string, timeoutMs: number) {
  return { adapter: 'jev' as const, adapterVersion, model: approval.model, credentialRef: approval.secretServiceReference,
    requiredCapabilities: [] as string[], acceptance: { mode: 'typed-value' as const }, timeoutMs,
    retry: { maxRetries: 0, initialDelayMs: 0, maxDelayMs: 0 } };
}
export function contextLiveBinding(ruleset: DecisionRuleset, aliases: string[], target: ReturnType<typeof contextLiveTarget>, timeoutMs: number): DecisionBinding {
  return { apiVersion: 'decision.aiwg.io/v1alpha1', kind: 'DecisionBinding', metadata: { id: 'tv12-binding', version: '1.0.0', description: 'TV-12 synthetic collection' },
    spec: { ruleset: artifactPin(ruleset), totalTimeoutMs: timeoutMs, maxAttempts: aliases.length, concurrency: 1,
      evaluations: Object.fromEntries(aliases.map(alias => [alias, { targets: [target], fallbackOn: [] }])) } };
}
/** Exposes the exact D10-projected planning input used by collection, for record binding and the canary. */
export async function compileContextLiveCase(item: ContextLiveCase, model: string, region: string) {
  return compiled(item, model, region);
}
/** Builds targets from actual compiled question and trust-partitioned provider state shapes. */
export async function generateContextLiveCorpus(profile: ContextProviderProfile): Promise<ContextLiveCorpus> {
  admitEntry(profile);
  if (profile.limits.aggregateTokens !== 64_000 || profile.limits.stateAndLongestQuestionTokens !== 32_000) throw new Error('TV-12 requires documented limits');
  // Validate profile semantics before generating or writing any preparatory output.
  const probe = await compiled({ id: 'profile-probe', dimension: 'probe', input: { payload: '' }, definitions: [definition('probe')] }, 'preparation-model', 'preparation-region');
  planDecisionContext(probe.input, profile, estimator);
  const cases: ContextLiveCase[] = [];
  for (const dimension of ['longest', 'aggregate'] as const) for (const boundary of ['raw', 'effective'] as const) for (const offset of [-1, 0, 1]) {
    const limit = dimension === 'longest' ? profile.limits.stateAndLongestQuestionTokens : profile.limits.aggregateTokens;
    const target = Math.floor(limit * (boundary === 'raw' ? 1 : 1 - profile.safetyMarginBps / 10_000)) + offset;
    const item: ContextLiveCase = { id: `${dimension}-${boundary}-${offset + 1}`, dimension: `${dimension}-${boundary}`, input: { payload: '' },
      definitions: Array.from({ length: dimension === 'aggregate' ? 4 : 1 }, (_, i) => definition(`${dimension}-${boundary}-${offset + 1}-d${i}`)) };
    // Aggregate targets pad four independent question instructions; longest targets pad state.
    let low = 0, high = target * 3;
    const score = async (n: number) => {
      if (dimension === 'longest') item.input.payload = Array.from({ length: 4 }, (_, i) => 'x'.repeat(Math.floor(n / 4) + (i < n % 4 ? 1 : 0)));
      else item.definitions.forEach((d, i) => { d.spec.question = 'Assess. ' + 'x'.repeat(Math.floor(n / 4) + (i < n % 4 ? 1 : 0)); });
      const { input } = await compiled(item, 'preparation-model', 'preparation-region');
      return estimator.estimate(input.authorizedState).tokens + input.questions.reduce((sum, q) => sum + estimator.estimate(q.entry).tokens, 0) + profile.requestEnvelopeTokens;
    };
    while (low < high) { const mid = Math.floor((low + high) / 2); if (await score(mid) < target) low = mid + 1; else high = mid; }
    if (await score(low) !== target) throw new Error('Unreachable estimator target');
    cases.push(item);
  }
  cases.push({ id: 'unicode-nested', dimension: 'unicode-nested', input: { payload: { nested: [{ text: '合成 🙂 é'.repeat(100) }] } }, definitions: [definition('unicode')] },
    { id: 'choice-255', dimension: 'choice-255', input: { payload: 'synthetic' }, definitions: [definition('choice255', 'choice', 255)] },
    { id: 'score-10', dimension: 'score-10', input: { payload: 'synthetic' }, definitions: [definition('score10', 'ordinal-score', 10)] },
    { id: 'many-short', dimension: 'many-short', input: { payload: 'synthetic' }, definitions: Array.from({ length: 24 }, (_, i) => definition(`short${i}`)) });
  const dominant = definition('dominant'); dominant.spec.question += 'x'.repeat(30_000);
  cases.push({ id: 'dominant', dimension: 'dominant', input: { payload: 'synthetic' }, definitions: [dominant, definition('short')] });
  return { schemaVersion: 'context-live-corpus/v1', syntheticOnly: true, profile: structuredClone(profile), cases };
}
export const TV12_MAX_RETRIES = 1;
export const TV12_MIN_MEASURED_CASES = 12;
const retryableReasons = ['invalid-output', 'service-error', 'overloaded'];
export function contextLivePreregistration(corpus: ContextLiveCorpus, marginRule: ContextLiveApproval['marginRule']) {
  return { schemaVersion: 'context-live-preregistration/v2', corpusDigest: contextLiveDigest(corpus), estimator: { id: estimator.id, version: estimator.version },
    metrics: ['absolute-error-tokens', 'undercount-bps'], marginRule, stopFraction: 0.8, automaticPromotion: false,
    providerFailurePolicy: { maxRetriesPerRequest: TV12_MAX_RETRIES, retryableReasons: [...retryableReasons], terminalResponsesOnly: true,
      accounting: 'reserve every attempt before dispatch; never refund', exhausted: 'measurement-failure-and-continue',
      marginPopulation: 'fully measured cases only; exclude every partition of a failed case', minimumMeasuredCases: TV12_MIN_MEASURED_CASES,
      rationale: '12 of 13 admissible cases; at most one missing case, no coverage claim for its input class',
      stillStopImmediately: ['served-model-change', 'usage-bound', 'budget', 'credential-anomaly', 'source-drift',
        'missing-success-request-id', 'unknown-success-model', 'missing-success-usage', 'deadline', 'uncertain-execution', 'other-provider-outcome'] } };
}
export function validateContextLiveApproval(approval: ContextLiveApproval, corpus: ContextLiveCorpus): void {
  admitEntry(approval); admitEntry(corpus, { ...DEFAULT_ENTRY_LIMITS, serializedBytes: 8_388_608, properties: 100_000, entries: 200_000, memoryBytes: 67_108_864 });
  const keys = ['schemaVersion', 'approved', 'reviewer', 'stagingWorkspace', 'runId', 'sourceCommit', 'exactHeadCi', 'model', 'apiRevision', 'region',
    'secretServiceReference', 'credentialResolverDigest', 'corpusDigest', 'preregistrationDigest', 'budget', 'perRequestBound', 'marginRule'];
  if (Object.keys(approval).some(key => !keys.includes(key))
    || Object.keys(approval.perRequestBound ?? {}).sort().join(',') !== 'approvalReference,totalTokens,usd'
    || Object.keys(approval.marginRule ?? {}).sort().join(',') !== 'extraReserveBps,maximumMarginBps') throw new Error('Unknown TV-12 approval field');
  if (approval.schemaVersion !== 'context-live-approval/v1' || approval.approved !== true || corpus.schemaVersion !== 'context-live-corpus/v1' || corpus.syntheticOnly !== true
    || ![approval.reviewer, approval.stagingWorkspace, approval.runId, approval.exactHeadCi, approval.model, approval.region, approval.secretServiceReference,
      approval.perRequestBound?.approvalReference].every(v => typeof v === 'string' && v.trim()) || approval.apiRevision !== 'v1'
    || !/^sha256:[a-f0-9]{64}$/.test(approval.credentialResolverDigest) || !/^[a-f0-9]{40}$/.test(approval.sourceCommit) || !/^[a-zA-Z0-9_-]+$/.test(approval.runId)
    || /latest|unknown/i.test(approval.model) || approval.region === 'unknown' || !CREDENTIAL_REF.test(approval.secretServiceReference)
    || !approval.budget || Object.keys(approval.budget).sort().join(',') !== 'requests,tokens,usd,wallClockMs' || Object.values(approval.budget).some(n => !Number.isFinite(n) || n <= 0)
    || approval.budget.usd > TV12_ISSUE_USD_CAP
    || approval.budget.usd > Number.MAX_SAFE_INTEGER / 1_000_000 || approval.perRequestBound.usd > Number.MAX_SAFE_INTEGER / 1_000_000
    || !Number.isSafeInteger(approval.budget.requests) || !Number.isSafeInteger(approval.budget.tokens) || !Number.isSafeInteger(approval.budget.wallClockMs)
    || !Number.isSafeInteger(approval.perRequestBound.totalTokens) || approval.perRequestBound.totalTokens < 1
    || !Number.isFinite(approval.perRequestBound.usd) || approval.perRequestBound.usd <= 0
    || !Number.isSafeInteger(approval.marginRule?.extraReserveBps) || approval.marginRule.extraReserveBps < 0
    || !Number.isSafeInteger(approval.marginRule?.maximumMarginBps) || approval.marginRule.maximumMarginBps < approval.marginRule.extraReserveBps
    || approval.marginRule.maximumMarginBps >= 10_000
    || approval.corpusDigest !== contextLiveDigest(corpus) || approval.preregistrationDigest !== contextLiveDigest(contextLivePreregistration(corpus, approval.marginRule))) {
    throw new Error('Incomplete or mismatched TV-12 approval');
  }
  if (corpus.profile.limits.aggregateTokens !== 64_000 || corpus.profile.limits.stateAndLongestQuestionTokens !== 32_000
    || corpus.profile.estimator.id !== estimator.id || corpus.profile.estimator.version !== estimator.version
    || !corpus.cases.length || new Set(corpus.cases.map(c => c.id)).size !== corpus.cases.length) throw new Error('Invalid TV-12 corpus');
  // Checked before any spend: a selectable margin above the collection margin could split a collected request.
  if (corpus.profile.safetyMarginBps < approval.marginRule.maximumMarginBps) throw new Error('TV-12 collection margin is below the preregistered maximum');
}
export async function assertContextLiveSource(root: string, expected: string): Promise<void> {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL' }).trim();
  if (git('rev-parse', 'HEAD') !== expected || git('status', '--porcelain', '--untracked-files=all')) throw new Error('TV-12 requires clean exact source commit');
}
export interface ContextLiveRecord {
  source: 'provider' | 'synthetic'; estimator: { id: string; version: string }; wireDigest: string; wireBytes: number;
  caseId: string; partitionId: string; planDigest: string; profileDigest: string; servedModel: string; requestId: string;
  estimatedInputTokens: number; actualInputTokens: number; errorTokens: number; absoluteErrorTokens: number; undercountBps: number;
  usageRef: string; usageArtifactDigest: string; inputTokens: number; outputTokens: number; costUsd: number | null;
}
/** Pure accounting guard. Reservations are never refunded, including uncertain failed calls. */
export class ContextLiveBudget {
  requests = 0; tokens = 0; usd = 0;
  private usdMicros = 0;
  constructor(private readonly approval: Pick<ContextLiveApproval, 'budget' | 'perRequestBound'>, readonly started: number, private readonly now: () => number = Date.now) {}
  reserve(): void {
    const { budget, perRequestBound: bound } = this.approval;
    if (this.requests + 1 > budget.requests * 0.8 || this.tokens + bound.totalTokens > budget.tokens * 0.8
      || this.usdMicros + Math.ceil(bound.usd * 1_000_000) > Math.floor(budget.usd * 800_000) || this.now() - this.started >= budget.wallClockMs * 0.8) throw new Error('TV-12 budget exhausted');
    this.requests++; this.tokens += bound.totalTokens; this.usdMicros += Math.ceil(bound.usd * 1_000_000); this.usd = this.usdMicros / 1_000_000;
  }
}
/** Most requests the 80% stop admits, derived from the same arithmetic as `ContextLiveBudget.reserve`. */
export function contextLiveRequestCapacity(approval: Pick<ContextLiveApproval, 'budget' | 'perRequestBound'>): number {
  const { budget, perRequestBound: bound } = approval;
  return Math.min(Math.floor(budget.requests * 0.8),
    Math.floor(budget.tokens * 0.8 / bound.totalTokens), Math.floor(Math.floor(budget.usd * 800_000) / Math.ceil(bound.usd * 1_000_000)));
}
export interface ContextLiveEstimate {
  schemaVersion: 'context-live-estimate/v2'; providerCalls: 0; credentialResolved: false;
  cases: Array<{ id: string; dimension: string; rejectedBeforeDispatch: boolean; partitions: Array<{ id: string; questions: number; estimatedInputTokens: number }> }>;
  requests: number; maximumRequestsWithRetries: number; estimatedInputTokens: number; maxPartitionEstimate: number;
  reserved: { requests: number; tokens: number; usd: number }; requestCapacityAtStop: number; fitsBeforeStop: boolean;
}
/** Dry run: the exact partitions collection would dispatch, without credentials, transport or writes. */
export async function estimateContextLiveCollection(approval: ContextLiveApproval, corpus: ContextLiveCorpus): Promise<ContextLiveEstimate> {
  validateContextLiveApproval(approval, corpus);
  const cases: ContextLiveEstimate['cases'] = [];
  for (const item of corpus.cases) {
    admitEntry(item); admitEntry(item.input);
    const { input, policy } = await compiled(item, approval.model, approval.region);
    let plan;
    try { plan = planDecisionContext(input, corpus.profile, estimator); }
    catch (error) {
      // Same rule as collection: a pre-dispatch rejection records the case and moves on.
      if (error instanceof ContextPlanError && ['oversized-state', 'oversized-question'].includes(error.reason)) { cases.push({ id: item.id, dimension: item.dimension, rejectedBeforeDispatch: true, partitions: [] }); continue; }
      throw error;
    }
    const { adapter, capabilities } = await contextLiveAdapter(approval, policy);
    const timeoutMs = Math.max(1, Math.min(30_000, Math.floor(approval.budget.wallClockMs * 0.8)));
    cases.push({ id: item.id, dimension: item.dimension, rejectedBeforeDispatch: false, partitions: plan.partitions.map(partition => {
      const selected = input.questions.filter(q => partition.questionIds.includes(q.id));
      const checked = planDecisionContext({ ...input, questions: selected }, corpus.profile, estimator);
      if (checked.partitions.length !== 1 || checked.partitions[0]!.questionIds.length !== selected.length) throw new Error('TV-12 partition is not one complete request');
      contextLivePartitionRequest(item, selected.map(q => q.id), approval, adapter.version, capabilities, timeoutMs);
      return { id: partition.id, questions: partition.questionIds.length, estimatedInputTokens: checked.partitions[0]!.estimate.aggregateTokens };
    }) });
  }
  const partitions = cases.flatMap(c => c.partitions);
  const requests = partitions.length;
  const maximumRequestsWithRetries = requests * (1 + TV12_MAX_RETRIES);
  const capacity = contextLiveRequestCapacity(approval);
  const maxPartitionEstimate = Math.max(0, ...partitions.map(p => p.estimatedInputTokens));
  return { schemaVersion: 'context-live-estimate/v2', providerCalls: 0, credentialResolved: false, cases, requests, maximumRequestsWithRetries,
    estimatedInputTokens: partitions.reduce((sum, p) => sum + p.estimatedInputTokens, 0), maxPartitionEstimate,
    reserved: { requests: maximumRequestsWithRetries, tokens: maximumRequestsWithRetries * approval.perRequestBound.totalTokens, usd: maximumRequestsWithRetries * Math.ceil(approval.perRequestBound.usd * 1_000_000) / 1_000_000 },
    requestCapacityAtStop: capacity, fitsBeforeStop: maximumRequestsWithRetries <= capacity && maxPartitionEstimate <= approval.perRequestBound.totalTokens };
}
export interface ContextLiveProviderFailure {
  schemaVersion: 'context-live-provider-failure/v1'; source: 'provider' | 'synthetic';
  caseId: string; partitionId: string; attempt: number; reason: string; measurementFailure: boolean;
  httpStatus: number | null; requestId: string | null; servedModel: string | null;
  inputTokens: number | null; outputTokens: number | null; costUsd: number | null;
}
class CollectionStop extends Error {
  constructor(message: string, readonly evidence: { httpStatus: number | null; requestId: string | null; servedModel: string | null; inputTokens: number | null; outputTokens: number | null; costUsd: number | null }) { super(message); }
}
/** Built-in Jev adapter plus its destination checks; `capabilities()` makes no network call. */
async function contextLiveAdapter(approval: ContextLiveApproval, policy: DecisionProjectionPolicy, offlineFetch?: typeof fetch) {
  const adapter = new JevDecisionAdapter({ region: approval.region, ...(offlineFetch ? { fetch: offlineFetch } : {}) });
  const capabilities = await adapter.capabilities();
  if (!capabilities.batch?.native || capabilities.batch.atomic !== true || capabilities.egress?.mode !== 'network' || capabilities.egress.origin !== policy.origin
    || capabilities.egress.region !== policy.region || adapter.version !== '1.0.0') throw new Error('TV-12 adapter destination mismatch');
  return { adapter, capabilities };
}
/**
 * Every request-shape check that precedes admission, reservation and dispatch: answer shapes against
 * adapter capabilities, ruleset and binding schemas (including the credential reference), and pins.
 * Collection runs it per partition; the dry run runs the same function for the same partitions.
 */
function contextLivePartitionRequest(item: ContextLiveCase, aliases: string[], approval: ContextLiveApproval, adapterVersion: string,
  capabilities: Awaited<ReturnType<JevDecisionAdapter['capabilities']>>, timeoutMs: number) {
  const definitions = aliases.map(alias => item.definitions[Number(alias.slice(1))]!);
  const ruleset = contextLiveRuleset(item.id, aliases, definitions);
  const target = contextLiveTarget(approval, adapterVersion, timeoutMs);
  const binding = contextLiveBinding(ruleset, aliases, target, timeoutMs);
  definitions.forEach(d => {
    if (!capabilities.answerKinds.includes(d.spec.answer.kind) || d.spec.answer.kind === 'choice' && d.spec.answer.options.length > capabilities.maxOptions!
      || d.spec.answer.kind === 'ordinal-score' && d.spec.answer.levels.length > capabilities.maxLevels!) throw new Error('TV-12 unsupported answer shape');
  });
  validateRuleset(ruleset); validateBinding(binding, ruleset); assertArtifactPin(ruleset, binding.spec.ruleset, 'tv12 ruleset');
  aliases.forEach((alias, i) => assertArtifactPin(definitions[i]!, ruleset.spec.evaluations[i]!.decision, alias));
  return { definitions, ruleset, target, binding };
}
/** Collection-only native request. Exposed for offline guard tests; mocks remain synthetic. */
export async function collectContextLiveCase(item: ContextLiveCase, corpus: ContextLiveCorpus, approval: ContextLiveApproval,
  host: ContextLiveHost, budget: ContextLiveBudget, signal: AbortSignal,
  offlineFetch?: typeof fetch): Promise<{ rejected: boolean; records: ContextLiveRecord[]; failures: ContextLiveProviderFailure[]; synthetic: boolean }> {
  validateContextLiveApproval(approval, corpus);
  if (!offlineFetch && !liveHosts.has(host)) throw new Error('Live collection requires the source-verified runner');
  admitEntry(item);
  if (!corpus.cases.some(candidate => contextLiveDigest(candidate) === contextLiveDigest(item))) throw new Error('Case is outside frozen corpus');
  admitEntry(item.input);
  const { input, projected, policy } = await compiled(item, approval.model, approval.region);
  let plan;
  try { plan = planDecisionContext(input, corpus.profile, estimator); }
  catch (error) { if (error instanceof ContextPlanError && ['oversized-state', 'oversized-question'].includes(error.reason)) return { rejected: true, records: [], failures: [], synthetic: !!offlineFetch }; throw error; }
  const { adapter, capabilities } = await contextLiveAdapter(approval, policy, offlineFetch);
  const registry = new DecisionAdmissionRegistry();
  const records: ContextLiveRecord[] = [];
  const failures: ContextLiveProviderFailure[] = [];
  for (const partition of plan.partitions) {
    for (let attempt = 1; attempt <= 1 + TV12_MAX_RETRIES; attempt++) {
      if (signal.aborted) throw new Error('TV-12 deadline reached');
      const selected = input.questions.filter(q => partition.questionIds.includes(q.id));
      const partitionInput = { ...input, questions: selected };
      const checked = planDecisionContext(partitionInput, corpus.profile, estimator);
      if (checked.partitions.length !== 1 || checked.partitions[0]!.questionIds.length !== selected.length) throw new Error('TV-12 partition is not one complete request');
      if (checked.partitions[0]!.estimate.aggregateTokens > approval.perRequestBound.totalTokens) throw new Error('TV-12 approved token bound below estimate');
      const timeoutMs = Math.max(1, Math.min(30_000, Math.floor(approval.budget.wallClockMs * 0.8 - (Date.now() - budget.started))));
      const { definitions, target } = contextLivePartitionRequest(item, selected.map(q => q.id), approval, adapter.version, capabilities, timeoutMs);
      const invocationId = `${approval.runId}:${item.id}:${partition.id}:${attempt}`;
      const limits = { concurrency: 1, maxTokens: approval.perRequestBound.totalTokens, maxCostUsd: approval.perRequestBound.usd, allowUnknownCost: false };
      const scheduler: DecisionSchedulerPolicy = { enabled: true, profileVersion: 'tv12-collection-v1', workspace: { id: approval.stagingWorkspace, limits },
        principal: { id: approval.reviewer, limits }, providers: { jev: limits } };
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
      const deadlineEpochMs = Date.now() + timeoutMs;
      const lease = await registry.controllerFor(scheduler, Date.now).acquire({ budgetId: invocationId, workspaceId: approval.stagingWorkspace,
        principalId: approval.reviewer, providerId: 'jev', estimate: { tokens: approval.perRequestBound.totalTokens, costUsd: approval.perRequestBound.usd,
          attempts: 1, batchSize: selected.length, items: selected.length }, deadlineEpochMs, signal: requestSignal });
      let success = false;
      try {
        // Reservation precedes adapter invocation, DNS, credential resolution and network.
        budget.reserve();
        const requests: DecisionAdapterRequest[] = selected.map((q, i) => ({ alias: q.id, questionId: q.id, definition: definitions[i]!,
          input: projected.state, projectionEvidence: projected.evidence, target, invocationId, deadlineEpochMs, signal: requestSignal,
          resolveCredential: async reference => {
            if (requestSignal.aborted || reference !== approval.secretServiceReference) throw new Error('TV-12 credential access denied');
            return host.resolveCredential(reference);
          }, compiledArtifact: compileJevQuestion(definitions[i]!) }));
        const wire = { state: input.authorizedState, model: approval.model, questions: Object.fromEntries(selected.map(q => [q.id, q.entry])) };
        const response = requests.length > 1 ? await adapter.evaluateMany({ requests, decisionSubject: subject })
          : await adapter.evaluate(requests[0]!).then(observation => ({ answers: [{ questionId: selected[0]!.id, observation }], sharedUsage: observation.usage }));
        const first = response.answers[0]?.observation;
        const stopEvidence = { httpStatus: first?.httpStatus ?? null, requestId: first?.requestId ?? null,
          servedModel: first?.actualModel === approval.model ? approval.model : null, ...response.sharedUsage };
        const usage = response.sharedUsage;
        // Safety stops dominate the measurement retry, even on a non-success response.
        if (requestSignal.aborted || response.answers.some(a => a.observation.actualModel !== null && a.observation.actualModel !== approval.model)
          || [usage.inputTokens, usage.outputTokens].some(n => n !== null && (!Number.isSafeInteger(n) || n < 0 || n > approval.perRequestBound.totalTokens))
          || usage.inputTokens !== null && usage.outputTokens !== null && usage.inputTokens + usage.outputTokens > approval.perRequestBound.totalTokens
          || usage.costUsd !== null && (!Number.isFinite(usage.costUsd) || usage.costUsd < 0 || usage.costUsd > approval.perRequestBound.usd)) {
          throw new CollectionStop('TV-12 provider identity or usage bound failed', stopEvidence);
        }
        const failed = response.answers.filter(a => a.observation.status !== 'success');
        if (response.answers.length === selected.length && failed.length > 0 && failed.every(a =>
          a.observation.dispatchCertainty === 'terminal-response' && a.observation.remoteExecution !== 'unknown'
          && retryableReasons.includes(a.observation.reason)
          && (a.observation.httpStatus === 200 || a.observation.httpStatus! >= 500 && a.observation.httpStatus! <= 599))) {
          const failure: ContextLiveProviderFailure = { schemaVersion: 'context-live-provider-failure/v1', source: offlineFetch ? 'synthetic' : 'provider',
            caseId: item.id, partitionId: partition.id, attempt, reason: failed[0]!.observation.reason,
            measurementFailure: attempt === 1 + TV12_MAX_RETRIES, ...stopEvidence };
          failures.push(failure);
          await host.recordFailure?.(structuredClone(failure));
          continue;
        }
        // Other outcomes stop collection, including first limit-related 4xx. No provider text escapes.
        if (response.answers.length !== selected.length || response.answers.some(answer => answer.observation.status !== 'success'
          || answer.observation.actualModel !== approval.model || !answer.observation.requestId)) throw new CollectionStop('TV-12 provider identity or outcome failed', stopEvidence);
        const requestIds = new Set(response.answers.map(a => a.observation.requestId));
        if (requestIds.size !== 1) throw new Error('TV-12 inconsistent shared request identity');
        if (!Number.isSafeInteger(usage.inputTokens) || !Number.isSafeInteger(usage.outputTokens) || usage.inputTokens! < 0 || usage.outputTokens! < 0
          || usage.inputTokens! + usage.outputTokens! > approval.perRequestBound.totalTokens
          || (usage.costUsd !== null && (!Number.isFinite(usage.costUsd) || usage.costUsd < 0 || usage.costUsd > approval.perRequestBound.usd))) {
          throw new CollectionStop('TV-12 usage missing or approved bound exceeded', stopEvidence);
        }
        const usageArtifact = { source: offlineFetch ? 'synthetic' : 'provider', servedModel: approval.model, requestId: [...requestIds][0]!, ...usage };
        const usageArtifactDigest = contextLiveDigest(usageArtifact);
        const usageRef = `usage:${usageArtifactDigest}`;
        const comparison = compareContextUsage([{ caseId: `${item.id}:${partition.id}`, input: partitionInput,
          actualInputTokens: usage.inputTokens!, source: offlineFetch ? 'synthetic' : 'provider', usageRef }], corpus.profile, estimator).cases[0]!;
        const record: ContextLiveRecord = { source: offlineFetch ? 'synthetic' : 'provider', estimator: { id: estimator.id, version: estimator.version },
          wireDigest: contextLiveDigest(wire), wireBytes: Buffer.byteLength(JSON.stringify(wire)), caseId: item.id, partitionId: partition.id, planDigest: checked.planDigest, profileDigest: checked.providerProfile.digest,
          servedModel: approval.model, requestId: [...requestIds][0]!, estimatedInputTokens: comparison.estimatedInputTokens,
          actualInputTokens: comparison.actualInputTokens, errorTokens: comparison.errorTokens, absoluteErrorTokens: Math.abs(comparison.errorTokens),
          undercountBps: comparison.undercountBps, usageRef, usageArtifactDigest, ...usage as { inputTokens: number; outputTokens: number; costUsd: number | null } };
        records.push(record);
        await host.record?.(structuredClone(record));
        success = true;
        break;
      } finally { lease.release({ success }); }
    }
  }
  return { rejected: false, records, failures, synthetic: !!offlineFetch };
}
/** `exact` (run evidence) requires the canonical root itself; `within` (prepared inputs) allows a descendant. */
export async function assertContextArtifactRoot(sourceRoot: string, artifactRoot: string, mode: 'exact' | 'within' = 'exact'): Promise<void> {
  const route = JSON.parse(execFileSync('aiwg', ['artifacts', 'path', '--json', '--check-write'], { cwd: sourceRoot, encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL' }));
  if (typeof route.artifact_root !== 'string') throw new Error('Canonical artifact root unavailable');
  const delta = relative(await realpath(route.artifact_root), await realpath(artifactRoot));
  if (mode === 'exact' ? delta !== '' : delta === '..' || delta.startsWith('../') || isAbsolute(delta)) throw new Error('TV-12 evidence must use the canonical artifact root');
}
/** Writes only sanitized evidence. The caller must resolve the canonical artifact root first. */
export async function runContextLiveCollection(options: { approval: ContextLiveApproval; corpus: ContextLiveCorpus; sourceRoot: string;
  artifactRoot: string; host: ContextLiveHost; offlineTransport?: typeof fetch }): Promise<unknown> {
  const { sourceRoot, artifactRoot, host, offlineTransport } = options;
  admitEntry(options.approval); admitEntry(options.corpus, { ...DEFAULT_ENTRY_LIMITS, serializedBytes: 8_388_608, properties: 100_000, entries: 200_000, memoryBytes: 67_108_864 });
  const approval = structuredClone(options.approval), corpus = structuredClone(options.corpus);
  validateContextLiveApproval(approval, corpus);
  await assertContextLiveSource(sourceRoot, approval.sourceCommit);
  if (contextLiveDigest(await generateContextLiveCorpus(corpus.profile)) !== approval.corpusDigest) throw new Error('TV-12 requires complete generated synthetic corpus');
  await assertContextArtifactRoot(sourceRoot, artifactRoot);
  try {
    return await withContextLiveSpendLedger(artifactRoot, approval.budget.usd, (runsRoot, issueSpend) =>
      collectWithinLedger(approval, corpus, sourceRoot, runsRoot, issueSpend, host, offlineTransport));
  } finally { host.dispose?.(); }
}
async function collectWithinLedger(approval: ContextLiveApproval, corpus: ContextLiveCorpus, sourceRoot: string, runsRoot: string,
  issueSpend: { capUsd: number; priorUsd: number; runUsdCeiling: number }, host: ContextLiveHost, offlineTransport?: typeof fetch): Promise<unknown> {
  // Immutable snapshots exist before any credential or provider operation; the approval is written first
  // so an interrupted run is always charged its full approved budget by later ledger scans.
  const directory = resolve(runsRoot, approval.runId);
  await mkdir(directory, { recursive: false, mode: 0o700 });
  await writeFile(join(directory, 'approval.json'), canonicalJson(approval), { flag: 'wx', mode: 0o600 });
  await writeFile(join(directory, 'preregistration.json'), canonicalJson(contextLivePreregistration(corpus, approval.marginRule)), { flag: 'wx', mode: 0o600 });
  await writeFile(join(directory, 'corpus.json'), canonicalJson(corpus), { flag: 'wx', mode: 0o600 });
  const started = Date.now();
  const controller = new AbortController();
  const deadlineTimer = setTimeout(() => controller.abort(), Math.min(2_147_483_647, Math.floor(approval.budget.wallClockMs * 0.8)));
  const signal = controller.signal;
  try {
    const budget = new ContextLiveBudget({ ...approval, budget: { ...approval.budget, usd: issueSpend.runUsdCeiling } }, started);
    const expected = new Map<string, number>();
    for (const item of corpus.cases) {
      try { expected.set(item.id, planDecisionContext((await compiled(item, approval.model, approval.region)).input, corpus.profile, estimator).partitions.length); }
      catch (error) { if (error instanceof ContextPlanError && ['oversized-state', 'oversized-question'].includes(error.reason)) expected.set(item.id, 0); else throw error; }
    }
    const records: ContextLiveRecord[] = [];
    const rejected: string[] = [];
    const failed: string[] = [];
    let stopped = false;
    const frozenInputs = { corpus: { path: 'corpus.json', digest: approval.corpusDigest },
      preregistration: { path: 'preregistration.json', digest: approval.preregistrationDigest },
      approval: { path: 'approval.json', digest: contextLiveDigest(approval) } };
    type CaseResult = { outcome: 'pass' | 'fail'; details: Record<string, unknown> };
    // Collection runs here, sequentially, before D11 recording. The generic D11 runner never invokes
    // executors in `live` mode (a callback cannot authenticate a provider), so provider-backed outcomes
    // are recorded afterwards in `recorded` mode; their provider proof is the retained request ID and
    // usage digest in each comparison record.
    const outcomes = new Map<string, CaseResult>();
    for (const item of corpus.cases) {
      if (stopped) { outcomes.set(item.id, { outcome: 'fail', details: { reason: 'prior-stop', frozenInputs } }); continue; }
      try {
        await assertContextLiveSource(sourceRoot, approval.sourceCommit);
        const collectionHost: ContextLiveHost = { recordFailure: async failure => {
          await writeFile(join(directory, `${failure.caseId}-${failure.partitionId}-attempt-${failure.attempt}-failure.json`), canonicalJson(failure), { flag: 'wx', mode: 0o600 });
          await host.recordFailure?.(structuredClone(failure));
        }, resolveCredential: async reference => {
          await assertContextLiveSource(sourceRoot, approval.sourceCommit);
          return host.resolveCredential(reference);
        }, record: async record => {
          const usage = { source: record.source, servedModel: record.servedModel, requestId: record.requestId, inputTokens: record.inputTokens, outputTokens: record.outputTokens, costUsd: record.costUsd };
          if (contextLiveDigest(usage) !== record.usageArtifactDigest) throw new Error('TV-12 usage digest mismatch');
          await writeFile(join(directory, `usage-${record.usageArtifactDigest.slice(7)}.json`), canonicalJson(usage), { flag: 'wx', mode: 0o600 });
          await writeFile(join(directory, `${record.caseId}-${record.partitionId}-comparison.json`), canonicalJson(record), { flag: 'wx', mode: 0o600 });
          records.push(record);
          await host.record?.(structuredClone(record));
        } };
        if (!offlineTransport) liveHosts.add(collectionHost);
        const collected = await collectContextLiveCase(item, corpus, approval, collectionHost, budget, signal, offlineTransport);
        if (collected.rejected) rejected.push(item.id);
        const measurementFailure = collected.failures.some(f => f.measurementFailure);
        if (measurementFailure) failed.push(item.id);
        outcomes.set(item.id, { outcome: measurementFailure ? 'fail' : 'pass', details: { frozenInputs, rejectedBeforeDispatch: collected.rejected,
          ...(measurementFailure ? { reason: 'measurement-failure' } : {}), failures: collected.failures, records: collected.records } });
      } catch (error) {
        stopped = true;
        outcomes.set(item.id, { outcome: 'fail', details: { reason: 'collection-stopped', frozenInputs, ...(error instanceof CollectionStop ? { provider: error.evidence } : {}), records: records.filter(row => row.caseId === item.id), reserved: { requests: budget.requests, tokens: budget.tokens, usd: budget.usd } } });
      }
    }
    const run = await executeQualificationPlan({ artifactRoot: runsRoot, timeoutMs: 60_000, concurrency: 1,
      manifest: { schemaVersion: 'decision-qualification-run/v1', mode: offlineTransport ? 'offline' : 'recorded', runId: approval.runId, generatedAt: new Date().toISOString(),
        sourceCommit: approval.sourceCommit, dirty: false, cases: corpus.cases.map(item => ({ id: item.id, kind: 'baseline', mandatory: true, candidateTests: [], evidenceIds: ['CTX-TV12'] })) },
      executors: Object.fromEntries(corpus.cases.map(item => [item.id, async () => outcomes.get(item.id)!])), sanitizeDetails: details => details });
    let sourceDrift = false;
    try { await assertContextLiveSource(sourceRoot, approval.sourceCommit); } catch { stopped = true; sourceDrift = true; }
    const measured = corpus.cases.filter(item => !failed.includes(item.id) && outcomes.get(item.id)?.outcome === 'pass'
      && expected.get(item.id)! > 0 && expected.get(item.id) === records.filter(row => row.caseId === item.id).length).map(item => item.id);
    const unmeasured = corpus.cases.map(item => item.id).filter(id => !measured.includes(id) && !failed.includes(id) && !rejected.includes(id));
    const worst = Math.max(0, ...records.filter(row => measured.includes(row.caseId)).map(row => row.undercountBps));
    const candidateMarginBps = !stopped && measured.length >= TV12_MIN_MEASURED_CASES ? worst + approval.marginRule.extraReserveBps : null;
    const marginValid = candidateMarginBps !== null && candidateMarginBps <= approval.marginRule.maximumMarginBps;
    const collectionSuccess = !stopped && records.length > 0 && run.evidence.length === corpus.cases.length && run.evidence.every(row => row.outcome === 'pass')
      && corpus.cases.every(item => expected.get(item.id) === records.filter(row => row.caseId === item.id).length
        && (expected.get(item.id) !== 0 || rejected.includes(item.id)));
    const summary = { schemaVersion: 'context-live-collection/v2', sourceCommit: approval.sourceCommit, corpusDigest: approval.corpusDigest,
      preregistrationDigest: approval.preregistrationDigest, frozenInputs, source: offlineTransport ? 'synthetic' : 'provider', collectionSuccess, collected: records.length, measured, failed, rejected, unmeasured, stopped, sourceDrift, marginValid, minimumMeasuredCases: TV12_MIN_MEASURED_CASES,
      candidateMarginBps, withinApprovedMaximum: candidateMarginBps !== null && candidateMarginBps <= approval.marginRule.maximumMarginBps,
      qualifiedForEnforcement: false, pending: ['reviewer-margin-approval', 'versioned-profile-qualification', 'enforce-canary', 'rollback-evidence'],
      reserved: { requests: budget.requests, tokens: budget.tokens, usd: budget.usd }, issueSpend, elapsedMs: Date.now() - started };
    await writeFile(join(directory, 'summary.json'), canonicalJson(summary), { flag: 'wx', mode: 0o600 });
    await writeFile(join(directory, 'run-manifest.json'), canonicalJson(run), { flag: 'wx', mode: 0o600 });
    const manifest = await writeQualificationEvidenceManifest(run, runsRoot, sourceRoot,
      Object.fromEntries(corpus.cases.map(item => [item.id, ['src/decision/context-live-qualification.ts', 'src/decision/context-plan.ts', 'src/decision/adapters/jev.ts']])));
    return { ...summary, evidenceManifest: manifest.artifact, evidenceDigest: manifest.digest };
  } finally { clearTimeout(deadlineTimer); }
}
