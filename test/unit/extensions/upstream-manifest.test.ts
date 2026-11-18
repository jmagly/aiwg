// Pinned upstream provenance extends the existing strict bundle manifest.
import { describe, expect, it } from 'vitest';
import { BundleManifestSchema } from '../../../src/extensions/manifest.js';

const manifest = {
  id: 'community', type: 'addon', name: 'Community', version: '1.0.0',
  description: 'Imported community skills', manifestVersion: '1',
  platforms: { claude: 'full' }, keywords: ['community'],
  deployment: { pathTemplate: '.{platform}/skills/{id}.md' },
  addonConfig: { entry: { skills: 'skills/' } },
};
const upstream = {
  repo: 'https://github.com/coreyhaines31/marketingskills',
  commit: 'a'.repeat(40), license: 'MIT',
  skills: ['sales-enablement'], renames: { 'sales-enablement': 'marketingskills-sales-enablement' },
};

describe('bundle upstream provenance', () => {
  it('accepts pinned repositories and local renames without relaxing strict keys', () => {
    expect(BundleManifestSchema.parse({ ...manifest, upstream: [upstream] }).upstream).toEqual([upstream]);
  });
  it.each([
    { commit: 'main' }, { commit: 'a'.repeat(39) }, { repo: '' },
    { skills: ['../escape'] }, { renames: { 'sales-enablement': '../escape' } },
    { renames: { other: 'local-other' } }, { surprise: true },
    { repo: 'https://user:secret@example.org/repo' },
  ])('rejects invalid provenance %j', (invalid) => {
    expect(BundleManifestSchema.safeParse({ ...manifest, upstream: [{ ...upstream, ...invalid }] }).success).toBe(false);
  });
});
