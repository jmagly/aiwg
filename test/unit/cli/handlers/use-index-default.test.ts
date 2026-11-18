// Every bundle target shares the discovery-first deployment policy.
import { describe, expect, it, vi } from 'vitest';
import { executeCopySelection, discoveryDeploymentArgs } from '../../../../src/cli/handlers/use-copy-selection.js';
import { validateUseOptions } from '../../../../src/cli/handlers/use.js';
import { bundleDeploymentScope, projectLocalDeploymentContext } from '../../../../src/cli/handlers/bundle-deployment-mode.js';

describe('discovery-first scope (#4279)', () => {
  it.each(['sdlc', 'voice-framework', 'project-local-addon'])('defaults %s to the kernel surface on every provider', id => {
    for (const provider of ['claude', 'codex', 'muse', 'pi', 'omp']) {
      expect(bundleDeploymentScope(id, provider, []).kernelOnly, `${id}/${provider}`).toBe(true);
    }
  });
  it.each(['--copy-all', '--copy-standard-skills'])('keeps %s as an explicit full-surface opt-in', flag => {
    expect(bundleDeploymentScope('sdlc', 'claude', [flag]).kernelOnly).toBe(false);
  });
});


describe('copy selection', () => {
  const context = (args: string[]) => ({ args, rawArgs: ['use'], cwd: '/synthetic' });
  it('recognizes both public copy option forms', () => {
    expect(validateUseOptions(['sdlc', '--copy'])).toBeUndefined();
    expect(validateUseOptions(['all', '--copy', 'sdlc'])).toBeUndefined();
  });
  it('leaves unflagged requests to the existing handler', async () => {
    const execute = vi.fn();
    expect(await executeCopySelection(context(['sdlc']), execute)).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });
  it.each([['sdlc', '--copy'], ['sdlc', '--copy', 'sdlc'], ['sdlc', '--copy', 'sdlc-complete']])('copies just the named target with %j', async (...args) => {
    const execute = vi.fn().mockResolvedValue({ exitCode: 0 });
    await executeCopySelection(context(args), execute);
    expect(execute.mock.calls[0][0].args).toEqual(['sdlc', '--copy-all']);
  });
  it('copies one selected bundle and indexes the rest of all', async () => {
    const execute = vi.fn().mockResolvedValue({ exitCode: 0 });
    await executeCopySelection(context(['all', '--copy', 'voice-framework', '--provider', 'claude']), execute);
    expect(execute.mock.calls.map(call => call[0].args)).toEqual([
      ['voice-framework', '--provider', 'claude', '--copy-all'], ['all', '--provider', 'claude'],
    ]);
  });
  it('stops when the selected bundle fails', async () => {
    const execute = vi.fn().mockResolvedValue({ exitCode: 2 });
    expect(await executeCopySelection(context(['all', '--copy', 'unknown']), execute)).toEqual({ exitCode: 2 });
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it.each([['--copy'], ['sdlc', '--copy', 'other']])('rejects an ambiguous copy request %j', async (...args) => {
    const execute = vi.fn();
    expect((await executeCopySelection(context(args), execute))?.exitCode).toBe(2);
    expect(execute).not.toHaveBeenCalled();
  });
  it('keeps recorded project-local choices independent of the parent mode', () => {
    const copied = ['--deploy-source', 'project-local', '--copy-all'];
    expect(discoveryDeploymentArgs(copied, true)).toBe(copied);
    expect(discoveryDeploymentArgs(['--deploy-source', 'project-local'], false)).toContain('--discovery-only');
  });
  it('removes internally forced copies only in discovery mode', () => {
    const args = ['--copy-all', '--index-mode', '--deploy-skills'];
    expect(discoveryDeploymentArgs(args, true)).toEqual(['--deploy-skills', '--discovery-only']);
    expect(discoveryDeploymentArgs(args, false)).toBe(args);
  });
});

describe('indexed availability', () => {
  it.each(['skill', 'agent', 'command'] as const)('reports an indexed %s as installed:false without a provider copy', async type => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { emptyConfig } = await import('../../../../src/config/aiwg-config.js');
    const { isArtifactInstalled } = await import('../../../../src/artifacts/query-engine-installation.js');
    const root = await mkdtemp(join(tmpdir(), 'aiwg-index-availability-'));
    try {
      const config = emptyConfig(['claude']);
      config.installed['synthetic-framework'] = { deployedTo: { claude: { copy: false, kernelOnly: true } } };
      await mkdir(join(root, '.aiwg'));
      await writeFile(join(root, '.aiwg/aiwg.config'), JSON.stringify(config));
      expect(await isArtifactInstalled(root, root, { path: `agentic/code/frameworks/synthetic-framework/${type}s/synthetic.md`, type }, 'framework', 'synthetic-framework')).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

it('recognizes a retained agent copy after indexing during migration', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { emptyConfig } = await import('../../../../src/config/aiwg-config.js');
  const { isArtifactInstalled } = await import('../../../../src/artifacts/query-engine-installation.js');
  const root = await mkdtemp(join(tmpdir(), 'aiwg-retained-availability-'));
  try {
    const config = emptyConfig(['claude']);
    config.installed['synthetic-framework'] = { deployedTo: { claude: { copy: false, kernelOnly: true } } };
    await mkdir(join(root, '.aiwg'));
    await writeFile(join(root, '.aiwg/aiwg.config'), JSON.stringify(config));
    await mkdir(join(root, '.claude/agents'), { recursive: true });
    await writeFile(join(root, '.claude/agents/synthetic.md'), 'Retained agent');
    expect(await isArtifactInstalled(root, root, { path: 'agentic/code/frameworks/synthetic-framework/agents/synthetic.md', type: 'agent' }, 'framework', 'synthetic-framework')).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('accepts empty indexed selections while still detecting lost kernels and missing indexes', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { emptyConfig } = await import('../../../../src/config/aiwg-config.js');
  const { deploymentIndexesOnly } = await import('../../../../src/cli/services/deployment-probe-scope.js');
  const { verifyProviderDeployment } = await import('../../../../src/cli/services/deployment-verification.js');
  const root = await mkdtemp(join(tmpdir(), 'aiwg-index-verification-'));
  try {
    const config = emptyConfig(['claude']);
    const flags = { copy: false, skills: 0 };
    config.installed['synthetic-framework'] = { deployedTo: { claude: flags } };
    await mkdir(join(root, '.aiwg'));
    const save = () => writeFile(join(root, '.aiwg/aiwg.config'), JSON.stringify(config));
    await save();
    expect(await deploymentIndexesOnly(root, 'claude', ['synthetic-framework'])).toBe(true);
    expect(await deploymentIndexesOnly(root, 'codex', ['synthetic-framework'])).toBe(false);
    expect(await deploymentIndexesOnly(root, 'claude', ['synthetic-framework'], 'user')).toBe(false);
    expect(await deploymentIndexesOnly(root, 'claude', [])).toBe(false);
    const result = await verifyProviderDeployment({ projectRoot: root, frameworkRoot: root, provider: 'claude', scope: 'project', requestedBundles: ['synthetic-framework'], contextOptOut: true });
    expect(result.findings.some(finding => finding.severity === 'blocking' && finding.id.startsWith('index-'))).toBe(true);
    flags.skills = 1;
    await save();
    expect(await deploymentIndexesOnly(root, 'claude', ['synthetic-framework'])).toBe(false);
    flags.skills = 0;
    flags.copy = true;
    await save();
    expect(await deploymentIndexesOnly(root, 'claude', ['synthetic-framework'])).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('reports project-local plugin payloads as indexed without provider copies', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join, dirname } = await import('node:path');
  const { emptyConfig } = await import('../../../../src/config/aiwg-config.js');
  const { emitShowCard } = await import('../../../../src/artifacts/query-engine-show-card.js');
  const root = await mkdtemp(join(tmpdir(), 'aiwg-plugin-availability-'));
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const config = emptyConfig(['claude']);
    config.installed['local-plugin'] = { deployedTo: { claude: { copy: false } } };
    await mkdir(join(root, '.aiwg'));
    await writeFile(join(root, '.aiwg/aiwg.config'), JSON.stringify(config));
    const entry = { path: '.aiwg/plugins/local-plugin/skills/plugin-probe/SKILL.md', type: 'skill' as const, name: 'plugin-probe', title: 'Probe', summary: '', tags: [], phase: '', created: '', updated: '', checksum: '', dependencies: [], dependents: [] };
    const file = join(root, entry.path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, '# Probe');
    await emitShowCard(root, root, entry, file, '# Probe', { name: 'plugin-probe', json: true }, { fields: {}, text: '' }, {}, true);
    expect(JSON.parse(String(output.mock.calls.at(-1)?.[0])).installed).toBe(false);
    expect(JSON.parse(String(output.mock.calls.at(-1)?.[0])).load_hint).toContain('--copy');
  } finally { output.mockRestore(); await rm(root, { recursive: true, force: true }); }
});


it('lets an explicit parent copy request apply when a local declaration has no recorded mode', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { emptyConfig } = await import('../../../../src/config/aiwg-config.js');
  const root = await mkdtemp(join(tmpdir(), 'aiwg-unset-local-mode-'));
  try {
    const config = emptyConfig(['claude']);
    config.installed['local-helper'] = { deployedTo: { claude: {} } };
    await mkdir(join(root, '.aiwg'));
    await writeFile(join(root, '.aiwg/aiwg.config'), JSON.stringify(config));
    const ctx = { args: ['sdlc', '--copy-all'], rawArgs: [], cwd: root };
    expect((await projectLocalDeploymentContext(ctx, root, 'local-helper', 'claude', false)).args).toContain('--copy-all');
  } finally { await rm(root, { recursive: true, force: true }); }
});
