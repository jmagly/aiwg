// Exercise declaration and receipt reconciliation with synthetic project payloads.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { projectLocalCopyMode, recordBundleDeployment } from '../../../../src/cli/handlers/bundle-deployment-mode.js';
import { emptyConfig } from '../../../../src/config/aiwg-config.js';
import { expectedBundleOwners, pruneAfterScopedDeployments, bundleProviders, pruneUndeclaredBundles } from '../../../../src/cli/handlers/bundle-reconciliation.js';
import { refreshDeclaredBundles } from '../../../../src/cli/handlers/refresh-bundles.js';
import { removeBundledDeployment } from '../../../../src/cli/handlers/remove-bundled.js';
import { declareBundle } from '../../../../src/cli/handlers/bundle-declaration.js';
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-reconcile-')); vi.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
const hash = (bytes: string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
function skill(owner: string, name: string, edited = false, provider = 'flue') {
  const dir = path.join(root, provider === 'claude' ? '.claude/skills' : '.agents/skills', name); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), edited ? 'operator edit' : 'deployed');
  fs.writeFileSync(path.join(dir, '.aiwg-manifest.json'), JSON.stringify({ managed: { 'SKILL.md': { owners: [owner], frameworkSlug: owner, hash: hash('deployed'), kind: 'skill' } } }));
  return path.join(dir, 'SKILL.md');
}
it('narrows to each bundle’s provider declarations, including aliases', () => {
  const installed = { 'sdlc-complete': { deployedTo: { flue: {}, codex: {} } }, voice: { deployedTo: { flue: {} } } };
  expect(bundleProviders(installed, 'sdlc')).toEqual(['flue', 'codex']);
  expect(bundleProviders(installed, 'voice', 'codex')).toEqual([]);
  expect(bundleProviders(installed, 'sdlc', 'codex')).toEqual(['codex']);
});
it('prunes absent bundles, keeps edits, and makes dry runs read-only', async () => {
  const keep = skill('sdlc-complete', 'keep'), remove = skill('voice-framework', 'remove'), edit = skill('voice-framework', 'edited', true);
  const config = emptyConfig(['flue']); config.installed.sdlc = { deployedTo: { flue: {} } };
  expect(await pruneUndeclaredBundles(root, config, undefined, true)).toBe(0);
  expect(fs.readFileSync(remove, 'utf8')).toBe('deployed');
  expect(await pruneUndeclaredBundles(root, config)).toBe(0);
  expect(fs.existsSync(remove)).toBe(false);
  expect(fs.readFileSync(keep, 'utf8')).toBe('deployed');
  expect(fs.readFileSync(edit, 'utf8')).toBe('operator edit');
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining('modified or unverifiable'));
  expect(Object.keys(config.installed)).toEqual(['sdlc']);
});
it('does not prune a shared Codex/Flue skill while another provider declares its bundle', async () => {
  const shared = skill('sdlc-complete', 'shared');
  const config = emptyConfig(['codex', 'flue']); config.installed.sdlc = { deployedTo: { flue: {} } };
  expect(await pruneUndeclaredBundles(root, config, 'codex')).toBe(0);
  expect(fs.readFileSync(shared, 'utf8')).toBe('deployed');
});
it('finds Flue project ownership even when installed has become empty', async () => {
  const module = path.join(root, 'src/aiwg/skills.ts'); fs.mkdirSync(path.dirname(module), { recursive: true }); fs.writeFileSync(module, 'deployed');
  fs.mkdirSync(path.join(root, '.aiwg'));
  fs.writeFileSync(path.join(root, '.aiwg/.aiwg-manifest.json'), JSON.stringify({ scope: 'project', managed: {
    'src/aiwg/skills.ts': { owners: ['voice-framework'], hash: hash('deployed'), filePreimage: { present: false } },
  } }));
  await pruneUndeclaredBundles(root, emptyConfig(['flue']));
  expect(fs.existsSync(module)).toBe(false);
});
it('declares headlessly, preserves other provider records, and undeclares without payload removal', async () => {
  const source = path.join(root, 'agentic/code/addons/voice-framework'); fs.mkdirSync(source, { recursive: true }); fs.writeFileSync(path.join(source, 'manifest.json'), '{}');
  const ctx = { cwd: root, frameworkRoot: root, rawArgs: [], args: ['voice-framework', '--provider', 'flue', '--declare'] };
  expect((await declareBundle(ctx)).exitCode).toBe(0);
  const read = () => JSON.parse(fs.readFileSync(path.join(root, '.aiwg/aiwg.config'), 'utf8'));
  expect(read().installed['voice-framework']).toEqual({ deployedTo: { flue: {} } });
  const payload = skill('voice-framework', 'voice');
  expect((await declareBundle({ ...ctx, args: ['voice-framework', '--provider', 'codex', '--declare'] })).exitCode).toBe(0);
  expect((await declareBundle(ctx, true)).exitCode).toBe(0);
  expect(read().installed['voice-framework'].deployedTo).toEqual({ codex: {} });
  expect(fs.readFileSync(payload, 'utf8')).toBe('deployed');
});

it('refreshes each pending bundle only for its recorded provider and narrows explicit requests', async () => {
  const config = emptyConfig(['codex', 'flue']);
  config.installed = { sdlc: { deployedTo: { codex: {}, flue: {} } }, 'voice-framework': { deployedTo: { flue: {} } } };
  const execute = vi.fn().mockResolvedValue({ exitCode: 0 });
  const handler = { id: 'use', name: 'use', description: '', category: 'framework', aliases: [], execute };
  const ctx = { cwd: root, args: [], rawArgs: [], frameworkRoot: root };
  const opts = { handler, frameworkRoot: root, quiet: true, dryRun: false, forceDeploy: false, modelDeployArgs: [] };
  expect(await refreshDeclaredBundles(ctx, config, Object.keys(config.installed), undefined, opts)).toEqual([]);
  expect(execute.mock.calls.map(([ctx]) => ctx.args.slice(0, 3))).toEqual([
    ['sdlc', '--provider', 'codex'], ['sdlc', '--provider', 'flue'], ['voice-framework', '--provider', 'flue'],
  ]);
  execute.mockClear();
  await refreshDeclaredBundles(ctx, config, Object.keys(config.installed), 'codex', opts);
  expect(execute.mock.calls.map(([ctx]) => ctx.args.slice(0, 3))).toEqual([['sdlc', '--provider', 'codex']]);
});

it('uses recorded project-local provider hashes after that provider is undeclared', async () => {
  const file = path.join(root, '.claude/rules/custom.md'); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'deployed');
  const config = emptyConfig(['claude', 'flue']);
  config.installed.custom = { version: '1', source: 'project-local', installedAt: '2026-10-31T00:00:00Z', localPath: '.aiwg/addons/custom', localType: 'addon',
    deployedTo: { flue: {} }, deployedArtifactHashes: { claude: { 'rules/custom.md': hash('deployed').slice(7) } } };
  await pruneUndeclaredBundles(root, config, 'claude', true);
  expect(fs.existsSync(file)).toBe(true);
  await pruneUndeclaredBundles(root, config, 'claude');
  expect(fs.existsSync(file)).toBe(false);
  expect(config.installed.custom.deployedTo).toEqual({ flue: {} });
});

it('protects shared project-local skills while pruning their undeclared provider hashes', async () => {
  const shared = skill('custom', 'custom-skill');
  const config = emptyConfig(['codex', 'flue']);
  config.installed.custom = { version: '1', source: 'project-local', installedAt: '2026-10-31T00:00:00Z', localPath: '.aiwg/addons/custom', localType: 'addon',
    deployedTo: { flue: {} }, deployedArtifactHashes: { codex: { 'skills/custom-skill/SKILL.md': hash('deployed').slice(7) } } };
  await pruneUndeclaredBundles(root, config, 'codex');
  expect(fs.readFileSync(shared, 'utf8')).toBe('deployed');
});

it('refuses an unknown explicit provider without falling back to Claude paths', async () => {
  const directory = path.join(root, '.claude/skills/demo'); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'SKILL.md'), 'deployed');
  fs.writeFileSync(path.join(directory, '.aiwg-manifest.json'), JSON.stringify({ managed: { 'SKILL.md': { owners: ['sdlc-complete'], hash: hash('deployed') } } }));
  expect(await pruneUndeclaredBundles(root, emptyConfig(['claude']), 'unsupported')).toBe(1);
  expect(fs.readFileSync(path.join(directory, 'SKILL.md'), 'utf8')).toBe('deployed');
});

it.each(['claude', 'codex', 'flue'])('derives %s expected owners from the deployment discovery policy', async provider => {
  for (const [group, id, manifest] of [
    ['frameworks', 'sdlc-complete', {}], ['addons', 'new-auto-addon', {}],
    ['addons', 'opt-in', { explicitInstall: true }], ['addons', 'contributor', { devOnly: true }],
    ['extensions', 'new-extension', {}], ['extensions', 'api-adapter', {}],
  ] as const) {
    const dir = path.join(root, 'agentic/code', group, id); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  }
  const config = emptyConfig([provider]); config.installed.sdlc = { deployedTo: { [provider]: {} } };
  for (const owner of ['new-auto-addon', 'new-extension', 'opt-in', 'contributor', 'api-adapter']) skill(owner, owner, false, provider);
  expect(await pruneUndeclaredBundles(root, config, provider, true, root)).toBe(0);
  const planned = vi.mocked(console.log).mock.calls.map(([line]) => line).filter(line => /^Would remove \S+ for /.test(line));
  expect(planned.sort()).toEqual((provider === 'flue'
    ? ['new-auto-addon', 'new-extension', 'opt-in', 'contributor', 'api-adapter']
    : ['opt-in', 'contributor', 'api-adapter']).map(owner => `Would remove ${owner} for ${provider}`).sort());
});

it('matches canonical receipt owners for the general framework alias on Flue', async () => {
  const file = skill('writing-quality', 'writing');
  const config = emptyConfig(['flue']); config.installed.general = { deployedTo: { flue: {} } };
  expect(bundleProviders(config.installed, 'writing-quality')).toEqual(['flue']);
  expect(await pruneUndeclaredBundles(root, config, 'flue', false, root)).toBe(0);
  expect(fs.readFileSync(file, 'utf8')).toBe('deployed');
  expect(console.log).not.toHaveBeenCalled();
});

it.each(['claude', 'flue'])('preserves required addon owners only when %s deploys dependencies', async provider => {
  for (const [id, required] of [['opt-in', ['support']], ['support', []]] as const) {
    const dir = path.join(root, 'agentic/code/addons', id); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id, dependencies: { required } }));
  }
  const file = skill('support', 'support', false, provider);
  const config = emptyConfig([provider]); config.installed['opt-in'] = { deployedTo: { [provider]: {} } };
  expect(await pruneUndeclaredBundles(root, config, provider, false, root)).toBe(0);
  expect(fs.existsSync(file)).toBe(provider === 'claude');
});

it('protects shared skills produced by another provider’s declared addon dependency', async () => {
  for (const [id, required] of [['opt-in', ['support']], ['support', []]] as const) {
    const dir = path.join(root, 'agentic/code/addons', id); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id, dependencies: { required } }));
  }
  const file = skill('support', 'shared-support');
  const config = emptyConfig(['codex', 'flue']); config.installed['opt-in'] = { deployedTo: { codex: {}, flue: {} } };
  expect(await pruneUndeclaredBundles(root, config, 'flue', false, root)).toBe(0);
  expect(fs.readFileSync(file, 'utf8')).toBe('deployed');
});

it('inherits either copy flag for a new local bundle and retains separately declared provider modes', () => {
  const config = emptyConfig(['claude', 'codex']);
  expect(projectLocalCopyMode(config, 'custom', 'claude', ['--copy-standard-skills'], false)).toBe(true);
  expect(projectLocalCopyMode(config, 'custom', 'claude', ['--copy-all'], false)).toBe(true);
  config.installed.custom = { deployedTo: { claude: { copy: false }, codex: { copy: true } } };
  expect(projectLocalCopyMode(config, 'custom', 'claude', ['--copy-all'], false)).toBe(false);
  expect(projectLocalCopyMode(config, 'custom', 'codex', [], false)).toBe(true);
  expect(projectLocalCopyMode(config, 'custom', 'claude', ['--copy-all'], true)).toBe(true);
  expect(projectLocalCopyMode(config, 'custom', 'codex', [], true)).toBe(false);
});
it('keeps historical project-local copy hashes when the bundle uses a framework alias', async () => {
  const file = path.join(root, '.claude/rules/custom.md'); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'deployed');
  await recordBundleDeployment(root, 'sdlc', 'claude', ['--copy-all'], root);
  const config = emptyConfig(['claude', 'flue']);
  config.installed.sdlc = { version: '1', source: 'project-local', installedAt: '2026-10-31T00:00:00Z', localPath: '.aiwg/addons/sdlc', localType: 'addon',
    deployedTo: { flue: {} }, deployedArtifactHashes: { claude: { 'rules/custom.md': hash('deployed').slice(7) } } };
  expect(await pruneUndeclaredBundles(root, config, 'claude', false, root)).toBe(0);
  expect(fs.readFileSync(file, 'utf8')).toBe('deployed');
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining('kept (copy mode)'));
});

it('keeps the recorded copy mode when explicit removal leaves an edited bundle file', async () => {
  const file = skill('voice-framework', 'edited-copy', true, 'claude');
  const config = emptyConfig(['claude']);
  config.installed['voice-framework'] = { version: '1', source: 'bundled', installedAt: '2026-10-31T00:00:00Z',
    deployedTo: { claude: { agents: 0, commands: 0, skills: 1, rules: 0, copy: true } } };
  fs.mkdirSync(path.join(root, '.aiwg'), { recursive: true }); fs.writeFileSync(path.join(root, '.aiwg/aiwg.config'), JSON.stringify(config));
  const result = await removeBundledDeployment(root, 'voice-framework', 'voice-framework', config, ['claude'], { dryRun: false, keepRegistry: false });
  expect(result.exitCode, result.message).toBe(0);
  expect(config.installed['voice-framework'].deployedTo.claude.copy).toBe(true);
  expect(fs.readFileSync(file, 'utf8')).toBe('operator edit');
});

it('prunes only the declared parent, retaining additive owners on later refreshes too', async () => {
  for (const [group, id] of [['frameworks', 'sdlc-complete'], ['addons', 'automatic-addon']]) {
    const dir = path.join(root, 'agentic/code', group, id); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'manifest.json'), '{}');
  }
  const parent = skill('sdlc-complete', 'parent', false, 'claude');
  const additive = skill('automatic-addon', 'automatic', false, 'claude');
  await recordBundleDeployment(root, 'sdlc', 'claude', [], root);
  const config = emptyConfig(['claude']);
  for (let iteration = 0; iteration < 2; iteration++) expect(await pruneUndeclaredBundles(root, config, 'claude', false, root)).toBe(0);
  expect(fs.existsSync(parent)).toBe(false);
  expect(fs.readFileSync(additive, 'utf8')).toBe('deployed');
});

it.each([undefined, false, true])('uses each provider’s recorded additive gates (skipUtils=%s)', async skipUtils => {
  for (const [group, id] of [['frameworks', 'sdlc-complete'], ['addons', 'aiwg-utils'], ['extensions', 'example']]) {
    const dir = path.join(root, 'agentic/code', group, id); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{}');
  }
  const config = emptyConfig(['claude', 'codex']);
  config.installed.sdlc = { deployedTo: { claude: { skipUtils }, codex: { skipUtils: false, kernelOnly: true } } };
  const owners = await expectedBundleOwners(config, 'claude', root);
  expect(owners.has('aiwg-utils')).toBe(skipUtils !== true);
  expect(owners.has('example')).toBe(skipUtils !== true);
  const kernel = await expectedBundleOwners(config, 'codex', root);
  expect(kernel.has('aiwg-utils')).toBe(true);
  expect(kernel.has('example')).toBe(false);
  // Another framework with unknown flags broadens the union safely.
  config.installed.all = { deployedTo: { claude: {} } };
  expect((await expectedBundleOwners(config, 'claude', root)).has('example')).toBe(true);
});

it('records copy-derived kernel scope and retains an all-framework declaration without keeping skipped addons', async () => {
  for (const [group, id] of [['frameworks', 'sdlc-complete'], ['addons', 'aiwg-utils'], ['extensions', 'example']]) {
    const dir = path.join(root, 'agentic/code', group, id); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{}');
  }
  const { bundleDeploymentHistory } = await import('../../../../src/cli/handlers/bundle-deployment-mode.js');
  await recordBundleDeployment(root, 'all', 'claude', ['--no-utils'], root);
  expect(bundleDeploymentHistory(root).claude.all).toEqual({ copy: false, skipUtils: true, kernelOnly: true, produces: ['sdlc-complete'] });
  await recordBundleDeployment(root, 'all', 'codex', ['--copy-all'], root);
  expect(bundleDeploymentHistory(root).codex.all).toMatchObject({ copy: true, skipUtils: false, kernelOnly: false });
  const config = emptyConfig(['claude']); config.installed.all = { deployedTo: { claude: { skipUtils: true, kernelOnly: true } } };
  const unchanged = skill('aiwg-utils', 'old-utils', false, 'claude');
  const edited = skill('aiwg-utils', 'edited-utils', true, 'claude');
  const keep = skill('sdlc-complete', 'sdlc', false, 'claude');
  expect(await pruneUndeclaredBundles(root, config, 'claude', false, root)).toBe(0);
  expect(fs.existsSync(unchanged)).toBe(false);
  expect(fs.readFileSync(edited, 'utf8')).toBe('operator edit');
  expect(fs.readFileSync(keep, 'utf8')).toBe('deployed');
});

it('retains Flue’s composed all owner with recorded kernel flags', async () => {
  const file = skill('all', 'composed-kernel');
  const config = emptyConfig(['flue']);
  config.installed.all = { deployedTo: { flue: { skipUtils: false, kernelOnly: true } } };
  expect(await expectedBundleOwners(config, 'flue', root)).toEqual(new Set(['all']));
  expect(await pruneUndeclaredBundles(root, config, 'flue', false, root)).toBe(0);
  expect(fs.readFileSync(file, 'utf8')).toBe('deployed');
});

it('removes recreated additive copies after a restricted deploy and leaves unknown scope alone', async () => {
  for (const [group, id] of [['frameworks', 'sdlc-complete'], ['addons', 'aiwg-utils']]) {
    const dir = path.join(root, 'agentic/code', group, id); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{}');
  }
  const config = emptyConfig(['claude']); config.installed.sdlc = { deployedTo: { claude: { skipUtils: true, kernelOnly: false } } };
  fs.mkdirSync(path.join(root, '.aiwg'), { recursive: true });
  fs.writeFileSync(path.join(root, '.aiwg/aiwg.config'), JSON.stringify(config));
  const file = skill('aiwg-utils', 'recreated', false, 'claude');
  const edited = skill('aiwg-utils', 'edited', true, 'claude');
  const unknown = structuredClone(config); unknown.installed.sdlc.deployedTo.claude = {};
  expect(await pruneAfterScopedDeployments(root, unknown, 'claude', root)).toBe(0);
  expect(fs.existsSync(file)).toBe(true);
  expect(await pruneAfterScopedDeployments(root, config, 'claude', root)).toBe(0);
  expect(fs.existsSync(file)).toBe(false);
  expect(fs.readFileSync(edited, 'utf8')).toBe('operator edit');
});


it('retains package history after undeclaration and replaces it on an index redeploy', async () => {
  const { bundleDeploymentHistory } = await import('../../../../src/cli/handlers/bundle-deployment-mode.js');
  const file = skill('sdlc-complete', 'package-owned');
  await recordBundleDeployment(root, 'sdlc', 'flue', ['--package'], root);
  expect(bundleDeploymentHistory(root).flue['sdlc-complete']).toMatchObject({ copy: false, package: true });
  const config = emptyConfig(['flue']);
  expect(await pruneUndeclaredBundles(root, config, 'flue', false, root)).toBe(0);
  expect(fs.readFileSync(file, 'utf8')).toBe('deployed');
  await recordBundleDeployment(root, 'sdlc', 'flue', [], root);
  expect(bundleDeploymentHistory(root).flue['sdlc-complete'].package).toBe(false);
  expect(await pruneUndeclaredBundles(root, config, 'flue', false, root)).toBe(0);
  expect(fs.existsSync(file)).toBe(false);
});

it('protects shared skills using an undeclared Flue package history', async () => {
  const shared = skill('sdlc-complete', 'shared-package');
  await recordBundleDeployment(root, 'sdlc', 'flue', ['--package'], root);
  const config = emptyConfig(['codex', 'flue']);
  expect(await pruneUndeclaredBundles(root, config, 'codex', false, root)).toBe(0);
  expect(fs.readFileSync(shared, 'utf8')).toBe('deployed');
});

it('keeps historical project-local package hashes after Flue is undeclared', async () => {
  const file = skill('custom', 'local-package');
  await recordBundleDeployment(root, 'custom', 'flue', ['--package'], root);
  const config = emptyConfig(['flue']);
  config.installed.custom = { source: 'project-local', localPath: '.aiwg/addons/custom', localType: 'addon',
    deployedTo: {}, deployedArtifactHashes: { flue: { 'skills/local-package/SKILL.md': hash('deployed').slice(7) } } };
  expect(await pruneUndeclaredBundles(root, config, 'flue', false, root)).toBe(0);
  expect(fs.readFileSync(file, 'utf8')).toBe('deployed');
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining('kept (package mode)'));
});
