import { describe, expect, it, vi } from 'vitest';
import { projectDecisionState, type DecisionProjectionPolicy } from '../../../src/decision/projection.js';
import { DecisionTraceBuilder, sanitizedTelemetryExport, scanTelemetryCanaries } from '../../../src/decision/telemetry/index.js';

const fields = (): DecisionProjectionPolicy => ({
  version: 'security-fixture-v1', provider: 'jev', model: 'jev-1', origin: 'https://api.typesafe.ai',
  region: 'us', purpose: 'offline-triage', allowIncompleteContext: false,
  fields: [{ pointer: '/approved', output: 'excerpt', source: 'fixture', subject: 'opaque-case',
    trust: 'untrusted', sensitivity: 'internal', purpose: 'offline-triage', retentionClass: 'ephemeral',
    accessScopes: ['decision-runtime'], exportPolicy: 'sanitized', deletionPolicy: 'erase',
    backupPolicy: 'not-persisted', allowedProviders: ['jev'], allowedModels: ['jev-1'],
    allowedOrigins: ['https://api.typesafe.ai'], allowedRegions: ['us'] }],
});

/** Synthetic strings only. No live provider, collector, or stored secret is accessed. */
describe('SEC/PRV cross-surface synthetic canary matrix', () => {
  it('scans excluded state, metadata, logs, telemetry, export, error and snapshot fixtures', async () => {
    const canaries = [
      'synthetic-portable-secret-canary', 'synthetic-personal-data-canary',
      'synthetic-header-canary', 'synthetic-response-canary', 'synthetic-debug-canary',
    ];
    const [secret, pii, header, response, debug] = canaries;
    const projected = await projectDecisionState({ approved: 'public fixture',
      adjacent: { secret, pii, header, response, debug } }, fields());
    const adapter = vi.fn(async (value: unknown) => value);
    const request = await adapter({ state: projected.state, evidence: projected.evidence });
    const builder = new DecisionTraceBuilder({ traceId: () => '1'.repeat(32), spanId: () => '2'.repeat(16) }, () => 1);
    const span = builder.startSpan('decision.workflow', { attributes: { prompt: secret!,
      'safe.canary': pii!, 'aiwg.provider.request_id': header!, response: response! } });
    builder.endSpan(span, 'ok', 2);
    const trace = sanitizedTelemetryExport(builder.build(), { canaries });
    const snapshots = { projectionDigest: projected.evidence.projectedDigest,
      allowedFieldCount: projected.evidence.included.length, traceId: trace.traceId };
    const audit = { outcome: 'allowed', classification: 'internal', debugCapture: 'disabled' };
    const output = { request, evidence: projected.evidence, trace, snapshots, audit };
    expect(adapter).toHaveBeenCalledOnce();
    expect(scanTelemetryCanaries(output, canaries)).toEqual([]);
    expect(JSON.stringify(output)).not.toMatch(/synthetic-(?:portable|personal|header|response|debug)/);
  });

  it('never echoes a denied portable locator in thrown errors or logs', async () => {
    const forbidden = 'vault://private/synthetic-debug-canary';
    const policy = fields(); policy.fields[0]!.source = forbidden;
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      let message = '';
      try { await projectDecisionState({ approved: 'fixture' }, policy); }
      catch (error) { message = String(error); }
      expect(message).toContain('forbidden credential');
      expect(message).not.toContain(forbidden);
      expect(log).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });
});
