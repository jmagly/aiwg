// T-OG-03/15: Droid 1.0.0 completion and legacy result regression (#4362).
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FactoryAdapter, FactoryDirectAdapter } from '../../../tools/ralph-external/lib/factory-adapter.mjs';
import { loadProviderModelCapabilities } from '../../../src/models/provider-policy.js';
import { workerVersionRangeMismatch } from '../../../src/models/worker-installation.mjs';

const adapter = new FactoryDirectAdapter();
const completion = readFileSync('test/fixtures/providers/factory/completion-1.0.0.ndjson', 'utf8');
const legacy = readFileSync('test/fixtures/providers/factory/health/stream.ndjson', 'utf8');
const terminal = JSON.parse(completion.trim().split('\n').at(-1)!);
const source = { kind: 'stdout', id: 'stdout', generation: 0, offset: 0 };
const binding = { invocationId: 'fixture', sessionId: 'fixture-session' };
const observation = { transport: 'shell', status: 'completed', termination: 'confirmed', exitCode: 0 };
const claims = { version: 1, status: 'completed', summary: 'Synthetic completion claims',
  claims: [], artifacts: [], checks: [], limitations: [] };
const jsonl = (...events: unknown[]) => events.map(event => JSON.stringify(event)).join('\n');
beforeEach(() => vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src'));
afterEach(() => vi.unstubAllEnvs());

describe('Factory 1.0.x terminal events', () => {
  it.each([[completion, 'factory-smoke-ok'], [legacy, 'fixture done']])(
    'extracts both captured completion and legacy result text', (stream, text) => {
      expect(adapter.parseDirectFinal(stream)).toMatchObject({ result: text });
      expect(adapter.parseOutput(stream)).toMatchObject({ result: text });
    });

  it('observes completion as a successful terminal with session and stdout guards', () => {
    expect(adapter.observeHealthEvent(terminal, source, binding)).toMatchObject({ kind: 'terminal', success: true });
    expect(adapter.observeHealthEvent(terminal, { ...source, kind: 'stderr' }, binding)).toBeNull();
    expect(adapter.observeHealthEvent(terminal, source, { ...binding, sessionId: 'other' })).toBeNull();
  });

  it.each([undefined, null, '', ' \n', 42, {}])('rejects invalid completion finalText %j', finalText => {
    const event = { ...terminal, finalText };
    expect(adapter.parseOutput(jsonl(event))).toBeNull();
    expect(adapter.observeHealthEvent(event, source, binding)).toMatchObject({ kind: 'terminal', success: false });
  });

  it.each(['before', 'after'])('rejects any error line %s either terminal shape', position => {
    for (const stream of [completion, legacy]) {
      const error = jsonl({ type: 'error', message: 'synthetic failure' });
      expect(adapter.parseOutput(position === 'before' ? `${error}\n${stream}` : `${stream}\n${error}`)).toBeNull();
    }
  });

  it('never replaces an unsuccessful legacy result with a completion', () => {
    expect(adapter.parseOutput(jsonl({ type: 'result', subtype: 'interrupted', result: 'partial' }, terminal))).toBeNull();
    expect(adapter.parseOutput(jsonl(terminal, { type: 'completion', finalText: '' }))).toBeNull();
  });

  it.each([
    null, '', ' \n', 'null', '[]', '42', '{', 'not json', '{}',
    jsonl({ type: 'result' }),
    jsonl({ type: 'result', subtype: 'success', is_error: true, result: 'failed' }),
    jsonl({ type: 'result', subtype: 'success', is_error: false, result: 42 }),
    jsonl({ type: 'result', subtype: 'success', is_error: false, result: ' ' }),
    `${completion}\nmalformed`,
  ])('preserves malformed and unsuccessful stream rejection %#', stream => {
    expect(adapter.parseDirectFinal(stream)).toBeNull();
  });

  it('feeds completion text into strict claims parsing and preserves terminal observation requirements', async () => {
    const stream = jsonl({ type: 'message' }, { ...terminal, finalText: JSON.stringify(claims) });
    await expect(adapter.parseWorkerFinal(Buffer.from(stream), { observation })).resolves.toEqual(claims);
    await expect(adapter.parseWorkerAttemptFinal(stream, { observation: { ...observation, attemptOutcome: 'succeeded' } }))
      .resolves.toEqual(claims);
    await expect(adapter.parseWorkerFinal(stream, { observation: { ...observation, exitCode: 1 } })).rejects.toThrow();
    await expect(adapter.parseWorkerFinal(stream, { observation: { ...observation, termination: 'uncertain' } })).rejects.toThrow();
    await expect(adapter.parseWorkerFinal(completion, { observation })).rejects.toThrow();
  });

  it('preserves the legacy Ralph parser', () => {
    expect(new FactoryAdapter().parseOutput('prefix {"ok":true} suffix')).toEqual({ ok: true });
  });

  it('catalog accepts the 1.0.x series and still rejects other series', () => {
    const metadata = loadProviderModelCapabilities().providers.factory.workerHealthAdapter!;
    expect(metadata.supportedVersions).toBe('1.0.x');
    expect(metadata.invocationProfiles!['direct-shell'].supportedVersions).toBe('1.0.x');
    for (const cliVersion of ['1.0.0', '1.0.9', '0.238.0', '1.1.0', '2.0.0']) {
      expect(workerVersionRangeMismatch(cliVersion,
        [metadata.supportedVersions, metadata.invocationProfiles!['direct-shell'].supportedVersions], 'factory') === null)
        .toBe(cliVersion.startsWith('1.0.'));
    }
  });
});
