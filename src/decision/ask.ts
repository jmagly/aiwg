import { aggregateModalAnswers } from './ensemble/aggregate.js';
import { readAiwgConfigCandidate } from '../config/aiwg-config.js';
import { readFile } from 'node:fs/promises';
import { JEV_ENDPOINT, JevDecisionAdapter } from './adapters/jev.js';
import { evaluateDecisionRuleset } from './evaluate.js';
import type {
  AdapterObservation,
  DecisionAdapter,
  DecisionAnswer,
  DecisionBinding,
  DecisionDefinition,
  DecisionRuleset,
  DecisionUsage,
  ExecutionTarget,
  RulesetResult,
} from './types.js';
import type { DecisionProjectionPolicy } from './projection.js';
import { artifactPin } from './validate.js';
import {
  JEV_CREDENTIAL_REF,
  JEV_DEFAULT_REGION,
  lookupJevCredential,
  removeJevCredentialFile,
  writeJevCredentialFile,
  type JevCredentialOptions,
} from './jev-credentials.js';

type AskMode =
  | { kind: 'yes-no' }
  | { kind: 'choices'; choices: string[] }
  | { kind: 'scale'; low: number; high: number };

export interface DecisionAskInput {
  question: string;
  mode: AskMode;
  context?: string;
  threshold?: number;
  timeoutMs?: number;
  passes?: number;
  escalationPasses?: number;
  minAgreement?: number;
  agreementConfidenceFloor?: number;
}

export interface DecisionAskPass {
  index: number;
  status: 'succeeded' | 'abstained' | 'failed';
  reason: string;
  answer: string | boolean | number | null;
  confidence: number | null;
  probability?: number;
  model: string | null;
  usage: DecisionAskResult['usage'];
  latencyMs: number;
}

export interface DecisionAskAggregate {
  algorithm: 'majority-v1';
  semantics: 'stability-signal-not-correctness';
  passesRequested: number;
  escalationPasses: number;
  passesRun: number;
  escalated: boolean;
  earlyStop: 'certain-failure' | 'timeout' | null;
  agreementRatio: number;
  votes: Record<string, number>;
  answer: string | boolean | number | null;
  confidenceSummary: { count: number; missing: number; mean: number | null; min: number | null; max: number | null };
  passes: DecisionAskPass[];
  minAgreement?: number | null;
  agreementConfidenceFloor?: number;
}

export interface DecisionAskResult {
  schema: 'aiwg-decision-ask/v1';
  status: 'answered' | 'fallback';
  answer: string | boolean | number | null;
  confidence: number | null;
  probability?: number;
  fallback: null | 'llm';
  reason: string;
  model: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null } | null;
  latencyMs: number;
  aggregate?: DecisionAskAggregate;
  /** Absent on legacy results; null on fallback. */
  answeredBy?: 'confidence' | 'agreement' | null;
}

export interface DecisionAskRuntimeOptions extends JevCredentialOptions {
  /** CLI/MCP supply the project root to load project sampling defaults. */
  cwd?: string;
  adapter?: DecisionAdapter;
  createAdapter?: (input: { region: string; endpoint?: string }) => DecisionAdapter;
  resolveCredential?: (logicalRef: string) => Promise<Uint8Array>;
  evaluate?: typeof evaluateDecisionRuleset;
  now?: () => number;
  runId?: string;
  invocationId?: string;
}

export interface DecisionSetupInput {
  token?: string;
  region?: string;
  endpoint?: string;
  verify?: boolean;
  remove?: boolean;
}

export interface DecisionSetupResult {
  schema: 'aiwg-decision-jev-setup/v1';
  configured: boolean;
  credentialSource: 'file' | 'env';
  region: string;
  verified?: boolean;
  model?: string | null;
  usage?: { inputTokens: number | null; outputTokens: number | null } | null;
  next: string[];
}

const CONTEXT_LIMIT_BYTES = 32 * 1024;
const MODEL = 'jev-latest';
const PURPOSE = 'agent-bounded-decision';
const INPUT_SCHEMA = {
  type: 'object',
  properties: { message: { type: 'string', minLength: 1 } },
  required: ['message'],
  additionalProperties: false,
};

export class DecisionAskUsageError extends Error {
  constructor(readonly reason: string, message: string) {
    super(message);
    this.name = 'DecisionAskUsageError';
  }
}

function usageError(reason: string, message: string): never {
  throw new DecisionAskUsageError(reason, message);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function validateQuestion(question: string): void {
  if (!question.trim()) usageError('question-required', 'decision ask requires --question <q>');
}

export function validateDecisionAskInput(input: DecisionAskInput): void {
  validateQuestion(input.question);
  if (input.context !== undefined && byteLength(input.context) > CONTEXT_LIMIT_BYTES) {
    usageError('context-too-large', 'decision ask context exceeds 32 KiB');
  }
  const threshold = input.threshold ?? 0.8;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    usageError('invalid-threshold', '--threshold must be a probability from 0 to 1');
  }
  for (const key of ['minAgreement', 'agreementConfidenceFloor'] as const) {
    const value = input[key];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)) {
      usageError('invalid-agreement-policy', `${key} must be a probability from 0 to 1`);
    }
  }
  const timeoutMs = input.timeoutMs ?? 15_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) usageError('invalid-timeout', '--timeout-ms must be a positive integer');
  const passes = input.passes ?? DEFAULT_DECISION_PASSES;
  const escalationPasses = input.escalationPasses ?? defaultEscalationPasses(passes);
  if (!Number.isSafeInteger(passes) || passes <= 0) usageError('invalid-passes', '--passes must be a positive safe integer');
  if (!Number.isSafeInteger(escalationPasses) || escalationPasses < passes) {
    usageError('invalid-escalation-passes', '--escalation-passes must be a positive safe integer >= passes');
  }
  if (input.mode.kind === 'choices') {
    if (input.mode.choices.length < 2 || input.mode.choices.length > 255) usageError('invalid-choices', '--choices requires 2..255 ids');
    const seen = new Set<string>();
    for (const { id, description } of input.mode.choices.map(parseChoice)) {
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(id)) usageError('invalid-choices', 'choice ids must match [A-Za-z0-9_.-]{1,64}');
      if (description !== undefined && (!description || description.length > 200)) {
        usageError('invalid-choices', 'choice descriptions after = must be 1..200 characters');
      }
      if (seen.has(id)) usageError('invalid-choices', 'choice ids must not contain duplicates');
      seen.add(id);
    }
  }
  if (input.mode.kind === 'scale') {
    const count = input.mode.high - input.mode.low + 1;
    if (!Number.isInteger(input.mode.low) || !Number.isInteger(input.mode.high) || input.mode.low > input.mode.high || count < 2 || count > 10) {
      usageError('invalid-scale', '--scale must be an integer range like 1-5 with at most 10 levels');
    }
  }
}

function usage(usageValue: DecisionUsage | undefined): DecisionAskResult['usage'] {
  if (!usageValue) return null;
  return { inputTokens: usageValue.inputTokens, outputTokens: usageValue.outputTokens };
}

function fallback(reason: string, latencyMs: number, attempt?: Pick<AdapterObservation, 'actualModel' | 'usage'>): DecisionAskResult {
  return {
    schema: 'aiwg-decision-ask/v1',
    status: 'fallback',
    answer: null,
    confidence: null,
    fallback: 'llm',
    reason,
    model: attempt?.actualModel ?? null,
    usage: usage(attempt?.usage),
    latencyMs,
  };
}

/** A choice is `id` or `id=description`; the description tells Jev what the option means. */
function parseChoice(entry: string): { id: string; description?: string } {
  const separator = entry.indexOf('=');
  if (separator < 0) return { id: entry.trim() };
  return { id: entry.slice(0, separator).trim(), description: entry.slice(separator + 1).trim() };
}

function scaleLevel(value: number, low: number, high: number): string {
  const edge = value === low ? ' (lowest)' : value === high ? ' (highest)' : '';
  return `Level ${value} on a ${low} to ${high} scale${edge}.`;
}

function answerKind(mode: AskMode): DecisionAnswer {
  if (mode.kind === 'yes-no') return {
    kind: 'truth-probability',
    trueDescription: 'Yes.',
    falseDescription: 'No.',
  };
  if (mode.kind === 'choices') return {
    kind: 'choice',
    options: mode.choices.map(parseChoice).map(({ id, description }) => ({ id, description: description ?? id })),
  };
  return {
    kind: 'ordinal-score',
    levels: Array.from({ length: mode.high - mode.low + 1 }, (_, index) => scaleLevel(mode.low + index, mode.low, mode.high)),
  };
}

function definition(input: DecisionAskInput): DecisionDefinition {
  return {
    apiVersion: 'decision.aiwg.io/v1alpha2',
    kind: 'DecisionDefinition',
    metadata: { id: 'aiwg.ask.answer', version: '1.0.0', description: 'Bounded advisory ask decision' },
    spec: {
      purpose: PURPOSE,
      inputSchema: INPUT_SCHEMA,
      question: input.question,
      answer: answerKind(input.mode),
      requiredCapabilities: [input.mode.kind === 'yes-no' ? 'truth-probability' : input.mode.kind === 'choices' ? 'choice' : 'ordinal-score'],
    },
  };
}

function ruleset(definitionValue: DecisionDefinition): DecisionRuleset {
  return {
    apiVersion: 'decision.aiwg.io/v1alpha2',
    kind: 'DecisionRuleset',
    metadata: { id: 'aiwg.ask.ruleset', version: '1.0.0', description: 'Bounded advisory ask ruleset' },
    spec: {
      purpose: PURPOSE,
      inputSchema: INPUT_SCHEMA,
      evaluations: [{ alias: 'answer', decision: artifactPin(definitionValue), inputPointer: '' }],
      rules: [{
        id: 'answered',
        priority: 1,
        when: { op: 'exists', left: { source: 'decision', alias: 'answer', pointer: '/value' } },
        outcome: 'answered',
      }],
      composition: 'first-match',
      conflict: 'review',
      defaultOutcome: 'fallback',
      failureOutcome: 'fallback',
      outputSchema: { enum: ['answered', 'fallback'] },
    },
  };
}

function binding(rulesetValue: DecisionRuleset, primitive: DecisionAnswer['kind'], timeoutMs: number): DecisionBinding {
  const target: ExecutionTarget = {
    adapter: 'jev',
    adapterVersion: '1.0.0',
    model: MODEL,
    requiredCapabilities: [primitive],
    acceptance: { mode: 'typed-value' },
    timeoutMs,
    retry: { maxRetries: 0, initialDelayMs: 250, maxDelayMs: 2_000 },
    credentialRef: JEV_CREDENTIAL_REF,
  };
  return {
    apiVersion: 'decision.aiwg.io/v1alpha2',
    kind: 'DecisionBinding',
    metadata: { id: 'aiwg.ask.binding', version: '1.0.0', description: 'Bounded advisory ask Jev binding' },
    spec: {
      ruleset: artifactPin(rulesetValue),
      totalTimeoutMs: timeoutMs,
      maxAttempts: 1,
      concurrency: 1,
      evaluations: { answer: { targets: [target], fallbackOn: [] } },
    },
  };
}

function projectionPolicy(region: string, endpoint: string | undefined): DecisionProjectionPolicy {
  const origin = new URL(endpoint ?? JEV_ENDPOINT).origin;
  return {
    version: '1.0.0',
    provider: 'jev',
    model: MODEL,
    origin,
    region,
    purpose: PURPOSE,
    allowIncompleteContext: false,
    fields: [{
      pointer: '/message',
      output: 'message',
      source: 'operator',
      subject: 'aiwg-decision-ask',
      trust: 'untrusted',
      sensitivity: 'internal',
      purpose: PURPOSE,
      retentionClass: 'ephemeral',
      accessScopes: ['decision-runtime'],
      exportPolicy: 'sanitized',
      deletionPolicy: 'erase',
      backupPolicy: 'not-persisted',
      allowedProviders: ['jev'],
      allowedModels: [MODEL],
      allowedOrigins: [origin],
      allowedRegions: [region],
    }],
  };
}

function contextMessage(input: DecisionAskInput): string {
  return input.context === undefined || input.context === ''
    ? input.question
    : `${input.question}\n\nContext:\n${input.context}`;
}

function confidenceFor(mode: AskMode, evaluation: NonNullable<RulesetResult['spec']['evaluations']['answer']>): number | null {
  const uncertainty = evaluation.spec.uncertainty;
  const value = evaluation.spec.value;
  if (mode.kind === 'yes-no' && typeof value === 'number') return Math.max(value, 1 - value);
  if (uncertainty?.distribution && mode.kind === 'choices' && typeof value === 'string') return uncertainty.distribution[value] ?? uncertainty.confidence;
  if (uncertainty?.distribution && mode.kind === 'scale') return Math.max(...Object.values(uncertainty.distribution));
  return uncertainty?.confidence ?? null;
}

function mostLikelyIndex(distribution: Record<string, number> | null | undefined): number | null {
  if (!distribution) return null;
  let best: number | null = null;
  for (const [index, probability] of Object.entries(distribution)) {
    if (best === null || probability > (distribution[String(best)] ?? -1)) best = Number(index);
  }
  return best;
}

function publicAnswer(mode: AskMode, value: string | number | undefined, distribution?: Record<string, number> | null): { answer: string | boolean | number | null; probability?: number } {
  if (mode.kind === 'yes-no') {
    const probability = typeof value === 'number' ? value : null;
    return probability === null ? { answer: null } : { answer: probability >= 0.5, probability };
  }
  if (mode.kind === 'scale') {
    // Jev returns the distribution-weighted mean index; report the most likely level instead.
    const index = mostLikelyIndex(distribution) ?? (typeof value === 'number' ? Math.round(value) : null);
    return index === null ? { answer: null } : { answer: mode.low + index };
  }
  return typeof value === 'string' ? { answer: value } : { answer: null };
}

/** Product default: 5 passes, escalating to 10 when the first round is not decisive. */
export const DEFAULT_DECISION_PASSES = 5;
/** Escalation defaults to twice the initial pass count (5 -> 10, 10 -> 20). */
export function defaultEscalationPasses(passes: number): number {
  return passes * 2;
}

export async function askDecision(input: DecisionAskInput, options: DecisionAskRuntimeOptions = {}): Promise<DecisionAskResult> {
  if (options.cwd) {
    let config;
    try { config = await readAiwgConfigCandidate(options.cwd); }
    catch (error) { usageError('invalid-config', error instanceof Error ? error.message : 'Invalid project config'); }
    input = { ...input, passes: input.passes ?? config?.decision?.ask?.passes,
      escalationPasses: input.escalationPasses ?? config?.decision?.ask?.escalation_passes,
      minAgreement: input.minAgreement ?? config?.decision?.ask?.min_agreement,
      agreementConfidenceFloor: input.agreementConfidenceFloor ?? config?.decision?.ask?.agreement_confidence_floor };
  }
  validateDecisionAskInput(input);
  const started = options.now?.() ?? Date.now();
  const wallStarted = Date.now();
  const passesRequested = input.passes ?? DEFAULT_DECISION_PASSES;
  const escalationPasses = input.escalationPasses ?? defaultEscalationPasses(passesRequested);
  const threshold = input.threshold ?? 0.8;
  const minAgreement = input.minAgreement;
  const agreementConfidenceFloor = input.agreementConfidenceFloor ?? 0.55;
  const timeoutMs = input.timeoutMs ?? 15_000;
  const passes: DecisionAskPass[] = [];
  let escalated = false;
  let earlyStop: DecisionAskAggregate['earlyStop'] = null;
  const labels = input.mode.kind === 'yes-no' ? ['false', 'true']
    : input.mode.kind === 'choices' ? input.mode.choices.map(parseChoice).map(choice => choice.id)
      : Array.from({ length: input.mode.high - input.mode.low + 1 }, (_, index) => String(input.mode.kind === 'scale' ? input.mode.low + index : index));
  const aggregate = (): DecisionAskAggregate => {
    const successful = passes.filter(pass => pass.status === 'succeeded');
    const modal = aggregateModalAnswers(labels, successful.map(pass => String(pass.answer)));
    const confidences = successful.flatMap(pass => pass.confidence === null ? [] : [pass.confidence]);
    return {
      algorithm: 'majority-v1', semantics: 'stability-signal-not-correctness',
      passesRequested, escalationPasses, passesRun: passes.length, escalated, earlyStop,
      minAgreement: minAgreement ?? null, agreementConfidenceFloor,
      // Failed/abstaining passes have no vote but remain in the denominator.
      agreementRatio: passes.length ? Math.max(0, ...Object.values(modal.votes)) / passes.length : 0,
      votes: modal.votes,
      answer: modal.value === null ? null : input.mode.kind === 'yes-no' ? modal.value === 'true'
        : input.mode.kind === 'scale' ? Number(modal.value) : modal.value,
      confidenceSummary: { count: confidences.length, missing: passes.length - confidences.length,
        mean: confidences.length ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length : null,
        min: confidences.length ? Math.min(...confidences) : null, max: confidences.length ? Math.max(...confidences) : null },
      passes: [...passes],
    };
  };
  // Sampling agreement is stability evidence, not calibrated correctness.
  // Confidence acceptance retains the original requirement that every pass succeeds.
  const answeredBy = (summary: DecisionAskAggregate): DecisionAskResult['answeredBy'] => {
    const successful = passes.filter(pass => pass.status === 'succeeded');
    if (successful.length < passesRequested || summary.answer === null) return null;
    const mean = summary.confidenceSummary.mean;
    if (successful.length === passes.length && !summary.confidenceSummary.missing
      && summary.agreementRatio >= threshold && mean !== null && mean >= threshold) return 'confidence';
    if (minAgreement !== undefined && summary.agreementRatio >= minAgreement
      && summary.confidenceSummary.count === successful.length && mean !== null
      && mean + Number.EPSILON >= agreementConfidenceFloor) return 'agreement';
    return null;
  };
  const problem = (summary: DecisionAskAggregate): string | null => {
    if (answeredBy(summary)) return null;
    const failed = passes.find(pass => pass.status !== 'succeeded');
    if (failed) return failed.reason;
    if (summary.agreementRatio < threshold) return 'low-agreement';
    return 'low-confidence';
  };
  const finish = (forcedReason?: string): DecisionAskResult => {
    const summary = aggregate();
    const reason = forcedReason ?? problem(summary);
    const latencyMs = Math.max(0, (options.now?.() ?? Date.now()) - started);
    const model = passes.map(pass => pass.model).filter(model => model !== null).at(-1) ?? null;
    const totalTokens = (key: 'inputTokens' | 'outputTokens') => {
      const values = passes.flatMap(pass => pass.usage?.[key] == null ? [] : [pass.usage[key]!]);
      return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
    };
    const combinedUsage = passes.some(pass => pass.usage !== null)
      ? { inputTokens: totalTokens('inputTokens'), outputTokens: totalTokens('outputTokens') } : null;
    const result = reason ? fallback(reason, latencyMs) : {
      schema: 'aiwg-decision-ask/v1' as const, status: 'answered' as const, answer: summary.answer,
      confidence: summary.agreementRatio * summary.confidenceSummary.mean!, fallback: null, reason: 'none',
      model, usage: combinedUsage, latencyMs,
      ...(input.mode.kind === 'yes-no' ? { probability: passes.reduce((sum, pass) => sum + (pass.probability ?? 0), 0)
        / passes.filter(pass => pass.status === 'succeeded').length } : {}),
    };
    return { ...result, model, usage: combinedUsage, aggregate: summary, answeredBy: reason ? null : answeredBy(summary) };
  };
  let credential: Awaited<ReturnType<typeof lookupJevCredential>>;
  try { credential = await lookupJevCredential(options); }
  catch { return finish('not-configured'); }
  if (!credential?.enabled || !credential.token) return finish('not-configured');
  const def = definition(input);
  const rules = ruleset(def);
  const adapter = options.adapter ?? options.createAdapter?.({ region: credential.region, endpoint: credential.endpoint })
    ?? new JevDecisionAdapter({ region: credential.region, ...(credential.endpoint ? {
      endpoint: credential.endpoint, allowedOrigins: [new URL(credential.endpoint).origin],
    } : {}) });
  const controller = new AbortController();
  const remainingMs = () => timeoutMs - (Date.now() - wallStarted);
  const timer = setTimeout(() => controller.abort(), Math.max(0, remainingMs()));
  const invocationId = options.invocationId ?? `ask-${Date.now()}`;
  const runPass = async (index: number): Promise<DecisionAskPass> => {
    const passStarted = Date.now();
    let removeListener = () => {};
    const interrupted = new Promise<never>((_resolve, reject) => {
      const abort = () => reject(new Error('ask deadline'));
      if (controller.signal.aborted) abort();
      else { controller.signal.addEventListener('abort', abort, { once: true });
        removeListener = () => controller.signal.removeEventListener('abort', abort); }
    });
    try {
      const result = await Promise.race([interrupted, (options.evaluate ?? evaluateDecisionRuleset)({
        ruleset: rules, binding: binding(rules, def.spec.answer.kind, Math.max(1, remainingMs())),
        definitions: { [def.metadata.id]: def }, input: { message: contextMessage(input) },
        runId: options.runId ?? 'aiwg-decision-ask', invocationId: `${invocationId}-pass-${index}`,
        signal: controller.signal, adapters: { jev: adapter },
        resolveCredential: options.resolveCredential ?? (() => Promise.resolve(new TextEncoder().encode(credential.token))),
        projection: { resolve: () => projectionPolicy(credential.region, credential.endpoint) },
      })]);
      const evaluation = result.spec.evaluations.answer;
      const attempt = evaluation?.spec.attempts.at(-1);
      const succeeded = evaluation?.spec.status === 'success';
      return { index, status: succeeded ? 'succeeded' : evaluation?.spec.status === 'abstained' ? 'abstained' : 'failed',
        reason: succeeded ? 'none' : evaluation?.spec.reason ?? result.spec.reason,
        ...(succeeded ? publicAnswer(input.mode, evaluation.spec.value, evaluation.spec.uncertainty?.distribution) : { answer: null }),
        confidence: succeeded ? confidenceFor(input.mode, evaluation) : null,
        model: attempt?.actualModel ?? null, usage: usage(attempt?.usage), latencyMs: Date.now() - passStarted };
    } catch {
      return { index, status: 'failed', reason: controller.signal.aborted ? 'timeout' : 'jev-error', answer: null,
        confidence: null, model: null, usage: null, latencyMs: Date.now() - passStarted };
    } finally { removeListener(); }
  };
  const certainFailure = (total: number): boolean => {
    const summary = aggregate();
    const remaining = total - passes.length;
    const bestVotes = Math.max(0, ...Object.values(summary.votes));
    const successful = passes.filter(pass => pass.status === 'succeeded');
    const confidenceSum = successful.reduce((sum, pass) => sum + (pass.confidence ?? 0), 0);
    // Give every unspent pass a matching vote and perfect confidence. Stop only
    // when even that best case cannot answer, allowing roundoff at the boundary.
    const bestAgreement = (bestVotes + remaining) / total;
    const knownConfidence = successful.every(pass => pass.confidence !== null);
    const confidenceReachable = successful.length === passes.length && knownConfidence
      && bestAgreement + 1e-12 >= threshold && (confidenceSum + remaining) / total + 1e-12 >= threshold;
    const agreementReachable = minAgreement !== undefined && knownConfidence
      && successful.length + remaining >= passesRequested
      && bestAgreement + 1e-12 >= minAgreement
      && (confidenceSum + remaining) / (successful.length + remaining) + 1e-12 >= agreementConfidenceFloor;
    return !confidenceReachable && !agreementReachable;
  };
  try {
    let target = passesRequested;
    while (passes.length < target) {
      if (controller.signal.aborted || remainingMs() <= 0) { earlyStop = 'timeout'; return finish('timeout'); }
      const offset = passes.length;
      if (offset >= passesRequested) escalated = true;
      passes.push(...await Promise.all(Array.from({ length: Math.min(4, target - offset) }, (_, index) => runPass(offset + index))));
      if (controller.signal.aborted || remainingMs() <= 0) { earlyStop = 'timeout'; return finish('timeout'); }
      if (passes.length >= passesRequested && problem(aggregate()) && escalationPasses > passesRequested) {
        target = escalationPasses;
      }
      if (passes.length < target && (passes.length >= passesRequested || certainFailure(passesRequested)) && certainFailure(escalationPasses)) {
        earlyStop = 'certain-failure';
        return finish();
      }
    }
    return finish();
  } finally { clearTimeout(timer); }
}

export async function readDecisionContextFile(filePath: string): Promise<string> {
  const content = await readFile(filePath, 'utf8');
  if (byteLength(content) > CONTEXT_LIMIT_BYTES) usageError('context-too-large', 'decision ask context exceeds 32 KiB');
  return content;
}

export async function setupJev(input: DecisionSetupInput = {}, options: DecisionAskRuntimeOptions = {}): Promise<DecisionSetupResult> {
  const region = input.region?.trim() || JEV_DEFAULT_REGION;
  if (input.remove) {
    await removeJevCredentialFile(options);
    return {
      schema: 'aiwg-decision-jev-setup/v1',
      configured: false,
      credentialSource: 'file',
      region,
      next: ['Run aiwg decision setup jev --token-stdin to configure Jev again.'],
    };
  }
  const environment = options.env ?? process.env;
  const envToken = environment.JEV_API_KEY?.trim() || environment.AIWG_DECISION_JEV_API_KEY?.trim();
  const token = input.token?.trim() || envToken;
  if (!token) usageError('token-required', 'Provide --token-stdin or set JEV_API_KEY or AIWG_DECISION_JEV_API_KEY.');
  await writeJevCredentialFile({
    token,
    region,
    ...(input.endpoint?.trim() ? { endpoint: input.endpoint.trim() } : {}),
    enabled: true,
  }, options);
  const result: DecisionSetupResult = {
    schema: 'aiwg-decision-jev-setup/v1',
    configured: true,
    credentialSource: input.token?.trim() ? 'file' : 'env',
    region,
    next: ['Run aiwg decision ask --question "<q>" --yes-no --json.'],
  };
  if (input.verify) {
    // Verify the credential just saved, even when the shell still names an
    // older token. Ordinary ask calls retain their environment precedence.
    const verificationEnv = { ...environment };
    delete verificationEnv.JEV_API_KEY;
    delete verificationEnv.AIWG_DECISION_JEV_API_KEY;
    const verified = await askDecision({
      question: 'Is this Jev decision setup verification request well formed?',
      mode: { kind: 'yes-no' },
      threshold: 0,
      timeoutMs: 15_000,
      passes: 1,
      escalationPasses: 1,
    }, { ...options, env: verificationEnv });
    result.verified = verified.status === 'answered';
    result.model = verified.model;
    result.usage = verified.usage;
  }
  return result;
}
