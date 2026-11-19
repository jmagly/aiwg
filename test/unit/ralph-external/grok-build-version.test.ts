// Keep the Grok direct-worker release pin aligned with the existing range policy.
import { describe, expect, it } from 'vitest';
import { loadProviderModelCapabilities } from '../../../src/models/provider-policy.js';
import { workerVersionRangeMismatch } from '../../../src/models/worker-installation.mjs';
import { GROK_BUILD_SUPPORTED_VERSIONS } from '../../../tools/ralph-external/lib/grok-build-adapter.mjs';

describe('Grok Build direct-worker supported release', () => {
  it('pins adapter and profile to 1.0.77 while retaining exact semver matching', () => {
    const adapter = loadProviderModelCapabilities().providers['grok-build'].workerHealthAdapter!;
    const profile = adapter.invocationProfiles!['direct-shell'];
    expect(GROK_BUILD_SUPPORTED_VERSIONS).toEqual(['1.0.77']);
    const ranges = [adapter.supportedVersions, profile.supportedVersions];
    expect(ranges).toEqual(['1.0.77', '1.0.77']);
    expect(workerVersionRangeMismatch('1.0.77', ranges)).toBeNull();
    for (const version of ['1.0.50', '1.0.76', '1.0.78', '2.0.0']) {
      expect(workerVersionRangeMismatch(version, ranges)).toBe('1.0.77');
    }
    expect(adapter.invocation.argv).toEqual(expect.arrayContaining(['-m', '${model}']));
    expect(adapter.qualification.status).toBe('unqualified');
  });
});
