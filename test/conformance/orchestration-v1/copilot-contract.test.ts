/** Copilot version, stdin and installed strict-final contracts for #4088. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rm } from '../../helpers/worker-capture-cleanup.mjs';
import { installWorkerAdapterPackage } from '../../helpers/worker-adapter-runtime.mjs';
import { loadProviderModelCapabilities, qualifyWorkerInvocationProfile, resolveWorkerAdapter } from '../../../src/models/provider-policy.js';
import { createProvider, loadInstalledWorkerAdapters } from '../../../src/models/worker-installation.mjs';
import { COPILOT_DIRECT_STDIN, COPILOT_SUPPORTED_VERSIONS } from '../../../tools/ralph-external/lib/copilot-adapter.mjs';

const MODULE = 'tools/ralph-external/lib/copilot-adapter.mjs';
const APPROVED = JSON.parse(readFileSync('test/fixtures/providers/copilot/approved-module.json', 'utf8'));
const VERSION = '1.0.106';
const MODEL = 'synthetic-copilot/model';
const roots: string[] = [];
const sha256 = (bytes: Buffer | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
async function installPackage(bytes: Buffer) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'aiwg-copilot-contract-')); roots.push(base);
  return installWorkerAdapterPackage(base, APPROVED.entry, bytes);
}
function loadingRegistry() {
  const registry = { ...structuredClone(loadProviderModelCapabilities()), workerAdapters: {} };
  registry.providers.copilot.workerAdapter = structuredClone(registry.providers.copilot.workerHealthAdapter);
  return registry;
}
let installed: { owner: any; ids: string[] };
beforeAll(async () => {
  const { packageRoot, writable } = await installPackage(readFileSync(MODULE));
  const ids = await loadInstalledWorkerAdapters({ registry: loadingRegistry(),
    modules: [{ ...APPROVED.entry, packageRoot }], workerWritableRoots: [writable], platform: 'linux' });
  installed = { owner: createProvider('copilot'), ids };
});
afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });

describe('Copilot version-bound profile (B-OG-36)', () => {
  it('CP01 pins the evidenced release, driver, argv template and health grammar; unknown controls stay unqualified', () => {
    const adapter = loadProviderModelCapabilities().providers.copilot.workerHealthAdapter!;
    expect(COPILOT_SUPPORTED_VERSIONS).toEqual([VERSION]);
    expect(adapter).toMatchObject({ supportedVersions: VERSION, adapterVersion: '1', runtimeDriver: 'installed:copilot',
      invocation: { kind: 'process', executable: 'copilot', stdin: 'brief-text', versionArgv: ['--version'] },
      qualification: { status: 'unqualified' } });
    expect(adapter.invocation.argv).toEqual(['--model', '${model}',
      '--reasoning-effort', '${effort}', '-C', '${workspace}', '--output-format', 'json', '--no-ask-user',
      '--no-custom-instructions', '--disable-builtin-mcps']);
    expect(adapter.invocation.argv.join(' ')).not.toMatch(/allow-all|yolo|--sandbox\b/);
    const profile = adapter.invocationProfiles!['direct-shell'];
    expect(profile.supportedVersions).toBe(VERSION);
    expect(profile.transport).toBe('shell');
    expect(Object.keys(profile.controls).sort()).toEqual(['approval', 'children', 'effort', 'fallback', 'finalOutput', 'model',
      'sandbox', 'stdin', 'stepCap', 'structuredOutput', 'trust', 'workdir']);
    for (const [name, control] of Object.entries(profile.controls)) {
      expect(control.support, name).toBe('unqualified');
      expect(control.evidence, name).toMatch(/^(H: copilot 1\.0\.95|L: copilot 1\.0\.106)/);
    }
    expect(profile.controls.model.mapping).toContain('--model');
    expect(profile.controls.model.mapping).not.toMatch(/-m\/--model|-m, --model/);
    expect(profile.controls.effort.mapping).toContain('--reasoning-effort');
    expect(profile.controls.stdin.mapping).toMatch(/^brief-text/);
    expect(profile.controls.approval.mapping).toMatch(/--allow-tool/);
    expect(profile.controls.approval.mapping).not.toMatch(/allow-all-tools is (emitted|used)/);
    expect(profile.controls.sandbox.mapping).toMatch(/unavailable/);
    expect(profile.pitfalls.some((line: string) => /no event-level health signal evidenced/.test(line))).toBe(true);
    expect(profile.health).toMatchObject({ handshake: 'process-only', outputFraming: 'jsonl',
      coverage: 'degraded', qualificationTarget: 'process-only', evidenceGrades: ['H', 'D'] });
    expect(profile.health!.provenance!.find((row: any) => row.kind === 'help')).toMatchObject({ cliVersion: '1.0.95' });
    expect(profile.health!.provenance!.find((row: any) => row.kind === 'documentation')).toMatchObject({ cliVersion: VERSION });
    expect(existsSync(profile.health!.fixtureRef)).toBe(true);
  });

  it('CP01a pins the one approved module digest and loads Copilot through the production installed loader', async () => {
    expect(APPROVED.source).toBe(MODULE);
    expect(sha256(readFileSync(MODULE))).toBe(APPROVED.entry.sha256);
    expect(APPROVED.entry).toMatchObject({ reference: 'installed:copilot', interfaceVersion: 1, adapterIds: ['copilot'], platforms: ['linux'] });
    expect(installed.ids).toEqual(['copilot']);
    expect(installed.owner.getName()).toBe('copilot');
    expect(installed.owner.constructor.name).toBe('CopilotAdapter');
    expect(installed.owner.buildWorkerArgs(
      { selected: { model: MODEL, effort: { value: 'medium' } }, cwd: '/w', briefPath: '/w/brief.md' },
      null, { allowTools: ['write'] })).toEqual(['--model', MODEL, '--reasoning-effort', 'medium', '-C', '/w', '--output-format', 'json', '--no-ask-user',
      '--no-custom-instructions', '--disable-builtin-mcps', '--allow-tool', 'write']);
    expect(COPILOT_DIRECT_STDIN).toBe('brief-text');
  });

  it('CP01b a tampered copy, an unapproved second module and a worker-writable install are all refused', async () => {
    const tampered = Buffer.concat([readFileSync(MODULE), Buffer.from('\n// tampered\n')]);
    const bad = await installPackage(tampered);
    await expect(loadInstalledWorkerAdapters({ registry: loadingRegistry(), modules: [{ ...APPROVED.entry, packageRoot: bad.packageRoot }],
      workerWritableRoots: [bad.writable], platform: 'linux' })).rejects.toThrow('Installed module digest mismatch');
    const widened = loadingRegistry();
    widened.providers.openclaw.workerAdapter = { ...structuredClone(widened.providers.openclaw.workerHealthAdapter!), runtimeDriver: 'installed:openclaw' };
    const good = await installPackage(readFileSync(MODULE));
    await expect(loadInstalledWorkerAdapters({ registry: widened, modules: [{ ...APPROVED.entry, packageRoot: good.packageRoot }],
      workerWritableRoots: [good.writable], platform: 'linux' })).rejects.toThrow('Worker module is not installed/approved: installed:openclaw');
    const insideWritable = await installPackage(readFileSync(MODULE));
    await expect(loadInstalledWorkerAdapters({ registry: loadingRegistry(), modules: [{ ...APPROVED.entry, packageRoot: insideWritable.packageRoot }],
      workerWritableRoots: [path.dirname(insideWritable.packageRoot)], platform: 'linux' })).rejects.toThrow(/worker-writable/);
    const adapter = resolveWorkerAdapter(loadingRegistry(), 'providers:copilot');
    expect(() => qualifyWorkerInvocationProfile(adapter, { profile: 'direct-shell', transport: 'shell', cliVersion: VERSION }))
      .toThrow('Worker transport/profile is unqualified');
  });
});

it('CP23 installed extraction validates a claims answer in the captured event envelope', async () => {
  const capture = readFileSync('test/fixtures/providers/copilot/copilot-stdin-only.jsonl', 'utf8');
  expect(installed.owner.parseOutput(capture)).toEqual({ text: 'copilot-smoke-ok' });
  const claims = { version: 1, status: 'completed', summary: 'Synthetic', claims: [], artifacts: [], checks: [], limitations: [] };
  const stream = capture.trim().split('\n').map(line => {
    const event = JSON.parse(line);
    if (event.type === 'assistant.message') event.data.content = JSON.stringify(claims);
    return JSON.stringify(event);
  }).join('\n');
  await expect(installed.owner.parseWorkerFinal(stream, { observation: {
    transport: 'shell', status: 'completed', termination: 'confirmed', exitCode: 0,
  } })).resolves.toEqual(claims);
});

it('CP24 the fake rejects Markdown attachments and inline prompts against the recorded transport failures', async () => {
  const workdir = await mkdtemp(path.join(os.tmpdir(), 'aiwg-copilot-transport-')); roots.push(workdir);
  const args = installed.owner.buildWorkerArgs({ briefPath: path.join(workdir, 'brief.md'), cwd: workdir,
    selected: { model: MODEL, effort: { value: 'low' } } }, null, { allowTools: ['write'] });
  const fake = path.resolve('test/fixtures/providers/copilot/fake-copilot.mjs');
  const attached = spawnSync(process.execPath, [fake, ...args, '--attachment', 'brief.md'], {
    cwd: workdir, env: {}, input: 'Reply with exactly: copilot-smoke-ok', encoding: 'utf8', timeout: 5000,
  });
  expect(attached.status).toBe(1);
  expect(attached.stderr).toContain(readFileSync('test/fixtures/providers/copilot/attachment-rejected.txt', 'utf8').trim());
  const prompted = spawnSync(process.execPath, [fake, ...args, '-p', 'Follow standard input'], {
    cwd: workdir, env: {}, input: 'Reply with exactly: copilot-smoke-ok', encoding: 'utf8', timeout: 5000,
  });
  expect(prompted.status).toBe(1);
  expect(prompted.stderr).toContain('-p ignores piped stdin');
});
