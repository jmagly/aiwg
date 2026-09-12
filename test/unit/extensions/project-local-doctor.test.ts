/**
 * Unit tests for the project-local doctor section (#1037 / DC-1)
 *
 * @source @src/extensions/project-local-doctor.ts
 * @design @.aiwg/architecture/design-doctor-log-promote.md
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import { buildProjectLocalDoctorSection } from '../../../src/extensions/project-local-doctor.js';
import { deployProjectQuickref } from '../../../src/extensions/project-quickref.js';
import type { AiwgConfig } from '../../../src/config/aiwg-config.js';
import { PROJECT_LOCAL_SEARCH_PATHS_ENV } from '../../../src/extensions/project-local-paths.js';

const ARTIFACT_ENV_KEYS = [
  'AIWG_ARTIFACTS_PATH',
  'AIWG_PROJECT_ARTIFACTS_PATH',
  'AIWG_PROJECT_AIWG_DIR',
  PROJECT_LOCAL_SEARCH_PATHS_ENV,
] as const;

let originalEnv: Partial<Record<typeof ARTIFACT_ENV_KEYS[number], string | undefined>> = {};

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'aiwg-pld-'));
}
function sha256(buf: string): string {
  return createHash('sha256').update(buf).digest('hex');
}

function writeBundle(projectDir: string, id: string, opts: { ruleBody?: string; mismatchType?: boolean } = {}): void {
  const ruleBody = opts.ruleBody ?? 'rule body';
  const dir = join(projectDir, '.aiwg', 'extensions', id);
  mkdirSync(join(dir, 'rules'), { recursive: true });
  writeFileSync(join(dir, 'rules', 'r1.md'), ruleBody);
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      id,
      type: opts.mismatchType ? 'addon' : 'extension',
      name: id,
      version: '1.0.0',
      description: 'Test bundle',
      manifestVersion: '1',
      platforms: { claude: 'full' },
      keywords: ['test'],
      deployment: { pathTemplate: '.{platform}/rules/{id}.md' },
    }, null, 2),
  );
}

function writeProviderBundle(projectDir: string, id: string): void {
  const dir = join(projectDir, '.aiwg', 'providers', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      id,
      type: 'provider',
      name: id,
      version: '1.0.0',
      description: 'Test provider bundle',
      manifestVersion: '1',
      platforms: { claude: 'full' },
      keywords: ['test'],
      deployment: { pathTemplate: '.{platform}/skills/{id}.md' },
      providerConfig: { extends: 'claude', displayName: id },
    }, null, 2),
  );
}

function deployRule(projectDir: string, body = 'rule body'): void {
  mkdirSync(join(projectDir, '.claude', 'rules'), { recursive: true });
  writeFileSync(join(projectDir, '.claude', 'rules', 'r1.md'), body);
}

function writeQuickref(projectDir: string): void {
  mkdirSync(join(projectDir, '.aiwg'), { recursive: true });
  writeFileSync(join(projectDir, '.aiwg', 'quickref.json'), JSON.stringify({
    version: '1',
    project: { id: 'doctor-test', name: 'Doctor Test', description: 'Doctor quickref fixture.' },
    precedence: 'Use local workflows before generic workflows.',
    entries: [{ title: 'Local flow', summary: 'Retrieve the local flow.', discover: ['local flow'], show: [] }],
  }, null, 2));
}

function makeConfig(bundleId: string, hashes: Record<string, string>): AiwgConfig {
  return {
    version: '1', providers: ['claude'],
    installed: {
      [bundleId]: {
        version: '1.0.0',
        source: 'project-local',
        installedAt: new Date().toISOString(),
        deployedTo: { claude: { agents: 0, commands: 0, skills: 0, rules: 1 } },
        localPath: `.aiwg/extensions/${bundleId}/`,
        localType: 'extension',
        manifestVersion: '1',
        artifactHashes: hashes,
      },
    },
    scripts: {},
  };
}

describe('project-local-doctor (DC-1)', () => {
  let projectDir: string;
  let frameworkRoot: string;

  beforeEach(() => {
    originalEnv = {};
    for (const key of ARTIFACT_ENV_KEYS) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
    projectDir = tmp();
    frameworkRoot = tmp();
  });
  afterEach(() => {
    for (const key of ARTIFACT_ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(frameworkRoot, { recursive: true, force: true });
  });

  it('returns empty section when no project-local content exists', async () => {
    const r = await buildProjectLocalDoctorSection({
      projectDir, frameworkRoot, config: null,
    });
    expect(r.output).toBe('');
    expect(r.hasFailures).toBe(false);
  });

  it('validates project quickref generation and configured-provider deployment', async () => {
    writeQuickref(projectDir);
    const config: AiwgConfig = { version: '1', providers: ['claude'], installed: {}, scripts: {} };

    const stale = await buildProjectLocalDoctorSection({ projectDir, frameworkRoot, config });
    expect(stale.output).toContain('Project quickref: aiwg-project-doctor-test-quickref');
    expect(stale.driftCount).toBe(2);
    expect(stale.hasFailures).toBe(true);

    await deployProjectQuickref(projectDir, 'claude');
    const current = await buildProjectLocalDoctorSection({ projectDir, frameworkRoot, config });
    expect(current.validationErrors).toBe(0);
    expect(current.driftCount).toBe(0);
    expect(current.hasFailures).toBe(false);
  });

  it('reports a discovered bundle with no recorded deployment as a failure (#2503)', async () => {
    writeBundle(projectDir, 'never-deployed');
    const config: AiwgConfig = { version: '1', providers: ['claude'], installed: {}, scripts: {} };

    // A deploy that aborts (e.g. on a support-asset reference) leaves no
    // installed entry, so manifest validation and drift both pass while the
    // bundle is in fact unavailable.
    const result = await buildProjectLocalDoctorSection({ projectDir, frameworkRoot, config });

    expect(result.validationErrors).toBe(0);
    expect(result.undeployedCount).toBe(1);
    expect(result.hasFailures).toBe(true);
    expect(result.output).toContain('not deployed');
    expect(result.output).toContain('extension/never-deployed');
  });

  it('reports all discovered bundles deployed once a deployment is recorded (#2503)', async () => {
    writeBundle(projectDir, 'deployed-ok');
    const config: AiwgConfig = {
      version: '1',
      providers: ['claude'],
      installed: {
        'deployed-ok': {
          version: '1.0.0',
          source: 'project-local',
          installedAt: new Date().toISOString(),
          deployedTo: { claude: { agents: 0, commands: 0, skills: 0, rules: 1 } },
        },
      },
      scripts: {},
    };

    const result = await buildProjectLocalDoctorSection({ projectDir, frameworkRoot, config });

    expect(result.undeployedCount).toBe(0);
    expect(result.output).toContain('Deployment: ✓ all discovered bundles deployed');
  });

  it('audits a managed quickref synthesized from bundles without a legacy source', async () => {
    writeBundle(projectDir, 'managed-tools');
    const config: AiwgConfig = {
      version: '1',
      providers: ['claude'],
      // Recorded as deployed so this quickref-focused case is not also
      // reporting the undeployed-bundle failure added for #2503.
      installed: {
        'managed-tools': {
          version: '1.0.0',
          source: 'project-local',
          installedAt: new Date().toISOString(),
          deployedTo: { claude: { agents: 0, commands: 0, skills: 0, rules: 1 } },
        },
      },
      scripts: {},
    };

    const stale = await buildProjectLocalDoctorSection({ projectDir, frameworkRoot, config });
    expect(stale.output).toContain('Project quickref: aiwg-project-');
    expect(stale.driftCount).toBe(2);

    await deployProjectQuickref(projectDir, 'claude');
    const current = await buildProjectLocalDoctorSection({ projectDir, frameworkRoot, config });
    expect(current.validationErrors).toBe(0);
    expect(current.driftCount).toBe(0);
    expect(current.hasFailures).toBe(false);
  });

  it('reports per-type counts and bundle ids when content exists', async () => {
    writeBundle(projectDir, 'foo');
    writeBundle(projectDir, 'bar');
    writeProviderBundle(projectDir, 'custom-provider');

    const r = await buildProjectLocalDoctorSection({
      projectDir, frameworkRoot, config: null,
    });
    expect(r.output).toContain('Project-local artifacts');
    expect(r.output).toContain('Discovered: 3 bundle');
    expect(r.output).toContain('extensions');
    expect(r.output).toContain('providers');
    expect(r.output).toContain('foo');
    expect(r.output).toContain('bar');
    expect(r.output).toContain('custom-provider');
  });

  it('surfaces validation errors with structured rows', async () => {
    writeBundle(projectDir, 'mismatched', { mismatchType: true });

    const r = await buildProjectLocalDoctorSection({
      projectDir, frameworkRoot, config: null,
    });
    expect(r.validationErrors).toBeGreaterThanOrEqual(1);
    expect(r.output).toContain('Validation: ✗');
    expect(r.hasFailures).toBe(true);
  });

  it('detects drift when deployed file differs from registered hash', async () => {
    writeBundle(projectDir, 'foo');
    await deployProjectQuickref(projectDir, 'claude');
    deployRule(projectDir, 'mutated content');
    const hashes = { 'rules/r1.md': sha256('rule body') }; // expected hash != deployed
    const config = makeConfig('foo', hashes);

    const r = await buildProjectLocalDoctorSection({
      projectDir, frameworkRoot, config,
    });
    expect(r.driftCount).toBe(1);
    expect(r.output).toContain('Drift (1)');
    expect(r.output).toContain('foo :: rules/r1.md @ claude');
    expect(r.hasFailures).toBe(true);
  });

  it('reports zero drift when deployed file matches', async () => {
    writeBundle(projectDir, 'foo');
    await deployProjectQuickref(projectDir, 'claude');
    deployRule(projectDir, 'rule body');
    const hashes = { 'rules/r1.md': sha256('rule body') };
    const config = makeConfig('foo', hashes);

    const r = await buildProjectLocalDoctorSection({
      projectDir, frameworkRoot, config,
    });
    expect(r.driftCount).toBe(0);
    expect(r.output).toContain('Drift: 0');
    expect(r.hasFailures).toBe(false);
  });

  it('reports zero drift when deployed file carries managed-marker (#1086)', async () => {
    // Source has no marker; recorded hash is sha256(source).
    // Deployer injected an HTML-comment marker on line 1 — normalization
    // must strip it on both sides so the hash equivalence still holds.
    writeBundle(projectDir, 'foo');
    await deployProjectQuickref(projectDir, 'claude');
    deployRule(projectDir, '<!-- aiwg:managed v2026.5.0-rc.6 bundled -->\nrule body');
    const hashes = { 'rules/r1.md': sha256('rule body') };
    const config = makeConfig('foo', hashes);

    const r = await buildProjectLocalDoctorSection({
      projectDir, frameworkRoot, config,
    });
    expect(r.driftCount).toBe(0);
    expect(r.hasFailures).toBe(false);
  });

  it('reports zero drift for a stale raw deployed hash with only managed-marker delta (#1370)', async () => {
    writeBundle(projectDir, 'foo');
    await deployProjectQuickref(projectDir, 'claude');
    const deployed =
      '---\n' +
      '# aiwg:managed vunknown bundled\n' +
      'name: voice-stylist\n' +
      '---\n' +
      '\nBody.\n';
    deployRule(projectDir, deployed);

    // Simulates an old or partially-populated registry that recorded the
    // deployed file hash before managed-marker normalization. Doctor should
    // treat a raw-hash match as clean so clean redeploys do not drift.
    const hashes = { 'rules/r1.md': sha256(deployed) };
    const config = makeConfig('foo', hashes);

    const r = await buildProjectLocalDoctorSection({
      projectDir, frameworkRoot, config,
    });
    expect(r.driftCount).toBe(0);
    expect(r.hasFailures).toBe(false);
  });

  it('still detects real drift when content differs beyond the marker (#1086)', async () => {
    writeBundle(projectDir, 'foo');
    await deployProjectQuickref(projectDir, 'claude');
    deployRule(
      projectDir,
      '<!-- aiwg:managed v2026.5.0-rc.6 bundled -->\nrule body EDITED',
    );
    const hashes = { 'rules/r1.md': sha256('rule body') };
    const config = makeConfig('foo', hashes);

    const r = await buildProjectLocalDoctorSection({
      projectDir, frameworkRoot, config,
    });
    expect(r.driftCount).toBe(1);
    expect(r.hasFailures).toBe(true);
  });

  it('quiet mode suppresses informational subsections but keeps failures', async () => {
    writeBundle(projectDir, 'foo');
    await deployProjectQuickref(projectDir, 'claude');
    deployRule(projectDir, 'mutated');
    const hashes = { 'rules/r1.md': sha256('rule body') };
    const config = makeConfig('foo', hashes);

    const r = await buildProjectLocalDoctorSection({
      projectDir, frameworkRoot, config, quiet: true,
    });
    expect(r.output).toContain('Drift (1)');
    expect(r.output).not.toContain('Discovered:');
    expect(r.output).not.toContain('Provider deployment matrix');
  });

  it('emits provider deployment matrix from registered installed entries', async () => {
    writeBundle(projectDir, 'foo');
    const hashes = { 'rules/r1.md': sha256('rule body') };
    const config = makeConfig('foo', hashes);
    // Add a second provider
    config.installed['foo'].deployedTo['cursor'] = { agents: 0, commands: 0, skills: 0, rules: 1 };

    const r = await buildProjectLocalDoctorSection({
      projectDir, frameworkRoot, config,
    });
    expect(r.output).toContain('Provider deployment matrix');
    expect(r.output).toMatch(/foo\s+✓ 1\s+✓ 1/);
  });

  it('warns when entries lack artifactHashes (older deploys)', async () => {
    writeBundle(projectDir, 'foo');
    await deployProjectQuickref(projectDir, 'claude');
    const config = makeConfig('foo', {});
    delete config.installed['foo'].artifactHashes;

    const r = await buildProjectLocalDoctorSection({
      projectDir, frameworkRoot, config,
    });
    expect(r.output).toContain('lack artifactHashes');
  });
});
