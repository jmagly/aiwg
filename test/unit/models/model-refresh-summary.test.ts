// Refresh output is independent of the size and contents of model rows.
import { expect, it } from 'vitest';
import { summarizeModelRefresh } from '../../../src/models/model-refresh-summary.js';

it('reports counts, cache location and warnings without serializing model rows', () => {
  const model = { id: 'synthetic', get worker(): never { throw new Error('row serialized'); } };
  const result = summarizeModelRefresh({ version: '1', providers: {}, discovery: {
    source: 'static', fetchedAt: '2026-11-24T00:00:00Z', remoteError: 'x'.repeat(10000), providers: {
      cursor: { provider: 'cursor', source: 'native', observedAt: '', accountScope: 'synthetic',
        models: Array(10000).fill(model) },
      factory: { provider: 'factory', source: 'native', observedAt: '', accountScope: 'synthetic',
        models: [], errorKind: 'command', error: 'unavailable' },
    },
  } }, '/tmp/synthetic-cache.json');
  expect(result).toMatchObject({ source: 'static', fetchedAt: '2026-11-24T00:00:00Z',
    cachePath: '/tmp/synthetic-cache.json', modelCount: 10000, providers: [
      { provider: 'cursor', modelCount: 10000 }, { provider: 'factory', modelCount: 0, errorKind: 'command' },
    ], warnings: ['x'.repeat(512), 'factory: unavailable'] });
  expect(JSON.stringify(result).length).toBeLessThan(2048);
});

it('handles catalogs without discovery and error kinds without messages', () => {
  expect(summarizeModelRefresh({ version: '1', providers: {} }, '/cache')).toEqual({
    source: 'static', cachePath: '/cache', modelCount: 0, providers: [], warnings: [],
  });
  expect(summarizeModelRefresh({ version: '1', providers: {}, discovery: {
    source: 'static', fetchedAt: '', providers: {
      cursor: { provider: 'cursor', source: 'native', observedAt: '', accountScope: 'synthetic',
        models: [], errorKind: 'command' },
    },
  } }, '/cache').warnings).toEqual(['cursor: command']);
});
