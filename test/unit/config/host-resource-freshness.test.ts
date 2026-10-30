import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hostResourceReport } from '../../../src/config/host-resource-report.mjs';
import { readLiveHostResources } from '../../../src/config/host-resource-runtime.mjs';
import { hostResourceReaders } from '../../fixtures/host-resources.js';

const remote = () => JSON.parse(readFileSync('test/fixtures/host-resource-remote.json', 'utf8'));
const collected = Date.parse(remote().collectedAt);
const maxAgeMs = 300_000;
const report = (ageMs: number, live = remote(), extra = {}) => hostResourceReport({ live, now: () => collected + ageMs, ...extra });

describe('host snapshot freshness', () => {
  it('uses the explicit decision clock for local collection even when readers supply another clock', () => {
    const result = hostResourceReport({ now: () => collected,
      readers: { ...hostResourceReaders(), now: () => collected - 7 * 86400_000 } });
    expect(result).toMatchObject({ ok: true, freshness: {
      status: 'fresh', collectedAt: remote().collectedAt, evaluatedAt: remote().collectedAt, ageMs: 0,
    } });
    expect(result.measured.collectedAt).toBe(remote().collectedAt);
  });

  it('uses the readers clock for both local collection and evaluation when no explicit clock is supplied', () => {
    const result = hostResourceReport({ readers: { ...hostResourceReaders(), now: () => collected } });
    expect(result).toMatchObject({ ok: true, freshness: {
      status: 'fresh', collectedAt: remote().collectedAt, evaluatedAt: remote().collectedAt, ageMs: 0,
    } });
  });

  it('timestamps live collection before reading signals with an injected clock', () => {
    let clock = collected;
    const readers = hostResourceReaders();
    const result = hostResourceReport({ now: () => clock, readers: { ...readers, readText: filename => {
      clock += 1000; return readers.readText(filename);
    } } });
    expect(result.measured.collectedAt).toBe(remote().collectedAt);
    expect(result.freshness).toMatchObject({ collectedAt: remote().collectedAt, ageMs: 3000, status: 'fresh' });
    expect(readLiveHostResources({ ...readers, now: () => collected }).collectedAt).toBe(remote().collectedAt);
  });

  it('keeps a synthetic SSH JSON snapshot fresh through the inclusive five-minute host limit', () => {
    for (const ageMs of [0, 60_000, 240_000, maxAgeMs]) {
      expect(report(ageMs)).toMatchObject({ ok: true, slots: 4,
        freshness: { status: 'fresh', collectedAt: remote().collectedAt, ageMs, maxAgeMs }, thresholds: { max_workers: 5 } });
    }
  });

  it('blocks stale cached snapshots without restamping collection time', () => {
    const cached = JSON.parse(JSON.stringify(report(0)));
    const result = report(maxAgeMs + 1, cached.measured);
    expect(result).toMatchObject({ ok: false, slots: 0, limitingThreshold: 'snapshot',
      freshness: { status: 'stale', ageMs: maxAgeMs + 1, collectedAt: remote().collectedAt } });
    expect(result.failures).toContainEqual({ signal: 'snapshot', reason: `stale: resource snapshot age ${maxAgeMs + 1}ms exceeds ${maxAgeMs}ms` });
    expect(cached.freshness.status).toBe('fresh');
  });

  it.each([undefined, '', 'invalid'])('blocks unavailable collection time (%s)', collectedAt => {
    const result = report(0, { ...remote(), collectedAt });
    expect(result).toMatchObject({ ok: false, slots: 0, freshness: { status: 'unavailable', collectedAt: null, ageMs: null } });
    expect(result.failures[0]).toEqual({ signal: 'snapshot', reason: 'unavailable: collection time or evaluation clock missing or invalid' });
  });

  it('blocks future collection time and an invalid evaluation clock', () => {
    expect(report(-1)).toMatchObject({ ok: false, slots: 0, freshness: { status: 'unavailable', ageMs: -1 },
      failures: [{ signal: 'snapshot', reason: 'unavailable: collection time is in the future' }] });
    expect(report(NaN)).toMatchObject({ ok: false, freshness: { evaluatedAt: null, ageMs: null, status: 'unavailable' } });
  });

  it('blocks a six-minute snapshot with its age and the five-minute reason', () => {
    expect(report(360_000)).toMatchObject({ ok: false, slots: 0,
      freshness: { status: 'stale', ageMs: 360_000, maxAgeMs },
      failures: [{ signal: 'snapshot', reason: 'stale: resource snapshot age 360000ms exceeds 300000ms' }] });
  });

  it('uses a configured 60-second host ceiling with its origin', () => {
    const extra = { thresholdOverlay: { max_snapshot_age_seconds: 60 } };
    expect(report(60_000, remote(), extra)).toMatchObject({ ok: true,
      freshness: { status: 'fresh', maxAgeMs: 60_000 },
      thresholds: { max_snapshot_age_seconds: 60 }, origins: { max_snapshot_age_seconds: ['task'] } });
    expect(report(60_001, remote(), extra)).toMatchObject({ ok: false,
      freshness: { status: 'stale', maxAgeMs: 60_000 } });
  });

  it.each([
    ['availMemGb', 'min_avail_mem_gb'], ['loadRatio', 'max_load_ratio'], ['memPsiAvg10', 'max_mem_psi_avg10'],
    ['memPsiAvg60', 'max_mem_psi_avg60'], ['workers', 'max_workers'], ['freeDiskGb', 'min_free_disk_gb'],
    ['load1', 'max_load_ratio'], ['cores', 'max_load_ratio'],
  ])('labels unavailable required %s and names its threshold', (field, signal) => {
    for (const value of [undefined, null, NaN, Infinity]) {
      const result = report(1000, { ...remote(), [field]: value });
      expect(result).toMatchObject({ ok: false, slots: 0, freshness: { status: 'unavailable', ageMs: 1000 } });
      expect(result.failures).toContainEqual(expect.objectContaining({ signal, reason: expect.stringContaining('unavailable:') }));
    }
  });

  it('blocks zero cores rather than declaring CPU headroom measurable', () => {
    expect(report(0, { ...remote(), cores: 0 })).toMatchObject({ ok: false, slots: 0,
      freshness: { status: 'unavailable' }, failures: expect.arrayContaining([{
        signal: 'max_load_ratio', reason: 'unavailable: load headroom requires detectable load1 and positive cores',
      }]) });
  });

  it('retains freshness even when thresholds are invalid or the host is unsupported', () => {
    expect(report(1000, remote(), { thresholdOverlay: { max_workers: 0 } })).toMatchObject({ ok: false,
      thresholds: null, freshness: { ageMs: 1000, status: 'fresh' } });
    expect(report(0, { supported: false, collectedAt: remote().collectedAt })).toMatchObject({ ok: false,
      freshness: { status: 'unavailable' }, failures: expect.arrayContaining([{ signal: 'platform', reason: expect.stringContaining('unavailable:') }]) });
  });
});
