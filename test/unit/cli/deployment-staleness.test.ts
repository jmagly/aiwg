// Exercise freshness boundaries without installing or launching providers.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deploymentStaleness, configuredDeploymentStaleness, withDeploymentStaleness } from '../../../src/cli/services/deployment-staleness.js';
import type { ProviderDeploymentVerification } from '../../../src/cli/services/deployment-verification.js';
import { installCodexPromptDiscovery } from '../../../src/smiths/hook-bridge/codex-translator.js';

let root: string;
let frameworkRoot: string;
async function write(file: string, value: unknown) {
  const target = path.join(root, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, typeof value === 'string' ? value : JSON.stringify(value));
}
const options = () => ({ projectRoot: root, frameworkRoot, provider: 'claude', scope: 'project' as const, requestedBundles: ['utils'] });
async function installed(version: string, source: string | undefined = 'bundled') {
  await write('.aiwg/aiwg.config', { version: '1', providers: ['claude'], installed: {
    utils: { version, source, deployedTo: { claude: {} } },
  } });
}
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'aiwg-freshness-'));
  frameworkRoot = path.join(root, 'runtime');
  vi.stubEnv('HOME', path.join(root, 'home'));
  vi.stubEnv('XDG_DATA_HOME', path.join(root, 'data'));
  vi.stubEnv('AIWG_USER_REGISTRY_PATH', path.join(root, 'user-registry.json'));
  await write('runtime/package.json', { version: '2026.11.8' });
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

it.each(['2026.11.8', '2026.11.9'])('accepts current or newer bundled version %s', async version => {
  await installed(version);
  expect(await deploymentStaleness(options())).toEqual([]);
});
it('keeps independently versioned bundled manifests separate from runtime CalVer', async () => {
  await installed('1.5.0');
  expect(await deploymentStaleness(options())).toEqual([]);
});
it.each(['project-local', 'cache', 'https://example.invalid/bundle.git'])('does not compare %s packages to the runtime version', async source => {
  await installed('1.0.0', source);
  expect(await deploymentStaleness(options())).toEqual([]);
});
it('reports legacy bundled entries with no source and scans only their registered provider', async () => {
  await installed('2026.11.4');
  const config = JSON.parse(await readFile(path.join(root, '.aiwg/aiwg.config'), 'utf8'));
  delete config.installed.utils.source;
  config.providers.push('muse');
  await write('.aiwg/aiwg.config', config);
  const before = await readFile(path.join(root, '.aiwg/aiwg.config'));
  expect(await configuredDeploymentStaleness(root, frameworkRoot)).toEqual([expect.objectContaining({
    provider: 'claude', severity: 'advisory', message: expect.stringContaining('utils (v2026.11.4'),
  })]);
  expect(await readFile(path.join(root, '.aiwg/aiwg.config'))).toEqual(before);
});
it('keeps a failed deployment failed and degrades a ready deployment with freshness advisories', async () => {
  await installed('2026.11.4');
  const ready: ProviderDeploymentVerification = {
    provider: 'claude', scope: 'project', outcome: 'ready', restartRequired: true,
    restartAction: 'Restart Claude', restartReason: null, reloadPolicy: 'restart-required', reloadFallback: null,
    counts: { agents: 0, commands: 0, skills: 0, rules: 0, behaviors: 0 }, findings: [],
    phases: ['resolve', 'deploy', 'verify', 'report'].map(id => ({
      id: id as 'resolve' | 'deploy' | 'verify' | 'report', state: 'passed', required: true, summary: 'verified',
    })),
  };
  const degraded = await withDeploymentStaleness(ready, options());
  expect(degraded.outcome).toBe('degraded');
  expect(degraded.restartRequired).toBe(true);
  expect(degraded.phases.find(p => p.id === 'deploy')?.summary).toContain('freshness advisories');
  expect(degraded.phases.find(p => p.id === 'verify')?.summary).toBe('0 blocking and 1 advisory finding(s).');
  expect(degraded.phases.find(p => p.id === 'report')?.summary).toContain('degraded');
  expect((await withDeploymentStaleness({ ...ready, outcome: 'failed' }, options())).outcome).toBe('failed');
});
it('accepts a runtime without package metadata but reports unreadable metadata', async () => {
  await rm(path.join(frameworkRoot, 'package.json'));
  expect(await deploymentStaleness(options())).toEqual([]);
  await write('runtime/package.json', '{broken');
  expect(await deploymentStaleness(options())).toContainEqual(expect.objectContaining({ id: 'deployment-staleness-unreadable' }));
});
it('uses user registry versions for user scope', async () => {
  await write('user-registry.json', { version: '1', installed: { utils: {
    version: '2026.11.4', source: 'bundled', deployedTo: { claude: {} },
  } } });
  const findings = await deploymentStaleness({ ...options(), scope: 'user' });
  expect(findings).toContainEqual(expect.objectContaining({ id: 'deployment-stale-bundle:utils', remediation: expect.stringContaining('--global') }));
});
it('accepts the current Codex user hook directory anchor', async () => {
  await write('runtime/agentic/code/addons/aiwg-hooks/canonical/prompt.json', {
    id: 'aiwg-prompt-discovery', command: 'node', events: ['UserPromptSubmit'],
    args: ['$AIWG_ROOT/runtime/prompt.cjs'],
  });
  await write('runtime/runtime/prompt.cjs', '// canonical prompt discovery\n');
  await write('user-registry.json', { version: '1', installed: { sdlc: {
    version: '2026.11.8', source: 'bundled', deployedTo: { codex: {} },
  } } });
  await installCodexPromptDiscovery({ projectPath: root, frameworkRoot,
    hookDirectory: path.join(root, 'home/.codex'), scope: 'user' });
  expect(await readFile(path.join(root, 'home/.codex/hooks.json'), 'utf8')).toContain('UserPromptSubmit');
  expect(await deploymentStaleness({ ...options(), outputRoot: path.join(root, 'home'),
    provider: 'codex', scope: 'user', requestedBundles: ['sdlc'] })).toEqual([]);
});

it('checks stale managed commands only for the requested provider', async () => {
  await installed('2026.11.8');
  for (const provider of ['claude', 'codex']) {
    await write(`.${provider}/commands/old.md`, '# aiwg:managed v2026.11.4 bundled\n');
  }
  const findings = await deploymentStaleness(options());
  expect(findings).toEqual([expect.objectContaining({ id: 'deployment-stale-tree', provider: 'claude' })]);
});
it('reports malformed config and ignores unversioned or absent bundle entries', async () => {
  await write('.aiwg/aiwg.config', '{broken');
  expect(await deploymentStaleness(options())).toContainEqual(expect.objectContaining({ id: 'deployment-staleness-unreadable' }));
  const snapshot = { empty: { deployedTo: {} }, invalid: { version: 'test', deployedTo: {} } };
  expect(await deploymentStaleness({ ...options(), requestedBundles: ['absent', 'empty', 'invalid'] }, snapshot)).toEqual([]);
  expect(await configuredDeploymentStaleness(root, frameworkRoot, null)).toEqual([]);
});
it('leaves verified results unchanged when the runtime is unversioned or current', async () => {
  await installed('2026.11.8');
  const result = { outcome: 'ready' } as ProviderDeploymentVerification;
  expect(await withDeploymentStaleness(result, options())).toBe(result);
  await write('runtime/package.json', { version: 'development' });
  expect(await deploymentStaleness(options())).toEqual([]);
});
it('checks the explicit deployment root without modifying project files', async () => {
  await installed('2026.11.8');
  await write('output/.claude/rules/old.md', '<!-- aiwg:managed v2026.11.4 bundled -->\n');
  expect(await deploymentStaleness({ ...options(), outputRoot: path.join(root, 'output') }))
    .toContainEqual(expect.objectContaining({ message: expect.stringContaining('.claude/rules/old.md') }));
});
