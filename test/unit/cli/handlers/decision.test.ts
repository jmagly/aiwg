import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allHandlers } from '../../../../src/cli/handlers/index.js';
import { decisionHandler } from '../../../../src/cli/handlers/decision.js';
import { getCommandDefinition, getCommandIds, searchCommandsByKeyword } from '../../../../src/extensions/commands/definitions.js';
import { listProviderDefinitions } from '../../../../src/providers/provider-definitions.js';
import { appendDecisionLedgerRecord, buildDecisionLedgerRecord, DECISION_SESSION_ENV_VARS } from '../../../../src/decision/ledger.js';

// Review r1 finding 10 / review r2 item 14: isolate every credential, session,
// artifact-root-override and harness-detection environment variable the
// decision CLI could read, and fail loudly if any test attempts a real
// network call (there should never be one here — every `ask` test runs with
// Jev unconfigured). The harness-marker list is derived from every provider
// definition's `detection.env` so no provider can be falsely detected
// regardless of which real host/terminal this suite runs under (a
// hand-curated list previously missed WARP_SESSION_ID/WARP_TERMINAL and
// WINDSURF_VERSION).
function allHarnessMarkerEnvKeys(): string[] {
  return [...new Set(listProviderDefinitions().flatMap(definition => definition.detection.env))];
}

const ISOLATED_ENV_KEYS = [
  'HOME', 'AIWG_HOME', 'AIWG_CONFIG', 'AIWG_SESSION_ID', 'CI', 'AIWG_ROOT',
  'AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR',
  'AIWG_PROVIDER', 'CLAUDECODE_PROVIDER', 'AIWG_TEST_PROCESS_PROVIDER', 'AIWG_DISABLE_PROCESS_PROVIDER_DETECTION',
  'AIWG_DECISION_ENABLED', 'JEV_API_KEY', 'AIWG_DECISION_JEV_API_KEY', 'XDG_CONFIG_HOME',
  ...DECISION_SESSION_ENV_VARS,
  ...allHarnessMarkerEnvKeys(),
] as const;

describe('decisionHandler', () => {
  const cleanup: string[] = [];
  let savedEnv: Record<string, string | undefined> = {};
  let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ISOLATED_ENV_KEYS) { savedEnv[key] = process.env[key]; delete process.env[key]; }
    // Process-tree provider detection walks /proc on the real host; disable it so
    // resolution is driven only by the explicit --provider/env this file sets.
    process.env.AIWG_DISABLE_PROCESS_PROVIDER_DETECTION = '1';
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('decisionHandler test attempted a real network call');
    });
  });

  afterEach(async () => {
    fetchSpy?.mockRestore();
    await Promise.all(cleanup.map(directory => rm(directory, { recursive: true, force: true })));
    cleanup.length = 0;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('is registered with command metadata', () => {
    expect(decisionHandler.id).toBe('decision');
    expect(decisionHandler.category).toBe('utility');
    expect(allHandlers.filter(handler => handler.id === 'decision')).toHaveLength(1);
    expect(getCommandDefinition('decision')).toMatchObject({
      id: 'decision',
      description: expect.stringMatching(/classification/i),
    });
    expect(getCommandIds()).toContain('decision');
    expect(searchCommandsByKeyword('classification').map(command => command.id)).toContain('decision');
  });

  it('rotates with the activity-log flags and reads archives offline through history and stats', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aiwg-decision-retention-cli-'));
    cleanup.push(dir);
    const record = buildDecisionLedgerRecord({ question: 'Proceed?', mode: { kind: 'yes-no' } }, {
      schema: 'aiwg-decision-ask/v1', status: 'fallback', answer: null, confidence: null,
      reason: 'not-configured', fallback: 'llm', model: null, usage: null, latencyMs: 0,
    }, { transport: 'cli', projectRoot: dir, provider: 'codex', sessionId: 'synthetic',
      now: () => Date.UTC(2020, 0, 1) });
    expect(await appendDecisionLedgerRecord(record, { projectRoot: dir })).toBe(true);
    const run = (args: string[]) => decisionHandler.execute({ args, rawArgs: [], cwd: dir, frameworkRoot: process.cwd() });
    const rotated = await run(['rotate', '--to', 'archive/decision/custom.jsonl', '--json']);
    expect(rotated.exitCode).toBe(0);
    expect(JSON.parse(rotated.message!)).toMatchObject({ archived: 1, retained: 0 });
    expect(JSON.parse((await run(['history', '--json'])).message!).count).toBe(0);
    expect(JSON.parse((await run(['history', '--include-archives', '--json'])).message!).count).toBe(1);
    expect(JSON.parse((await run(['stats', '--include-archives', '--json'])).message!).groups[0].totalCalls).toBe(1);
    expect((await run(['stats', '--include-archives'])).message).toContain('1 calls');
    expect((await run(['rotate', '--all'])).exitCode).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('routes retention and archive inclusion through the built CLI offline', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aiwg-decision-built-retention-'));
    cleanup.push(dir);
    const record = buildDecisionLedgerRecord({ question: 'Synthetic?', mode: { kind: 'yes-no' } }, {
      schema: 'aiwg-decision-ask/v1', status: 'fallback', answer: null, confidence: null,
      reason: 'not-configured', fallback: 'llm', model: null, usage: null, latencyMs: 0,
    }, { transport: 'cli', projectRoot: dir, provider: 'unknown', sessionId: 'synthetic' });
    expect(await appendDecisionLedgerRecord(record, { projectRoot: dir })).toBe(true);
    const run = (...args: string[]) => JSON.parse(execFileSync(process.execPath,
      [path.resolve('bin/aiwg.mjs'), 'decision', ...args, '--json'], {
        cwd: dir, encoding: 'utf8', timeout: 60_000,
        env: { PATH: process.env.PATH, HOME: dir, AIWG_CONFIG: path.join(dir, 'aiwg-config.json'),
          AIWG_ARTIFACTS_PATH: path.join(dir, '.aiwg'), AIWG_SKIP_ACTIVITY_LOG: '1',
          AIWG_DISABLE_PROCESS_PROVIDER_DETECTION: '1' },
      }));
    expect(run('rotate', '--all')).toMatchObject({ archived: 1, retained: 0 });
    expect(run('history')).toMatchObject({ count: 0 });
    expect(run('history', '--include-archives')).toMatchObject({ count: 1 });
    expect(run('stats', '--include-archives').groups[0]).toMatchObject({ totalCalls: 1 });
  });

  it.each([
    ['rotate', '--keep-last', '0'], ['rotate', '--keep-last', '0d'],
    ['rotate', '--all', '--keep-last', '90d'], ['rotate', '--keep-last'],
    ['rotate', '--to'], ['rotate', '--unknown'], ['rotate', 'extra'],
  ])('rejects invalid retention arguments: %j', async (...args) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aiwg-decision-retention-usage-'));
    cleanup.push(dir);
    const result = await decisionHandler.execute({ args, rawArgs: [], cwd: dir, frameworkRoot: process.cwd() });
    expect(result.exitCode).toBe(2);
  });

  it('refuses an archive outside the artifact root through the CLI', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aiwg-decision-retention-path-'));
    cleanup.push(dir);
    const result = await decisionHandler.execute({ args: ['rotate', '--all', '--to', path.join(dir, 'escape.jsonl')],
      rawArgs: [], cwd: dir, frameworkRoot: process.cwd() });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('artifact root');
  });

  it('shows separate token and dollar estimates in text and JSON for session and caller groups', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aiwg-decision-cli-'));
    cleanup.push(dir);
    const record = buildDecisionLedgerRecord({ question: 'Proceed?', mode: { kind: 'yes-no' } }, {
      schema: 'aiwg-decision-ask/v1', status: 'answered', answer: true, confidence: 0.95, probability: 0.95,
      reason: 'none', fallback: null, model: 'mock', usage: { inputTokens: 400, outputTokens: 10 }, latencyMs: 1,
    }, { transport: 'cli', projectRoot: dir, provider: 'codex', sessionId: 'sess-42', sessionSource: 'CODEX_THREAD_ID', caller: 'worker' });
    await appendDecisionLedgerRecord(record, { projectRoot: dir });
    const run = (args: string[]) => decisionHandler.execute({ args, rawArgs: [], cwd: dir, frameworkRoot: process.cwd() });
    const text = await run(['stats', '--group-by', 'session']);
    expect(text.exitCode).toBe(0);
    expect(text.message).toContain('session=sess-42');
    expect(text.message).toContain(`llm_tokens_avoided=${record.llm_tokens_avoided} jev_tokens=410 cost_weighted_net_usd=`);
    expect(text.message).toContain('v1 comparison only:');
    expect(text.message).toContain('rates used (1 calls):');
    expect(text.message).toContain('source=manual checked_at=unknown');
    const json = await run(['stats', '--group-by', 'caller', '--json']);
    expect(JSON.parse(json.message!).groups[0]).toMatchObject({ key: 'worker', llm_tokens_avoided: record.llm_tokens_avoided,
      jev_tokens: 410, cost_weighted_net_usd: record.cost_weighted_net_usd });
  });

  it('shows recorded sourced rates and checked date next to existing stats', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aiwg-pricing-stats-'));
    cleanup.push(dir);
    const { decisionSavingsWeights } = await import('../../../../src/decision/savings.js');
    const cost = { jev_input_per_mtok: 0.042, jev_output_per_mtok: 0, source: 'typesafe-docs' as const,
      checked_at: '2026-10-23', jev_model: 'jev-1.13.0' };
    const record = buildDecisionLedgerRecord({ question: 'Proceed?', mode: { kind: 'yes-no' } }, {
      schema: 'aiwg-decision-ask/v1', status: 'answered', answer: true, confidence: 0.95, probability: 0.95,
      reason: 'none', fallback: null, model: 'jev-1.13.0', usage: { inputTokens: 400, outputTokens: 10 }, latencyMs: 1,
    }, { transport: 'cli', projectRoot: dir, provider: 'codex', savingsWeights: decisionSavingsWeights({ cost }) });
    await appendDecisionLedgerRecord(record, { projectRoot: dir });
    const run = (args: string[]) => decisionHandler.execute({ args, rawArgs: [], cwd: dir, frameworkRoot: process.cwd() });
    const text = await run(['stats']);
    expect(text.exitCode).toBe(0);
    expect(text.message).toContain('cost_weighted_net_usd=');
    expect(text.message).toContain('source=typesafe-docs checked_at=2026-10-23');
    expect(text.message).toContain('jev_input_per_mtok');
    const json = await run(['stats', '--json']);
    expect(JSON.parse(json.message!).groups[0].ratesUsed).toEqual([expect.objectContaining({ calls: 1, method: expect.objectContaining(cost) })]);
  });

  it('previews sourced pricing with a fake fetch and displays current config offline', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aiwg-pricing-cli-'));
    cleanup.push(dir);
    const document = '| Model ID | `jev-1.13.0` |\n| Price (per Btok / per Mtok) | $42 / $0.042 |\nOutput tokens are free.';
    fetchSpy!.mockImplementation(async () => new Response(document));
    const run = (args: string[]) => decisionHandler.execute({ args, rawArgs: [], cwd: dir, frameworkRoot: process.cwd() });
    const preview = await run(['pricing', '--refresh', '--model', 'jev-1.13.0', '--dry-run', '--json']);
    expect(preview.exitCode).toBe(0);
    expect(JSON.parse(preview.message!)).toMatchObject({ written: false, current: { source: 'typesafe-docs', jev_input_per_mtok: 0.042 }, diff: expect.any(Array) });
    await expect(readFile(path.join(dir, '.aiwg/aiwg.config'))).rejects.toThrow();
    expect((await run(['pricing', '--refresh', '--offline', '--model', 'jev-1.13.0'])).message).toContain('Bundled snapshot dated 2026-10-18');
    fetchSpy!.mockClear();
    expect((await run(['pricing'])).message).toContain('typesafe-snapshot');
    expect(fetchSpy).not.toHaveBeenCalled();
    for (const args of [['pricing', '--wat'], ['pricing', '--refresh', '--model'], ['pricing', 'refresh']]) {
      expect((await run(args)).exitCode).toBe(2);
    }
    expect((await run(['pricing', '--offline'])).exitCode).toBe(1);
  });

  it('returns machine-readable capabilities', async () => {
    const result = await decisionHandler.execute({
      args: ['capabilities'],
      rawArgs: ['decision', 'capabilities'],
      cwd: process.cwd(),
      frameworkRoot: process.cwd(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.rawOutput).toBe(true);
    expect(JSON.parse(result.message ?? '{}')).toMatchObject({ offlineReady: true, backend: { status: 'not-probed' } });
  });

  it('evaluates through the CLI handler with an operator-selected trusted host policy module', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aiwg-decision-cli-'));
    cleanup.push(dir);
    const setup = await decisionHandler.execute({
      args: ['setup', 'synthetic-classification', '--output-dir', dir],
      rawArgs: ['decision', 'setup', 'synthetic-classification', '--output-dir', dir],
      cwd: process.cwd(),
      frameworkRoot: process.cwd(),
    });
    expect(setup.exitCode).toBe(0);
    const modulePath = path.join(dir, 'trusted-host-policies.mjs');
    await writeFile(modulePath, 'export default {};\n');
    process.env.AIWG_DECISION_ENABLED = '1';
    const result = await decisionHandler.execute({
      args: ['evaluate', '--request', path.join(dir, 'dispatcher-request.json'), '--host-policy-module', modulePath],
      rawArgs: ['decision', 'evaluate', '--request', path.join(dir, 'dispatcher-request.json'), '--host-policy-module', modulePath],
      cwd: process.cwd(),
      frameworkRoot: process.cwd(),
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.message ?? '{}')).toMatchObject({ exitCode: 0, result: { kind: 'RulesetResult' } });
  });

  it('returns ask fallback JSON without configured Jev, resolving provider to "unknown" under a missing/unreadable project config', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aiwg-decision-cli-'));
    cleanup.push(dir);
    process.env.XDG_CONFIG_HOME = dir;
    const result = await decisionHandler.execute({
      args: ['ask', '--question', 'Proceed?', '--yes-no', '--json'],
      rawArgs: ['decision', 'ask', '--question', 'Proceed?', '--yes-no', '--json'],
      // Isolated project root (not process.cwd()): `ask` now appends a decision-ledger
      // record (#2946) and must never write into this repository's own .aiwg/. It also
      // has no .aiwg/aiwg.config at all, so provider auto-detection degrades with no
      // signal — exercising the same "attribution resolution found nothing usable"
      // path as review r1 finding 3's probe, end to end through the real resolver.
      cwd: dir,
      frameworkRoot: process.cwd(),
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.message ?? '{}')).toMatchObject({ schema: 'aiwg-decision-ask/v1', status: 'fallback', reason: 'not-configured', ledgerRecorded: true });
    const ledger = await readFile(path.join(dir, '.aiwg', 'decision', 'ledger.jsonl'), 'utf8');
    expect(JSON.parse(ledger.trim())).toMatchObject({ provider: 'unknown' });
  });

  it('records a ledger entry for ask, honoring --provider, --session, --caller and --record-text', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aiwg-decision-cli-'));
    cleanup.push(dir);
    process.env.XDG_CONFIG_HOME = dir;
    const result = await decisionHandler.execute({
      args: [
        'ask', '--question', 'Proceed?', '--yes-no', '--json',
        '--provider', 'codex', '--session', 'sess-123', '--caller', 'worker-pick', '--record-text',
      ],
      rawArgs: [],
      cwd: dir,
      frameworkRoot: process.cwd(),
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.message ?? '{}')).toMatchObject({ status: 'fallback', reason: 'not-configured' });

    const ledger = await readFile(path.join(dir, '.aiwg', 'decision', 'ledger.jsonl'), 'utf8');
    const record = JSON.parse(ledger.trim().split('\n')[0]);
    expect(record).toMatchObject({
      schema: 'aiwg-decision-ledger-record/v2',
      sessionSource: '--session',
      transport: 'cli',
      provider: 'codex',
      sessionId: 'sess-123',
      caller: 'worker-pick',
      decisionKind: 'yes-no',
      status: 'fallback',
      fallbackReason: 'not-configured',
      questionText: 'Proceed?',
    });
    expect(record.questionDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('review r1 finding 1 — rejects a malformed --session or --caller with exit 2, before any Jev call', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aiwg-decision-cli-'));
    cleanup.push(dir);
    const badSession = await decisionHandler.execute({
      args: ['ask', '--question', 'Proceed?', '--yes-no', '--session', 'has spaces', '--json'],
      rawArgs: [],
      cwd: dir,
      frameworkRoot: process.cwd(),
    });
    expect(badSession.exitCode).toBe(2);
    expect(JSON.parse(badSession.message ?? '{}')).toMatchObject({ reason: 'invalid-session' });

    const badCaller = await decisionHandler.execute({
      args: ['ask', '--question', 'Proceed?', '--yes-no', '--caller', 'not allowed!', '--json'],
      rawArgs: [],
      cwd: dir,
      frameworkRoot: process.cwd(),
    });
    expect(badCaller.exitCode).toBe(2);
    expect(JSON.parse(badCaller.message ?? '{}')).toMatchObject({ reason: 'invalid-caller' });

    // Rejected before askDecision ever runs: no ledger file was created at all.
    await expect(readFile(path.join(dir, '.aiwg', 'decision', 'ledger.jsonl'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('review r2 item 11 — accepts the documented --caller "address-issues:worker-pick" form', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aiwg-decision-cli-'));
    cleanup.push(dir);
    process.env.XDG_CONFIG_HOME = dir;
    const result = await decisionHandler.execute({
      args: ['ask', '--question', 'Proceed?', '--yes-no', '--json', '--caller', 'address-issues:worker-pick'],
      rawArgs: [],
      cwd: dir,
      frameworkRoot: process.cwd(),
    });
    expect(result.exitCode).toBe(0);
    const ledger = await readFile(path.join(dir, '.aiwg', 'decision', 'ledger.jsonl'), 'utf8');
    expect(JSON.parse(ledger.trim())).toMatchObject({ caller: 'address-issues:worker-pick' });
  });

  it('a ledger write failure leaves the ask result and exit code unchanged, and warns once on stderr', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aiwg-decision-cli-'));
    cleanup.push(dir);
    process.env.XDG_CONFIG_HOME = dir;
    // Pre-create .aiwg/decision as a *file* so the ledger append fails deterministically.
    await mkdir(path.join(dir, '.aiwg'), { recursive: true });
    await writeFile(path.join(dir, '.aiwg', 'decision'), 'not a directory');

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const result = await decisionHandler.execute({
        args: ['ask', '--question', 'Proceed?', '--yes-no', '--json'],
        rawArgs: [],
        cwd: dir,
        frameworkRoot: process.cwd(),
      });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.message ?? '{}')).toMatchObject({ schema: 'aiwg-decision-ask/v1', status: 'fallback', reason: 'not-configured' });
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      expect(String(stderrSpy.mock.calls[0]?.[0])).toMatch(/decision ledger/i);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('validates pass flags before credentials and records requested policy for offline fallback', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aiwg-decision-cli-passes-'));
    cleanup.push(dir);
    process.env.XDG_CONFIG_HOME = dir;
    for (const flags of [['--passes', '0'], ['--passes', '2.1'], ['--passes', '3', '--escalation-passes', '2'], ['--passes']]) {
      const args = ['ask', '--question', 'Proceed?', '--yes-no', '--json', ...flags];
      const result = await decisionHandler.execute({ args, rawArgs: ['decision', ...args], cwd: dir, frameworkRoot: process.cwd() });
      expect(result.exitCode).toBe(2);
    }
    const args = ['ask', '--question', 'Proceed?', '--yes-no', '--passes', '10', '--escalation-passes', '20', '--json'];
    const result = await decisionHandler.execute({ args, rawArgs: ['decision', ...args], cwd: dir, frameworkRoot: process.cwd() });
    expect(JSON.parse(result.message!)).toMatchObject({ status: 'fallback',
      aggregate: { passesRequested: 10, escalationPasses: 20, passesRun: 0, escalated: false } });
    for (const groupBy of ['passes', 'escalation']) {
      const statsArgs = ['stats', '--group-by', groupBy, '--json'];
      const stats = await decisionHandler.execute({ args: statsArgs, rawArgs: ['decision', ...statsArgs], cwd: dir, frameworkRoot: process.cwd() });
      expect(stats.exitCode).toBe(0);
      expect(JSON.parse(stats.message!).groups[0]).toMatchObject({ hitRate: 0, passesRun: 0, tokensPerAnsweredDecision: null });
    }
  });

  it('applies project defaults and CLI pass overrides through a fake Jev transport', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aiwg-decision-cli-fake-'));
    cleanup.push(dir);
    process.env.XDG_CONFIG_HOME = dir;
    process.env.AIWG_DECISION_ENABLED = '1';
    process.env.JEV_API_KEY = 'fixture-token';
    await mkdir(path.join(dir, '.aiwg'));
    await writeFile(path.join(dir, '.aiwg/aiwg.config'), JSON.stringify({ decision: { ask: { passes: 3, escalation_passes: 6 } } }));
    fetchSpy!.mockImplementation(async () => new Response(JSON.stringify({ model: 'jev-fixture', answers: { answer: { type: 'noul', noul: 0.95 } },
      usage: { input_tokens: 10, output_tokens: 2 } }), { status: 200 }));
    for (const [flags, count] of [[[], 3], [['--passes', '2', '--escalation-passes', '4'], 2]] as const) {
      fetchSpy!.mockClear();
      const args = ['ask', '--question', 'Proceed?', '--yes-no', '--json', ...flags];
      const result = await decisionHandler.execute({ args, rawArgs: ['decision', ...args], cwd: dir, frameworkRoot: process.cwd() });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.message!)).toMatchObject({ status: 'answered', answer: true, aggregate: { passesRun: count, passesRequested: count } });
      expect(fetchSpy).toHaveBeenCalledTimes(count);
    }
  });

  it('reports agreement answers and tokens per answered decision by pass policy in JSON and text', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aiwg-decision-agreement-'));
    cleanup.push(dir);
    process.env.XDG_CONFIG_HOME = dir;
    process.env.AIWG_DECISION_ENABLED = '1';
    process.env.JEV_API_KEY = 'fixture-token';
    await mkdir(path.join(dir, '.aiwg'));
    await writeFile(path.join(dir, '.aiwg/aiwg.config'), JSON.stringify({ decision: { ask: {
      passes: 10, escalation_passes: 20, min_agreement: 0.9,
    } } }));
    fetchSpy!.mockImplementation(async () => new Response(JSON.stringify({ model: 'jev-fixture', answers: { answer: { type: 'noul', noul: 0.41 } },
      usage: { input_tokens: 10, output_tokens: 2 } }), { status: 200 }));
    const execute = (args: string[]) => decisionHandler.execute({ args, rawArgs: ['decision', ...args], cwd: dir, frameworkRoot: process.cwd() });
    const result = await execute(['ask', '--question', 'Proceed?', '--yes-no', '--json']);
    expect(JSON.parse(result.message!)).toMatchObject({ status: 'answered', answer: false, answeredBy: 'agreement',
      aggregate: { passesRun: 10, escalated: false } });
    expect(fetchSpy).toHaveBeenCalledTimes(10);
    // Include a fallback's tokens in the policy's cost per successful answer.
    fetchSpy!.mockImplementation(async () => new Response(JSON.stringify({ model: 'jev-fixture', answers: { answer: { type: 'noul', noul: 0.5 } },
      usage: { input_tokens: 10, output_tokens: 2 } }), { status: 200 }));
    const fallback = await execute(['ask', '--question', 'Unclear?', '--yes-no', '--json']);
    const fallbackPasses = JSON.parse(fallback.message!).aggregate.passesRun;
    expect(JSON.parse(fallback.message!)).toMatchObject({ status: 'fallback', answeredBy: null });
    const cost = (10 + fallbackPasses) * 12;
    const stats = await execute(['stats', '--group-by', 'passes', '--json']);
    expect(JSON.parse(stats.message!).groups).toEqual([expect.objectContaining({ key: '10/20', hitRate: 0.5, tokensPerAnsweredDecision: cost })]);
    const text = await execute(['stats', '--group-by', 'passes']);
    expect(text.message).toContain(`tokens per answered decision=${cost.toFixed(2)}`);
    expect(fetchSpy).toHaveBeenCalledTimes(10 + fallbackPasses);
  });

  it('history and stats read the ledger offline, with --json, filters and --group-by', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aiwg-decision-cli-'));
    cleanup.push(dir);
    process.env.XDG_CONFIG_HOME = dir;

    for (const [question, provider, caller] of [
      ['Proceed?', 'claude', 'worker-a'],
      ['Pick?', 'codex', 'worker-b'],
    ] as const) {
      const execResult = await decisionHandler.execute({
        args: ['ask', '--question', question, '--yes-no', '--json', '--provider', provider, '--caller', caller],
        rawArgs: [],
        cwd: dir,
        frameworkRoot: process.cwd(),
      });
      expect(execResult.exitCode).toBe(0);
    }

    const history = await decisionHandler.execute({
      args: ['history', '--provider', 'codex', '--json'],
      rawArgs: [],
      cwd: dir,
      frameworkRoot: process.cwd(),
    });
    expect(history.exitCode).toBe(0);
    const historyBody = JSON.parse(history.message ?? '{}');
    expect(historyBody).toMatchObject({ schema: 'aiwg-decision-ledger-history/v1', count: 1, skipped: 0 });
    expect(historyBody.records[0]).toMatchObject({ provider: 'codex', caller: 'worker-b' });

    const stats = await decisionHandler.execute({
      args: ['stats', '--group-by', 'caller', '--json'],
      rawArgs: [],
      cwd: dir,
      frameworkRoot: process.cwd(),
    });
    expect(stats.exitCode).toBe(0);
    const statsBody = JSON.parse(stats.message ?? '{}');
    expect(statsBody.schema).toBe('aiwg-decision-ledger-stats/v1');
    expect(statsBody.groupBy).toBe('caller');
    expect(statsBody.groups.map((group: { key: string }) => group.key).sort()).toEqual(['worker-a', 'worker-b']);

    const emptyDir = await mkdtemp(path.join(tmpdir(), 'aiwg-decision-cli-'));
    cleanup.push(emptyDir);
    const emptyHistory = await decisionHandler.execute({
      args: ['history', '--json'],
      rawArgs: [],
      cwd: emptyDir,
      frameworkRoot: process.cwd(),
    });
    expect(JSON.parse(emptyHistory.message ?? '{}')).toMatchObject({ count: 0, skipped: 0, records: [] });
  });

  it('review r1 finding 9 — stats honors the same provider/session/kind/status filters as history, not just since/group-by', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aiwg-decision-cli-'));
    cleanup.push(dir);
    process.env.XDG_CONFIG_HOME = dir;

    await decisionHandler.execute({ args: ['ask', '--question', 'A', '--yes-no', '--json', '--provider', 'claude'], rawArgs: [], cwd: dir, frameworkRoot: process.cwd() });
    await decisionHandler.execute({ args: ['ask', '--question', 'B', '--yes-no', '--json', '--provider', 'codex'], rawArgs: [], cwd: dir, frameworkRoot: process.cwd() });

    const filtered = await decisionHandler.execute({
      args: ['stats', '--provider', 'codex', '--json'],
      rawArgs: [],
      cwd: dir,
      frameworkRoot: process.cwd(),
    });
    const body = JSON.parse(filtered.message ?? '{}');
    // Before the finding-9 fix, --provider was silently dropped and this totalled both calls.
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0].totalCalls).toBe(1);
  });

  it('review r1 finding 11 — rejects an invalid calendar date and a non-ISO --since with exit 2', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aiwg-decision-cli-'));
    cleanup.push(dir);
    const badCalendarDate = await decisionHandler.execute({
      args: ['history', '--since', '2026-02-30', '--json'],
      rawArgs: [],
      cwd: dir,
      frameworkRoot: process.cwd(),
    });
    expect(badCalendarDate.exitCode).toBe(2);
    expect(JSON.parse(badCalendarDate.message ?? '{}')).toMatchObject({ reason: 'invalid-since' });

    const badFormat = await decisionHandler.execute({
      args: ['history', '--since', '10/01/2026', '--json'],
      rawArgs: [],
      cwd: dir,
      frameworkRoot: process.cwd(),
    });
    expect(badFormat.exitCode).toBe(2);
    expect(JSON.parse(badFormat.message ?? '{}')).toMatchObject({ reason: 'invalid-since' });

    // Review r2 item 12: an impossible calendar date must be rejected even with an explicit offset.
    const badOffsetDate = await decisionHandler.execute({
      args: ['history', '--since', '2026-02-30T00:00:00+01:00', '--json'],
      rawArgs: [],
      cwd: dir,
      frameworkRoot: process.cwd(),
    });
    expect(badOffsetDate.exitCode).toBe(2);
    expect(JSON.parse(badOffsetDate.message ?? '{}')).toMatchObject({ reason: 'invalid-since' });
  });

  it('rejects an invalid --kind, --status or --group-by with exit 2', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aiwg-decision-cli-'));
    cleanup.push(dir);
    const badKind = await decisionHandler.execute({
      args: ['history', '--kind', 'bogus', '--json'],
      rawArgs: [],
      cwd: dir,
      frameworkRoot: process.cwd(),
    });
    expect(badKind.exitCode).toBe(2);
    expect(JSON.parse(badKind.message ?? '{}')).toMatchObject({ reason: 'invalid-kind' });

    const badGroupBy = await decisionHandler.execute({
      args: ['stats', '--group-by', 'bogus', '--json'],
      rawArgs: [],
      cwd: dir,
      frameworkRoot: process.cwd(),
    });
    expect(badGroupBy.exitCode).toBe(2);
    expect(JSON.parse(badGroupBy.message ?? '{}')).toMatchObject({ reason: 'invalid-group-by' });
  });

  it('#3065 — history filters by exact --caller, prefix --caller and --no-caller', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aiwg-decision-cli-'));
    cleanup.push(dir);
    process.env.XDG_CONFIG_HOME = dir;

    for (const [question, callerArgs] of [
      ['One', ['--caller', 'address-issues:worker-pick']],
      ['Two', ['--caller', 'address-issues:failure-triage']],
      ['Three', ['--caller', 'other:worker-pick']],
      ['Four', []],
    ] as const) {
      const execResult = await decisionHandler.execute({
        args: ['ask', '--question', question, '--yes-no', '--json', ...callerArgs],
        rawArgs: [],
        cwd: dir,
        frameworkRoot: process.cwd(),
      });
      expect(execResult.exitCode).toBe(0);
    }

    const exact = await decisionHandler.execute({
      args: ['history', '--caller', 'address-issues:worker-pick', '--json'],
      rawArgs: [],
      cwd: dir,
      frameworkRoot: process.cwd(),
    });
    expect(exact.exitCode).toBe(0);
    const exactBody = JSON.parse(exact.message ?? '{}');
    expect(exactBody.count).toBe(1);
    expect(exactBody.records.map((record: { caller: string }) => record.caller)).toEqual(['address-issues:worker-pick']);
    expect(exactBody.filters).toMatchObject({ caller: 'address-issues:worker-pick' });

    const prefix = await decisionHandler.execute({
      args: ['history', '--caller', 'address-issues:*', '--json'],
      rawArgs: [],
      cwd: dir,
      frameworkRoot: process.cwd(),
    });
    expect(prefix.exitCode).toBe(0);
    const prefixBody = JSON.parse(prefix.message ?? '{}');
    expect(prefixBody.count).toBe(2);
    expect(prefixBody.filters).toMatchObject({ callerPrefix: 'address-issues:' });

    const noCaller = await decisionHandler.execute({
      args: ['history', '--no-caller', '--json'],
      rawArgs: [],
      cwd: dir,
      frameworkRoot: process.cwd(),
    });
    expect(noCaller.exitCode).toBe(0);
    const noCallerBody = JSON.parse(noCaller.message ?? '{}');
    expect(noCallerBody.count).toBe(1);
    expect(noCallerBody.records[0].caller).toBeNull();
    expect(noCallerBody.filters).toMatchObject({ noCaller: true });

    const human = await decisionHandler.execute({
      args: ['history', '--caller', 'address-issues:*'],
      rawArgs: [],
      cwd: dir,
      frameworkRoot: process.cwd(),
    });
    expect(human.exitCode).toBe(0);
    expect(human.message).toMatch(/Caller filter: address-issues:\*/);
  });

  it('#3065 — stats aggregates only caller-matching records and echoes filters', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aiwg-decision-cli-'));
    cleanup.push(dir);
    process.env.XDG_CONFIG_HOME = dir;

    for (const [question, callerArgs] of [
      ['One', ['--caller', 'address-issues:worker-pick']],
      ['Two', ['--caller', 'address-issues:failure-triage']],
      ['Three', ['--caller', 'other:worker-pick']],
    ] as const) {
      await decisionHandler.execute({
        args: ['ask', '--question', question, '--yes-no', '--json', ...callerArgs],
        rawArgs: [],
        cwd: dir,
        frameworkRoot: process.cwd(),
      });
    }

    const stats = await decisionHandler.execute({
      args: ['stats', '--caller', 'address-issues:*', '--json'],
      rawArgs: [],
      cwd: dir,
      frameworkRoot: process.cwd(),
    });
    expect(stats.exitCode).toBe(0);
    const body = JSON.parse(stats.message ?? '{}');
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0].totalCalls).toBe(2);
    expect(body.filters).toMatchObject({ callerPrefix: 'address-issues:' });

    const human = await decisionHandler.execute({
      args: ['stats', '--no-caller'],
      rawArgs: [],
      cwd: dir,
      frameworkRoot: process.cwd(),
    });
    expect(human.exitCode).toBe(0);
    expect(human.message).toMatch(/Caller filter: no caller/);
  });

  it('#3065 — history and stats reject bad caller filters, unknown flags and positionals with exit 2', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aiwg-decision-cli-'));
    cleanup.push(dir);

    const both = await decisionHandler.execute({
      args: ['history', '--caller', 'worker-a', '--no-caller', '--json'],
      rawArgs: [],
      cwd: dir,
      frameworkRoot: process.cwd(),
    });
    expect(both.exitCode).toBe(2);
    expect(JSON.parse(both.message ?? '{}')).toMatchObject({ reason: 'invalid-caller-filter' });
    expect(both.message).toMatch(/--caller.*--no-caller|--no-caller.*--caller/);

    for (const bad of ['', 'not allowed!', 'a*b', '*']) {
      const invalid = await decisionHandler.execute({
        args: ['history', '--caller', bad, '--json'],
        rawArgs: [],
        cwd: dir,
        frameworkRoot: process.cwd(),
      });
      expect(invalid.exitCode).toBe(2);
      expect(JSON.parse(invalid.message ?? '{}')).toMatchObject({ reason: 'invalid-caller' });
      expect(invalid.message).toMatch(/--caller/);
    }

    const unknownHistory = await decisionHandler.execute({
      args: ['history', '--bogus', '--json'],
      rawArgs: [],
      cwd: dir,
      frameworkRoot: process.cwd(),
    });
    expect(unknownHistory.exitCode).toBe(2);
    expect(JSON.parse(unknownHistory.message ?? '{}')).toMatchObject({ reason: 'unknown-flag' });
    expect(unknownHistory.message).toMatch(/--bogus/);

    const unknownStats = await decisionHandler.execute({
      args: ['stats', '--bogus', '--json'],
      rawArgs: [],
      cwd: dir,
      frameworkRoot: process.cwd(),
    });
    expect(unknownStats.exitCode).toBe(2);
    expect(JSON.parse(unknownStats.message ?? '{}')).toMatchObject({ reason: 'unknown-flag' });
    expect(unknownStats.message).toMatch(/--bogus/);

    const positional = await decisionHandler.execute({
      args: ['history', 'extra-positional', '--json'],
      rawArgs: [],
      cwd: dir,
      frameworkRoot: process.cwd(),
    });
    expect(positional.exitCode).toBe(2);
    expect(positional.message).toMatch(/extra-positional/);
  });

  it('returns usage errors with exit 2', async () => {
    const result = await decisionHandler.execute({
      args: ['ask', '--question', 'Proceed?', '--yes-no', '--choices', 'a,b', '--json'],
      rawArgs: ['decision', 'ask', '--question', 'Proceed?', '--yes-no', '--choices', 'a,b', '--json'],
      cwd: process.cwd(),
      frameworkRoot: process.cwd(),
    });
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.message ?? '{}')).toMatchObject({ reason: 'invalid-mode' });
  });

  it('reports context-too-large as exit 2', async () => {
    const result = await decisionHandler.execute({
      args: ['ask', '--question', 'Proceed?', '--yes-no', '--context', 'x'.repeat(32 * 1024 + 1), '--json'],
      rawArgs: ['decision', 'ask', '--question', 'Proceed?', '--yes-no', '--context', 'x'.repeat(32 * 1024 + 1), '--json'],
      cwd: process.cwd(),
      frameworkRoot: process.cwd(),
    });
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.message ?? '{}')).toMatchObject({ reason: 'context-too-large' });
  });
});
