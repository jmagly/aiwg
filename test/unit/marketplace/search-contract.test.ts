// Recorded valid and invalid snapshots keep discovery data under the catalog schema.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { validateSearchSnapshot } from '../../../src/marketplace/search-contract.js';

const fixture = (name: string) => JSON.parse(fs.readFileSync(path.resolve(`test/fixtures/marketplace-search/public/cache-${name}.json`), 'utf8'));
describe('public observation cache schema', () => {
  it('reports a missing shipped schema before accepting snapshots', async () => {
    vi.resetModules();
    const { validateSearchSnapshot: validate } = await import('../../../src/marketplace/search-contract.js');
    const exists = vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    try { expect(() => validate(fixture('valid'))).toThrow('Marketplace catalog schema is unavailable'); }
    finally { exists.mockRestore(); }
  });
  it('accepts the valid dated fixture', () => {
    expect(validateSearchSnapshot(fixture('valid'))).toBe(true);
  });
  it('rejects the invalid undated signal fixture', () => {
    expect(validateSearchSnapshot(fixture('invalid'))).toBe(false);
  });
  it.each([
    (v: any) => { v.unreviewed = true; },
    (v: any) => { v.observations[0].signals.installs.value = -1; },
    (v: any) => { v.observations[0].signals.installs.value = '100'; },
    (v: any) => { v.observations[0].signals.lastPush = { value: 'invalid', source: v.endpoint, asOf: v.fetchedAt }; },
    (v: any) => { v.source = 'imaginary'; },
    (v: any) => { v.fetchedAt = 'not-a-date'; },
    (v: any) => { delete v.observations[0].signals.installs.source; },
    (v: any) => { v.observations[0].signals.unverified = v.observations[0].signals.installs; },
    (v: any) => { v.observations[0].signals.installs.value = null; },
  ])('rejects invalid extensions, dates and observation provenance', mutate => {
    const value = fixture('valid'); mutate(value);
    expect(validateSearchSnapshot(value)).toBe(false);
  });
});
