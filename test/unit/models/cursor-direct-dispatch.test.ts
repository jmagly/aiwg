// Checks operator approval and bounded native Cursor rendering without live calls.
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CursorAdapter } from '../../../tools/ralph-external/lib/cursor-adapter.mjs';
import { CodexAdapter } from '../../../tools/ralph-external/lib/codex-adapter.mjs';
import {
  assertOperatorWorkerNativeArgv, assertWorkerLaunchMode, hasOperatorWorkerNativeRenderer,
  inspectWorkerInvocationProfile, loadProviderModelCapabilities, qualifyWorkerInvocationProfile,
  requiresWorkerExternalBoundary, WORKER_OPERATOR_APPROVAL,
} from '../../../src/models/provider-policy.js';
import { resolveWorkerInvocation } from '../../../src/serve/worker-invocation.js';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';

const versions = { codex: '0.161.0', muse: '1.4.12', factory: '1.0.0', cursor: '2026.11.13-eacade1' };
type Provider = keyof typeof versions;
const selected = { model: 'gpt-5.3-codex-high', effort: { value: 'high' } };
function adapter(provider: Provider = 'cursor') {
  const value = structuredClone(loadProviderModelCapabilities().providers[provider].workerHealthAdapter!);
  value.qualification = { status: 'qualified', evidenceRef: WORKER_OPERATOR_APPROVAL,
    fixtureDigest: `sha256:${'a'.repeat(64)}`, verifiedAt: '2026-11-17T00:00:00Z' };
  return value;
}
function selection(provider: Provider = 'cursor') {
  return { profile: 'direct-shell', transport: 'shell' as const, cliVersion: versions[provider] };
}
function argv(sandbox = 'workspace-write') {
  return ['cursor-agent', ...new CursorAdapter().buildWorkerArgs({ selected, cwd: '/tmp/worker tree', brief: 'Synthetic' },
    adapter().invocationProfiles!['direct-shell'], { sandbox, approval: 'never' })];
}

describe('operator-qualified Cursor native renderer', () => {
  it.each(Object.keys(versions) as Provider[])('uses the same approval and process conditions for %s', provider => {
    const value = adapter(provider);
    expect(hasOperatorWorkerNativeRenderer(value)).toBe(true);
    expect(inspectWorkerInvocationProfile(value, selection(provider))).toBe(value.invocationProfiles!['direct-shell']);
    // Default resolution adds no controls; explicitly requested controls remain strict.
    expect(() => inspectWorkerInvocationProfile(value, { ...selection(provider), requiredControls: [] })).not.toThrow();
    expect(() => inspectWorkerInvocationProfile(value, { ...selection(provider), requiredControls: ['fallback'] })).toThrow('unqualified');
    value.invocation.kind = 'mcp';
    expect(hasOperatorWorkerNativeRenderer(value)).toBe(false);
    value.invocation.kind = 'process';
    value.qualification.evidenceRef = 'fixture:synthetic-only';
    expect(hasOperatorWorkerNativeRenderer(value)).toBe(false);
    expect(() => inspectWorkerInvocationProfile(value, selection(provider))).toThrow(/unqualified|qualified external enforcing boundary/);
    value.qualification = { status: 'unqualified' };
    expect(() => inspectWorkerInvocationProfile(value, selection(provider))).toThrow('unqualified');
  });

  it('does not grant unknown providers the native exception', () => {
    const value = adapter();
    value.provider = 'unknown';
    expect(hasOperatorWorkerNativeRenderer(value)).toBe(false);
    // An unknown provider uses ordinary semver, so reach the control check with an in-range release.
    expect(() => inspectWorkerInvocationProfile(value, { ...selection(), cliVersion: '2026.11.13' })).toThrow('unqualified: model');
  });

  it('preserves version, transport and explicit control requirements', () => {
    const value = adapter();
    expect(() => inspectWorkerInvocationProfile(value, { ...selection(), cliVersion: '2026.11.11-b912975' })).toThrow('outside qualified profile');
    expect(() => inspectWorkerInvocationProfile(value, { ...selection(), transport: 'mcp' })).toThrow('unqualified');
    for (const control of ['model', 'effort', 'sandbox', 'stepCap', 'children', 'unknown']) {
      expect(() => inspectWorkerInvocationProfile(value, { ...selection(), requiredControls: [control] })).toThrow(`unqualified: ${control}`);
    }
  });

  it.each(['2026.11.13-eacade1', '2026.11.17-f532c45', '2026.11.19-f005e9d'])(
    '#4306 admits tested and newer builds at dispatch: %s', cliVersion => {
      expect(() => inspectWorkerInvocationProfile(adapter(), { ...selection(), cliVersion })).not.toThrow();
    });

  it.each(['codex', 'cursor'] as const)('preserves the explicit child-agent policy for %s', provider => {
    const value = adapter(provider);
    expect(() => qualifyWorkerInvocationProfile(value, selection(provider))).toThrow('unqualified: children');
    expect(() => qualifyWorkerInvocationProfile(value, { ...selection(provider),
      policy: { guards: { denySelfDelegation: false } } })).not.toThrow();
  });

  it.each(Object.keys(versions) as Provider[])('keeps the native-sandbox launch limits for %s', provider => {
    const value = adapter(provider);
    for (const sandbox of ['read-only', 'workspace-write'] as const) {
      const permissions = { launchMode: 'native-sandbox' as const, sandbox, transport: 'shell' as const };
      expect(() => assertWorkerLaunchMode(value, permissions)).not.toThrow();
      expect(requiresWorkerExternalBoundary(value, { ...selection(provider), permissions })).toBe(false);
    }
    for (const permissions of [{ sandbox: 'external' as const }, { sandbox: 'workspace-write' as const, transport: 'mcp' as const }, {}]) {
      expect(() => assertWorkerLaunchMode(value, { ...permissions, launchMode: 'native-sandbox' })).toThrow('native-sandbox requires');
    }
    value.qualification = { status: 'unqualified' };
    expect(() => assertWorkerLaunchMode(value, { launchMode: 'native-sandbox', sandbox: 'workspace-write' })).toThrow('native-sandbox requires');
  });
});

describe('bounded Cursor native argv', () => {
  it.each(['read-only', 'workspace-write'])('accepts the adapter renderer for %s and rejects overrides', sandbox => {
    const value = adapter();
    const rendered = argv(sandbox);
    const permissions = { sandbox, approval: 'never' };
    expect(() => assertOperatorWorkerNativeArgv(value, rendered, selected, permissions)).not.toThrow();
    for (const extra of [['--force'], ['--yolo'], ['--auto-review'], ['--approve-mcps'], ['--sandbox', 'disabled'],
      ['--model', 'other'], ['--workspace', '/other'], ['--mode', 'plan'], ['prompt'], ['--effort', 'low']]) {
      expect(() => assertOperatorWorkerNativeArgv(value, [...rendered, ...extra], selected, permissions)).toThrow();
    }
    for (const flag of ['-p', '--trust', '--output-format', '--sandbox', '--workspace', '--model']) {
      const broken = [...rendered];
      broken.splice(broken.indexOf(flag), ['-p', '--trust'].includes(flag) ? 1 : 2);
      expect(() => assertOperatorWorkerNativeArgv(value, broken, selected, permissions)).toThrow();
    }
    expect(() => assertOperatorWorkerNativeArgv(value, rendered, selected,
      { sandbox: sandbox === 'read-only' ? 'workspace-write' : 'read-only' })).toThrow();
  });

  it('rejects unsupported permission and model/effort requests', () => {
    for (const permissions of [{ sandbox: 'external' }, { sandbox: 'unknown' }, { approval: 'on-request' }]) {
      expect(() => assertOperatorWorkerNativeArgv(adapter(), argv(), selected, permissions)).toThrow();
    }
    for (const model of ['auto', 'DEFAULT', 'opus', 'gpt-5.3-codex-high[effort=low]']) {
      const rendered = argv().map(token => token === selected.model ? model : token);
      expect(() => assertOperatorWorkerNativeArgv(adapter(), rendered, { ...selected, model })).toThrow('exact model ID');
    }
    for (const effort of [null, '', 'high[effort=low]']) {
      expect(() => assertOperatorWorkerNativeArgv(adapter(), argv(), { ...selected, effort: { value: effort } })).toThrow('explicit effort');
    }
  });
});

describe('default direct-shell resolution parity', () => {
  it.each(['codex', 'cursor'] as const)('renders a launchable %s command without upgrading declared controls', async provider => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-native-resolve-'));
    try {
      const f = workerResolutionFixture();
      const value = adapter(provider);
      value.qualification.verifiedAt = f.observation.verifiedAt;
      delete f.snapshot.registry.providers.codex.workerAdapter;
      f.snapshot.registry.providers[provider].workerAdapter = value;
      const group = f.snapshot.config.parallelism!.groups!.workers;
      group.execution = { sandbox: 'workspace-write' };
      group.members = [{ ...group.members[0], cli: provider, model: selected.model }];
      group.fallback = [];
      f.snapshot.models.defaults.workerSelection!.guards!.denySelfDelegation = false;
      f.snapshot.models.defaults.workerSelection!.roleGuidance!.coding.initialEffort = 'high';
      const discovery = f.snapshot.catalog.discovery!.instances!.codex;
      discovery.provider = provider; discovery.runtimeVersion = versions[provider];
      discovery.models = discovery.models.slice(0, 1);
      Object.assign(discovery.models[0], { id: selected.model, apiModelId: selected.model });
      Object.assign(discovery.models[0].worker!, { cliId: provider, runtimeVersion: versions[provider] });
      f.snapshot.catalog.discovery!.instances = { [provider]: discovery };
      f.snapshot.installations = { [provider]: { ...f.snapshot.installations.codex, profile: 'direct-shell', cliVersion: versions[provider] } };
      const owner = provider === 'cursor' ? new CursorAdapter() : new CodexAdapter();
      const brief = path.join(root, 'brief.txt');
      await writeFile(brief, 'Synthetic brief');
      const drivers: any = { [provider]: {
        qualification: { adapter: value, adapterId: value.id, cliVersion: versions[provider] },
        buildInvocation: async (input: any) => ({ argv: [`/synthetic/${owner.getBinary()}`,
          ...owner.buildWorkerArgs(input, value.invocationProfiles!['direct-shell'], input.permissions)], stdin: 'brief-text', envNames: [] }),
      } };
      const request = { role: 'coding', group: 'workers', task: 'implementation', brief, workdir: root,
        final_output: path.join(root, 'result.json'), transport: 'shell' as const, format: 'shell' as const };
      const plan = await resolveWorkerInvocation(f.snapshot, request, drivers, f.request.now);
      expect(plan.invocation, JSON.stringify({ diagnostics: plan.diagnostics, exclusions: plan.exclusions })).toMatchObject({
        readiness: 'launchable', isolation: 'systemd-unit', selected: { cli: provider, model: selected.model, effort: { value: 'high' } },
        controlEvidence: [WORKER_OPERATOR_APPROVAL],
      });
      expect(plan.invocation!.shellCommand).toContain(`/synthetic/${owner.getBinary()}`);
      expect(plan.invocation!.argv).toContain(selected.model);
      expect(Object.values(value.invocationProfiles!['direct-shell'].controls).every(control => control.support === 'unqualified')).toBe(true);
      f.snapshot.config.parallelism!.health = { requireStepCap: true };
      const strict = await resolveWorkerInvocation(f.snapshot, request, drivers, f.request.now);
      expect(strict.invocation).toBeUndefined();
      expect(strict.exclusions.some(row => row.diagnostics.some(diagnostic => diagnostic.message.includes('unqualified: stepCap')))).toBe(true);
      if (provider === 'cursor') {
        f.snapshot.config.parallelism!.health = {};
        group.execution.launchMode = 'native-sandbox';
        const native = await resolveWorkerInvocation(f.snapshot, request, drivers, f.request.now);
        expect(native.invocation).toBeUndefined();
        expect(native.diagnostics.some(diagnostic => diagnostic.message.includes('native-sandbox requires a codex adapter'))).toBe(true);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
