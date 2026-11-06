// Keep nested repository context advisory while preserving root-scope deployment gates (#3891).
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyConfig, updateInstalled, writeAiwgConfig } from '../../../src/config/aiwg-config.js';
import { getGraphIndexDir } from '../../../src/artifacts/types.js';
import { generate } from '../../../src/smiths/context-pipeline/index.js';
import { diagnoseWorkspaceContext } from '../../../src/smiths/context-pipeline/workspace-doctor.js';
import {
  aggregateUseDeploymentResult,
  renderUseDeploymentResult,
  verifyProviderDeployment,
} from '../../../src/cli/services/deployment-verification.js';

const roots: string[] = [];
const cli = fileURLToPath(new URL('../../../bin/aiwg.mjs', import.meta.url));
const sentinel = 'synthetic-context-sentinel-3891';
const shared = 'Keep the shared project directive.';
const contextCodes = new Set(['duplicate-directive', 'directive-conflict', 'possible-secret']);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'aiwg-context-scopes-'));
  roots.push(directory);
  const projectRoot = path.join(directory, 'workspace');
  const frameworkRoot = path.join(directory, 'framework');
  await mkdir(path.join(projectRoot, '.git'), { recursive: true });
  await mkdir(path.join(projectRoot, '.agents/skills/fixture'), { recursive: true });
  await writeFile(path.join(projectRoot, '.agents/skills/fixture/SKILL.md'), '# Fixture skill\n');
  await writeAiwgConfig(projectRoot, updateInstalled(emptyConfig(['muse']), 'sdlc', 'muse', {
    agents: 0, commands: 0, skills: 1, rules: 0,
  }, { version: 'test', source: 'bundled' }));
  await generate({ provider: 'muse', projectPath: projectRoot, sections: [], detectExistingFiles: true });

  const indexDir = getGraphIndexDir(frameworkRoot, 'framework');
  await mkdir(indexDir, { recursive: true });
  const builtAt = new Date().toISOString();
  const manifestPath = 'agentic/code/frameworks/sdlc-complete/manifest.json';
  await mkdir(path.dirname(path.join(frameworkRoot, manifestPath)), { recursive: true });
  await writeFile(path.join(frameworkRoot, manifestPath), '{"id":"sdlc-complete","version":"test"}\n');
  await writeFile(path.join(indexDir, 'metadata.json'), JSON.stringify({
    version: '1', builtAt, buildTimeMs: 1,
    entries: { [manifestPath]: { path: manifestPath, type: 'manifest' } },
  }));
  await writeFile(path.join(indexDir, 'stats.json'), JSON.stringify({
    version: '1', builtAt, buildTimeMs: 1, totalArtifacts: 1,
    byPhase: {}, byType: { manifest: 1 }, tagDistribution: {}, graphMetrics: { totalEdges: 0 },
  }));
  return { projectRoot, frameworkRoot, provider: 'muse', scope: 'project' as const, requestedBundles: ['sdlc'] };
}

async function writeContext(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'CLAUDE.md'), `${shared}\nUse consistent formatting.\n`);
  await writeFile(path.join(directory, 'AGENTS.md'), `${shared}\nNever use consistent formatting.\ntoken=${sentinel}\n`);
}

async function addMarker(directory: string, marker: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  if (marker === '.git directory') await mkdir(path.join(directory, '.git'));
  if (marker === '.git file') await writeFile(path.join(directory, '.git'), 'gitdir: /unused/synthetic-worktree\n');
  if (marker === 'AIWG project') {
    await mkdir(path.join(directory, '.aiwg'));
    await writeFile(path.join(directory, '.aiwg/aiwg.config'), '{}\n');
  }
}

describe('workspace context scope boundaries (#3891)', () => {
  it.each(['.git directory', '.git file', 'AIWG project'])('makes %s findings advisory for root verification and doctor', async (marker) => {
    const options = await fixture();
    const nested = path.join(options.projectRoot, 'repos/child');
    await addMarker(nested, marker);
    // Instructions below the repository root inherit its boundary.
    await writeContext(path.join(nested, 'src'));

    const diagnostics = (await diagnoseWorkspaceContext(options.projectRoot)).filter((item) => contextCodes.has(item.code));
    expect(diagnostics.map((item) => item.code).sort()).toEqual(['directive-conflict', 'duplicate-directive', 'possible-secret']);
    expect(diagnostics.every((item) => item.severity === 'warning' && item.message.includes('repos/child'))).toBe(true);
    expect(diagnostics.find((item) => item.code === 'possible-secret')?.message).toContain('repos/child/src/AGENTS.md');
    expect(JSON.stringify(diagnostics)).not.toContain(sentinel);

    const provider = await verifyProviderDeployment(options);
    expect(provider.findings.filter((item) => item.severity === 'blocking')).toEqual([]);
    for (const diagnostic of diagnostics) {
      expect(provider.findings).toContainEqual(expect.objectContaining({
        id: `context-diagnostic:${diagnostic.code}`, severity: 'advisory', message: diagnostic.message,
      }));
    }
    const result = aggregateUseDeploymentResult({ ...options, providers: [provider] });
    expect(result.exitCode).toBe(0);
    const output = renderUseDeploymentResult(result);
    expect(output).toContain('Advisories');
    expect(output).toContain('repos/child');
    expect(output).not.toContain('Blocking findings');
    expect(output).not.toContain(sentinel);

    const doctor = spawnSync(process.execPath, [cli, 'workspace-context', 'doctor'], {
      cwd: options.projectRoot, encoding: 'utf8', timeout: 10_000,
      // Isolated user config: a host in dev mode would otherwise run another checkout's CLI.
      env: { ...process.env, AIWG_CONFIG: path.join(path.dirname(options.projectRoot), 'user-config') },
    });
    expect(doctor.error).toBeUndefined();
    expect(doctor.status, doctor.stderr).toBe(0);
    expect(doctor.stdout).toContain('WARNING duplicate-directive: Advisory for nested project(s) repos/child');
    expect(doctor.stdout).toContain('WARNING possible-secret: Advisory for nested project(s) repos/child');
    expect(doctor.stdout).toContain('repos/child/src/AGENTS.md');
    expect(doctor.stdout).not.toContain(sentinel);
  });

  it.each(['.', 'packages/ordinary'])('keeps %s in root scope and separates blockers from advisories', async (relative) => {
    const options = await fixture();
    await writeContext(path.join(options.projectRoot, relative));
    const diagnostics = await diagnoseWorkspaceContext(options.projectRoot);
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: 'possible-secret', severity: 'error' }));
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: 'directive-conflict', severity: 'error' }));
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: 'duplicate-directive', severity: 'warning' }));
    expect(JSON.stringify(diagnostics)).not.toContain(sentinel);

    const provider = await verifyProviderDeployment(options);
    const result = aggregateUseDeploymentResult({ ...options, providers: [provider] });
    expect(result.exitCode).toBe(1);
    expect(provider.findings).toContainEqual(expect.objectContaining({ id: 'context-diagnostic:possible-secret', severity: 'blocking' }));
    expect(provider.findings).toContainEqual(expect.objectContaining({ id: 'context-diagnostic:duplicate-directive', severity: 'advisory' }));
    const output = renderUseDeploymentResult(result);
    const blocking = output.split('Blocking findings')[1].split('Advisories')[0];
    const advisory = output.split('Advisories')[1];
    expect(blocking).toContain('Possible credential value');
    expect(blocking).not.toContain('identical directive(s) duplicated');
    expect(advisory).toContain('identical directive(s) duplicated');
    expect(output).not.toContain(sentinel);

    const doctor = spawnSync(process.execPath, [cli, 'workspace-context', 'doctor'], {
      cwd: options.projectRoot, encoding: 'utf8', timeout: 10_000,
      // Isolated user config: a host in dev mode would otherwise run another checkout's CLI.
      env: { ...process.env, AIWG_CONFIG: path.join(path.dirname(options.projectRoot), 'user-config') },
    });
    expect(doctor.error).toBeUndefined();
    expect(doctor.status, doctor.stderr).toBe(1);
    expect(doctor.stdout).toContain('ERROR possible-secret:');
    expect(doctor.stdout).toContain('WARNING duplicate-directive:');
    expect(doctor.stdout).not.toContain(sentinel);
  });

  it('names both repositories for cross-repository duplicates and conflicts', async () => {
    const { projectRoot } = await fixture();
    for (const name of ['one', 'two']) await addMarker(path.join(projectRoot, 'repos', name), '.git directory');
    await writeFile(path.join(projectRoot, 'repos/one/CLAUDE.md'), `${shared}\nUse consistent formatting.\n`);
    await writeFile(path.join(projectRoot, 'repos/two/CLAUDE.md'), `${shared}\nNever use consistent formatting.\n`);
    const diagnostics = (await diagnoseWorkspaceContext(projectRoot)).filter((item) => contextCodes.has(item.code));
    expect(diagnostics).toHaveLength(2);
    for (const diagnostic of diagnostics) {
      expect(diagnostic.severity).toBe('warning');
      expect(diagnostic.message).toContain('repos/one');
      expect(diagnostic.message).toContain('repos/two');
    }
  });

  it('does not downgrade a conflict that also involves root-scope policy', async () => {
    const { projectRoot } = await fixture();
    await writeFile(path.join(projectRoot, 'CLAUDE.md'), 'Use consistent formatting.\n');
    await addMarker(path.join(projectRoot, 'repos/child'), '.git directory');
    await writeFile(path.join(projectRoot, 'repos/child/CLAUDE.md'), 'Never use consistent formatting.\n');
    const diagnostics = await diagnoseWorkspaceContext(projectRoot);
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: 'directive-conflict', severity: 'error' }));
  });
});
