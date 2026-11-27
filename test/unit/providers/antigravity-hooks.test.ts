// Native agy hook schema, deployment, runtime deduplication and refresh regressions.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { translateForAntigravity, managedAntigravityPromptHook, ANTIGRAVITY_EVENT_MAP } from '../../../src/smiths/hook-bridge/antigravity-translator.js';
import { bridgeAll, loadHookSources } from '../../../src/smiths/hook-bridge/index.js';
import { postDeploy } from '../../../tools/agents/providers/antigravity.mjs';
import { checkManagedDeployment } from '../../../src/cli/handlers/refresh-managed-deployment.js';
import { getProviderDefinition } from '../../../src/providers/provider-definitions.js';
import type { HookSource } from '../../../src/smiths/hook-bridge/types.js';
import contract from '../../fixtures/providers/antigravity-conformance/hooks-contract.json';

const frameworkRoot = path.resolve(import.meta.dirname, '../../..');
const canonical = path.join(frameworkRoot, 'agentic/code/addons/aiwg-hooks/hooks/aiwg-prompt-discovery.cjs');
let temporary: string, project: string, runtime: string;
const write = (file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
};
const read = (file = '.agents/hooks.json') => JSON.parse(fs.readFileSync(path.join(project, file), 'utf8'));
const check = () => checkManagedDeployment({ projectRoot: project, frameworkRoot, provider: 'antigravity', quiet: true });
async function source() { return (await loadHookSources(frameworkRoot)).sources.find(hook => hook.id === 'aiwg-prompt-discovery')!; }
async function deploy(dryRun = false) {
  const [result] = await bridgeAll([await source()], ['antigravity'], { projectPath: project, dryRun });
  expect(result.skipped, JSON.stringify(result)).toBe(false);
  return result;
}
function invoke(overrides: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  return spawnSync(read()['aiwg-prompt-discovery'].PreInvocation[0].command, {
    shell: true, cwd: path.join(project, '.agents'), encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, AIWG_ROOT: runtime, AIWG_PROMPT_DISCOVERY: '1', TMPDIR: temporary, ...env },
    input: JSON.stringify({ conversationId: 'conversation-one', workspacePaths: [project],
      lastUserInput: 'Review the security code', invocationNum: 1, ...overrides }),
  });
}
beforeEach(() => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-antigravity-hooks-'));
  project = path.join(temporary, "project's $literal"); runtime = path.join(temporary, 'runtime');
  fs.mkdirSync(project);
  write(path.join(runtime, 'dist/src/artifacts/query-engine-discover.js'),
    fs.readFileSync(path.join(frameworkRoot, 'test/fixtures/hooks-prompt-discovery.mjs'), 'utf8'));
  vi.stubEnv('HOME', path.join(temporary, 'home'));
  vi.stubEnv('XDG_DATA_HOME', path.join(temporary, 'data'));
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(temporary, { recursive: true, force: true }); });

it('declares native prompt discovery in the provider contract', () => {
  expect(getProviderDefinition('agy')?.adapters.hookBridge).toBe('antigravity');
  expect(getProviderDefinition('antigravity')?.context.promptDiscovery).toEqual({ delivery: 'hook-bridge', event: 'PreInvocation',
    files: ['.agents/hooks.json', '.agents/hooks/aiwg-prompt-discovery.cjs'] });
});
it('emits only native keys and the event names verified against installed agy 1.3.3', async () => {
  expect(contract.version).toBe('1.3.3');
  const eventNames = contract.jsonHookSpecFields.map(field => field.name);
  for (const event of Object.values(ANTIGRAVITY_EVENT_MAP)) expect(eventNames).toContain(event);
  expect(contract.protobufMessages.PreInvocationHookResult).toContainEqual(expect.objectContaining({ jsonName: 'injectSteps' }));
  expect(contract.protobufMessages.HookInjectedStep).toContainEqual(expect.objectContaining({ jsonName: 'systemMessage', typeName: '.exa.hooks_pb.HookSystemMessage' }));
  expect(contract.protobufMessages.HookSystemMessage).toContainEqual(expect.objectContaining({ jsonName: 'systemMessage', type: 9 }));
  await deploy();
  expect(Object.keys(read())).toEqual(['aiwg-prompt-discovery']);
  const registration = read()['aiwg-prompt-discovery'];
  expect(Object.keys(registration)).toEqual(['PreInvocation']);
  expect(Object.keys(registration.PreInvocation[0]).sort()).toEqual(['command', 'timeout', 'type']);
  expect(registration.PreInvocation[0]).toMatchObject({ type: 'command', timeout: 2 });
});
it('maps lifecycle handlers flat and tool handlers in matcher groups, warning on unsupported events', async () => {
  const hook: HookSource = { id: 'fixture', description: 'fixture', command: 'echo', args: ['fixture'], timeout: 3,
    events: ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd'] };
  const result = await translateForAntigravity(hook, { projectPath: project });
  expect(result.warnings).toEqual(['Unsupported Antigravity hook event: SessionEnd']);
  const handler = { type: 'command', command: "echo 'fixture'", timeout: 3 };
  expect(read().fixture).toEqual({ SessionStart: [handler], PreToolUse: [{ matcher: '*', hooks: [handler] }],
    PostToolUse: [{ matcher: '*', hooks: [handler] }], Stop: [handler] });
});
it('preserves operator hooks and disablement, records ownership, and redeploys idempotently', async () => {
  const operator = { Stop: [{ command: 'echo operator' }] };
  const prior = { hash: 'sha256:fixture', owners: ['fixture'], kind: 'generated' };
  write(path.join(project, '.agents/.aiwg-manifest.json'), { managed: { 'neighbour.md': prior } });
  write(path.join(project, '.agents/hooks.json'), { operator });
  await deploy(); const once = fs.readFileSync(path.join(project, '.agents/hooks.json'), 'utf8');
  await deploy();
  expect(fs.readFileSync(path.join(project, '.agents/hooks.json'), 'utf8')).toBe(once);
  expect(read().operator).toEqual(operator);
  expect(read('.agents/.aiwg-manifest.json').managed['neighbour.md']).toEqual(prior);
  expect(read('.agents/hooks/.aiwg-manifest.json').managed['aiwg-prompt-discovery.cjs'].owners).toContain('aiwg-hooks');
  expect(await check()).toEqual([]);
  const doc = read(); doc['aiwg-prompt-discovery'].enabled = false; write(path.join(project, '.agents/hooks.json'), doc);
  await deploy(); expect(read()['aiwg-prompt-discovery'].enabled).toBe(false);
  expect(await check()).toContainEqual(expect.objectContaining({ reason: 'outdated' }));
});
it('injects bounded protojson context once per conversation and exact prompt', async () => {
  await deploy();
  const first = invoke();
  expect(first.status).toBe(0); expect(first.stderr).toBe('');
  const result = JSON.parse(first.stdout);
  const text = result.injectSteps[0].systemMessage.systemMessage;
  expect(Object.keys(result)).toEqual(['injectSteps']);
  expect(text).toContain('security-review'); expect(text.length).toBeLessThan(600);
  expect(invoke({ invocationNum: 2 }).stdout).toBe('');
  expect(invoke({ conversationId: 'conversation-two' }).stdout).not.toBe('');
  expect(invoke({ lastUserInput: 'Review another security module', invocationNum: 3 }).stdout).not.toBe('');
  const markers = fs.readdirSync(path.join(temporary, 'aiwg-antigravity-prompt-discovery'));
  expect(markers).toHaveLength(3); expect(markers.every(name => /^[a-f0-9]{64}$/.test(name))).toBe(true);
});
it('passes the workspace path to discovery even though agy invokes from .agents', async () => {
  write(path.join(runtime, 'dist/src/artifacts/query-engine-discover.js'), `export async function discoverCapability(cwd) {
    if (cwd !== ${JSON.stringify(project)}) throw Error('wrong cwd');
    console.log(JSON.stringify({results: [{type: 'skill', name: 'workspace-verified', score: 0.95}]}));
  }`);
  await deploy(); expect(invoke().stdout).toContain('workspace-verified');
});
it.each([{ lastUserInput: 'yes' }, { lastUserInput: '' }, { conversationId: '' }, { workspacePaths: [] },
  { workspacePaths: ['relative'] }, { lastUserInput: 'Trigger discovery error' }])('fails open for %j', async event => {
  await deploy(); const result = invoke(event); expect(result.status).toBe(0); expect(result.stdout).toBe('');
});
it('does not consume the dedup key when disabled or discovery fails', async () => {
  await deploy(); expect(invoke({}, { AIWG_PROMPT_DISCOVERY: '0' }).stdout).toBe('');
  expect(invoke({}, { AIWG_ROOT: path.join(temporary, 'missing') }).stdout).toBe('');
  expect(invoke().stdout).not.toBe('');
});
it('reports missing and stale registrations and scripts, preserving edited scripts', async () => {
  expect(await check()).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'PreInvocation → aiwg-prompt-discovery', reason: 'missing' }),
    expect.objectContaining({ file: '.agents/hooks/aiwg-prompt-discovery.cjs', reason: 'missing' }),
  ]));
  await deploy(); const doc = read(); doc['aiwg-prompt-discovery'].PreInvocation[0].command = 'node obsolete.cjs';
  write(path.join(project, '.agents/hooks.json'), doc);
  expect(await check()).toContainEqual(expect.objectContaining({ reason: 'outdated' }));
  await deploy(); expect(await check()).toEqual([]);
  write(path.join(project, '.agents/hooks/aiwg-prompt-discovery.cjs'), '// operator edit\n');
  expect(await check()).toContainEqual(expect.objectContaining({ reason: 'operator-edited' }));
  expect((await deploy()).warnings.join(' ')).toContain('operator-edited');
});
it.each(['{', '[]', '{"fixture":null}'])('refuses malformed native config %s', async text => {
  write(path.join(project, '.agents/hooks.json'), text);
  await expect(translateForAntigravity(await source(), { projectPath: project })).rejects.toThrow();
  expect(fs.readFileSync(path.join(project, '.agents/hooks.json'), 'utf8')).toBe(text);
});
it.each(['.agents', '.agents/hooks', '.agents/hooks.json', '.agents/hooks/aiwg-prompt-discovery.cjs'])(
  'refuses symlinked targets %s', async relative => {
    const outside = path.join(temporary, 'outside'); fs.mkdirSync(outside);
    const target = path.join(project, relative); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(outside, target);
    await expect(translateForAntigravity(await source(), { projectPath: project })).rejects.toThrow('symlinked');
    expect(fs.readdirSync(outside)).toEqual([]);
  });
it('honors dry-run, no-hooks, user scope, partial deploys and explicit degrade-on', async () => {
  await deploy(true); expect(fs.existsSync(path.join(project, '.agents'))).toBe(false);
  for (const options of [{ hooks: false }, { rulesOnly: true }, { commandsOnly: true }, { skillsOnly: true }]) {
    await postDeploy(project, { ...options, quiet: true, contextFiles: false });
    expect(fs.existsSync(path.join(project, '.agents/hooks.json'))).toBe(false);
  }
  expect((await translateForAntigravity(await source(), { projectPath: project, scope: 'user' })).skipped).toBe(true);
  expect((await translateForAntigravity({ ...await source(), degradeOn: ['antigravity'] }, { projectPath: project })).skipped).toBe(true);
});
it('public use all emits discovery-first startup and refresh detects a deleted native registration', () => {
  const cli = (...args: string[]) => execFileSync(process.execPath, [path.join(frameworkRoot, 'bin/aiwg.mjs'), ...args], {
    cwd: project, env: { ...process.env, AIWG_NO_UPDATE_CHECK: '1', NO_UPDATE_NOTIFIER: '1' },
    encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
  });
  cli('use', 'all', '--provider', 'antigravity');
  expect(read()['aiwg-prompt-discovery']).toEqual(managedAntigravityPromptHook(project, fs.readFileSync(canonical)));
  const hook = fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8').split('<!-- AIWG:rule-hook-antigravity:start -->')[1].split('<!-- AIWG:rule-hook-antigravity:end -->')[0];
  expect(hook).toContain('first information-gathering call');
  expect(hook.indexOf('aiwg discover')).toBeLessThan(hook.indexOf('RULES-INDEX.md'));
  fs.rmSync(path.join(project, '.agents/hooks.json'));
  expect(cli('refresh', '--dry-run', '--skip-update', '--provider', 'antigravity')).toContain('PreInvocation → aiwg-prompt-discovery');
}, 240_000);
