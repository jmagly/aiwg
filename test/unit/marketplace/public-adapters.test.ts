// Public search response edge cases preserve unknowns instead of inventing signals.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { marketplaceSearchAdapters } from '../../../src/marketplace/registry.js';
import type { SearchSourceId } from '../../../src/marketplace/types.js';
const asOf = '2026-11-17T12:00:00.000Z';
function normalize(source: SearchSourceId, body: unknown) {
  const adapter = marketplaceSearchAdapters.find(item => item.source === source)!;
  return adapter.normalize(body, adapter.endpoint('social media'), asOf);
}
const fixture = (source: string) => JSON.parse(fs.readFileSync(path.resolve(`test/fixtures/marketplace-search/public/${source}.json`), 'utf8'));
describe('public discovery adapters', () => {
  it('keeps zero installs, falls back to the skill ID and marks a limited directory', () => {
    const body = fixture('skills.sh');
    body.skills[0].installs = 0; delete body.skills[0].name; body.count = 1000;
    const result = normalize('skills.sh', body);
    expect(result.limited).toBe(true);
    expect(result.observations[0]).toMatchObject({ name: 'social-media', signals: { installs: { value: 0, asOf } } });
  });
  it('does not coerce strings, fractional counts or negative installs into popularity', () => {
    for (const installs of ['1400000', 1.5, -1, null]) {
      const body = fixture('skills.sh'); body.skills[0].installs = installs;
      expect(normalize('skills.sh', body).observations[0].signals.installs).toMatchObject({ value: null, asOf: null });
    }
  });
  it('keeps missing MCP version, repository and provider dates unknown', () => {
    const body = { servers: [{ server: { name: 'example/social-tools' } }] };
    expect(normalize('mcp-registry', body).observations[0]).toMatchObject({
      description: '', repository: null,
      signals: { version: { value: null, asOf: null }, publishedAt: { value: null }, updatedAt: { value: null } },
    });
  });
  it('does not equate NOASSERTION with a known free license or invent keywords', () => {
    const body = fixture('github'); body.items[0].license.spdx_id = 'NOASSERTION';
    body.items[0].topics = null; body.incomplete_results = true;
    const result = normalize('github', body);
    expect(result.limited).toBe(true);
    expect(result.observations[0]).toMatchObject({ keywords: [], signals: { license: { value: null, asOf: null } } });
  });
  it.each(['mcp-registry', 'github', 'skills.sh'] as const)('rejects malformed %s response shapes', source => {
    for (const body of [null, [], {}, { servers: [null], items: [[]], skills: [null] }]) {
      expect(() => normalize(source, body)).toThrow(/response/i);
    }
    const body = fixture(source);
    if (source === 'github') body.items[0].full_name = '';
    if (source === 'skills.sh') body.skills[0].id = null;
    if (source === 'mcp-registry') body.servers[0].server.name = '';
    expect(() => normalize(source, body)).toThrow(/identity/i);
  });
});
