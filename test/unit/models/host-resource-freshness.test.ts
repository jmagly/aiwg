import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { resolveWorkerPlan } from '../../../src/models/worker-plan.js';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';

const remote = JSON.parse(readFileSync('test/fixtures/host-resource-remote.json', 'utf8'));
const fixture = () => {
  const f = workerResolutionFixture();
  // Keep unrelated catalog/qualification evidence fresh; vary only the resource clock.
  f.snapshot.hostResources = { ...remote, collectedAt: f.request.now };
  return f;
};

it('carries the source collection time and age in a fresh admission verdict', () => {
  const f = fixture();
  f.snapshot.hostResources!.collectedAt = new Date(Date.parse(f.request.now) - 240_000).toISOString();
  const result = resolveWorkerPlan(f.snapshot, f.request);
  expect(result).toMatchObject({ status: 'eligible', slots: 1, resources: {
    freshness: { status: 'fresh', ageMs: 240_000, collectedAt: f.snapshot.hostResources!.collectedAt, evaluatedAt: new Date(f.request.now).toISOString() },
  } });
  expect(result.selected!.resources).toEqual(result.resources);
});

it.each([
  ['stale', { collectedAt: '2020-01-01T00:00:00Z' }, 'stale: resource snapshot age'],
  ['unavailable', { collectedAt: undefined }, 'unavailable: collection time'],
  ['unavailable', { collectedAt: 'bad' }, 'unavailable: collection time'],
  ['unavailable', { collectedAt: '2099-01-01T00:00:00Z' }, 'unavailable: collection time is in the future'],
  ['unavailable', { workers: undefined }, 'max_workers: unavailable: worker count'],
])('blocks %s remote snapshot admission with a named reason (%j)', (status, fields, reason) => {
  const f = fixture();
  Object.assign(f.snapshot.hostResources!, fields);
  const result = resolveWorkerPlan(f.snapshot, f.request);
  expect(result).toMatchObject({ status: 'blocked', selected: null, slots: 0,
    resources: { freshness: { status }, ok: false } });
  expect(result.diagnostics).toContainEqual(expect.objectContaining({
    pointer: '/parallelism/admission/hostResources', message: expect.stringContaining(reason),
  }));
  expect(result.exclusions.every(tuple => tuple.diagnostics.some(diagnostic => diagnostic.message.includes(reason)))).toBe(true);
});

it('blocks an absent host snapshot rather than bypassing admission or probing this host', () => {
  const f = fixture();
  delete f.snapshot.hostResources;
  const result = resolveWorkerPlan(f.snapshot, f.request);
  expect(result).toMatchObject({ status: 'blocked', selected: null, slots: 0,
    resources: { freshness: { status: 'unavailable', collectedAt: null, ageMs: null } } });
  expect(result.diagnostics.at(-1)?.message).toContain('host snapshot missing');
});

it.each([undefined, 600, 60])('applies host freshness ceiling %s to every tuple verdict', seconds => {
  const f = fixture();
  f.snapshot.hostResources!.collectedAt = new Date(Date.parse(f.request.now) - 360_000).toISOString();
  f.snapshot.config.parallelism!.admission = { hostResources: { max_snapshot_age_seconds: seconds } };
  const result = resolveWorkerPlan(f.snapshot, f.request);
  expect(result).toMatchObject({ status: 'blocked', slots: 0, resources: {
    freshness: { status: 'stale', maxAgeMs: Math.min(seconds ?? 300, 300) * 1000, ageMs: 360_000 },
  } });
  expect(result.diagnostics.at(-1)?.message).toContain('snapshot: stale: resource snapshot age 360000ms exceeds');
  expect(result.exclusions.length).toBeGreaterThan(1);
  for (const tuple of result.exclusions) expect(tuple.diagnostics.some(diagnostic => diagnostic.message.includes('snapshot: stale:'))).toBe(true);
});

it('keeps every tuple host snapshot independent of merged model observation freshness', () => {
  const f = fixture();
  f.snapshot.hostResources!.collectedAt = new Date(Date.parse(f.request.now) - 240_000).toISOString();
  const freshness = { blockHours: 1, warnHours: 1 };
  f.snapshot.models.defaults.workerSelection!.freshness = freshness;
  const result = resolveWorkerPlan(f.snapshot, f.request);
  expect(result).toMatchObject({ status: 'eligible', resources: {
    freshness: { status: 'fresh', ageMs: 240_000, maxAgeMs: 300_000 },
  } });
});
