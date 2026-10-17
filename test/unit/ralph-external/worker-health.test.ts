/** Synthetic ACP and bounded replay vectors for #2994/#2965. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { GrokBuildAdapter } from '../../../tools/ralph-external/lib/grok-build-adapter.mjs';
import { createWorkerHealthObserver, observeProviderHealthEvent, PROGRESS_CHURN_LIMITS } from '../../../tools/ralph-external/lib/worker-health.mjs';

const source = { kind: 'stdout' };
const health = { handshake: 'semantic', outputFraming: 'jsonl', progressEvidence: ['tool-call'], coverage: 'full' };
function fixture() {
  let now = 0;
  const observer = createWorkerHealthObserver({ health, now: () => now, wallNow: () => Date.UTC(2026, 9, 8) });
  observer.observe({ kind: 'accepted' });
  return { observer, progress(key: string) { now++; observer.observe({ kind: 'progress', key }); }, set(time: number) { now = time; } };
}

describe('legacy Grok observer ACP grammar', () => {
  const direct = new GrokBuildAdapter();
  it('replays the documented ACP fixture through the shared observer with chunked framing', () => {
    const base = new URL('../../fixtures/providers/grok-build/health/', import.meta.url);
    const wire = readFileSync(new URL('stream.ndjson', base));
    const manifest = JSON.parse(readFileSync(new URL('manifest.json', base), 'utf8'));
    const observer = createWorkerHealthObserver({ provider: 'grok-build', health: { ...health, handshake: 'process-only' } });
    observer.processStarted({ pid: 123, startTicks: '1', executable: '/synthetic/grok' });
    // Small chunks cut through both JSON fields and line boundaries.
    for (let offset = 0; offset < wire.length; offset += 7) observer.feed(wire.subarray(offset, offset + 7));
    expect(observer.evidence().events.map(event => event.kind)).toEqual(manifest.expectedKinds);
    expect(observer.snapshot().lastProgressAt).not.toBeNull();
    expect(observer.finish({ exitCode: 0, termination: 'confirmed', finalValid: true }).state).toBe('completed');
  });
  it.each([
    { type: 'text', data: 'synthetic' }, { type: 'thought', data: 'synthetic' },
    { type: 'usage', messageId: 'm1' }, { type: 'plan', entries: [] }, { type: 'available_commands' },
    { type: 'tool_call', toolCallId: 't1', status: 'in_progress' },
    { type: 'tool_call_update', toolCallId: 't1', status: 'completed' },
    { type: 'tool_call_update', status: 'completed' },
    { type: 'tool_call', toolCallId: 't1', status: 'failed' },
    { type: 'tool_call_update', toolCallId: 't1', status: 'failed' },
    { type: 'end', stopReason: 'end_turn' }, { type: 'end', stopReason: 'refusal' },
    { type: 'end' }, { type: 'error', message: 'synthetic failure' },
    { type: 'message' }, { type: 'result' },
  ])('agrees with the unchanged direct adapter for %j', event => {
    expect(observeProviderHealthEvent('grok-build', event, source, {})).toEqual(direct.observeHealthEvent(event, source, {}));
  });
  it('rejects foreign identities and unqualified sources', () => {
    for (const key of ['sessionId', 'requestId']) {
      const event = { type: 'end', stopReason: 'end_turn', [key]: 'other' };
      expect(observeProviderHealthEvent('grok-build', event, source, { [key]: 'bound' })).toBeNull();
    }
    expect(observeProviderHealthEvent('grok-build', { type: 'text' }, { kind: 'session-log' }, {})).toBeNull();
  });
  it('recognizes ACP activity/progress with process-only startup and latches errors', () => {
    const observer = createWorkerHealthObserver({ provider: 'grok-build', health: { ...health, handshake: 'process-only' } });
    observer.processStarted({ pid: 123, startTicks: '1', executable: '/synthetic/grok' });
    const feed = (event: unknown) => observer.feed(`${JSON.stringify(event)}\n`);
    feed({ type: 'text', data: 'synthetic' });
    expect(observer.snapshot().lastProgressAt).toBeNull();
    feed({ type: 'tool_call_update', toolCallId: 't1', status: 'completed' });
    expect(observer.snapshot()).toMatchObject({ state: 'active', handshake: 'process-only' });
    feed({ type: 'tool_call_update', toolCallId: 't2', status: 'failed' });
    feed({ type: 'end', stopReason: 'end_turn' });
    expect(observer.shouldStop()).toBe(true);
    expect(observer.finish({ exitCode: 0, termination: 'confirmed', finalValid: true }).state).toBe('failed');
  });
});

describe('bounded rotating progress identities', () => {
  it('detects at exactly 32 distinct evicted replays and keeps the last novel clock', () => {
    const f = fixture();
    for (let i = 0; i < 513; i++) f.progress(`key-${i}`);
    const progress = f.observer.snapshot().lastProgressAt;
    for (let i = 0; i < PROGRESS_CHURN_LIMITS.repeatedEvictedKeys - 1; i++) f.progress(`key-${i}`);
    expect(f.observer.snapshot().unavailableSignals).not.toContain('progress-key-churn');
    f.progress(`key-${PROGRESS_CHURN_LIMITS.repeatedEvictedKeys - 1}`);
    expect(f.observer.snapshot()).toMatchObject({ coverage: 'degraded', lastProgressAt: progress });
    expect(f.observer.snapshot().unavailableSignals).toEqual(expect.arrayContaining(['semantic-progress', 'progress-key-churn']));
    f.progress('new-after-churn');
    expect(f.observer.snapshot().lastProgressAt).toBe(progress);
    f.set(300513); expect(f.observer.check()).toMatchObject({ state: 'stalled', confidence: 'suspected' });
  });
  it('retains cycles up to the explicit history boundary', () => {
    const f = fixture();
    for (let i = 0; i < PROGRESS_CHURN_LIMITS.historyKeys; i++) f.progress(`key-${i}`);
    for (let i = 0; i < PROGRESS_CHURN_LIMITS.repeatedEvictedKeys; i++) f.progress(`key-${i}`);
    expect(f.observer.snapshot().unavailableSignals).toContain('progress-key-churn');
  });
  it('allows varied fresh progress beyond both memory bounds, including adjacent duplicates', () => {
    const f = fixture();
    for (let i = 0; i < PROGRESS_CHURN_LIMITS.historyKeys + 1024; i++) {
      f.progress(`key-${i}`); f.progress(`key-${i}`);
    }
    expect(f.observer.snapshot()).toMatchObject({ state: 'active', coverage: 'full' });
    expect(f.observer.snapshot().unavailableSignals).not.toContain('semantic-progress');
  });
  it('fresh keys interrupt replay suspicion; FIFO duplicates alone never downgrade', () => {
    const f = fixture();
    for (let i = 0; i < 513; i++) f.progress(`key-${i}`);
    for (let i = 0; i < 31; i++) f.progress(`key-${i}`);
    f.progress('fresh');
    for (let i = 31; i < 62; i++) f.progress(`key-${i}`);
    for (let i = 0; i < 100; i++) f.progress('key-61');
    expect(f.observer.snapshot().unavailableSignals).not.toContain('progress-key-churn');
  });
  it.each([511, 512])('a cycle of %s identities stays inside ordinary dedup without churn downgrade', size => {
    const f = fixture();
    for (let i = 0; i < size * 3; i++) f.progress(`key-${i % size}`);
    expect(f.observer.snapshot().unavailableSignals).not.toContain('progress-key-churn');
    f.set(size + 300000);
    expect(f.observer.check().state).toBe('stalled');
  });
  it('restored snapshots preserve the run-long semantic downgrade', () => {
    const f = fixture();
    for (let i = 0; i < 545; i++) f.progress(`key-${i % 513}`);
    const initial = f.observer.snapshot();
    const restored = createWorkerHealthObserver({ health, initialSnapshot: initial,
      now: () => 1000, launchTime: '2026-10-08T00:00:01.000Z' });
    restored.observe({ kind: 'progress', key: 'fresh-after-restore' });
    expect(restored.snapshot().lastProgressAt).toBe(initial.lastProgressAt);
    expect(restored.snapshot().unavailableSignals).toContain('progress-key-churn');
  });
  it('independent worktree content remains progress after stream churn', () => {
    const f = fixture();
    for (let i = 0; i < 545; i++) f.progress(`key-${i % 513}`);
    f.observer.sampleActivity({ content: 'first' }); f.set(1000);
    f.observer.sampleActivity({ content: 'changed' });
    expect(f.observer.snapshot()).toMatchObject({ state: 'active', lastProgressAt: '2026-10-08T00:00:01.000Z' });
    expect(f.observer.snapshot().unavailableSignals).toContain('progress-key-churn');
  });
});
