/** @issue #1187 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatFleetSpendReport,
  generateFleetSpendReport,
  keyEnvironmentName,
  loadFleetConfig,
  loadFleetKey,
} from '../../../src/cost/fleet-report.js';
import { costReportHandler } from '../../../src/cli/handlers/cost-report.js';
import { buildHandlerMap } from '../../../src/cli/handlers/index.js';
import type { HandlerContext } from '../../../src/cli/handlers/types.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aiwg-fleet-report-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

function context(cwd: string, args: string[]): HandlerContext {
  return { cwd, frameworkRoot: cwd, args, rawArgs: ['cost-report', ...args] };
}

describe('OpenRouter fleet cost reporting', () => {
  it('uses a deterministic environment variable name for a key reference', () => {
    expect(keyEnvironmentName('openrouter-eride-quickbooksbot')).toBe(
      'AIWG_OPENROUTER_KEY_OPENROUTER_ERIDE_QUICKBOOKSBOT',
    );
  });

  it('rejects credentials embedded in fleet config', async () => {
    const directory = await temporaryDirectory();
    const config = path.join(directory, 'fleet.yaml');
    await fs.writeFile(config, [
      'fleet:',
      '  - bot: unsafe',
      '    machine: local',
      '    key_ref: unsafe-key',
      '    openrouter_api_key: sk-or-should-never-live-here',
      '    monthly_cap: 10',
      '',
    ].join('\n'));

    await expect(loadFleetConfig(config)).rejects.toThrow(/credential-like/);
  });

  it('loads credential files only when private and not symlinked', async () => {
    const homeDir = await temporaryDirectory();
    const keyDirectory = path.join(homeDir, '.config', 'aiwg', 'keys');
    const keyFile = path.join(keyDirectory, 'fleet-bot');
    await fs.mkdir(keyDirectory, { recursive: true });
    await fs.chmod(keyDirectory, 0o700);
    await fs.writeFile(keyFile, 'private-token\n', { mode: 0o600 });

    await expect(loadFleetKey('fleet-bot', { homeDir, env: {} })).resolves.toBe('private-token');

    await fs.chmod(keyFile, 0o644);
    await expect(loadFleetKey('fleet-bot', { homeDir, env: {} })).rejects.toThrow(/group or other/);

    await fs.chmod(keyFile, 0o600);
    await fs.symlink(keyFile, path.join(keyDirectory, 'linked-bot'));
    await expect(loadFleetKey('linked-bot', { homeDir, env: {} })).rejects.toThrow(/not a symlink/);
  });

  it('aggregates per-bot MTD usage and correlates tagged generation activity', async () => {
    const directory = await temporaryDirectory();
    const configPath = path.join(directory, 'fleet.yaml');
    await fs.mkdir(path.join(directory, '.aiwg'), { recursive: true });
    await fs.writeFile(configPath, [
      'provider: openrouter',
      'fleet:',
      '  - bot: quickbooksbot',
      '    machine: eride',
      '    key_ref: qb-key',
      '    monthly_cap: 10',
      '  - bot: hermesclaw',
      '    machine: oci',
      '    key_ref: hermes-key',
      '    monthly_cap: 20',
      '',
    ].join('\n'));
    await fs.writeFile(path.join(directory, '.aiwg', 'activity.log'), [
      '## [2026-08-13 15:00] query | bot=quickbooksbot session=invoice-a generation_id=gen-qb-1',
      '## [2026-08-13 15:05] query | bot=quickbooksbot session=invoice-a generation_id=gen-qb-2',
      '## [2026-08-13 15:10] query | bot=hermesclaw session=review-b generation_id=gen-h-1',
      '',
    ].join('\n'));

    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const authorization = new Headers(init?.headers).get('Authorization');
      if (url.endsWith('/key')) {
        const usage = authorization === 'Bearer qb-secret' ? 8.5 : 4;
        return new Response(JSON.stringify({ data: { usage_monthly: usage } }), { status: 200 });
      }
      const id = new URL(url).searchParams.get('id');
      const generation = id === 'gen-qb-1'
        ? { total_cost: 5, model: 'openai/gpt-5', service_tier: 'tier-2', created_at: '2026-08-13T15:00:00Z' }
        : id === 'gen-qb-2'
          ? { total_cost: 1, model: 'openai/gpt-5', service_tier: 'tier-2', created_at: '2026-07-31T23:59:00Z' }
          : { total_cost: 2, model: 'anthropic/claude', service_tier: 'tier-1', created_at: '2026-08-13T15:10:00Z' };
      return new Response(JSON.stringify({ data: generation }), { status: 200 });
    });

    const report = await generateFleetSpendReport({
      cwd: directory,
      configPath,
      env: {
        AIWG_OPENROUTER_KEY_QB_KEY: 'qb-secret',
        AIWG_OPENROUTER_KEY_HERMES_KEY: 'hermes-secret',
      },
      fetchImpl,
      apiBaseUrl: 'https://openrouter.test/api/v1',
      now: new Date('2026-08-13T16:00:00Z'),
    });

    expect(report.enforcement).toBe('openrouter');
    expect(report.bots[0]).toMatchObject({
      bot: 'quickbooksbot',
      spend_mtd: 8.5,
      cap: 10,
      percent_used: 85,
      anomalies: ['cap-near-limit', 'single-session-spike'],
      top_sessions: [{ session: 'invoice-a', cost: 5, generations: 1 }],
      model_tier_breakdown: { 'tier-2': 5 },
    });
    expect(report.bots[1].top_sessions[0]).toMatchObject({ session: 'review-b', cost: 2 });
    const formatted = formatFleetSpendReport(report);
    expect(formatted).toMatch(/bot\s+\| machine \| spend MTD \| cap/);
    expect(formatted).toContain('AIWG observes and correlates spend; OpenRouter enforces');
    expect(formatted).not.toContain('qb-secret');
  });

  it('keeps key-level spend when generation correlation is partially unavailable', async () => {
    const directory = await temporaryDirectory();
    await fs.mkdir(path.join(directory, '.aiwg'), { recursive: true });
    await fs.writeFile(
      path.join(directory, '.aiwg', 'activity.log'),
      '## [2026-08-13 15:00] query | session=solo generation_id=gen-unavailable\n',
    );
    const fetchImpl = vi.fn(async (input: string | URL | Request) => (
      String(input).endsWith('/key')
        ? new Response(JSON.stringify({ data: { usage_monthly: 2, limit: 5, limit_reset: 'monthly' } }), { status: 200 })
        : new Response('{}', { status: 503 })
    ));

    const report = await generateFleetSpendReport({
      cwd: directory,
      fleet: [{ bot: 'solo', machine: 'local', key_ref: 'solo-key', monthly_cap: 0 }],
      env: { AIWG_OPENROUTER_KEY_SOLO_KEY: 'solo-secret' },
      fetchImpl,
      apiBaseUrl: 'https://openrouter.test/api/v1',
      now: new Date('2026-08-13T16:00:00Z'),
    });

    expect(report.bots[0]).toMatchObject({
      spend_mtd: 2,
      cap: 5,
      percent_used: 40,
      anomalies: ['generation-correlation-partial'],
      top_sessions: [],
    });
    expect(report.bots[0].error).toBeUndefined();
  });

  it('never exposes a credential in API failure reports', async () => {
    const directory = await temporaryDirectory();
    const credential = 'secret-that-must-not-appear';
    const report = await generateFleetSpendReport({
      cwd: directory,
      fleet: [{ bot: 'private', machine: 'local', key_ref: 'private-key', monthly_cap: 10 }],
      env: { AIWG_OPENROUTER_KEY_PRIVATE_KEY: credential },
      fetchImpl: vi.fn(async () => new Response('{}', { status: 401 })),
      apiBaseUrl: 'https://openrouter.test/api/v1',
    });

    expect(report.bots[0].error).toContain('status 401');
    expect(JSON.stringify(report)).not.toContain(credential);
    expect(formatFleetSpendReport(report)).toContain('status 401');
    expect(formatFleetSpendReport(report)).not.toContain(credential);
  });

  it.each(['transport Error', 'transport string', 'response decoding'] as const)(
    'sanitizes untrusted %s diagnostics in structured and rendered reports', async failure => {
      const directory = await temporaryDirectory();
      const credential = 'synthetic-fleet-regression-key';
      const untrusted = `untrusted-diagnostic Authorization: Bearer ${credential}`;
      const fetchImpl = vi.fn(async () => {
        if (failure === 'transport Error') throw new Error(untrusted);
        if (failure === 'transport string') throw untrusted;
        const response = new Response('{}', { status: 200 });
        vi.spyOn(response, 'json').mockRejectedValue(new SyntaxError(untrusted));
        return response;
      });
      const report = await generateFleetSpendReport({
        cwd: directory,
        homeDir: directory,
        fleet: [{ bot: 'synthetic', machine: 'local', key_ref: 'synthetic-key', monthly_cap: 10 }],
        env: { AIWG_OPENROUTER_KEY_SYNTHETIC_KEY: credential },
        fetchImpl,
        apiBaseUrl: 'https://openrouter.test/api/v1',
      });
      const diagnostic = failure === 'response decoding'
        ? 'OpenRouter returned unreadable JSON. Check the API response format.'
        : 'OpenRouter request could not complete. Check connectivity, timeout, or cancellation.';
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(report.bots[0]).toMatchObject({
        spend_mtd: null, percent_used: null, cap: 10, top_sessions: [],
        model_tier_breakdown: {}, anomalies: ['observation-error'], error: diagnostic,
      });
      for (const output of [JSON.stringify(report), formatFleetSpendReport(report)]) {
        expect(output).toContain(diagnostic);
        expect(output).toContain('observation-error');
        expect(output).not.toContain(credential);
        expect(output).not.toContain(untrusted);
        expect(output).not.toContain('Authorization');
        expect(output).not.toContain('untrusted-diagnostic');
      }
    },
  );

  it('returns helpful guidance when fleet.yaml is absent', async () => {
    const directory = await temporaryDirectory();
    const result = await costReportHandler.execute(context(directory, [
      '--fleet',
      '--config',
      'missing-fleet.yaml',
    ]));

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('No fleet config found');
    expect(result.message).toContain('store only key_ref values');
  });

  it('documents single-key observation mode in CLI help', async () => {
    const directory = await temporaryDirectory();
    const result = await costReportHandler.execute(context(directory, ['--help']));
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain('--key <key_ref>');
    expect(result.message).toContain('OpenRouter enforces');
  });

  it('is registered as the aiwg cost-report command', () => {
    expect(buildHandlerMap().get('cost-report')).toBe(costReportHandler);
  });
});
