import { directWorkerEnvironment } from '../../../src/config/worker-attribution.mjs';
import baseline from '../../fixtures/providers/worker-delivery-baseline.json';
import { workerStdinBytes, workerStdinDocument } from '../../../src/serve/worker-stdin-frame.mjs';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderAdapter } from '../../../tools/ralph-external/lib/provider-adapter.mjs';
import { workerModelKey, loadProviderModelCapabilities, WorkerPolicyError } from '../../../src/models/provider-policy.js';
import { workerInvocationDiagnostic, WorkerInvocationCheckError } from '../../../src/serve/worker-invocation.js';
import { workerInputSchema } from '../../fixtures/ralph-worker-protocol.mjs';
import { fixtureJson } from '../../conformance/mission-v1/worker-contract-fixtures.js';

const exec = promisify(execFile);
const roots: string[] = [];
const vectors = fixtureJson('mission-vectors.json');
const digest = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
class FixtureAdapter extends ProviderAdapter {
  getName() { return 'fixture'; }
  buildSessionArgs = vi.fn(() => { throw new Error('Legacy bypass defaults must not be used'); });
}
const adapter = new FixtureAdapter();
function setup(transport: 'shell' | 'mcp' = 'shell') {
  const invocation = structuredClone(vectors.find((v: any) => v.id === `resolved-${transport}`).value);
  const metadata = structuredClone(fixtureJson('shared-vectors.json').find((v: any) => v.id === 'adapter-process-shape').value);
  metadata.qualification = { status: 'qualified', fixtureDigest: invocation.selected.qualificationDigest,
    verifiedAt: '2026-10-07T00:00:00Z', evidenceRef: 'fixture:synthetic-only' };
  const profile = metadata.invocationProfiles['fixture-shell'];
  profile.transport = transport;
  for (const [name, control] of Object.entries(profile.controls) as any) {
    if (!['effort', 'stepCap'].includes(name)) control.support = 'native';
  }
  metadata.invocationProfiles = { [invocation.selected.profileRef]: profile };
  const qualification: any = { adapter: metadata, cliVersion: '1.0.0', now: Date.parse('2026-10-07T00:00:00Z'),
    platform: 'linux', permissions: { sandbox: 'workspace-write', approval: 'never' }, requiredControls: ['workdir'], role: 'efficiency',
    policy: { roleGuidance: { efficiency: { groups: ['synthesis'], tier: 'economy',
      initialEffort: null, effortLadder: [], allowNotApplicableEffort: true } } },
    modelObservation: { observedAt: '2026-10-07T00:00:00Z', lifecycle: 'active',
      effortSupport: 'not-applicable', dataUse: { processing: 'local', productImprovement: false, retentionDays: null } } };
  if (transport === 'mcp') {
    qualification.mcpSchemas = { input: structuredClone(workerInputSchema), output: { type: 'object' } };
    invocation.mcp.inputSchemaDigest = digest(qualification.mcpSchemas.input);
    invocation.mcp.outputSchemaDigest = digest(qualification.mcpSchemas.output);
    invocation.mcp.arguments = { invocationId: 'synthetic-1', workspace: invocation.cwd,
      selection: { provider: invocation.selected.inferenceProvider, model: invocation.selected.model, effort: null }, brief: 'Synthetic brief' };
    profile.mcp = { serverRef: invocation.mcp.serverRef, tool: invocation.mcp.tool,
      inputSchemaDigest: invocation.mcp.inputSchemaDigest, outputSchemaDigest: invocation.mcp.outputSchemaDigest,
      sessionIsolation: invocation.mcp.sessionIsolation, cancel: 'uncertain' };
    qualification.mcp = structuredClone(profile.mcp);
  }
  return { invocation, qualification, profile };
}
// Unit guards must exercise current source even when an older dist is present.
beforeEach(() => { vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src'); });
afterEach(async () => {
  vi.unstubAllEnvs();
  expect(adapter.buildSessionArgs).not.toHaveBeenCalled();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
    await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  }
});

describe('S1 pure installed-path invocation preparation (T-OG-03/14/15/17)', () => {
  it.each(['invocation_build_failed', 'invocation_prepare_failed', 'installation_recheck_unavailable', 'qualified_workspace_mismatch'] as const)(
    'publishes only the fixed %s check summary (#3516)', reason => {
      const error = new WorkerInvocationCheckError('OG_ADAPTER_UNQUALIFIED', reason);
      const sensitive = 'Bearer synthetic-token ENV_VALUE=synthetic-secret /home/private-user/driver';
      error.message = sensitive;
      error.cause = new Error(sensitive);
      const diagnostic = workerInvocationDiagnostic(error, '/parallelism/clis/codex/invocationProfile');
      expect(diagnostic).toMatchObject({ code: 'OG_ADAPTER_UNQUALIFIED', reason,
        pointer: reason === 'qualified_workspace_mismatch' ? '/request/workdir'
          : reason === 'invocation_build_failed' ? '/invocation/buildInvocation' : '/invocation/prepareWorkerInvocation' });
      expect(JSON.stringify(diagnostic)).not.toMatch(/synthetic-token|synthetic-secret|private-user/);
      expect(JSON.stringify(workerInvocationDiagnostic(new WorkerPolicyError('OG_ADAPTER_UNQUALIFIED', sensitive), '/invocation')))
        .not.toMatch(/synthetic-token|synthetic-secret|private-user/);
    });

  describe.each(['shell', 'mcp'] as const)('T-OG-15 %s policy guards', transport => {
    it.each<Array<[string, (f: any) => void, RegExp]>[number]>([
      ['ultra', f => { f.invocation.selected.effort = { support: 'explicit', value: 'ultra' }; }, /denied effort/i],
      ['policy effort', f => {
        f.qualification.policy = { guards: { deniedEfforts: ['high'] } };
        f.invocation.selected.effort = { support: 'explicit', value: 'high' };
      }, /denied effort/i],
      ['contributor', f => { f.invocation.selected.model = 'muse-spark-1.3-contributor'; }, /denied model/i],
      ['canonical model', f => {
        // Encode reserved model characters; the inference provider is not the CLI.
        f.invocation.selected.model = 'fixture/a%b:c';
        f.qualification.policy = { guards: { deniedModels: [workerModelKey(
          f.invocation.selected.inferenceProvider, f.invocation.selected.model,
        )] } };
      }, /denied model/i],
      ['partial guards retain default effort deny', f => {
        f.qualification.policy = { guards: { deniedModels: [] } };
        f.invocation.selected.effort = { support: 'explicit', value: 'ultra' };
      }, /denied effort/i],
      ['missing observations', f => {
        delete f.qualification.modelObservation;
        delete f.qualification.defaultObservation;
      }, /requires.*observation evidence/i],
      ['missing observations under permissive data policy', f => {
        delete f.qualification.modelObservation;
        delete f.qualification.defaultObservation;
        f.qualification.policy = { dataPolicy: { allowUnknown: true, allowProductImprovement: true } };
      }, /requires.*observation evidence/i],
      ['null effort with explicit support', f => {
        f.qualification.modelObservation.effortSupport = 'explicit';
      }, /denied effort.*null/i],
      ['null effort with unknown support', f => {
        delete f.qualification.modelObservation.effortSupport;
      }, /denied effort.*null/i],
      ['null effort forbidden by role', f => {
        f.qualification.policy.roleGuidance.efficiency.allowNotApplicableEffort = false;
      }, /denied effort.*null/i],
      ['null effort without role guidance', f => { f.qualification.policy = {}; }, /denied effort.*null/i],
      ['null effort without selected role', f => { delete f.qualification.role; }, /denied effort.*null/i],
      ['data use', f => { f.qualification.modelObservation.dataUse = { productImprovement: true }; }, /data.use/i],
      ['unknown processing', f => { f.qualification.modelObservation.dataUse.processing = 'unknown'; }, /data.use/i],
      ['unknown improvement', f => { f.qualification.modelObservation.dataUse.productImprovement = null; }, /data.use/i],
      ['processing restriction', f => {
        f.qualification.policy = { dataPolicy: { allowedProcessing: [] } };
      }, /data.use/i],
      ['retention restriction', f => {
        f.qualification.policy = { dataPolicy: { maxRetentionDays: 0 } };
        f.qualification.modelObservation.dataUse.retentionDays = 1;
      }, /data.use/i],
      ['data class restriction', f => {
        f.qualification.policy = { dataClasses: { private: { allowedProcessing: [] } } };
        f.qualification.dataClass = 'private';
      }, /data.use/i],
      ['stale model', f => { f.qualification.modelObservation.observedAt = '2026-09-01T00:00:00Z'; }, /stale/i],
      ['policy observation age', f => {
        f.qualification.policy = { freshness: { blockHours: 1 } };
        f.qualification.modelObservation.observedAt = '2026-10-06T22:00:00Z';
      }, /stale/i],
      ['policy verification age', f => {
        f.qualification.policy = { freshness: { policyDays: 1 } };
        f.qualification.modelObservation.verifiedAt = '2026-10-05T00:00:00Z';
      }, /stale/i],
      ['future evidence', f => { f.qualification.modelObservation.observedAt = '2026-10-07T00:01:00Z'; }, /stale/i],
      ['retired model', f => { f.qualification.modelObservation.lifecycle = 'retired'; }, /retired/i],
      ['stale default', f => { f.qualification.defaultObservation = { observedAt: '2026-09-01T00:00:00Z', lifecycle: 'active' }; }, /stale/i],
      ['retired default', f => { f.qualification.defaultObservation = { observedAt: '2026-10-07T00:00:00Z', lifecycle: 'retired' }; }, /retired/i],
      ['conflicting lifecycle evidence', f => {
        f.qualification.modelObservation.conflicts = [{ field: '/lifecycle', values: [] }];
      }, /conflicting selection-relevant evidence/i],
    ])('refuses %s before rendering', async (_id, mutate, error) => {
      const f = setup(transport);
      f.profile.controls.effort = { support: 'native', mapping: '--effort', evidence: 'fixture:synthetic-only' };
      f.qualification.modelObservation = { observedAt: '2026-10-07T00:00:00Z', lifecycle: 'active', effortSupport: 'not-applicable', dataUse: { processing: 'local', productImprovement: false, retentionDays: null } };
      if (!_id.startsWith('null effort') && !_id.startsWith('missing observations')) {
        f.invocation.selected.effort = { support: 'explicit', value: 'high' };
      }
      mutate(f);
      await expect(adapter.prepareWorkerInvocation(f.invocation, f.qualification)).rejects.toThrow(error);
    });
  });

  it.each(['shell', 'mcp'] as const)('renders qualified null effort with %s observation evidence', async transport => {
    for (const useDefault of [false, true]) {
      const f = setup(transport);
      if (useDefault) {
        f.qualification.defaultObservation = f.qualification.modelObservation;
        delete f.qualification.modelObservation;
      }
      const result = await adapter.prepareWorkerInvocation(f.invocation, f.qualification);
      expect(result.selected.effort).toEqual({ support: 'not-applicable', value: null });
      if (transport === 'shell') expect(result.shellCommand).toContain('env -i');
      else expect(result.mcp).toEqual(f.invocation.mcp);
    }
  });

  it.each([
    ['defaults', () => {}],
    ['different inference provider', (f: any) => {
      f.qualification.policy = { guards: { deniedModels: [workerModelKey('different-provider', f.invocation.selected.model)] } };
    }],
    ['explicit effort default replacement', (f: any) => {
      f.qualification.policy = { guards: { deniedEfforts: [] } };
      f.invocation.selected.effort.value = 'ultra';
    }],
    ['explicit freshness default replacement', (f: any) => {
      f.qualification.policy = { freshness: { blockHours: 1000 } };
      f.qualification.modelObservation.observedAt = '2026-09-01T00:00:00Z';
    }],
    ['unknown data allowed with retention ceiling', (f: any) => {
      f.qualification.policy = { dataPolicy: { allowUnknown: true, maxRetentionDays: 0 } };
      f.qualification.modelObservation.dataUse = { processing: 'unknown', productImprovement: null, retentionDays: null };
    }],
    ['product improvement allowed', (f: any) => {
      f.qualification.policy = { dataPolicy: { allowProductImprovement: true } };
      f.qualification.modelObservation.dataUse.productImprovement = true;
    }],
    ['release-date-only conflict stays advisory', (f: any) => {
      f.qualification.modelObservation.conflicts = [{ field: '/releaseDate', values: [] }];
    }],
  ] as const)('T-OG-15 renders a permitted selection: %s', async (_id, mutate) => {
    const f = setup();
    f.profile.controls.effort = { support: 'native', mapping: '--effort', evidence: 'fixture:synthetic-only' };
    f.invocation.selected.effort = { support: 'explicit', value: 'high' };
    f.qualification.modelObservation = { observedAt: '2026-10-07T00:00:00Z', lifecycle: 'active', effortSupport: 'not-applicable', dataUse: { processing: 'local', productImprovement: false, retentionDays: null } };
    f.qualification.defaultObservation = structuredClone(f.qualification.modelObservation);
    mutate(f);
    const result = await adapter.prepareWorkerInvocation(f.invocation, f.qualification);
    expect(result.shellCommand).toContain('env -i');
    expect(result.selected).toEqual(f.invocation.selected);
  });

  it.each(['shell', 'mcp'] as const)('%s reuses the typed contract without managed services or mutation', async transport => {
    const { invocation, qualification } = setup(transport);
    const before = structuredClone(invocation);
    const result = await adapter.prepareWorkerInvocation(invocation, qualification);
    expect(invocation).toEqual(before);
    expect(result).not.toBe(invocation);
    expect(result.selected).toEqual(invocation.selected);
    expect(result.mode).toBe('direct');
    if (transport === 'mcp') expect(result).toEqual(invocation);
    else expect(result.shellCommand).toContain('env -i PATH="${PATH-}"');
    result.selected.model = 'different';
    expect(invocation.selected.model).toBe(before.selected.model);
  });

  it('T-OG-15 executes quoted data and EOF with only declared env in a fresh project', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-direct-render-'));
    roots.push(root);
    const { invocation, qualification, profile } = setup();
    const brief = path.join(root, 'brief 雪.md');
    const recordPath = path.join(root, 'record.json');
    const configPath = path.join(root, 'fixture.json');
    const final = path.join(root, 'final output.json');
    const payload = `quotes ' " spaces 雪\n--leading-dash $(touch '${path.join(root, 'injected')}')`;
    await writeFile(brief, payload);
    await writeFile(configPath, JSON.stringify({ recordPath, scenarioId: 'T-OG-15-exact-data', scenario: 'success', recordWorkerAttribution: true }));
    await writeFile(path.join(root, 'models.json'), JSON.stringify(fixtureJson('shared-vectors.json').find((v: any) => v.id === 'direct-model-no-effort').value));
    await writeFile(path.join(root, 'aiwg.config'), JSON.stringify(fixtureJson('shared-vectors.json').find((v: any) => v.id === 'direct-config-no-managed-state').value));
    Object.assign(invocation, { cwd: root, briefPath: brief, stdoutPath: path.join(root, 'events.jsonl'), stderrPath: path.join(root, 'stderr.log'), finalPath: final,
      argv: [process.execPath, path.resolve('test/fixtures/ralph-worker-cli.mjs'), '--model', invocation.selected.model, '--final-output', final, '--', payload],
      shellCommand: `touch '${path.join(root, 'injected')}'`, envNames: ['AIWG_FAKE_WORKER_CONFIG'] });
    profile.envAllowlist = ['AIWG_FAKE_WORKER_CONFIG'];
    const rendered = await adapter.prepareWorkerInvocation(invocation, qualification);
    await exec('/bin/sh', ['-c', rendered.shellCommand], { cwd: root, timeout: 5_000,
      env: { AIWG_FAKE_WORKER_CONFIG: configPath, UNRELATED_SECRET: 'synthetic-secret-not-forwarded' } });
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    expect(record).toMatchObject({ scenarioId: 'T-OG-15-exact-data', argv: invocation.argv.slice(2), cwd: root, stdin: payload,
      outputPaths: { final, '--final-output': final } });
    // POSIX sh may add PWD; the unrelated credential is never inherited.
    expect(record.envNames).toContain('AIWG_FAKE_WORKER_CONFIG');
    expect(record.workerAttribution).toEqual(directWorkerEnvironment(invocation));
    expect(record.workerAttribution.AIWG_WORKER_WORKSPACE).toBe(root);
    expect(record.workerAttribution.AIWG_WORKER_GROUP).toBe(invocation.selected.group);
    expect(record.envNames).not.toContain('UNRELATED_SECRET');
    await expect(lstat(path.join(root, 'injected'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(root)).not.toContain('.aiwg');
    expect(JSON.parse((await readFile(final, 'utf8')).trim()).type).toBe('result');
  });

  it.each([
    ['unqualified', (f: any) => { f.qualification.adapter.qualification.status = 'unqualified'; }, /unqualified/],
    ['unsupported-version', (f: any) => { f.qualification.cliVersion = '2.0.0'; }, /version/],
    ['required-control', (f: any) => { f.qualification.requiredControls.push('stepCap'); }, /control/],
    ['missing-policy-source', (f: any) => { delete f.qualification.permissions; }, /control/],
    ['unknown-profile', (f: any) => { f.invocation.selected.profileRef = 'missing'; }, /unqualified/],
    ['explicit-effort', (f: any) => { f.invocation.selected.effort = { support: 'explicit', value: 'high' }; }, /control/],
    ['expired', (f: any) => { f.qualification.now = Date.parse(f.invocation.expiresAt); }, /expired/],
    ['no-clock', (f: any) => { delete f.qualification.now; }, /clock/],
    ['unsupported-platform', (f: any) => { f.qualification.platform = 'win32'; }, /platform/],
    ['relative-binary', (f: any) => { f.invocation.argv[0] = 'worker'; }, /absolute binary/],
    ['nul-argv', (f: any) => { f.invocation.argv.push('bad\0data'); }, /NUL/],
    ['relative-cwd', (f: any) => { f.invocation.cwd = '-workdir'; }, /absolute cwd/],
    ['nul-path', (f: any) => { f.invocation.briefPath += '\0'; }, /absolute briefPath/],
    ['overlapping-output', (f: any) => { f.invocation.stdoutPath = f.invocation.briefPath; }, /distinct/],
    ['undeclared-env', (f: any) => { f.invocation.envNames.push('UNRELATED_SECRET'); }, /allowlist/],
    ['environment-syntax', (f: any) => { f.invocation.envNames.push('PATH; touch injected'); }, /Invalid/],
    ['wrong-adapter', (f: any) => { f.qualification.adapter.id = 'wrong'; }, /identity/],
    ['changed-qualification', (f: any) => { f.invocation.selected.qualificationDigest = `sha256:${'0'.repeat(64)}`; }, /digest changed/],
    ['stale-installation', (f: any) => { f.qualification.adapter.qualification.verifiedAt = '2026-01-01T00:00:00Z'; }, /stale/],
    ['unknown-transport', (f: any) => { f.invocation.transport = 'msp'; }, /Invalid/],
  ] as const)('T-OG-03/14 rejects %s before returning a command', async (_id, mutate, error) => {
    const f = setup(); mutate(f);
    await expect(adapter.prepareWorkerInvocation(f.invocation, f.qualification)).rejects.toThrow(error);
  });

  it.each(['claude', 'muse', 'hermes'])('#2956 preparation cannot waive %s sandbox with caller controls', async provider => {
    const f = setup();
    f.qualification.adapter.id = provider;
    f.qualification.boundary = { kind: 'native' };
    f.qualification.requiredControls = ['model'];
    const { prepareWorkerInvocation } = await import('../../../src/serve/worker-invocation.js');
    await expect(prepareWorkerInvocation(f.invocation, { ...f.qualification, adapterId: provider })).rejects.toThrow(/sandbox.*external/);
    delete f.qualification.policy;
    f.invocation.selected.effort = { support: 'explicit', value: 'medium' };
    await expect(prepareWorkerInvocation(f.invocation, { ...f.qualification, adapterId: provider })).rejects.toThrow(/sandbox.*external/);
  });

  it.each(['shell', 'mcp'] as const)('#2956 %s refuses a synthetic external boundary without installation evidence', async transport => {
    const f = setup(transport);
    f.qualification.adapter.provider = 'claude';
    f.qualification.boundary = { kind: 'os', identity: 'caller-asserted', digest: `sha256:${'1'.repeat(64)}`, controls: ['sandbox'] };
    const { prepareWorkerInvocation } = await import('../../../src/serve/worker-invocation.js');
    for (const prepare of [() => prepareWorkerInvocation(f.invocation, { ...f.qualification, adapterId: 'fixture' }),
      () => adapter.prepareWorkerInvocation(f.invocation, f.qualification)]) {
      await expect(prepare()).rejects.toThrow(/installation qualification/i);
    }
    f.profile.installationQualification = { scopeDigest: f.invocation.selected.qualificationDigest,
      fixtureDigest: f.invocation.selected.qualificationDigest, verifiedAt: '2026-10-07T00:00:00Z', evidenceRef: 'fixture:synthetic-only' };
    await expect(prepareWorkerInvocation(f.invocation, { ...f.qualification, adapterId: 'fixture' }))
      .rejects.toThrow(/installation.*(evidence|qualification|recheck)/i);
  });

  it.each([
    ['schema-change', (f: any) => { f.qualification.mcpSchemas.input.required.push('changed'); }, /schema digest/],
    ['output-schema-change', (f: any) => { f.qualification.mcpSchemas.output.type = 'string'; }, /schema digest/],
    ['tool-change', (f: any) => { f.invocation.mcp.tool = 'conversation-send'; }, /binding changed/],
    ['session-change', (f: any) => { f.invocation.mcp.sessionIsolation = 'serialized'; }, /binding changed/],
    ['current-binding-change', (f: any) => { f.qualification.mcp.serverRef = 'different'; }, /qualification changed/],
    ['invalid-input', (f: any) => { f.invocation.mcp.arguments.command = 'echo injected'; }, /input schema/],
    ['oversized-input', (f: any) => { f.invocation.mcp.arguments.brief = '雪'.repeat(100_000); }, /UTF-8/],
    ['deadline', (f: any) => { f.invocation.mcp.timeoutSeconds = 61; }, /deadline/],
  ] as const)('T-OG-17 rejects %s without calling or retrying MCP', async (_id, mutate, error) => {
    const f = setup('mcp'); mutate(f);
    await expect(adapter.prepareWorkerInvocation(f.invocation, f.qualification)).rejects.toThrow(error);
  });

  it('renders closed stdin and preparatory data without asserting launch readiness', async () => {
    const f = setup();
    f.invocation.stdin = 'closed';
    f.invocation.readiness = 'preparatory'; f.invocation.briefDigest = null;
    const result = await adapter.prepareWorkerInvocation(f.invocation, f.qualification);
    expect(result.shellCommand).toContain('< /dev/null');
    expect(result.readiness).toBe('preparatory');
    expect(result.briefDigest).toBeNull();
  });

  it('permits a qualified stdout final capture while protecting the input', async () => {
    const f = setup();
    f.invocation.finalPath = f.invocation.stdoutPath;
    const result = await adapter.prepareWorkerInvocation(f.invocation, f.qualification);
    expect(result.finalPath).toBe(result.stdoutPath);
    f.invocation.stdoutPath = '/fixture/dir/../brief 雪.md';
    await expect(adapter.prepareWorkerInvocation(f.invocation, f.qualification)).rejects.toThrow('distinct');
  });
});

describe('T-OG-15 adapter stdin rendering (#2998)', () => {
  it('renders only framing identities on argv; the brief stays in its input file', async () => {
    const f = setup();
    f.invocation.stdin = 'adapter-frame';
    f.qualification.adapter.invocation.stdin = 'adapter-frame';
    f.qualification.stdinFramerBinding = { storePath: '/trusted/worker-installations.json', storeDigest: `sha256:${'a'.repeat(64)}` };
    const prepared = await adapter.prepareWorkerInvocation(f.invocation, f.qualification);
    expect(prepared.shellCommand).toContain("'--adapter-frame'");
    expect(prepared.shellCommand).toContain(f.invocation.briefPath);
    expect(prepared.argv).toEqual(f.invocation.argv);
  });
  it('clears the adapter framer environment and binds the conductor store and policy', async () => {
    const f = setup();
    f.invocation.stdin = 'adapter-frame';
    f.qualification.adapter.invocation.stdin = 'adapter-frame';
    f.qualification.stdinFramerBinding = { storePath: '/trusted/worker-installations.json', storeDigest: `sha256:${'a'.repeat(64)}` };
    const prepared = await adapter.prepareWorkerInvocation(f.invocation, f.qualification);
    const framer = prepared.shellCommand!.split(' | ')[0];
    expect(framer).toContain(`&& env -i PATH="\${PATH-}" '${process.execPath}'`);
    expect(framer).toContain("'/trusted/worker-installations.json'");
    expect(framer).toContain(f.qualification.stdinFramerBinding.storeDigest);
    expect(framer).toContain(JSON.stringify(f.qualification.policy));
  });
  it('fails closed when the adapter framer has no trusted installation binding', async () => {
    const f = setup();
    f.invocation.stdin = 'adapter-frame';
    f.qualification.adapter.invocation.stdin = 'adapter-frame';
    await expect(adapter.prepareWorkerInvocation(f.invocation, f.qualification)).rejects.toThrow(/framer.*binding/i);
  });
  it('refuses an unknown stdin kind before emitting shell syntax', async () => {
    const f = setup();
    f.invocation.stdin = 'unknown-kind';
    await expect(adapter.prepareWorkerInvocation(f.invocation, f.qualification)).rejects.toThrow();
  });
});

// Frozen baseline covers the shared rendering boundary for every other bundled
// process profile, including profiles being developed in other worktrees.
describe('T-OG-15 bundled delivery remains byte-identical', () => {
  it.each(baseline.rows)('$provider $field argv and stdin bytes', async row => {
    const metadata = (loadProviderModelCapabilities().providers as any)[row.provider][row.field];
    expect(metadata.invocation.argv).toEqual(row.argv);
    expect(metadata.invocation.stdin).toBe(row.stdin);
    const f = setup();
    const invocation = f.invocation;
    invocation.stdin = row.stdin;
    invocation.envNames = [];
    invocation.argv = [process.execPath, ...row.argv.map(token => token.replace(/\$\{([a-zA-Z]+)\}/g,
      (_, name) => ({ model: invocation.selected.model, effort: 'medium', workspace: invocation.cwd,
        briefPath: invocation.briefPath, finalPath: invocation.finalPath, finalOutput: invocation.finalPath } as any)[name] ?? `/preview/${name}`))];
    const prepared = await adapter.prepareWorkerInvocation(invocation, f.qualification);
    const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
    const markers = Object.entries(directWorkerEnvironment(invocation)).map(([name, value]) => `${name}=${quote(value)}`).join(' ');
    const worker = `env -i ${markers} ${invocation.argv.map(quote).join(' ')}`;
    const outputs = `> ${quote(invocation.stdoutPath)} 2> ${quote(invocation.stderrPath)}`;
    const expected = row.stdin === 'brief-json'
      ? `cd ${quote(invocation.cwd)} && env -i ${[process.execPath, path.resolve('src/serve/worker-stdin-frame.mjs'), invocation.briefPath, invocation.selected.model, invocation.cwd].map(quote).join(' ')} | ${worker} ${outputs}`
      : `cd ${quote(invocation.cwd)} && ${worker} ${row.stdin === 'closed' ? '< /dev/null' : `< ${quote(invocation.briefPath)}`} ${outputs}`;
    expect(prepared.shellCommand).toBe(expected);
    const brief = Buffer.from('synthetic 雪\nbrief');
    const bytes = row.stdin === 'closed' ? null : row.stdin === 'brief-text' ? brief
      : Buffer.from(workerStdinDocument({ brief, model: invocation.selected.model, cwd: invocation.cwd }));
    expect(workerStdinBytes(invocation, brief)).toEqual(bytes);
  });
});

describe('native sandbox launch boundary qualification', () => {
  it('refuses an unverified native renderer before building arguments', async () => {
    const { buildWorkerInvocationTransport } = await import('../../../src/serve/worker-invocation.js');
    const f = setup();
    const buildInvocation = vi.fn();
    await expect(buildWorkerInvocationTransport({ qualification: f.qualification, buildInvocation }, {
      selected: f.invocation.selected, permissions: { launchMode: 'native-sandbox', sandbox: 'workspace-write' },
      cwd: '/synthetic/work', briefPath: '/synthetic/brief', brief: 'Synthetic task.', finalPath: '/synthetic/result',
      limits: f.invocation.limits, health: f.invocation.health,
    })).rejects.toMatchObject({ code: 'OG_POLICY_RELAXATION' });
    expect(buildInvocation).not.toHaveBeenCalled();
  });

  it('refuses an invocation isolation field that disagrees with its execution policy', async () => {
    const { prepareWorkerInvocation } = await import('../../../src/serve/worker-invocation.js');
    const f = setup();
    f.invocation.isolation = 'native-sandbox';
    f.qualification.adapterId = f.qualification.adapter.id;
    await expect(prepareWorkerInvocation(f.invocation, f.qualification)).rejects.toMatchObject({ code: 'OG_PIN_MISMATCH' });
  });
});
