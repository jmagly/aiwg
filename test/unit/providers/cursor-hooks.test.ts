// Cursor prompt discovery deployment, native transport, preservation and refresh regression coverage.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { translateForCursor, installCursorPromptDiscovery } from '../../../src/smiths/hook-bridge/cursor-translator.js';
import { deployCursorPromptDiscovery } from '../../../tools/agents/providers/cursor-prompt-discovery.mjs';
import { postDeploy as cursorPostDeploy } from '../../../tools/agents/providers/cursor.mjs';
import { bridgeAll, loadHookSources } from '../../../src/smiths/hook-bridge/index.js';
import { checkManagedDeployment } from '../../../src/cli/handlers/refresh-managed-deployment.js';
import { getProviderDefinition } from '../../../src/providers/provider-definitions.js';

const frameworkRoot = path.resolve(import.meta.dirname, '../../..');
const canonical = path.join(frameworkRoot, 'agentic/code/addons/aiwg-hooks/hooks/aiwg-prompt-discovery.cjs');
let temporary: string;
let project: string;
let runtime: string;
const operator = { command: 'echo operator', timeout: 3 };
const write = (file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
};
const read = (file = '.cursor/hooks.json') => JSON.parse(fs.readFileSync(path.join(project, file), 'utf8'));
const check = () => checkManagedDeployment({ projectRoot: project, frameworkRoot, provider: 'cursor', quiet: true });
async function deploy(dryRun = false) {
  const { sources } = await loadHookSources(frameworkRoot);
  const [result] = await bridgeAll([sources.find(source => source.id === 'aiwg-prompt-discovery')!], ['cursor'],
    { projectPath: project, dryRun });
  expect(result.skipped, JSON.stringify(result)).toBe(false);
  return result;
}
function invoke(prompt: string, command?: string) {
  const options = { cwd: project, encoding: 'utf8' as const, timeout: 10_000,
    env: { ...process.env, AIWG_ROOT: runtime, AIWG_PROMPT_DISCOVERY: '1' },
    input: JSON.stringify({ hook_event_name: 'beforeSubmitPrompt', prompt, workspace_roots: [project] }) };
  return command ? execFileSync(command, { ...options, shell: true, timeout: 10_000 })
    : execFileSync(process.execPath, [canonical], { ...options, timeout: 10_000 });
}
beforeEach(() => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-cursor-hooks-'));
  project = path.join(temporary, "project's $literal");
  runtime = path.join(temporary, 'runtime');
  fs.mkdirSync(project);
  const module = path.join(runtime, 'dist/src/artifacts/query-engine-discover.js');
  write(module, fs.readFileSync(path.join(frameworkRoot, 'test/fixtures/hooks-prompt-discovery.mjs'), 'utf8'));
  vi.stubEnv('HOME', path.join(temporary, 'home'));
  vi.stubEnv('XDG_DATA_HOME', path.join(temporary, 'data'));
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(temporary, { recursive: true, force: true }); });

it('declares the existing Cursor hook bridge adapter', () => {
  expect(getProviderDefinition('cursor')?.adapters.hookBridge).toBe('cursor');
  expect(getProviderDefinition('cursor')?.context.promptDiscovery).toMatchObject({
    delivery: 'hook-bridge', event: 'beforeSubmitPrompt',
    files: ['.cursor/hooks.json', '.cursor/hooks/aiwg-prompt-discovery.cjs'],
  });
});
it('reports a missing registration and script before installation', async () => {
  expect(await check()).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'beforeSubmitPrompt → aiwg-prompt-discovery', reason: 'missing' }),
    expect.objectContaining({ file: '.cursor/hooks/aiwg-prompt-discovery.cjs', reason: 'missing' }),
  ]));
});
it.each(['Review the authentication code for security issues', 'Review long capabilities for security issues',
  'Show long template hints for an issue update', 'Show weak long template hints for an issue update',
  'Find Jira CSV ' + '🙂'.repeat(1000)])('returns bounded native additional_context for %s', prompt => {
  const result = JSON.parse(invoke(prompt));
  expect(result.continue).toBe(true);
  expect(typeof result.additional_context).toBe('string');
  expect(result.additional_context.length).toBeGreaterThan(0);
  expect(result.additional_context.length).toBeLessThan(600);
  expect(result.additional_context.length).toBeLessThanOrEqual(10_000);
  expect(result.hookSpecificOutput).toBeUndefined();
});
it('keeps continuation prompts fail-open', () => { expect(invoke('yes')).toBe(''); });
it('merges a flat event array, preserves operator hooks and records ownership idempotently', async () => {
  write(path.join(project, '.cursor/hooks.json'), { version: 1, operatorSetting: 42,
    hooks: { beforeSubmitPrompt: [operator], afterAgentResponse: [operator] } });
  await deploy();
  await deploy();
  const doc = read();
  expect(doc).toMatchObject({ version: 1, operatorSetting: 42, hooks: { afterAgentResponse: [operator] } });
  expect(doc.hooks.beforeSubmitPrompt).toHaveLength(2);
  expect(doc.hooks.beforeSubmitPrompt[0]).toEqual(operator);
  expect(doc.hooks.beforeSubmitPrompt[1]).toMatchObject({ type: 'command', timeout: 2,
    _aiwg_managed: true, _aiwg_id: 'aiwg-prompt-discovery' });
  expect(fs.readFileSync(path.join(project, '.cursor/hooks/aiwg-prompt-discovery.cjs'))).toEqual(fs.readFileSync(canonical));
  expect(read('.cursor/hooks/.aiwg-manifest.json').managed['aiwg-prompt-discovery.cjs'].owners).toContain('aiwg-hooks');
  expect(await check()).toEqual([]);
  expect(JSON.parse(invoke('Review security code', doc.hooks.beforeSubmitPrompt[1].command)).additional_context).toContain('security-review');
});
it('does not write on dry-run', async () => {
  await deploy(true);
  expect(fs.existsSync(path.join(project, '.cursor'))).toBe(false);
});
it('detects a stale registration and repairs it', async () => {
  await deploy();
  const doc = read();
  doc.hooks.beforeSubmitPrompt[0].command = 'node obsolete.cjs';
  write(path.join(project, '.cursor/hooks.json'), doc);
  expect(await check()).toContainEqual(expect.objectContaining({ reason: 'outdated', name: 'beforeSubmitPrompt → aiwg-prompt-discovery' }));
  await deploy();
  expect(await check()).toEqual([]);
});
it('preserves edited scripts and reports their drift', async () => {
  await deploy();
  const script = path.join(project, '.cursor/hooks/aiwg-prompt-discovery.cjs');
  write(script, '// operator edit\n');
  expect(await check()).toContainEqual(expect.objectContaining({ file: '.cursor/hooks/aiwg-prompt-discovery.cjs', reason: 'operator-edited' }));
  expect((await deploy()).warnings.join(' ')).toContain('operator-edited');
  expect(fs.readFileSync(script, 'utf8')).toBe('// operator edit\n');
});
it('reports malformed configuration without overwriting it', async () => {
  const file = path.join(project, '.cursor/hooks.json');
  write(file, '{');
  expect(await check()).toContainEqual(expect.objectContaining({ reason: 'unreadable' }));
  const { sources } = await loadHookSources(frameworkRoot);
  const [result] = await bridgeAll([sources.find(s => s.id === 'aiwg-prompt-discovery')!], ['cursor'], { projectPath: project });
  expect(result.skipReason).toBe('translator error');
  expect(fs.readFileSync(file, 'utf8')).toBe('{');
});
it('public use installs the hook and refresh detects a missing registration', () => {
  const cli = (...args: string[]) => execFileSync(process.execPath, [path.join(frameworkRoot, 'bin/aiwg.mjs'), ...args], {
    cwd: project, env: { ...process.env, AIWG_NO_UPDATE_CHECK: '1', NO_UPDATE_NOTIFIER: '1' },
    encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
  });
  cli('use', 'all', '--provider', 'cursor');
  expect(read().hooks.beforeSubmitPrompt).toHaveLength(1);
  fs.rmSync(path.join(project, '.cursor/hooks.json'));
  expect(cli('refresh', '--dry-run', '--skip-update', '--provider', 'cursor')).toContain('beforeSubmitPrompt → aiwg-prompt-discovery');
}, 240_000);

it('replaces an outdated managed script while preserving its operator neighbours', async () => {
  await deploy();
  const script = path.join(project, '.cursor/hooks/aiwg-prompt-discovery.cjs');
  write(script, '// older canonical version\n');
  const receipt = read('.cursor/hooks/.aiwg-manifest.json');
  receipt.managed['aiwg-prompt-discovery.cjs'].hash = 'sha256:' + createHash('sha256').update(fs.readFileSync(script)).digest('hex');
  write(path.join(project, '.cursor/hooks/.aiwg-manifest.json'), receipt);
  expect(await check()).toContainEqual(expect.objectContaining({ file: '.cursor/hooks/aiwg-prompt-discovery.cjs', reason: 'outdated' }));
  await deploy();
  expect(await check()).toEqual([]);
});
it.each(['.cursor', '.cursor/hooks', '.cursor/hooks.json', '.cursor/hooks/aiwg-prompt-discovery.cjs'])(
  'rejects a symlinked deployment target %s', async relative => {
    const target = path.join(temporary, 'operator-target');
    const file = path.join(project, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (relative.endsWith('.json') || relative.endsWith('.cjs')) write(target, '// operator');
    else fs.mkdirSync(target);
    fs.symlinkSync(target, file);
    const { sources } = await loadHookSources(frameworkRoot);
    await expect(translateForCursor(sources.find(source => source.id === 'aiwg-prompt-discovery')!, { projectPath: project }))
      .rejects.toThrow('Refusing symlinked Cursor hook target');
  });
it.each([{ hooks: false }, { commandsOnly: true }, { rulesOnly: true }, { skillsOnly: true }, { scope: 'user' }])(
  'respects selective deployment and hook opt-out: %j', async opts => {
    await deployCursorPromptDiscovery(project, opts);
    expect(fs.existsSync(path.join(project, '.cursor'))).toBe(false);
  });
it('uses the logical project root when preparing hook commands in a staging directory', async () => {
  const { sources } = await loadHookSources(frameworkRoot);
  const source = sources.find(source => source.id === 'aiwg-prompt-discovery')!;
  await translateForCursor(source, { projectPath: project, commandRoot: path.join(temporary, 'final') });
  const command = read().hooks.beforeSubmitPrompt[0].command;
  const encoded = command.match(/Buffer.from\('([^']+)'/)[1];
  expect(JSON.parse(Buffer.from(encoded, 'base64').toString()).anchor).toBe(path.join(temporary, 'final'));
});
it('skips unrelated canonical events and explicit degrade-on without deploying files', async () => {
  const source = { id: 'other-hook', description: 'fixture', command: 'node', events: ['SessionStart' as const] };
  expect((await translateForCursor(source, { projectPath: project })).skipReason).toContain('no Cursor-mapped');
  expect((await translateForCursor({ ...source, degradeOn: ['cursor'] }, { projectPath: project })).skipReason).toContain('degrade-on');
  expect(fs.existsSync(path.join(project, '.cursor'))).toBe(false);
});

it('prepares a full Cursor project dry-run without writing hook destinations', async () => {
  await cursorPostDeploy(project, { srcRoot: frameworkRoot, mode: 'general', dryRun: true });
  expect(fs.existsSync(path.join(project, '.cursor'))).toBe(false);
});

it.each(['.cursor', '.cursor/hooks', '.cursor/hooks.json', '.cursor/hooks/aiwg-prompt-discovery.cjs'])(
  'rejects symlinked hook targets: %s', async relative => {
    const target = path.join(project, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const outside = path.join(temporary, 'outside');
    if (relative.endsWith('.json') || relative.endsWith('.cjs')) write(outside, 'operator bytes');
    else fs.mkdirSync(outside);
    fs.symlinkSync(outside, target);
    const { sources } = await loadHookSources(frameworkRoot);
    await expect(translateForCursor(sources.find(s => s.id === 'aiwg-prompt-discovery')!, { projectPath: project }))
      .rejects.toThrow('Refusing symlinked Cursor hook target');
    if (fs.statSync(outside).isFile()) expect(fs.readFileSync(outside, 'utf8')).toBe('operator bytes');
    else expect(fs.readdirSync(outside)).toEqual([]);
  });
it('detects and replaces an older managed script while retaining its ownership', async () => {
  await deploy();
  const bytes = '// previous managed release\n';
  write(path.join(project, '.cursor/hooks/aiwg-prompt-discovery.cjs'), bytes);
  const receipt = read('.cursor/hooks/.aiwg-manifest.json');
  receipt.managed['aiwg-prompt-discovery.cjs'].hash = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
  write(path.join(project, '.cursor/hooks/.aiwg-manifest.json'), receipt);
  expect(await check()).toContainEqual(expect.objectContaining({ file: '.cursor/hooks/aiwg-prompt-discovery.cjs', reason: 'outdated' }));
  await deploy();
  expect(await check()).toEqual([]);
});
it('rejects a prompt source without its canonical script', async () => {
  await expect(translateForCursor({ id: 'aiwg-prompt-discovery', description: 'fixture', command: 'node',
    events: ['UserPromptSubmit'] }, { projectPath: project })).rejects.toThrow('Missing shared prompt discovery script');
});

it('installs the canonical source directly and surfaces preservation warnings from the provider owner', async () => {
  await installCursorPromptDiscovery({ projectPath: project, frameworkRoot });
  write(path.join(project, '.cursor/hooks/aiwg-prompt-discovery.cjs'), '// operator edit\n');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await deployCursorPromptDiscovery(project, { logicalOutputPath: (directory: string) => directory });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('operator-edited'));
  } finally { warn.mockRestore(); }
});
it('rejects missing or malformed canonical source packages', async () => {
  const fixture = path.join(temporary, 'source');
  await expect(installCursorPromptDiscovery({ projectPath: project, frameworkRoot: fixture }))
    .rejects.toThrow('Missing canonical');
  write(path.join(fixture, 'agentic/code/addons/aiwg-hooks/canonical/broken.yaml'), '[');
  await expect(installCursorPromptDiscovery({ projectPath: project, frameworkRoot: fixture }))
    .rejects.toThrow();
});
it('rejects invalid native hook documents without overwriting them', async () => {
  const { sources } = await loadHookSources(frameworkRoot);
  const source = sources.find(source => source.id === 'aiwg-prompt-discovery')!;
  const invalid = [null, [], {}, { version: 0, hooks: {} }, { version: 1 }, { version: 1, hooks: [] },
    { version: 1, hooks: { beforeSubmitPrompt: {} } }, { version: 1, hooks: { beforeSubmitPrompt: [null] } }];
  for (const doc of invalid) {
    write(path.join(project, '.cursor/hooks.json'), doc);
    await expect(translateForCursor(source, { projectPath: project })).rejects.toThrow('Invalid Cursor hooks');
    expect(read()).toEqual(doc);
  }
});
it.each([{ type: 'prompt' }, { timeout: 9 }, { _aiwg_managed: false }])(
  'detects invalid managed registration attributes: %j', async attributes => {
    await deploy();
    const doc = read();
    Object.assign(doc.hooks.beforeSubmitPrompt[0], attributes);
    doc.hooks.beforeSubmitPrompt.push(null, operator);
    write(path.join(project, '.cursor/hooks.json'), doc);
    expect(await check()).toContainEqual(expect.objectContaining({ reason: 'outdated', name: 'beforeSubmitPrompt → aiwg-prompt-discovery' }));
  });
it('keeps non-Cursor refresh paths active and ignores providers without hooks', async () => {
  for (const provider of ['codex', 'factory', 'antigravity']) {
    const stale = await checkManagedDeployment({ projectRoot: project, frameworkRoot, provider, quiet: true });
    expect(stale.some(item => item.name.includes('beforeSubmitPrompt'))).toBe(false);
    if (provider !== 'antigravity') expect(stale.length).toBeGreaterThan(0);
  }
});
