// Keep the Grok direct-worker release pin aligned with the existing range policy.
import { describe, expect, it } from 'vitest';
import { loadProviderModelCapabilities } from '../../../src/models/provider-policy.js';
import { workerVersionRangeMismatch } from '../../../src/models/worker-installation.mjs';
import { GrokBuildAdapter, GROK_BUILD_SUPPORTED_VERSIONS } from '../../../tools/ralph-external/lib/grok-build-adapter.mjs';

describe('Grok Build direct-worker supported release', () => {
  it('pins adapter and profile to exactly 1.0.77 and 1.0.92', () => {
    const adapter = loadProviderModelCapabilities().providers['grok-build'].workerHealthAdapter!;
    const profile = adapter.invocationProfiles!['direct-shell'];
    expect(GROK_BUILD_SUPPORTED_VERSIONS).toEqual(['1.0.77', '1.0.92']);
    const ranges = [adapter.supportedVersions, profile.supportedVersions];
    expect(ranges).toEqual(['1.0.77 || 1.0.92', '1.0.77 || 1.0.92']);
    for (const version of GROK_BUILD_SUPPORTED_VERSIONS) expect(workerVersionRangeMismatch(version, ranges)).toBeNull();
    for (const version of ['1.0.50', '1.0.76', '1.0.78', '1.0.91', '1.0.93', '1.0.92-preview', '2.0.0']) {
      expect(workerVersionRangeMismatch(version, ranges)).toBe('1.0.77 || 1.0.92');
    }
    expect(adapter.invocation.argv).toEqual(expect.arrayContaining(['-m', '${model}']));
    expect(adapter.qualification.status).toBe('unqualified');
  });

  it.each(['read-only', 'workspace-write'])('removes every native fan-out tool for %s direct workers', sandbox => {
    const profile = loadProviderModelCapabilities().providers['grok-build'].workerHealthAdapter!;
    const argv = new GrokBuildAdapter().buildWorkerArgs({ cwd: '/synthetic/project', briefPath: '/synthetic/brief.md',
      selected: { model: 'synthetic-grok/model', effort: { value: 'low' } } }, null, { sandbox });
    for (const args of [profile.invocation.argv, argv]) {
      expect(args.slice(args.indexOf('--no-subagents'), args.indexOf('--no-subagents') + 3))
        .toEqual(['--no-subagents', '--disallowed-tools', 'workflow,scheduler_create,scheduler_list,scheduler_delete']);
    }
  });
});
