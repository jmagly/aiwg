// Query caches preserve older observations on failure and never become installed packages.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSearchCachePath, listCachedPackages, readSearchCache, writeSearchCache } from '../../../src/marketplace/cache.js';
import type { SearchSnapshot } from '../../../src/marketplace/types.js';
let home: string;
const snapshot = (): SearchSnapshot => JSON.parse(fs.readFileSync(path.resolve('test/fixtures/marketplace-search/public/cache-valid.json'), 'utf8'));
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-search-cache-'));
  vi.stubEnv('AIWG_CACHE_DIR', path.join(home, '.aiwg/marketplace-cache'));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(home, { recursive: true, force: true }); });
describe('query discovery cache', () => {
  it('reads missing snapshots without creating files and uses an explicit home', () => {
    expect(readSearchCache('github', 'social media', home)).toBeNull();
    expect(fs.readdirSync(home)).toEqual([]);
    const value = snapshot(); writeSearchCache(value, home);
    expect(readSearchCache(value.source, value.query, home)).toEqual(value);
    expect(listCachedPackages()).toEqual([]);
  });
  it('keeps queries as opaque hashed names under the existing cache root', () => {
    const file = getSearchCachePath('github', '../../escape query', home);
    expect(path.dirname(file)).toBe(path.join(home, '.aiwg/marketplace-cache/github/search'));
    expect(path.basename(file)).toMatch(/^[a-f0-9]{64}\.json$/);
  });
  it('rejects invalid snapshots before creating a cache directory', () => {
    const value = snapshot(); value.fetchedAt = 'unknown';
    expect(() => writeSearchCache(value)).toThrow('Invalid discovery snapshot');
    expect(fs.readdirSync(home)).toEqual([]);
  });
  it('rejects a valid cache copied under the wrong query', () => {
    const value = snapshot(); writeSearchCache(value);
    const wrong = getSearchCachePath(value.source, 'other query');
    fs.copyFileSync(getSearchCachePath(value.source, value.query), wrong);
    expect(() => readSearchCache(value.source, 'other query')).toThrow('Invalid discovery cache');
  });
  it('preserves an older snapshot and removes temporary files when atomic replacement fails', () => {
    const value = snapshot(); writeSearchCache(value);
    const file = getSearchCachePath(value.source, value.query);
    const before = fs.readFileSync(file, 'utf8');
    value.fetchedAt = '2026-11-18T12:00:00.000Z';
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('fixture write failure'); });
    expect(() => writeSearchCache(value)).toThrow('fixture write failure');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(fs.readdirSync(path.dirname(file))).toEqual([path.basename(file)]);
  });
});
