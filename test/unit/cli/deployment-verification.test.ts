import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  emptyConfig,
  updateInstalled,
  writeAiwgConfig,
} from '../../../src/config/aiwg-config.js';
import { getGraphIndexDir } from '../../../src/artifacts/types.js';
import { generate as generateContextFiles } from '../../../src/smiths/context-pipeline/index.js';
import {
  aggregateUseDeploymentResult,
  buildDeploymentStatusProbe,
  buildDryRunUseResult,
  normalizeFrameworkDiscoveryInventory,
  renderUseDeploymentResult,
  verifyConfiguredDeployments,
  verifyProviderDeployment,
  type ProviderDeploymentVerification,
  type UseDeploymentResult,
} from '../../../src/cli/services/deployment-verification.js';
import type { IndexStats } from '../../../src/artifacts/types.js';
import { finalizeProviderTransformationReceipt } from '../../../src/providers/transformation-receipt-integration.js';
import type { ArtifactVerificationResult } from '../../../src/security/artifact-verifier.js';

const roots: string[] = [];
let previousXdgDataHome: string | undefined;
let previousUserRegistryPath: string | undefined;

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function writeFrameworkIndex(frameworkRoot: string, builtAt = new Date().toISOString()): Promise<void> {
  const indexDir = getGraphIndexDir(frameworkRoot, 'framework');
  await mkdir(indexDir, { recursive: true });
  await writeFile(path.join(indexDir, 'metadata.json'), JSON.stringify({
    version: '1',
    builtAt,
    buildTimeMs: 1,
    entries: {
      'agentic/code/frameworks/sdlc-complete/manifest.json': {
        path: 'agentic/code/frameworks/sdlc-complete/manifest.json',
        type: 'manifest',
      },
    },
  }));
  await writeFile(path.join(indexDir, 'stats.json'), JSON.stringify({
    version: '1',
    builtAt,
    buildTimeMs: 1,
    totalArtifacts: 3,
    byPhase: {},
    byType: { agent: 1, skill: 2 },
    tagDistribution: {},
    graphMetrics: { totalEdges: 0 },
  }));
  const manifest = path.join(frameworkRoot, 'agentic/code/frameworks/sdlc-complete/manifest.json');
  await mkdir(path.dirname(manifest), { recursive: true });
  await writeFile(manifest, '{"id":"sdlc-complete","version":"test"}\n');
}

async function readyCodexFixture(): Promise<{ projectRoot: string; frameworkRoot: string }> {
  const projectRoot = await tempRoot('aiwg-deploy-verify-project-');
  const frameworkRoot = await tempRoot('aiwg-deploy-verify-framework-');
  await mkdir(path.join(projectRoot, '.codex', 'commands'), { recursive: true });
  await writeFile(path.join(projectRoot, '.codex', 'commands', 'fixture.md'), '# aiwg:managed vtest bundled\n# Fixture command\n');
  await writeFile(path.join(projectRoot, '.codex', 'commands', '.aiwg-manifest.json'), JSON.stringify({
    managed: { 'fixture.md': { hash: 'sha256:fixture' } },
  }));
  await mkdir(path.join(projectRoot, '.agents', 'skills', 'fixture'), { recursive: true });
  await writeFile(path.join(projectRoot, '.agents', 'skills', 'fixture', 'SKILL.md'), '# Fixture skill\n');
  await writeFile(path.join(projectRoot, '.agents', 'skills', 'fixture', '.aiwg-managed'), 'aiwg\n');

  const config = updateInstalled(
    emptyConfig(['codex']),
    'sdlc',
    'codex',
    { agents: 0, commands: 1, skills: 1, rules: 0 },
    { version: 'test', source: 'bundled' },
  );
  await writeAiwgConfig(projectRoot, config);
  await generateContextFiles({
    provider: 'codex',
    projectPath: projectRoot,
    sections: [],
    detectExistingFiles: true,
    force: true,
  });
  await writeFrameworkIndex(frameworkRoot);
  const manifestBytes = await readFile(path.join(frameworkRoot, 'agentic/code/frameworks/sdlc-complete/manifest.json'));
  const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');
  const bundleSha256 = createHash('sha256').update(JSON.stringify([{
    bytes: manifestBytes.byteLength,
    path: 'manifest.json',
    sha256: manifestSha256,
  }])).digest('hex');
  const sourceVerification: ArtifactVerificationResult = {
    schemaVersion: 'aiwg.verify.result.v1',
    status: 'verified',
    exitCode: 0,
    artifact: {
      name: 'agentic/code/frameworks/sdlc-complete/manifest.json',
      sha256: bundleSha256,
    },
    policy: 'test-threshold-policy',
    identities: ['test-release-signer'],
    rootVersion: 1,
    diagnostics: [],
  };
  await finalizeProviderTransformationReceipt({
    projectRoot,
    frameworkRoot,
    provider: 'codex',
    scope: 'project',
    requestedBundles: ['sdlc'],
    sourceVerifications: { sdlc: sourceVerification },
  });
  return { projectRoot, frameworkRoot };
}

async function verifyFixture(projectRoot: string, frameworkRoot: string, options: {
  contextOptOut?: boolean;
  invocationStartedAt?: string;
  reportMissingReceipt?: boolean;
} = {}) {
  return verifyProviderDeployment({
    projectRoot,
    frameworkRoot,
    provider: 'codex',
    scope: 'project',
    requestedBundles: ['sdlc'],
    ...options,
  });
}

describe.sequential('deployment verification contract (#2069)', () => {
  beforeEach(async () => {
    previousXdgDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = await tempRoot('aiwg-deploy-verify-xdg-');
    previousUserRegistryPath = process.env.AIWG_USER_REGISTRY_PATH;
    process.env.AIWG_USER_REGISTRY_PATH = path.join(
      await tempRoot('aiwg-deploy-verify-user-registry-'),
      'installed.json',
    );
  });

  afterEach(async () => {
    if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousXdgDataHome;
    if (previousUserRegistryPath === undefined) delete process.env.AIWG_USER_REGISTRY_PATH;
    else process.env.AIWG_USER_REGISTRY_PATH = previousUserRegistryPath;
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('reports a fresh and repeated deployment as verified with a restart action', async () => {
    const fixture = await readyCodexFixture();
    const first = await verifyFixture(fixture.projectRoot, fixture.frameworkRoot);
    const second = await verifyFixture(fixture.projectRoot, fixture.frameworkRoot);

    expect(first.outcome).toBe('ready-restart-required');
    expect(first.restartAction).toMatch(/Restart or reopen Codex/);
    expect(first.findings.filter((item) => item.severity === 'blocking')).toHaveLength(0);
    expect(second.outcome).toBe(first.outcome);
    expect(second.counts).toEqual(first.counts);
  });

  it('fails closed for missing artifacts, stale indexes, context loss, and invalid registry state', async () => {
    const missingArtifacts = await readyCodexFixture();
    await rm(path.join(missingArtifacts.projectRoot, '.codex'), { recursive: true, force: true });
    await rm(path.join(missingArtifacts.projectRoot, '.agents'), { recursive: true, force: true });
    expect((await verifyFixture(missingArtifacts.projectRoot, missingArtifacts.frameworkRoot)).findings)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: 'provider-artifacts-missing', severity: 'blocking' })]));

    const staleIndex = await readyCodexFixture();
    await writeFrameworkIndex(staleIndex.frameworkRoot, '2020-01-01T00:00:00.000Z');
    expect((await verifyFixture(staleIndex.projectRoot, staleIndex.frameworkRoot, {
      invocationStartedAt: new Date().toISOString(),
    })).findings).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'index-stale:framework', severity: 'blocking' })]));

    const missingStats = await readyCodexFixture();
    await rm(path.join(getGraphIndexDir(missingStats.frameworkRoot, 'framework'), 'stats.json'));
    expect((await verifyFixture(missingStats.projectRoot, missingStats.frameworkRoot)).findings)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'index-stats-unreadable:framework', severity: 'blocking' }),
      ]));

    const missingContext = await readyCodexFixture();
    await rm(path.join(missingContext.projectRoot, '.aiwg', 'AIWG.md'));
    expect((await verifyFixture(missingContext.projectRoot, missingContext.frameworkRoot)).findings)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: 'context-missing:.aiwg/AIWG.md', severity: 'blocking' })]));

    const invalidRegistry = await readyCodexFixture();
    const configPath = path.join(invalidRegistry.projectRoot, '.aiwg', 'aiwg.config');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.installed.sdlc.deployedTo.codex.skills = -1;
    await writeFile(configPath, JSON.stringify(config));
    expect((await verifyFixture(invalidRegistry.projectRoot, invalidRegistry.frameworkRoot)).findings)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: 'registry-count-invalid:sdlc:skills', severity: 'blocking' })]));
  });

  it('keeps explicit context opt-out advisory-only', async () => {
    const fixture = await readyCodexFixture();
    const result = await verifyFixture(fixture.projectRoot, fixture.frameworkRoot, { contextOptOut: true });
    expect(result.outcome).toBe('degraded');
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'context-opt-out', severity: 'advisory' }),
    ]));
    expect(result.findings.some((item) => item.severity === 'blocking')).toBe(false);
  });

  it('aggregates partial multi-provider failure deterministically', async () => {
    const fixture = await readyCodexFixture();
    const ready = await verifyFixture(fixture.projectRoot, fixture.frameworkRoot);
    const failed: ProviderDeploymentVerification = {
      ...ready,
      provider: 'claude',
      outcome: 'failed',
      restartAction: 'Restart Claude Code.',
      phases: ready.phases.map((item) => item.id === 'deploy' ? { ...item, state: 'failed' } : item),
      findings: [{
        id: 'provider-artifacts-missing',
        provider: 'claude',
        severity: 'blocking',
        message: 'No artifacts found.',
      }],
    };
    const aggregate = aggregateUseDeploymentResult({
      ...fixture,
      scope: 'project',
      requestedBundles: ['sdlc'],
      providers: [ready, failed],
    });
    expect(aggregate.outcome).toBe('failed');
    expect(aggregate.exitCode).toBe(1);
    expect(aggregate.phases.find((item) => item.id === 'deploy')?.state).toBe('failed');
  });

  it('models dry-run as planned and never claims deployment success', async () => {
    const projectRoot = await tempRoot('aiwg-deploy-preview-');
    const result = buildDryRunUseResult({
      projectRoot,
      frameworkRoot: projectRoot,
      providers: ['codex', 'claude'],
      scope: 'project',
      requestedBundles: ['sdlc'],
    });
    expect(result.outcome).toBe('planned');
    expect(result.exitClassification).toBe('preview');
    expect(result.providers.every((provider) => provider.outcome === 'planned')).toBe(true);
    expect(result.phases.every((item) => item.state === 'planned')).toBe(true);
  });

  it('reuses the verifier for status probe readiness', async () => {
    const fixture = await readyCodexFixture();
    const probe = await buildDeploymentStatusProbe(fixture.projectRoot, fixture.frameworkRoot);
    expect(probe).toMatchObject({
      schema: 'aiwg.status.probe.v1',
      engaged: true,
      status: 'ready-restart-required',
    });
  });

  it('surfaces the five receipt drift classes through deployment, doctor, and probe verification', async () => {
    const missing = await readyCodexFixture();
    await rm(path.join(missing.projectRoot, '.aiwg/receipts/providers/codex.project.json'));
    expect((await verifyFixture(missing.projectRoot, missing.frameworkRoot)).findings)
      .toEqual(expect.arrayContaining([expect.objectContaining({
        id: 'provider-drift:missing-receipt:0',
        evidence: expect.objectContaining({ driftClass: 'missing-receipt' }),
      })]));
    const firstUse = await verifyFixture(missing.projectRoot, missing.frameworkRoot, {
      reportMissingReceipt: false,
    });
    expect(firstUse.findings.some((finding) => finding.id.startsWith('provider-drift:missing-receipt'))).toBe(false);
    expect(firstUse.outcome).toBe('ready-restart-required');

    const altered = await readyCodexFixture();
    await writeFile(path.join(altered.projectRoot, '.codex/commands/fixture.md'), '# operator changed managed output\n');
    expect((await buildDeploymentStatusProbe(altered.projectRoot, altered.frameworkRoot)))
      .toMatchObject({
        status: 'needs-repair',
        deployment_verification: {
          findings: expect.arrayContaining([expect.objectContaining({
            evidence: expect.objectContaining({ driftClass: 'user-modification' }),
          })]),
        },
      });

    const partial = await readyCodexFixture();
    await rm(path.join(partial.projectRoot, '.codex/commands/fixture.md'));
    expect((await verifyFixture(partial.projectRoot, partial.frameworkRoot)).findings)
      .toEqual(expect.arrayContaining([expect.objectContaining({
        evidence: expect.objectContaining({ driftClass: 'stale-output' }),
      })]));

    const adapter = await readyCodexFixture();
    const adapterReceiptPath = path.join(adapter.projectRoot, '.aiwg/receipts/providers/codex.project.json');
    const adapterReceipt = JSON.parse(await readFile(adapterReceiptPath, 'utf8'));
    adapterReceipt.transformer.providerAdapterVersion = 'outdated';
    await writeFile(adapterReceiptPath, JSON.stringify(adapterReceipt));
    expect((await verifyFixture(adapter.projectRoot, adapter.frameworkRoot)).findings)
      .toEqual(expect.arrayContaining([expect.objectContaining({
        evidence: expect.objectContaining({ driftClass: 'transformation-mismatch' }),
      })]));

    const source = await readyCodexFixture();
    await rm(path.join(source.frameworkRoot, 'agentic/code/frameworks/sdlc-complete/manifest.json'));
    expect((await verifyFixture(source.projectRoot, source.frameworkRoot)).findings)
      .toEqual(expect.arrayContaining([expect.objectContaining({
        evidence: expect.objectContaining({ driftClass: 'source-verification-failure' }),
      })]));
  });

  it('treats local-source evidence as informational and stable source unavailability as actionable', async () => {
    const local = await readyCodexFixture();
    await finalizeProviderTransformationReceipt({
      ...local,
      provider: 'codex',
      scope: 'project',
      requestedBundles: ['sdlc'],
      sourceDisposition: 'local-source',
    });
    const localResult = await verifyFixture(local.projectRoot, local.frameworkRoot);
    expect(localResult.findings).toEqual(expect.arrayContaining([expect.objectContaining({
      id: 'provider-drift:policy-exempt:0',
      severity: 'info',
      remediation: undefined,
    })]));
    expect(localResult.outcome).not.toBe('degraded');

    const stable = await readyCodexFixture();
    await finalizeProviderTransformationReceipt({
      ...stable,
      provider: 'codex',
      scope: 'project',
      requestedBundles: ['sdlc'],
      sourceDisposition: 'source-unavailable',
    });
    const stableResult = await verifyFixture(stable.projectRoot, stable.frameworkRoot, {
      reportMissingReceipt: false,
    });
    expect(stableResult).toMatchObject({
      outcome: 'degraded',
      findings: expect.arrayContaining([expect.objectContaining({
        id: 'provider-drift:source-evidence-unavailable:0',
        severity: 'advisory',
        remediation: expect.stringMatching(/cache|resource access/),
      })]),
    });
  });

  it('reports an unconfigured workspace as diagnostic state rather than deployment failure', async () => {
    const projectRoot = await tempRoot('aiwg-deploy-unconfigured-');
    const frameworkRoot = await tempRoot('aiwg-deploy-framework-');
    await mkdir(path.join(projectRoot, '.aiwg'), { recursive: true });
    await writeFile(path.join(projectRoot, '.aiwg', 'aiwg.config'), JSON.stringify({
      version: '1.0',
      project: { name: 'legacy-project' },
      providers: ['claude'],
    }));

    const probe = await buildDeploymentStatusProbe(projectRoot, frameworkRoot);
    expect(probe).toMatchObject({
      schema: 'aiwg.status.probe.v1',
      engaged: false,
      status: 'not-configured',
      checks: {
        provider_deployment_count: 0,
        health: 'not-configured',
        artifact_health: 'not-configured',
      },
      verification: { next_command: 'aiwg wizard --dry-run' },
    });
  });

  it('resolves user-scope deployments from the user registry without a project deployment record', async () => {
    const projectRoot = await tempRoot('aiwg-user-deploy-project-');
    const frameworkRoot = await tempRoot('aiwg-user-deploy-framework-');
    await writeFrameworkIndex(frameworkRoot);
    await mkdir(path.dirname(process.env.AIWG_USER_REGISTRY_PATH!), { recursive: true });
    await writeFile(process.env.AIWG_USER_REGISTRY_PATH!, JSON.stringify({
      version: '1',
      installed: {
        sdlc: {
          version: 'test',
          source: 'bundled',
          installedAt: new Date().toISOString(),
          deployedTo: { codex: { agents: 0, commands: 1, skills: 1, rules: 0 } },
        },
      },
    }));

    const result = await verifyConfiguredDeployments(
      projectRoot,
      { scope: 'user' },
      frameworkRoot,
    );
    expect(result.providers[0]).toMatchObject({ provider: 'codex', scope: 'user' });
    expect(result.requestedBundles).toEqual(['sdlc']);
    expect(result.findings.some(item => item.id === 'deployment-not-configured')).toBe(false);
  });

  // #2507 — deployment counts came from a readdir of the provider directory, so
  // a run that wrote nothing still reported every stale file sitting there as a
  // successful deploy.
  it('excludes unmanaged artifacts from deployment counts and reports them', async () => {
    const fixture = await readyCodexFixture();
    const commandsDir = path.join(fixture.projectRoot, '.codex', 'commands');
    const stale = path.join(commandsDir, 'stale-unmanaged.md');
    await writeFile(stale, '---\nname: stale\n---\n\nLeft behind by an older AIWG.\n');
    const longAgo = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(stale, longAgo, longAgo);

    const invocationStartedAt = new Date().toISOString();
    const result = await verifyFixture(fixture.projectRoot, fixture.frameworkRoot, {
      invocationStartedAt,
    });

    // Only the sidecar-managed fixture command counts as deployed.
    expect(result.counts.commands).toBe(1);
    const unmanaged = result.findings.find((item) => item.id === 'unmanaged-artifacts:commands');
    expect(unmanaged).toBeDefined();
    expect(unmanaged?.severity).toBe('advisory');
    expect(unmanaged?.message).toContain('stale-unmanaged.md');
    expect(unmanaged?.remediation).toContain('--force');
  });

  it('counts artifacts this run wrote even when they carry no ownership marker', async () => {
    const fixture = await readyCodexFixture();
    const commandsDir = path.join(fixture.projectRoot, '.codex', 'commands');
    const invocationStartedAt = new Date(Date.now() - 1_000).toISOString();
    // Skill-command wrappers are written without a managed marker or sidecar
    // entry; attribution by write time keeps them out of the unmanaged bucket.
    await writeFile(path.join(commandsDir, 'mirrored-wrapper.md'), '---\nname: wrapper\n---\n');

    const result = await verifyFixture(fixture.projectRoot, fixture.frameworkRoot, {
      invocationStartedAt,
    });

    expect(result.counts.commands).toBe(2);
    expect(result.findings.some((item) => item.id === 'unmanaged-artifacts:commands')).toBe(false);
  });

  it('keeps the plain entry count when the run has no attribution boundary', async () => {
    const fixture = await readyCodexFixture();
    const stale = path.join(fixture.projectRoot, '.codex', 'commands', 'stale-unmanaged.md');
    await writeFile(stale, '---\nname: stale\n---\n');
    const longAgo = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(stale, longAgo, longAgo);

    const result = await verifyFixture(fixture.projectRoot, fixture.frameworkRoot);

    expect(result.counts.commands).toBe(2);
    expect(result.findings.some((item) => item.id === 'unmanaged-artifacts:commands')).toBe(false);
  });
});

function outputFixture(overrides: Partial<UseDeploymentResult> = {}): UseDeploymentResult {
  const provider: ProviderDeploymentVerification = {
    provider: 'codex',
    scope: 'project',
    outcome: 'ready-restart-required',
    restartRequired: true,
    restartAction: 'Restart or reopen Codex in this workspace.',
    restartReason: 'Codex reads its registry when a session starts.',
    counts: { agents: 204, commands: 50, skills: 30, rules: 2, behaviors: 1 },
    phases: [
      { id: 'resolve', state: 'passed', required: true, summary: 'Resolved the project and provider.' },
      { id: 'deploy', state: 'passed', required: true, summary: 'Deployed managed artifacts.' },
      { id: 'index', state: 'passed', required: true, summary: 'Loaded the framework index.' },
      { id: 'context', state: 'passed', required: true, summary: 'Verified project context.' },
      { id: 'verify', state: 'passed', required: true, summary: 'Verified the deployment.' },
      { id: 'report', state: 'passed', required: true, summary: 'Prepared this result.' },
    ],
    findings: [],
  };
  return {
    schema: 'aiwg.use.result.v1',
    generatedAt: '2026-08-14T12:00:00.000Z',
    projectRoot: '/tmp/project',
    frameworkRoot: '/tmp/aiwg',
    scope: 'project',
    requestedBundles: ['all'],
    dryRun: false,
    providers: [provider],
    phases: provider.phases,
    findings: [],
    outcome: 'ready-restart-required',
    restartRequired: true,
    discovery: {
      graph: 'framework',
      totalArtifacts: 3235,
      builtAt: '2026-08-14T11:59:00.000Z',
      byType: {
        agent: 244,
        skill: 545,
        command: 24,
        rule: 126,
        behavior: 9,
        template: 512,
        flow: 423,
        runbook: 19,
        schema: 128,
        architecture: 23,
        document: 1118,
      },
    },
    exitClassification: 'success',
    exitCode: 0,
    ...overrides,
  };
}

describe('aiwg use presentation contract (#2066)', () => {
  it('renders a compact, deterministic 80-column default summary', () => {
    const output = renderUseDeploymentResult(outputFixture(), {
      width: 80,
      version: { version: '2026.8.8', repository: 'github.com/jmagly/aiwg' },
    });

    expect(output).toMatchInlineSnapshot(`
      "
      AIWG ready — provider reload required

      Deployed to OpenAI Codex (codex)
          Agents 204  ·  Commands 50  ·  Skills 30  ·  Rules 2  ·  Behaviors 1

      Indexed for discovery
          3,235 artifacts · framework graph
          agent 244  ·  skill 545  ·  command 24  ·  rule 126  ·  behavior 9
          template 512  ·  flow 423  ·  runbook 19  ·  schema 128  ·  architecture 23
          document 1,118

      Next
          Restart or reopen Codex in this workspace.
          Ask your AI tool to verify AIWG and recommend one useful next action.

        AIWG v2026.8.8 · github.com/jmagly/aiwg"
    `);
    expect(output).not.toContain('Registered');
    expect(output).not.toMatch(/\x1b\[/);
    expect(output.split('\n').every((line) => line.length <= 80)).toBe(true);
  });

  it('keeps reload rationale and phase diagnostics behind verbose output at 120 columns', () => {
    const compact = renderUseDeploymentResult(outputFixture(), { width: 120 });
    const verbose = renderUseDeploymentResult(outputFixture(), { width: 120, verbose: true });

    expect(verbose).toMatchInlineSnapshot(`
      "
      AIWG ready — provider reload required

      Deployed to OpenAI Codex (codex)
          Agents 204  ·  Commands 50  ·  Skills 30  ·  Rules 2  ·  Behaviors 1

      Indexed for discovery
          3,235 artifacts · framework graph
          agent 244  ·  skill 545  ·  command 24  ·  rule 126  ·  behavior 9  ·  template 512  ·  flow 423  ·  runbook 19
          schema 128  ·  architecture 23  ·  document 1,118

      Verification details
          codex/resolve: passed — Resolved the project and provider.
          codex/deploy: passed — Deployed managed artifacts.
          codex/index: passed — Loaded the framework index.
          codex/context: passed — Verified project context.
          codex/verify: passed — Verified the deployment.
          codex/report: passed — Prepared this result.
          codex reload rationale: Codex reads its registry when a session starts.
          Framework index built: 2026-08-14T11:59:00.000Z

      Next
          Restart or reopen Codex in this workspace.
          Ask your AI tool to verify AIWG and recommend one useful next action."
    `);
    expect(compact).not.toContain('reload rationale');
    expect(compact).not.toContain('codex/resolve');
    expect(verbose).toContain('Verification details');
    expect(verbose).toContain('codex/resolve: passed');
    expect(verbose).toContain('codex reload rationale:');
    expect(verbose).toContain('Framework index built: 2026-08-14T11:59:00.000Z');
    expect(verbose.split('\n').every((line) => line.length <= 120)).toBe(true);
  });

  it('defines zero-count core types and automatically includes future index types', () => {
    const inventory = normalizeFrameworkDiscoveryInventory({
      version: '1',
      builtAt: '2026-08-14T12:00:00.000Z',
      buildTimeMs: 1,
      totalArtifacts: 7,
      byPhase: {},
      byType: { agent: 2, playbook: 5 },
      tagDistribution: {},
      graphMetrics: { totalEdges: 0 },
    } as IndexStats);

    expect(inventory.byType).toMatchObject({
      agent: 2,
      skill: 0,
      command: 0,
      rule: 0,
      behavior: 0,
      template: 0,
      flow: 0,
      runbook: 0,
      schema: 0,
      playbook: 5,
    });
    expect(Object.keys(inventory.byType).at(-1)).toBe('playbook');
  });

  it('preserves index failures and blocking remediation in the human summary', () => {
    const result = outputFixture({
      outcome: 'failed',
      exitClassification: 'failure',
      exitCode: 1,
      discovery: null,
      findings: [{
        id: 'index-missing:framework',
        provider: 'codex',
        severity: 'blocking',
        message: 'Framework capability index is missing.',
        remediation: 'Run aiwg index build --graph framework.',
      }],
    });
    const output = renderUseDeploymentResult(result, { width: 80 });

    expect(output).toContain('AIWG needs repair');
    expect(output).toContain('Unavailable — the framework index could not be read.');
    expect(output).toContain('Blocking findings');
    expect(output).toContain('Fix: Run aiwg index build --graph framework.');
    expect(output).toContain('Repair the blocking findings above');
    expect(output).not.toContain('Restart or reopen Codex');
  });

  it('labels native providers without changing the inventory contract', () => {
    const cursor = outputFixture({
      providers: [{
        ...outputFixture().providers[0],
        provider: 'cursor',
        restartAction: 'Reload the Cursor workspace.',
        restartReason: 'Cursor reads its registry when the workspace opens.',
      }],
    });
    const output = renderUseDeploymentResult(cursor, { width: 80 });
    expect(output).toContain('Deployed to Cursor IDE (cursor)');
    expect(output).toContain('Reload the Cursor workspace.');
  });
});
