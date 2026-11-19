import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DecisionAskInput, DecisionAskResult } from '../../../src/decision/ask.js';
import { DecisionAskUsageError } from '../../../src/decision/ask.js';
import {
  appendDecisionOpportunity,
  buildDecisionOffloadSnapshot,
  DECISION_OPPORTUNITY_SCHEMA,
  runDecisionOffloadCheckpoint,
  type DecisionOpportunityRecord,
} from '../../../src/decision/offload.js';
import { writeJevCredentialFile } from '../../../src/decision/jev-credentials.js';
import { DECISION_COMPACT_ANCHOR } from '../../../src/decision/offload-activation.js';

const input: DecisionAskInput = { question: 'Proceed?', mode: { kind: 'yes-no' } };
const answered: DecisionAskResult = {
  schema: 'aiwg-decision-ask/v1', status: 'answered', answer: true, confidence: 0.94,
  probability: 0.94, fallback: null, reason: 'none', model: 'jev-test',
  usage: { inputTokens: 4, outputTokens: 1 }, latencyMs: 2,
};
const fallback: DecisionAskResult = {
  schema: 'aiwg-decision-ask/v1', status: 'fallback', answer: null, confidence: null,
  fallback: 'llm', reason: 'low-confidence', model: 'jev-test',
  usage: { inputTokens: 3, outputTokens: 1 }, latencyMs: 2,
};

const roots: string[] = [];
const execFileAsync = promisify(execFile);
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function root(prefix = 'aiwg-offload-') {
  const value = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(value);
  return value;
}

function options(projectRoot: string, overrides: Record<string, unknown> = {}) {
  return {
    transport: 'cli' as const,
    projectRoot,
    caller: 'address-issues:worker-pick',
    explicitSessionId: 'session-1',
    env: {},
    now: () => Date.UTC(2026, 9, 20, 12, 0, 0),
    id: () => 'correlation-1',
    resolveProvider: async () => ({ provider: 'codex', source: 'explicit' as const, candidates: ['codex'], reason: 'test' }),
    ...overrides,
  };
}

async function configureAsk(projectRoot: string, enabled = true) {
  const configHome = path.join(projectRoot, 'config-home');
  await writeJevCredentialFile({ token: 'fixture-token', region: 'us', enabled }, { configHome, env: {} });
  return { XDG_CONFIG_HOME: configHome };
}

async function isolatedEnv(projectRoot: string, extra: NodeJS.ProcessEnv = {}) {
  const configHome = path.join(projectRoot, 'empty-config-home');
  await mkdir(configHome, { recursive: true, mode: 0o700 });
  return { XDG_CONFIG_HOME: configHome, ...extra };
}

function opportunity(overrides: Partial<DecisionOpportunityRecord> = {}): DecisionOpportunityRecord {
  return {
    schema: DECISION_OPPORTUNITY_SCHEMA,
    correlationId: 'opportunity-1',
    timestamp: '2026-10-20T12:00:00.000Z',
    phase: 'completed',
    provider: 'codex',
    sessionId: 'session-1',
    sessionSource: '--session',
    transport: 'cli',
    caller: 'address-issues:worker-pick',
    category: 'organic',
    eligible: true,
    attempted: false,
    outcome: 'skipped',
    reason: 'disabled',
    ledgerRecorded: null,
    ...overrides,
  };
}

describe('decision offload checkpoint', () => {
  it('persists an attempted event before invoking the backend and correlates completion with the ledger', async () => {
    const projectRoot = await root();
    const events: DecisionOpportunityRecord[] = [];
    const recorded = vi.fn(async () => ({ id: 'correlation-1' } as never));
    const ask = vi.fn(async () => {
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ phase: 'started', attempted: true, outcome: 'unknown', reason: 'attempt-started' });
      return answered;
    });
    const result = await runDecisionOffloadCheckpoint(input, options(projectRoot, {
      ask, recordAsk: recorded,
      appendOpportunity: async (event: DecisionOpportunityRecord) => { events.push(event); return true; },
    }));
    expect(result).toMatchObject({ outcome: 'answered', attemptRecorded: true, opportunityRecorded: true });
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ phase: 'completed', correlationId: 'correlation-1', outcome: 'answered', ledgerRecorded: true });
    expect(recorded).toHaveBeenCalledWith(input, answered, expect.objectContaining({ caller: 'address-issues:worker-pick' }));
  });

  it('records explicit exclusions without calling the backend', async () => {
    const projectRoot = await root();
    const ask = vi.fn();
    const events: DecisionOpportunityRecord[] = [];
    const result = await runDecisionOffloadCheckpoint(input, options(projectRoot, {
      ask, eligibility: { eligible: false, reason: 'privacy-excluded' },
      appendOpportunity: async (event: DecisionOpportunityRecord) => { events.push(event); return true; },
    }));
    expect(result).toMatchObject({ outcome: 'skipped', opportunity: { phase: 'skipped', reason: 'privacy-excluded', attempted: false } });
    expect(ask).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
  });

  it('uses one warning channel across ledger and opportunity recording failures', async () => {
    const projectRoot = await root();
    const warnings: string[] = [];
    await runDecisionOffloadCheckpoint(input, options(projectRoot, {
      ask: async () => fallback,
      recordAsk: async (_input: unknown, _result: unknown, recordOptions: { warn?: (message: string) => void }) => {
        recordOptions.warn?.('ledger failed'); return null;
      },
      appendOpportunity: async (_event: DecisionOpportunityRecord, _root: string, warn: (message: string) => void) => {
        warn('opportunity failed'); return false;
      },
      warn: (message: string) => warnings.push(message),
    }));
    expect(warnings).toEqual(['ledger failed']);
  });

  it('bounds stalled provider attribution and journal writers without suppressing an answer', async () => {
    const projectRoot = await root();
    const ask = vi.fn(async () => answered);
    const never = new Promise<never>(() => undefined);
    const result = await runDecisionOffloadCheckpoint(input, options(projectRoot, {
      ask,
      resolveProvider: async () => never,
      appendOpportunity: async () => never,
      providerTimeoutMs: 5,
      opportunityTimeoutMs: 5,
      recordAsk: async () => { throw new Error('fixture ledger failure'); },
      warn: () => undefined,
    }));
    expect(ask).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ outcome: 'answered', result: answered, attemptRecorded: null, opportunityRecorded: null,
      opportunity: { provider: 'unknown', ledgerRecorded: null } });
  });

  it('keeps deadline timers alive in a standalone process with no Vitest handles', async () => {
    const projectRoot = await root();
    const moduleUrl = pathToFileURL(path.resolve('src/decision/offload.ts')).href;
    const script = `
      import { runDecisionOffloadCheckpoint } from ${JSON.stringify(moduleUrl)};
      const answer = { schema:'aiwg-decision-ask/v1', status:'answered', answer:true, confidence:0.9,
        fallback:null, reason:'none', model:'fixture', usage:null, latencyMs:1 };
      const base = { transport:'cli', projectRoot:${JSON.stringify(projectRoot)}, caller:'control:liveness',
        explicitSessionId:'child', env:{}, ask:async()=>answer, recordAsk:async()=>null, warn:()=>{} };
      const stalled = async () => new Promise(() => {});
      const attribution = await runDecisionOffloadCheckpoint({ question:'q', mode:{kind:'yes-no'} },
        { ...base, resolveProvider:stalled, providerTimeoutMs:25, appendOpportunity:async()=>true });
      const journal = await runDecisionOffloadCheckpoint({ question:'q', mode:{kind:'yes-no'} },
        { ...base, resolveProvider:async()=>({provider:'codex',source:'explicit',candidates:['codex'],reason:'fixture'}),
          providerTimeoutMs:25, appendOpportunity:stalled, opportunityTimeoutMs:25 });
      process.stdout.write(JSON.stringify({ attribution:attribution.outcome, provider:attribution.opportunity.provider,
        journal:journal.outcome, attemptRecorded:journal.attemptRecorded, opportunityRecorded:journal.opportunityRecorded }));
    `;
    const { stdout } = await execFileAsync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: process.cwd(), timeout: 5_000,
    });
    expect(JSON.parse(stdout)).toEqual({ attribution: 'answered', provider: 'unknown', journal: 'answered',
      attemptRecorded: null, opportunityRecorded: null });
  });

  it('keeps a completed answer when injected recording callbacks reject', async () => {
    const projectRoot = await root();
    const events: DecisionOpportunityRecord[] = [];
    const result = await runDecisionOffloadCheckpoint(input, options(projectRoot, {
      ask: async () => answered,
      recordAsk: async () => { throw new Error('ledger unavailable'); },
      appendOpportunity: async (event: DecisionOpportunityRecord) => {
        events.push(event);
        if (event.phase === 'completed') throw new Error('journal unavailable');
        return true;
      },
      warn: () => undefined,
    }));
    expect(result).toMatchObject({ outcome: 'answered', result: answered, attemptRecorded: true, opportunityRecorded: false,
      opportunity: { ledgerRecorded: null } });
    expect(events.map(event => event.phase)).toEqual(['started', 'completed']);
  });

  it('treats an unavailable external artifact root as a best-effort recording failure', async () => {
    const projectRoot = await root();
    await writeFile(path.join(projectRoot, '.aiwg-location'), `../${path.basename(projectRoot)}-unavailable/.aiwg\n`);
    const result = await runDecisionOffloadCheckpoint(input, options(projectRoot, {
      ask: async () => answered,
      recordAsk: async () => null,
      warn: () => undefined,
    }));
    expect(result).toMatchObject({ outcome: 'answered', attemptRecorded: false, opportunityRecorded: false });
  });

  it('records usage rejection separately from an attempted execution failure', async () => {
    const projectRoot = await root();
    const events: DecisionOpportunityRecord[] = [];
    const appendOpportunity = async (event: DecisionOpportunityRecord) => { events.push(event); return true; };
    await expect(runDecisionOffloadCheckpoint(input, options(projectRoot, {
      ask: async () => { throw new DecisionAskUsageError('invalid-input', 'fixture rejection'); }, appendOpportunity,
    }))).rejects.toThrow('fixture rejection');
    expect(events.at(-1)).toMatchObject({ phase: 'completed', outcome: 'skipped', attempted: false, reason: 'usage-rejected' });
    events.length = 0;
    const failed = await runDecisionOffloadCheckpoint(input, options(projectRoot, {
      ask: async () => { throw new Error('transport crashed'); }, appendOpportunity,
    }));
    expect(failed).toMatchObject({ outcome: 'unknown', opportunity: { attempted: true, reason: 'execution-unknown' } });
  });

  it('writes strict, private append-only opportunity events', async () => {
    const projectRoot = await root();
    expect(await appendDecisionOpportunity(opportunity(), projectRoot)).toBe(true);
    const file = path.join(projectRoot, '.aiwg', 'decision', 'opportunities.jsonl');
    const parsed = JSON.parse((await readFile(file, 'utf8')).trim());
    expect(parsed).toMatchObject({ phase: 'completed', correlationId: 'opportunity-1' });
    expect(parsed).not.toHaveProperty('projectRoot');
  });
});

describe('decision offload snapshot', () => {
  // Snapshot fixtures require completed persistence, not the production deadline
  // race. Freeze only deadlines so real filesystem I/O can finish under CI load.
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
  afterEach(() => { vi.useRealTimers(); });

  it('awaits diagnostic persistence independently of the recording deadline and real clock', async () => {
    const projectRoot = await root();
    const env = await configureAsk(projectRoot);
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2030, 0, 1));
    // A zero deadline deterministically models I/O losing the recording race.
    const checkpoint = await runDecisionOffloadCheckpoint(input, options(projectRoot, {
      env, caller: 'diagnosis:connectivity', ask: async () => answered,
      timeoutMs: 0, opportunityTimeoutMs: 0,
    }));
    expect(checkpoint.opportunity.ledgerRecorded).toBe(true);
    const snapshot = await buildDecisionOffloadSnapshot({
      projectRoot, env, windowHours: 1, now: new Date('2026-10-20T12:01:00.000Z'),
    });
    expect(snapshot.calls).toMatchObject({ organic: { completed: 0 }, excluded: { completed: 1 } });
    expect(snapshot.opportunities).toMatchObject({ organic: { observed: 0 }, excluded: { observed: 1 } });
    expect(snapshot.correlation).toMatchObject({ matched: 1, attemptedWithoutLedger: 0 });
    expect(checkpoint.opportunity.timestamp).toBe('2026-10-20T12:00:00.000Z');
  });

  it('correlates a real checkpoint opportunity with its completed-call ledger record', async () => {
    const projectRoot = await root();
    const env = await configureAsk(projectRoot);
    await runDecisionOffloadCheckpoint(input, options(projectRoot, { env, ask: async () => answered }));
    const snapshot = await buildDecisionOffloadSnapshot({ projectRoot, sessionId: 'session-1', env, now: new Date('2026-10-20T12:01:00.000Z') });
    expect(snapshot.opportunities).toMatchObject({ journalEvents: 2, organic: { observed: 1, attempted: 1, answered: 1 } });
    expect(snapshot.calls.organic).toMatchObject({ completed: 1, answered: 1, fallback: 0 });
    expect(snapshot.correlation).toEqual({ matched: 1, attemptedWithoutLedger: 0, organicAttemptedWithoutLedger: 0, ledgerWithoutOpportunity: 0 });
    expect(snapshot.drift.status).toBe('advisory');
    expect(snapshot.drift.reasons).toContain('missing-activation-anchor');
    await writeFile(path.join(projectRoot, '.aiwg', 'aiwg.config'), JSON.stringify({
      installed: { 'decision-engine': { version: '1', source: 'bundled', deployedTo: {} } },
    }));
    await writeFile(path.join(projectRoot, 'AIWG.md'), `## Compact Instructions\n\n${DECISION_COMPACT_ANCHOR}\n`);
    const anchored = await buildDecisionOffloadSnapshot({ projectRoot, sessionId: 'session-1', env,
      now: new Date('2026-10-20T12:01:00.000Z') });
    expect(anchored.activation).toMatchObject({ addon: 'installed', startupAnchor: 'present',
      ruleDelivery: 'unknown', nativeActivation: 'not-claimed' });
    expect(anchored.drift.status).toBe('ok');
  });

  it('reports an observed organic opportunity with zero attempts as advisory, never healthy', async () => {
    const projectRoot = await root();
    await appendDecisionOpportunity(opportunity(), projectRoot);
    const snapshot = await buildDecisionOffloadSnapshot({
      projectRoot, sessionId: 'session-1', now: new Date('2026-10-20T12:01:00.000Z'), env: await isolatedEnv(projectRoot),
    });
    expect(snapshot.opportunities.organic).toMatchObject({ observed: 1, eligible: 1, attempted: 0 });
    expect(snapshot.drift).toMatchObject({ status: 'advisory', reasons: expect.arrayContaining(['observed-eligible-zero-attempts']) });
    expect(snapshot.readiness.ask.state).toBe('disabled');
  });

  it('collapses started/completed journal events by correlation id and shows diagnostics separately', async () => {
    const projectRoot = await root();
    await appendDecisionOpportunity(opportunity({ phase: 'started', attempted: true, outcome: 'unknown', reason: 'attempt-started' }), projectRoot);
    await appendDecisionOpportunity(opportunity({ attempted: false, outcome: 'fallback', reason: 'not-configured', ledgerRecorded: true }), projectRoot);
    await appendDecisionOpportunity(opportunity({ correlationId: 'control-1', caller: 'control:readiness', category: 'diagnostic', outcome: 'answered', attempted: true, reason: 'none', ledgerRecorded: true }), projectRoot);
    const snapshot = await buildDecisionOffloadSnapshot({ projectRoot, sessionId: 'session-1', now: new Date('2026-10-20T12:01:00.000Z'), env: await isolatedEnv(projectRoot) });
    expect(snapshot.opportunities).toMatchObject({ journalEvents: 3, organic: { observed: 1, fallback: 1 }, excluded: { observed: 1, answered: 1 } });
    expect(snapshot.readiness.observed).toMatchObject({ category: 'diagnostic', outcome: 'answered' });
    expect(snapshot.readiness.ask.state).toBe('disabled');
  });

  it('uses saved ask opt-in independently from evaluate enablement and never performs a probe', async () => {
    const projectRoot = await root();
    const env = await configureAsk(projectRoot);
    const snapshot = await buildDecisionOffloadSnapshot({ projectRoot, env, now: new Date('2026-10-20T12:01:00.000Z') });
    expect(snapshot.readiness.ask).toMatchObject({ state: 'configured-unprobed', configured: true, enabled: true, source: 'file', probed: false });
    expect(snapshot.readiness.evaluate).toMatchObject({ state: 'disabled', enabled: false, probed: false });
    expect(snapshot.drift.status).toBe('not-applicable');
  });

  it('uses a configured diagnostic call as transport evidence without counting it as organic adoption', async () => {
    const projectRoot = await root();
    const env = await configureAsk(projectRoot);
    await appendDecisionOpportunity(opportunity({ caller: 'diagnosis:connectivity', category: 'diagnostic', attempted: true,
      outcome: 'answered', reason: 'none', ledgerRecorded: true }), projectRoot);
    const snapshot = await buildDecisionOffloadSnapshot({ projectRoot, sessionId: 'session-1', env, now: new Date('2026-10-20T12:01:00.000Z') });
    expect(snapshot.readiness.ask.state).toBe('reachable');
    expect(snapshot.opportunities).toMatchObject({ organic: { observed: 0 }, excluded: { observed: 1, answered: 1 } });
    expect(snapshot.drift.status).toBe('not-applicable');
  });

  it('does not let a historical answer override a currently disabled ask path', async () => {
    const projectRoot = await root();
    await appendDecisionOpportunity(opportunity({ attempted: true, outcome: 'answered', reason: 'none', ledgerRecorded: true }), projectRoot);
    const snapshot = await buildDecisionOffloadSnapshot({ projectRoot, sessionId: 'session-1', env: await isolatedEnv(projectRoot, { AIWG_DECISION_ENABLED: '0' }), now: new Date('2026-10-20T12:01:00.000Z') });
    expect(snapshot.readiness.ask.state).toBe('disabled');
    expect(snapshot.drift.reasons).toContain('disabled-or-unconfigured');
  });

  it('treats malformed configuration and unreadable observation journals as unknown', async () => {
    const projectRoot = await root();
    await mkdir(path.join(projectRoot, '.aiwg', 'decision'), { recursive: true, mode: 0o700 });
    await writeFile(path.join(projectRoot, '.aiwg', 'aiwg.config'), '{bad json');
    const journal = path.join(projectRoot, '.aiwg', 'decision', 'opportunities.jsonl');
    await mkdir(journal);
    const snapshot = await buildDecisionOffloadSnapshot({ projectRoot, env: {}, now: new Date('2026-10-20T12:01:00.000Z') });
    expect(snapshot.readiness).toMatchObject({ ask: { state: 'unknown' }, evaluate: { state: 'unknown' } });
    expect(snapshot.opportunities.journal).toBe('unreadable');
    expect(snapshot.drift.status).toBe('unknown');
  });

  it('marks a started attempt without a completed ledger as unknown drift', async () => {
    const projectRoot = await root();
    await appendDecisionOpportunity(opportunity({ phase: 'started', attempted: true, outcome: 'unknown', reason: 'attempt-started' }), projectRoot);
    const snapshot = await buildDecisionOffloadSnapshot({ projectRoot, sessionId: 'session-1', env: {}, now: new Date('2026-10-20T12:01:00.000Z') });
    expect(snapshot.correlation.attemptedWithoutLedger).toBe(1);
    expect(snapshot.correlation.organicAttemptedWithoutLedger).toBe(1);
    expect(snapshot.drift).toMatchObject({ status: 'unknown', reasons: expect.arrayContaining(['attempted-without-completed-ledger']) });
  });

  it('loads advisory thresholds from project configuration and scopes to the current session', async () => {
    const projectRoot = await root();
    await mkdir(path.join(projectRoot, '.aiwg'), { recursive: true });
    await writeFile(path.join(projectRoot, '.aiwg', 'aiwg.config'), JSON.stringify({ decision: { offload_report: {
      window_hours: 12, minimum_eligible: 2, minimum_attempt_rate: 0.75, repeated_fallbacks: 4,
    } } }));
    await appendDecisionOpportunity(opportunity({ sessionId: 'wanted' }), projectRoot);
    await appendDecisionOpportunity(opportunity({ correlationId: 'other', sessionId: 'other' }), projectRoot);
    const snapshot = await buildDecisionOffloadSnapshot({ projectRoot, env: { AIWG_SESSION_ID: 'wanted' }, now: new Date('2026-10-20T12:01:00.000Z') });
    expect(snapshot.scope).toMatchObject({ mode: 'session', sessionId: 'wanted', windowHours: null });
    expect(snapshot.opportunities.organic.observed).toBe(1);
    expect(snapshot.drift).toMatchObject({ thresholdSource: 'project', thresholds: {
      minimumEligible: 2, minimumAttemptRate: 0.75, repeatedFallbacks: 4,
    } });
  });

  it('does not report a gap when minimum eligible is configured to zero but no eligible work was observed', async () => {
    const projectRoot = await root();
    const snapshot = await buildDecisionOffloadSnapshot({
      projectRoot, env: await isolatedEnv(projectRoot), thresholds: { minimumEligible: 0 },
      now: new Date('2026-10-20T12:01:00.000Z'),
    });
    expect(snapshot.opportunities.organic.eligible).toBe(0);
    expect(snapshot.drift.status).toBe('not-applicable');
    expect(snapshot.drift.reasons).not.toContain('observed-eligible-zero-attempts');
  });

  it('reports the original low-confidence activity hint, excludes diagnostics, and clears it after an organic call', async () => {
    const projectRoot = await root();
    let env = await configureAsk(projectRoot, true);
    await mkdir(path.join(projectRoot, '.aiwg'), { recursive: true, mode: 0o700 });
    await writeFile(path.join(projectRoot, '.aiwg', 'activity.log'),
      '## [2026-10-20 12:00] update | address-issues cycle dispatched worker for review\n');
    const base = { projectRoot, now: new Date('2026-10-20T12:01:00.000Z'), windowHours: 1 };

    let snapshot = await buildDecisionOffloadSnapshot({ ...base, env, activationEvidence: { addon: 'missing' } });
    expect(snapshot.activityHint).toMatchObject({ status: 'none', reason: null, suppressionReason: 'addon-missing' });
    snapshot = await buildDecisionOffloadSnapshot({ ...base, env, activationEvidence: { addon: 'unknown' } });
    expect(snapshot.activityHint).toMatchObject({ status: 'none', reason: null, suppressionReason: 'activation-unknown' });

    env = await configureAsk(projectRoot, false);
    snapshot = await buildDecisionOffloadSnapshot({ ...base, env, activationEvidence: { addon: 'installed' } });
    expect(snapshot.activityHint).toMatchObject({ status: 'none', reason: null, suppressionReason: 'ask-disabled-or-unconfigured' });

    env = await configureAsk(projectRoot, true);
    const snapshotOptions = { ...base, env, activationEvidence: { addon: 'installed' as const } };
    snapshot = await buildDecisionOffloadSnapshot(snapshotOptions);
    expect(snapshot.activityHint).toMatchObject({ status: 'advisory', reason: 'orchestration-without-organic-completed-calls',
      suppressionReason: null, recognizableOrchestrationEvents: 1, eligibleCount: 'unknown', confidence: 'low' });

    await runDecisionOffloadCheckpoint(input, options(projectRoot, { env, id: () => 'diagnostic-1',
      caller: 'diagnosis:connectivity', category: 'diagnostic', ask: async () => answered }));
    snapshot = await buildDecisionOffloadSnapshot(snapshotOptions);
    expect(snapshot.activityHint.status).toBe('advisory');
    expect(snapshot.calls).toMatchObject({ organic: { completed: 0 }, excluded: { completed: 1 } });

    await runDecisionOffloadCheckpoint(input, options(projectRoot, { env, id: () => 'organic-1',
      caller: 'address-issues:worker-pick', ask: async () => answered }));
    snapshot = await buildDecisionOffloadSnapshot(snapshotOptions);
    expect(snapshot.activityHint).toMatchObject({ status: 'none', reason: null });
    expect(snapshot.calls.organic.completed).toBe(1);
  });
});
