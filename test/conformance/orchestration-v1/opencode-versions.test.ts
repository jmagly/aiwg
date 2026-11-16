// Exercise OpenCode distribution ranges and version-bound argv with offline CLI fixtures.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectWorkerInvocationProfile, loadProviderModelCapabilities } from '../../../src/models/provider-policy.js';
import { workerVersionRangeMismatch } from '../../../src/models/worker-installation.mjs';
import { buildWorkerInvocationTransport } from '../../../src/serve/worker-invocation.js';
import { OpenCodeAdapter, OPENCODE_FIXED_MESSAGE, OPENCODE_SUPPORTED_VERSIONS } from '../../../tools/ralph-external/lib/opencode-adapter.mjs';

const run = promisify(execFile);
const roots: string[] = [];
const owner = new OpenCodeAdapter();
const model = 'synthetic/local-model';
const adapter = () => structuredClone(loadProviderModelCapabilities().providers.opencode.workerHealthAdapter!);

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('T-OG-15 OpenCode distribution version contracts', () => {
  it.each([
    ['1.17.0', false], ['1.18.0', true], ['1.19.0', true], ['1.19.5', true],
    ['2.0.0', false], ['2.0.25', false], ['2.0.26', true], ['2.1.0', true],
    ['3.0.0', false], ['1.19.0-rc.1', false], ['2.0.26-rc.1', false],
  ])('checks %s at the shared readiness and invocation range gate: %s', (cliVersion, supported) => {
    const metadata = adapter();
    const profile = metadata.invocationProfiles!['direct-shell'];
    expect(metadata.supportedVersions).toBe(OPENCODE_SUPPORTED_VERSIONS.join(' || '));
    expect(profile.supportedVersions).toBe(metadata.supportedVersions);
    expect(workerVersionRangeMismatch(cliVersion, [metadata.supportedVersions, profile.supportedVersions]) === null)
      .toBe(supported);
    // Synthetic qualification lets us reach the version gate; it is never persisted.
    metadata.qualification = { status: 'qualified', fixtureDigest: `sha256:${'a'.repeat(64)}`,
      verifiedAt: '2026-11-15T00:00:00Z', evidenceRef: 'fixture:synthetic-only' };
    metadata.capabilities.nestedAgentsControllable = metadata.capabilities.nativeFallbackControllable = true;
    for (const control of Object.values(profile.controls)) control.support = 'native';
    const inspect = () => inspectWorkerInvocationProfile(metadata, { profile: 'direct-shell', transport: 'shell', cliVersion });
    if (supported) expect(inspect()).toBe(profile);
    else expect(inspect).toThrow('Worker CLI version is outside qualified profile');
    profile.supportedVersions = '2.0.26';
    if (cliVersion === '1.19.0') expect(inspect).toThrow('Worker CLI version is outside qualified profile');
  });

  it.each(['1.18.0', '1.19.0', '1.19.5', '2.0.26'])('renders and executes %s with explicit effort and no effort', async cliVersion => {
    const root = await mkdtemp(path.join(tmpdir(), 'aiwg-opencode-versions-'));
    roots.push(root);
    const briefPath = path.join(root, 'brief.md');
    const recordPath = path.join(root, 'record.json');
    const configPath = path.join(root, 'config.json');
    const brief = 'Synthetic brief marker that must stay out of argv.';
    await writeFile(briefPath, brief);
    await writeFile(configPath, JSON.stringify({ cliVersion, recordPath }));
    const metadata = adapter();
    for (const effort of ['high', null]) {
      const input = { cliVersion: '3.0.0', selected: { model, effort: { value: effort }, profileRef: 'direct-shell' },
        cwd: root, briefPath, permissions: { sandbox: 'external' } } as any;
      const transport = await buildWorkerInvocationTransport({
        qualification: { adapter: metadata, cliVersion } as any,
        buildInvocation: async invocation => ({
          argv: [process.execPath, path.resolve('test/fixtures/providers/opencode/fake-opencode.mjs'),
            ...owner.buildWorkerArgs(invocation, null, invocation.permissions)], stdin: 'closed', envNames: [],
        }),
      }, input);
      const modelArgs = cliVersion.startsWith('1.')
        ? ['-m', model, ...(effort === null ? [] : ['--variant', effort])]
        : ['-m', effort === null ? model : `${model}#${effort}`];
      expect(transport.argv!.slice(2)).toEqual(['run', '--format', 'json', ...modelArgs,
        '-f', briefPath, OPENCODE_FIXED_MESSAGE]);
      expect(transport.argv!.join(' ')).not.toContain(brief);
      const result = await run(transport.argv![0], transport.argv!.slice(1), { cwd: root, timeout: 5000,
        env: { PATH: process.env.PATH, AIWG_FAKE_WORKER_CONFIG: configPath } });
      const record = JSON.parse(await readFile(recordPath, 'utf8'));
      expect(record).toMatchObject({ model: modelArgs[1], variant: cliVersion.startsWith('1.') ? effort : null,
        brief, cwd: root, format: 'json', message: OPENCODE_FIXED_MESSAGE });
      expect(owner.parseOutput(result.stdout)).toEqual({ text: `synthetic reply (${brief.length} chars)` });
    }
  });

  it.each([undefined, '1.17.0', '2.0.25', '3.0.0', 'not-a-version'])('refuses missing or unsupported renderer version %s', cliVersion => {
    expect(() => owner.buildWorkerArgs({ cliVersion, selected: { model, effort: { value: 'high' } },
      cwd: '/synthetic', briefPath: '/synthetic/brief.md' }, null, {}))
      .toThrow('OpenCode worker requires a supported installed CLI version');
  });

  it('retains unqualified controls and records the supplied 1.19.0 help evidence', () => {
    const metadata = adapter();
    expect(metadata.qualification.status).toBe('unqualified');
    const profile = metadata.invocationProfiles!['direct-shell'];
    expect(Object.values(profile.controls).every(control => control.support === 'unqualified')).toBe(true);
    for (const name of ['model', 'effort', 'sandbox', 'approval', 'finalOutput']) {
      expect(profile.controls[name].evidence).toContain('opencode 1.19.0 `opencode run --help` (titan, 2026-11-15)');
    }
    expect(profile.controls.effort.mapping).toContain('--variant <effort>');
    expect(profile.controls.model.evidence).toContain('provider/model');
    expect(profile.controls.effort.evidence).toContain('--variant  model variant');
    expect(profile.controls.finalOutput.evidence).toContain('--format  default|json');
    expect(profile.controls.approval.evidence).toContain('--auto  auto-approve permissions that are not explicitly denied');
  });
});
