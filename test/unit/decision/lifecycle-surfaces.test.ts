import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { decisionResultForExport } from '../../../src/decision/export.js';
import { FileDecisionLifecycleStore } from '../../../src/decision/file-lifecycle-store.js';
import {
  DECISION_LIFECYCLE_SURFACES, DECISION_LIFECYCLE_VERSION, eraseDecisionSubject, restoreDecisionSubjectBackup,
  type DecisionLifecycleBackupEntry, type DecisionLifecycleHold, type DecisionLifecyclePolicy,
  type DecisionLifecycleReference, type DecisionLifecycleSurface,
} from '../../../src/decision/lifecycle.js';
import {
  DecisionTraceBuilder, deleteTelemetryReference, restoreTelemetryTrace, sanitizedTelemetryExport, scanTelemetryCanaries,
  telemetryRetentionFromLifecyclePolicy, type DecisionRetentionPolicy, type DecisionTelemetryIdSource, type DecisionTelemetryTrace,
} from '../../../src/decision/telemetry/index.js';
import type { DecisionResult } from '../../../src/decision/types.js';

const CANARY = 'synthetic-erased-subject-canary';

const policy = (retentionMs = 1_000): DecisionLifecyclePolicy => ({ version: DECISION_LIFECYCLE_VERSION,
  surfaces: Object.fromEntries(DECISION_LIFECYCLE_SURFACES.map(surface => [surface, {
    classification: 'restricted', accessScopes: ['case-worker'], retentionMs, export: 'sanitized',
    deletion: 'erase', backup: 'expire-with-primary',
  }])) as DecisionLifecyclePolicy['surfaces'] });

const legacyRetention = (): DecisionRetentionPolicy => ({ traceTtlMs: 1_000, debugSidecarTtlMs: 1_000, exportTtlMs: 1_000,
  linkedRecordTtlMs: 1_000, deletionEnabled: true, tombstonesEnabled: true, legalHold: false });

function ids(): DecisionTelemetryIdSource {
  let value = 1;
  return { traceId: () => 'a'.repeat(32), spanId: () => (value++).toString(16).padStart(16, '0') };
}

/** Workflow trace whose spans link to a review owned by case-7 and a job owned by case-8. */
function linkedTrace(): DecisionTelemetryTrace {
  const builder = new DecisionTraceBuilder(ids(), () => 100);
  const root = builder.startSpan('decision.workflow', {
    attributes: { 'aiwg.run.id': 'run-7', 'aiwg.decision.status': 'success', 'aiwg.subject.note': CANARY },
    provenance: { 'aiwg.run.id': 'client-derived', 'aiwg.decision.status': 'client-derived' },
    links: [
      { traceId: 'b'.repeat(32), spanId: '1'.repeat(16), relationship: 'review',
        attributes: { 'aiwg.review.id': 'review-7', 'aiwg.review.status': CANARY } },
      { traceId: 'c'.repeat(32), spanId: '2'.repeat(16), relationship: 'job',
        attributes: { 'aiwg.job.id': 'job-8', 'aiwg.job.status': 'completed' } },
    ],
  });
  root.events.push({ name: 'review.note', timeUnixMs: 101, attributes: { 'aiwg.review.status': CANARY } });
  builder.endSpan(root, 'ok', 110);
  return builder.build();
}

function receipt(value: string): DecisionResult {
  const pin = { id: 'pin', version: '1.0.0', digest: `sha256:${'0'.repeat(64)}` as const };
  return {
    apiVersion: 'decision.aiwg.io/v1alpha1', kind: 'DecisionResult',
    metadata: { id: 'triage', version: '1.0.0', description: 'triage' },
    spec: {
      decision: pin, ruleset: pin, binding: pin, alias: 'triage', runId: 'run-7', invocationId: 'inv-7',
      status: 'success', value, reason: 'none', uncertainty: { confidence: 0.9 } as unknown as DecisionResult['spec']['uncertainty'],
      attempts: [{ ordinal: 1, adapter: 'fixture', adapterVersion: '1', requestedModel: 'm', actualModel: 'm', subagent: null,
        status: 'success', reason: 'none', durationMs: 3, usage: { inputTokens: 4, outputTokens: 1, costUsd: null },
        requestId: 'provider-request-7', requestIdSource: 'typesafe' }],
    },
  };
}

async function withRoot(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'decision-lifecycle-surfaces-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

describe('AC12d orphaned references become explicit tombstones', () => {
  it('LIFE-ORPHAN-01 rewrites a telemetry link to a deleted record as an explicit tombstone and keeps unrelated links', () => {
    const deleted = deleteTelemetryReference(linkedTrace(), 'review', 'review-7', 'subject erased', legacyRetention(), 500);
    const [review, job] = deleted.spans[0]!.links;
    expect(review).toEqual({ traceId: 'b'.repeat(32), spanId: '1'.repeat(16), relationship: 'review',
      attributes: { 'aiwg.link.state': 'deleted', 'aiwg.link.tombstone': 'review-7' } });
    expect(job?.attributes).toEqual({ 'aiwg.job.id': 'job-8', 'aiwg.job.status': 'completed' });
    expect(deleted.tombstones).toEqual([{ referenceType: 'review', opaqueId: 'review-7', deletedAtUnixMs: 500, reason: 'subject erased' }]);
    expect(JSON.stringify(deleted.spans[0]!.links)).not.toContain(CANARY);
    // The tombstone survives sanitized export as an explicit link state, not a broken reference.
    expect(sanitizedTelemetryExport(deleted).spans[0]!.links[0]!.attributes).toEqual({ 'aiwg.link.state': 'deleted', 'aiwg.link.tombstone': 'review-7' });
  });

  it('LIFE-ORPHAN-02 resolves a cross-surface reference to an erased subject record as a tombstone across restart', async () => withRoot(async root => {
    const erasers = Object.fromEntries(DECISION_LIFECYCLE_SURFACES.map(surface => [surface, vi.fn(async () => undefined)])) as
      Record<DecisionLifecycleSurface, (id: string) => Promise<void>>;
    const store = new FileDecisionLifecycleStore(root, erasers);
    const state7: DecisionLifecycleReference = { surface: 'state', opaqueId: 'state-7' };
    const review8: DecisionLifecycleReference = { surface: 'review', opaqueId: 'review-8' };
    await store.register('case-7', state7);
    await store.register('case-7', { surface: 'receipt', opaqueId: 'receipt-7' });
    await store.register('case-8', review8);
    // review-8 (unrelated subject) holds a cross-surface reference to state-7.
    expect(await store.resolveReference(state7)).toEqual({ state: 'linked', reference: state7 });
    await eraseDecisionSubject('case-7', policy(), store, 200);
    const restarted = new FileDecisionLifecycleStore(root, erasers);
    const resolved = await restarted.resolveReference(state7);
    expect(resolved).toEqual({ state: 'tombstoned', reference: state7, deletedAt: 200 });
    expect(JSON.stringify(resolved)).not.toContain('case-7');
    expect(await restarted.resolveReference(review8)).toEqual({ state: 'linked', reference: review8 });
    expect(await restarted.resolveReference({ surface: 'job', opaqueId: 'never-registered' }))
      .toEqual({ state: 'unknown', reference: { surface: 'job', opaqueId: 'never-registered' } });
    await expect(restarted.resolveReference({ surface: 'state', opaqueId: '../escape' })).rejects.toThrow(/opaque/);
  }));
});

describe('AC12g sanitized export after deletion', () => {
  it('LIFE-EXPORT-AFTER-ERASE-01 omits erased content and canaries while keeping non-sensitive audit facts', async () => withRoot(async root => {
    const receipts = new Map<string, DecisionResult>([['receipt-7', receipt(CANARY)]]);
    const reviews = new Map<string, string>([['review-7', `${CANARY} reviewer note`]]);
    let trace = linkedTrace();
    const store = new FileDecisionLifecycleStore(root, {
      // Receipt deletion erases body-bearing detail but keeps bounded audit identity.
      receipt: async id => {
        const value = receipts.get(id)!;
        delete value.spec.value;
        value.spec.uncertainty = null;
      },
      review: async id => {
        reviews.delete(id);
        trace = deleteTelemetryReference(trace, 'review', id, 'subject erased', legacyRetention(), 200);
      },
    });
    await store.register('case-7', { surface: 'receipt', opaqueId: 'receipt-7' });
    await store.register('case-7', { surface: 'review', opaqueId: 'review-7' });
    await eraseDecisionSubject('case-7', policy(), store, 200);

    const exportedResult = decisionResultForExport(receipts.get('receipt-7')!);
    const exportedTrace = sanitizedTelemetryExport(trace, { canaries: [CANARY] });
    const disclosure = { result: exportedResult, trace: exportedTrace };
    expect(reviews.has('review-7')).toBe(false);
    expect(JSON.stringify(disclosure)).not.toContain(CANARY);
    expect(scanTelemetryCanaries(disclosure, [CANARY])).toEqual([]);
    expect(JSON.stringify(disclosure)).not.toContain('provider-request-7');
    // Allowed audit facts remain.
    expect(exportedResult.spec).toMatchObject({ status: 'success', reason: 'none', runId: 'run-7', invocationId: 'inv-7' });
    expect(exportedResult.spec.value).toBeUndefined();
    expect(exportedResult.spec.attempts[0]).toMatchObject({ ordinal: 1, status: 'success', requestId: null });
    expect(exportedTrace.spans[0]!.attributes).toEqual({ 'aiwg.run.id': 'run-7', 'aiwg.decision.status': 'success' });
    expect(exportedTrace.spans[0]!.events).toEqual([]);
    expect(exportedTrace.spans[0]!.links[0]!.attributes).toEqual({ 'aiwg.link.state': 'deleted', 'aiwg.link.tombstone': 'review-7' });
    expect(exportedTrace.tombstones).toEqual([{ referenceType: 'review', opaqueId: 'review-7', deletedAtUnixMs: 200, reason: 'subject erased' }]);
    expect((await store.tombstones('case-7')).map(t => t.reference.surface).sort()).toEqual(['receipt', 'review']);
  }));
});

describe('AC12c subject-level backup and restore across lifecycle surfaces', () => {
  it('LIFE-BACKUP-01 refuses erased surfaces after restore while restoring an unrelated subject', async () => withRoot(async root => {
    type Live = Record<DecisionLifecycleSurface, Map<string, string>>;
    const live = Object.fromEntries(DECISION_LIFECYCLE_SURFACES.map(surface => [surface, new Map<string, string>()])) as Live;
    const erasers = Object.fromEntries(DECISION_LIFECYCLE_SURFACES.map(surface => [surface,
      async (id: string) => { live[surface].delete(id); }])) as Record<DecisionLifecycleSurface, (id: string) => Promise<void>>;
    const store = new FileDecisionLifecycleStore(root, erasers);
    const backup: DecisionLifecycleBackupEntry[] = [];
    for (const [subject, surfaces] of [['case-7', DECISION_LIFECYCLE_SURFACES], ['case-8', ['state', 'review', 'trace']]] as const) {
      for (const surface of surfaces) {
        const reference = { surface, opaqueId: `${surface}-${subject}` };
        live[surface].set(reference.opaqueId, subject === 'case-7' ? `${CANARY}:${surface}` : `body:${surface}`);
        await store.register(subject, reference);
        backup.push({ subject, reference, createdAt: 100 });
      }
    }
    // Backup taken before erasure: a full copy of every surface body.
    const snapshot = structuredClone(Object.fromEntries(Object.entries(live).map(([surface, map]) => [surface, [...map]])));
    await eraseDecisionSubject('case-7', policy(), store, 200);
    // Disaster: every surface is lost and restored from the pre-erasure backup.
    for (const map of Object.values(live)) map.clear();
    const restore = Object.fromEntries(DECISION_LIFECYCLE_SURFACES.map(surface => [surface, async (id: string) => {
      const body = new Map(snapshot[surface] as Array<[string, string]>).get(id);
      if (body !== undefined) live[surface].set(id, body);
    }])) as Record<DecisionLifecycleSurface, (id: string) => Promise<void>>;
    const restarted = new FileDecisionLifecycleStore(root, erasers);
    const tombstones = [...await restarted.tombstones('case-7'), ...await restarted.tombstones('case-8')];
    const report = await restoreDecisionSubjectBackup(backup, policy(), tombstones, restore, 300);

    expect(report.refused).toHaveLength(DECISION_LIFECYCLE_SURFACES.length);
    expect(report.refused.every(item => item.entry.subject === 'case-7' && item.reason === 'tombstoned')).toBe(true);
    expect(report.restored.map(item => item.reference.opaqueId).sort()).toEqual(['review-case-8', 'state-case-8', 'trace-case-8']);
    expect(JSON.stringify(Object.values(live).map(map => [...map]))).not.toContain(CANARY);
    expect(live.state.get('state-case-8')).toBe('body:state');
  }));

  it('LIFE-BACKUP-02 refuses expired, not-persisted, invalid and handler-less entries and fails closed on restore error', async () => {
    const value = policy(100);
    value.surfaces.cache.backup = 'not-persisted';
    const restored: string[] = [];
    const handler = async (id: string) => { restored.push(id); };
    const entry = (surface: DecisionLifecycleSurface, opaqueId: string, createdAt: number): DecisionLifecycleBackupEntry =>
      ({ subject: 'case-9', reference: { surface, opaqueId }, createdAt });
    const report = await restoreDecisionSubjectBackup([
      entry('state', 'fresh', 250), entry('state', 'expired', 100), entry('cache', 'not-persisted', 250),
      entry('unknown' as DecisionLifecycleSurface, 'bad', 250), entry('review', 'future', 400), entry('job', 'no-handler', 250),
    ], value, [], { state: handler, cache: handler, review: handler }, 300);
    expect(restored).toEqual(['fresh']);
    expect(report.refused.map(item => [item.entry.reference.opaqueId, item.reason])).toEqual([
      ['expired', 'expired'], ['not-persisted', 'not-persisted'], ['bad', 'invalid'], ['future', 'invalid'], ['no-handler', 'restore-unavailable'],
    ]);
    await expect(restoreDecisionSubjectBackup([entry('state', 'fresh', 250)], value, [],
      { state: async () => { throw new Error(CANARY); } }, 300)).rejects.toThrow('Decision lifecycle restore failed');
    const incomplete = policy(); delete (incomplete.surfaces as Partial<DecisionLifecyclePolicy['surfaces']>).job;
    await expect(restoreDecisionSubjectBackup([], incomplete, [], {}, 300)).rejects.toThrow(/incomplete/);
  });
});

describe('M09 telemetry retention derives from the common lifecycle policy', () => {
  const hold = (scope: DecisionLifecycleSurface[], expiresAt = 1_000): DecisionLifecycleHold =>
    ({ subject: 'case-7', reason: 'incident', scope, expiresAt, authorizedBy: 'privacy-owner' });

  it('M09-01 maps lifecycle surface TTLs onto telemetry retention', () => {
    const value = policy();
    value.surfaces.trace.retentionMs = 10; value.surfaces['debug-sidecar'].retentionMs = 20;
    value.surfaces.export.retentionMs = 30; value.surfaces.review.retentionMs = 50; value.surfaces.cache.retentionMs = 40;
    expect(telemetryRetentionFromLifecyclePolicy(value, [], 0)).toEqual({ traceTtlMs: 10, debugSidecarTtlMs: 20, exportTtlMs: 30,
      linkedRecordTtlMs: 40, deletionEnabled: true, tombstonesEnabled: true, legalHold: false, lifecycleVersion: 'decision-lifecycle/v1' });
  });

  it('M09-02 rejects an incomplete lifecycle policy instead of defaulting telemetry retention', () => {
    const value = policy(); delete (value.surfaces as Partial<DecisionLifecyclePolicy['surfaces']>).trace;
    expect(() => telemetryRetentionFromLifecyclePolicy(value)).toThrow(/incomplete/);
    const scopes = policy(); scopes.surfaces.trace.accessScopes = [];
    expect(() => telemetryRetentionFromLifecyclePolicy(scopes)).toThrow(/incomplete/);
  });

  it('M09-03 routes legal hold through active lifecycle holds on telemetry surfaces', () => {
    expect(telemetryRetentionFromLifecyclePolicy(policy(), [hold(['review'])], 500).legalHold).toBe(true);
    expect(telemetryRetentionFromLifecyclePolicy(policy(), [hold(['trace'], 400)], 500).legalHold).toBe(false);
    expect(telemetryRetentionFromLifecyclePolicy(policy(), [hold(['state', 'receipt'])], 500).legalHold).toBe(false);
    const held = telemetryRetentionFromLifecyclePolicy(policy(), [hold(['trace'])], 500);
    expect(() => deleteTelemetryReference(linkedTrace(), 'review', 'review-7', 'requested', held, 500)).toThrow(/legal hold/);
    expect(restoreTelemetryTrace(linkedTrace(), held, 10_000).spans).toHaveLength(1);
  });

  it('M09-04 derived policy drives deletion and restore TTL like the deprecated shape', () => {
    const value = policy(); value.surfaces.trace.retentionMs = 100;
    const derived = telemetryRetentionFromLifecyclePolicy(value, [], 500);
    expect(deleteTelemetryReference(linkedTrace(), 'review', 'review-7', 'erased', derived, 500).tombstones).toHaveLength(1);
    expect(restoreTelemetryTrace(linkedTrace(), derived, 150).spans).toHaveLength(1);
    expect(restoreTelemetryTrace(linkedTrace(), derived, 1_000).spans).toEqual([]);
    // The deprecated hand-set boolean shape still works.
    expect(() => deleteTelemetryReference(linkedTrace(), 'review', 'review-7', 'erased', { ...legacyRetention(), legalHold: true })).toThrow(/legal hold/);
  });
});
