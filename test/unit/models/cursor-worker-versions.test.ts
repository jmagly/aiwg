// Cursor self-updates retain the lower bound and surface the explicit refresh path.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildDirectWorkerDoctorSection, diagnoseDirectWorkerReadiness, probeDirectWorkerVersion } from '../../../src/models/worker-direct-readiness.js';
import { boundedVersionProbe, normalizeWorkerVersionBanner, workerVersionProbeEnvironment, workerVersionRangeMismatch } from '../../../src/models/worker-installation.mjs';
import { cursorWorkerVersionWarning, workerComparableVersion } from '../../../src/models/cursor-worker-version.mjs';
import { fakeCli, installDirectWorkerFixtures, parallelismWith, registry, scratchDir } from './worker-direct-readiness.fixtures.js';

const builds: Array<{ version: string; ready: boolean; newer: boolean }> = JSON.parse(
  readFileSync(new URL('../../fixtures/providers/cursor/version-builds.json', import.meta.url), 'utf8'));
installDirectWorkerFixtures();

describe('#4306 Cursor build compatibility', () => {
  it.each(builds)('$version readiness=$ready newer=$newer', async ({ version, ready, newer }) => {
    const input = {
      parallelism: parallelismWith({ cursor: { adapter: 'providers:cursor', executable: await fakeCli(version),
        accountScope: 'synthetic', quotaScope: 'synthetic' } }),
      registry: registry(), probe: probeDirectWorkerVersion, probeCwd: await scratchDir('aiwg-cursor-version-'),
    };
    const report = await diagnoseDirectWorkerReadiness(input);
    expect(report.ready).toBe(ready);
    const install = report.findings.find(row => row.kind === 'install')!;
    expect(install.readiness).toBe(ready ? 'ready' : 'not-ready');
    if (ready) {
      expect(install.installedVersion).toBe(version); // Approval still binds the exact build.
      expect(install.code).toBe('WORKER_DIRECT_READY');
      expect(install.status).toBe(newer ? 'warn' : 'ok');
    }
    const section = await buildDirectWorkerDoctorSection({ ...input, probeWorkers: true });
    const message = section.lines.map(row => row.message).join('\n');
    if (newer) {
      expect(message).toContain('newer than tested');
      expect(message).toContain('2026.11.13-eacade1');
      expect(message).toContain('aiwg doctor --probe-workers --qualify --cli cursor --yes');
      expect(message).toContain('manual smoke');
      expect(message).not.toContain('upgrade or pin');
    }
  });

  it.each(builds.filter(row => row.version !== 'unknown'))('compares the date rather than the hash: $version', row => {
    expect(workerVersionRangeMismatch(row.version, ['>=2026.11.13'], 'cursor'))
      .toBe(row.ready ? null : '>=2026.11.13');
  });

  it('keeps prerelease comparison unchanged for other providers and enforces both ranges', () => {
    expect(workerVersionRangeMismatch('2026.11.19-f005e9d', ['>=2026.11.13'])).toBe('>=2026.11.13');
    expect(workerVersionRangeMismatch('2026.11.19-f005e9d', ['>=2026.11.13'], 'other')).toBe('>=2026.11.13');
    expect(workerVersionRangeMismatch('2026.11.19-f005e9d', ['>=2026.11.13', '<2026.11.19'], 'cursor')).toBe('<2026.11.19');
  });

  it.each(['2026.13.19-f005e9d', '2026.11.31-f005e9d', '2026.0.19-f005e9d', '0000.11.19-f005e9d', '2026.11.19', '1.2.3', '2026.11.19-rc.1'])(
    'blocks unknown Cursor release formats and invalid dates: %s', version => {
      expect(workerVersionRangeMismatch(version, ['>=2026.11.13'], 'cursor')).toBe('>=2026.11.13');
    });

  it.each(['health', 'provenance'] as const)('does not invent a tested build when %s metadata is absent', async missing => {
    const capabilities = registry();
    const profile = capabilities.providers.cursor.workerHealthAdapter!.invocationProfiles!['direct-shell'];
    if (missing === 'health') delete profile.health;
    else delete profile.health!.provenance;
    const report = await diagnoseDirectWorkerReadiness({
      parallelism: parallelismWith({ cursor: { adapter: 'providers:cursor' } }), registry: capabilities,
      probe: async () => ({ ok: true, rawBanner: '2026.11.19-f005e9d' }),
    });
    expect(report.ready).toBe(true);
    expect(report.findings.find(row => row.kind === 'install')).toMatchObject({ status: 'ok', readiness: 'ready' });
  });

  it('normalizes decimal date cores and chooses the latest known tested release', () => {
    expect(workerComparableVersion('2026.10.01-e373342', 'cursor')).toBe('2026.10.1');
    const tested = [null, 'unknown', '2026.11.11-b912975', '2026.11.13-eacade1', '2026.10.01-e373342'];
    expect(cursorWorkerVersionWarning('2026.11.19-f005e9d', tested, 'cursor-local')).toContain('--cli cursor-local --yes');
    expect(cursorWorkerVersionWarning('2026.11.19-f005e9d', tested, 'cursor')).toContain('2026.11.13-eacade1');
    expect(cursorWorkerVersionWarning('unknown', tested, 'cursor')).toBeNull();
    expect(cursorWorkerVersionWarning('2026.11.19-f005e9d', [null], 'cursor')).toBeNull();
    expect(cursorWorkerVersionWarning('2026.11.11-b912975', tested, 'cursor')).toBeNull();
  });

  it('retains numeric Cursor hashes in the bounded installation probe without relaxing other providers', async () => {
    const version = '2026.11.19-0001234';
    const pattern = '^([0-9A-Za-z.+-]{1,128})$';
    const result = await boundedVersionProbe(await fakeCli(version), ['--version'], workerVersionProbeEnvironment(),
      await scratchDir('aiwg-cursor-numeric-hash-'), 5000, 4096, pattern, 'cursor');
    expect(result.version).toBe(version);
    expect(() => normalizeWorkerVersionBanner(version, pattern)).toThrow('not semver');
    expect(() => normalizeWorkerVersionBanner(version, pattern, 'other')).toThrow('not semver');
  });
});
