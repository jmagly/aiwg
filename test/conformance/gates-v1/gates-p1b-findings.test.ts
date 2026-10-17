import { mkdtempSync } from '../../helpers/temp-dir.js';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { artifactDigest } from '../../../src/decision/validate.js';
import { gatesHandler } from '../../../src/cli/handlers/gates.js';
import { readAiwgConfig } from '../../../src/config/aiwg-config.js';
import {
  buildGatesRegistry, listGatePacks, loadHoldoutFile, loadUpstreamFile,
} from '../../../src/gates/driver.js';
import { evaluateGates } from '../../../src/gates/evaluate.js';
import { resolveProjectFloors, validateGatesConfig } from '../../../src/gates/floors.js';
import { GateRegistry } from '../../../src/gates/registry.js';
import { validateGateDocument } from '../../../src/gates/schema.js';
import { createCoreProviderRegistry, proportionProvider } from '../../../src/gates/providers/index.js';
import type { GateBinding, GatePack } from '../../../src/gates/types.js';
import {
  NOW, REGISTERED_AT, FROZEN_AT, cleanIntegrity, makeBindingForPack, makeUpstream,
  passingMetrics, projectPack, testHoldout, testRegistry, trustedDigest,
} from './helper.js';

const here = dirname(fileURLToPath(import.meta.url));

const tmpbox = (prefix: string): string => mkdtempSync(join(tmpdir(), `aiwg-gates-p1b-${prefix}-`));

/** Minimal valid pack: one all-scoped upstream-ceiling gate, no metrics. */
const minimalPack = (id: string): GatePack => ({
  apiVersion: 'gates.aiwg.io/v1alpha1',
  kind: 'GatePack',
  metadata: { id, version: '1.0.0', description: 'P1b minimal pack.' },
  spec: {
    metrics: {},
    gates: [{
      id: 'g', kind: 'upstream-ceiling', description: 'ceiling',
      scope: { mode: 'all' }, direction: 'higher-is-stricter', onFail: 'HOLD',
    }],
  },
});

const writeJson = (dir: string, name: string, value: unknown): string => {
  const file = join(dir, name);
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
};

/** Offline CLI file set for one binding: pack file plus binding/metrics/holdout/upstream JSON. */
const cliFiles = (dir: string, pack: GatePack) => {
  const binding = makeBindingForPack(pack);
  const packPath = writeJson(dir, 'pack.gatepack.json', pack);
  const bindingPath = writeJson(dir, 'binding.json', binding);
  const metricsPath = writeJson(dir, 'metrics.json', passingMetrics());
  const holdoutPath = writeJson(dir, 'holdout.json', testHoldout(binding));
  const upstreamPath = writeJson(dir, 'upstream.json', makeUpstream('promote'));
  return { binding, packPath, bindingPath, metricsPath, holdoutPath, upstreamPath };
};

const cliCtx = (args: string[], cwd: string) => ({
  args, rawArgs: ['gates', ...args], cwd, frameworkRoot: process.cwd(),
});

describe('p1b A1: --pack-dir files cannot self-attest namespaces', () => {
  it('rejects a file pack claiming an aiwg: id', () => {
    const dir = tmpbox('a1');
    const file = writeJson(dir, 'hijack.gatepack.json', minimalPack('aiwg:evil/x'));
    expect(() => buildGatesRegistry({ cwd: dir, packDirs: [file] })).toThrow(/project:/);
  });

  it('rejects a file pack claiming the shipped bundle id', () => {
    const dir = tmpbox('a1');
    const file = writeJson(dir, 'hijack2.gatepack.json', minimalPack('aiwg:decision-engine/other'));
    expect(() => buildGatesRegistry({ cwd: dir, packDirs: [file] })).toThrow(/project:/);
  });

  it('rejects a file pack claiming an addon: id', () => {
    const dir = tmpbox('a1');
    const file = writeJson(dir, 'hijack3.gatepack.json', minimalPack('addon:decision-engine/x'));
    expect(() => buildGatesRegistry({ cwd: dir, packDirs: [file] })).toThrow(/project:/);
  });

  it('scopes manifest-declared packs from an unverified directory to project: (R4)', () => {
    const dir = tmpbox('a1');
    const bundleDir = join(dir, 'bundle-mine');
    mkdirSync(join(bundleDir, 'gate-packs'), { recursive: true });
    writeFileSync(join(bundleDir, 'manifest.json'), JSON.stringify({ id: 'mine', type: 'addon' }));
    // An addon:-namespaced pack through an unverified --pack-dir refuses: the
    // path cannot prove the bundle it names.
    writeJson(join(bundleDir, 'gate-packs'), 'mine.gatepack.json', minimalPack('addon:mine/pack'));
    expect(() => buildGatesRegistry({ cwd: dir, packDirs: [bundleDir] })).toThrow(/namespace|project/);
    // A project:-namespaced pack in the same bundle loads as project-local.
    writeJson(join(bundleDir, 'gate-packs'), 'mine.gatepack.json', minimalPack('project:mine'));
    const { loaded } = buildGatesRegistry({ cwd: dir, packDirs: [bundleDir] });
    expect(loaded).toContain('project:mine');
  });
});

describe('p1b A8: pack origin comes from verification, not the path or manifest', () => {
  it('scopes even a manifest-declared framework bundle under a misleading path to project: (R4)', () => {
    const dir = tmpbox('a8');
    const bundleDir = join(dir, 'addons', 'legacy');
    mkdirSync(join(bundleDir, 'gate-packs'), { recursive: true });
    writeFileSync(join(bundleDir, 'manifest.json'), JSON.stringify({ id: 'fw', type: 'framework' }));
    // Path substrings such as /addons/ are never consulted, and the manifest
    // type no longer promotes an unverified directory: framework: refuses.
    writeJson(join(bundleDir, 'gate-packs'), 'fw.gatepack.json', minimalPack('framework:fw/pack'));
    expect(() => buildGatesRegistry({ cwd: dir, packDirs: [bundleDir] })).toThrow(/namespace|project/);
    writeJson(join(bundleDir, 'gate-packs'), 'fw.gatepack.json', minimalPack('project:legacy'));
    const { loaded } = buildGatesRegistry({ cwd: dir, packDirs: [bundleDir] });
    expect(loaded).toContain('project:legacy');
  });
});

describe('p1b A4: only the installed tree ships the aiwg: namespace', () => {
  const fakeRoot = (): string => {
    const dir = tmpbox('a4');
    const packDir = join(dir, 'agentic/code/addons/evil/gate-packs');
    mkdirSync(packDir, { recursive: true });
    writeJson(packDir, 'evil.gatepack.yaml', minimalPack('aiwg:evil/pack'));
    return dir;
  };

  it('ignores the cwd tree when listing shipped packs', () => {
    const ids = listGatePacks({ cwd: fakeRoot() }).map(pack => pack.id);
    expect(ids).not.toContain('aiwg:evil/pack');
    expect(ids).toContain('aiwg:decision-engine/integrity-ceiling');
  });

  it('refuses evaluation when packs come from an --aiwg-root override', async () => {
    const dir = tmpbox('a4eval');
    const root = tmpbox('a4root');
    const { binding, bindingPath, metricsPath, holdoutPath, upstreamPath, packPath } = cliFiles(dir, projectPack());
    const result = await gatesHandler.execute(cliCtx([
      'evaluate', '--binding', bindingPath, '--metrics', metricsPath,
      '--holdout', holdoutPath, '--upstream', upstreamPath,
      '--now', NOW, '--trusted-binding-digest', artifactDigest(binding),
      '--pack-dir', packPath, '--aiwg-root', root,
    ], dir));
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/untrusted/);
  });
});

describe('p1b A5: manifest gatePacks paths stay inside the bundle', () => {
  it('rejects a traversal outside the bundle dir', () => {
    const dir = tmpbox('a5');
    const bundleDir = join(dir, 'proj/addons/mine');
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(join(bundleDir, 'manifest.json'),
      JSON.stringify({ entry: { gatePacks: '../../../outside/gate-packs' } }));
    const outside = join(dir, 'outside/gate-packs');
    mkdirSync(outside, { recursive: true });
    writeJson(outside, 'evil.gatepack.json', minimalPack('project:evil'));
    const registry = new GateRegistry(createCoreProviderRegistry());
    return import('../../../src/gates/discovery.js').then(({ registerBundleGatePacks }) => {
      expect(() => registerBundleGatePacks(registry, bundleDir, { namespace: 'project' }))
        .toThrow(/escapes|relative|traversal|outside|containment/);
    });
  });
});

describe('p1b A6: symlinks, non-files and unbounded reads are rejected', () => {
  it('rejects a symlinked gate-pack file', async () => {
    const dir = tmpbox('a6');
    const bundleDir = join(dir, 'bundle');
    const packDir = join(bundleDir, 'gate-packs');
    mkdirSync(packDir, { recursive: true });
    const realDir = join(dir, 'real');
    mkdirSync(realDir, { recursive: true });
    const real = writeJson(realDir, 's.gatepack.json', minimalPack('project:sym'));
    symlinkSync(real, join(packDir, 's.gatepack.yaml'));
    const { registerBundleGatePacks } = await import('../../../src/gates/discovery.js');
    const registry = new GateRegistry(createCoreProviderRegistry());
    expect(() => registerBundleGatePacks(registry, bundleDir, { namespace: 'project' }))
      .toThrow(/symlink/);
  });

  it('rejects an oversized gate-pack file before reading it', async () => {
    const dir = tmpbox('a6');
    const file = join(dir, 'big.gatepack.yaml');
    writeFileSync(file, `x: ${'y'.repeat(300 * 1024)}\n`);
    const { loadGatePackFile } = await import('../../../src/gates/discovery.js');
    expect(() => loadGatePackFile(file)).toThrow(/too large|exceeds/);
  });

  it('rejects a non-regular gate-pack file', async () => {
    const dir = tmpbox('a6');
    const file = join(dir, 'dir.gatepack.yaml');
    mkdirSync(file);
    const { loadGatePackFile } = await import('../../../src/gates/discovery.js');
    expect(() => loadGatePackFile(file)).toThrow(/not a regular file|symlink/);
  });
});

describe('p1b A2: CLI evaluation trusts nothing it derives itself', () => {
  it('requires --trusted-binding-digest', async () => {
    const dir = tmpbox('a2');
    const { bindingPath, metricsPath, holdoutPath, upstreamPath, packPath } = cliFiles(dir, projectPack());
    const result = await gatesHandler.execute(cliCtx([
      'evaluate', '--binding', bindingPath, '--metrics', metricsPath,
      '--holdout', holdoutPath, '--upstream', upstreamPath,
      '--now', NOW, '--pack-dir', packPath,
    ], dir));
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/trusted-binding-digest/);
  });

  it('refuses a mismatched trusted binding digest', async () => {
    const dir = tmpbox('a2');
    const { bindingPath, metricsPath, holdoutPath, upstreamPath, packPath } = cliFiles(dir, projectPack());
    const result = await gatesHandler.execute(cliCtx([
      'evaluate', '--binding', bindingPath, '--metrics', metricsPath,
      '--holdout', holdoutPath, '--upstream', upstreamPath,
      '--now', NOW, '--trusted-binding-digest', `sha256:${'0'.repeat(64)}`,
      '--pack-dir', packPath,
    ], dir));
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/binding digest does not match|mismatch/);
  });

  it('labels CLI reports with attestation offline-cli', async () => {
    const dir = tmpbox('a2');
    const { binding, bindingPath, metricsPath, holdoutPath, upstreamPath, packPath } = cliFiles(dir, projectPack());
    const result = await gatesHandler.execute(cliCtx([
      'evaluate', '--binding', bindingPath, '--metrics', metricsPath,
      '--holdout', holdoutPath, '--upstream', upstreamPath,
      '--now', NOW, '--trusted-binding-digest', artifactDigest(binding),
      '--pack-dir', packPath,
    ], dir));
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.message ?? '{}')).toMatchObject({ attestation: 'offline-cli' });
  });

  it('requires holdout files to already carry their digest instead of auto-sealing', async () => {
    const dir = tmpbox('a2');
    const binding = makeBindingForPack(projectPack());
    const file = writeJson(dir, 'holdout.json', {
      frozenDigest: trustedDigest(binding), firstAccessedAt: null,
    });
    await expect(loadHoldoutFile(file, dir)).rejects.toThrow(/digest|seal/);
  });

  it('requires upstream files to be sealed records instead of auto-sealing raw metadata', async () => {
    const dir = tmpbox('a2');
    const file = writeJson(dir, 'upstream.json', cleanIntegrity());
    await expect(loadUpstreamFile(file, dir)).rejects.toThrow(/sealed|digest/);
  });

  it('accepts the offline-cli attestation in GateReport schema validation', () => {
    const { registry } = testRegistry();
    const binding = makeBindingForPack(projectPack());
    registry.registerPack(projectPack(), { namespace: 'project' });
    const evaluated = evaluateGates({
      binding, registry, trustedBindingDigest: trustedDigest(binding),
      holdout: testHoldout(binding), metrics: passingMetrics(),
      upstream: makeUpstream('promote'), now: NOW,
      floors: 'none-explicit-opt-out' as never,
    });
    const labeled = { ...evaluated, attestation: 'offline-cli' as const };
    const { digest: _dropped, ...fields } = labeled;
    void _dropped;
    expect(() => validateGateDocument({ ...fields, digest: artifactDigest(fields) })).not.toThrow();
  });
});

describe('p1b A3: a bound upstream-ceiling gate without a sealed upstream refuses', () => {
  it('refuses null upstream in the evaluator instead of downgrading to HOLD', () => {
    const { registry } = testRegistry();
    const binding = makeBindingForPack(projectPack());
    registry.registerPack(projectPack(), { namespace: 'project' });
    expect(() => evaluateGates({
      binding, registry, trustedBindingDigest: trustedDigest(binding),
      holdout: testHoldout(binding), metrics: passingMetrics(),
      upstream: null, now: NOW,
      floors: 'none-explicit-opt-out' as never,
    })).toThrow(/upstream/);
  });

  it('refuses CLI evaluation without --upstream instead of reporting HOLD', async () => {
    const dir = tmpbox('a3');
    const { binding, bindingPath, metricsPath, holdoutPath, packPath } = cliFiles(dir, projectPack());
    const result = await gatesHandler.execute(cliCtx([
      'evaluate', '--binding', bindingPath, '--metrics', metricsPath,
      '--holdout', holdoutPath,
      '--now', NOW, '--trusted-binding-digest', artifactDigest(binding),
      '--pack-dir', packPath,
    ], dir));
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/upstream/);
  });
});

describe('p1b B1: project floors are a required evaluator input', () => {
  const validInput = () => {
    const { registry } = testRegistry();
    const binding = makeBindingForPack(projectPack());
    registry.registerPack(projectPack(), { namespace: 'project' });
    return {
      binding, registry, trustedBindingDigest: trustedDigest(binding),
      holdout: testHoldout(binding), metrics: passingMetrics(),
      upstream: makeUpstream('promote'), now: NOW,
    };
  };

  it('refuses evaluation without an explicit floors input', () => {
    expect(() => evaluateGates({ ...validInput(), floors: undefined as never }))
      .toThrow(/floors/);
  });

  it('loads aiwg.config floors in CLI evaluation and refuses loosened bindings', async () => {
    const dir = tmpbox('b1');
    const floorPack: GatePack = {
      apiVersion: 'gates.aiwg.io/v1alpha1', kind: 'GatePack',
      metadata: { id: 'project:p1b-floors', version: '1.0.0', description: 'Strict support floor.' },
      spec: {
        metrics: { 'false-ready': { provider: 'test.proportion/v1', kind: 'proportion' } },
        gates: [{
          id: 'support-total', kind: 'minimum-n', description: 'Strict support.',
          metric: { provider: 'test.proportion/v1', name: 'false-ready' },
          minimumN: 5000, scope: { mode: 'all' },
          direction: 'higher-is-stricter', onFail: 'HOLD',
        }],
      },
    };
    mkdirSync(join(dir, '.aiwg'), { recursive: true });
    writeJson(join(dir, '.aiwg'), 'aiwg.config', { version: '1', gates: { floors: [{ pack: floorPack }] } });
    const { binding, bindingPath, metricsPath, holdoutPath, upstreamPath, packPath } = cliFiles(dir, projectPack());
    const result = await gatesHandler.execute(cliCtx([
      'evaluate', '--binding', bindingPath, '--metrics', metricsPath,
      '--holdout', holdoutPath, '--upstream', upstreamPath,
      '--now', NOW, '--trusted-binding-digest', artifactDigest(binding),
      '--pack-dir', packPath,
    ], dir));
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/loosens project floor gate 'support-total'/);
  });

  it('refuses CLI evaluation when the gates config section is invalid', async () => {
    const dir = tmpbox('b1');
    mkdirSync(join(dir, '.aiwg'), { recursive: true });
    writeJson(join(dir, '.aiwg'), 'aiwg.config', { version: '1', gates: { floors: [{ pack: { kind: 'GatePack' } }] } });
    const { binding, bindingPath, metricsPath, holdoutPath, upstreamPath, packPath } = cliFiles(dir, projectPack());
    const result = await gatesHandler.execute(cliCtx([
      'evaluate', '--binding', bindingPath, '--metrics', metricsPath,
      '--holdout', holdoutPath, '--upstream', upstreamPath,
      '--now', NOW, '--trusted-binding-digest', artifactDigest(binding),
      '--pack-dir', packPath,
    ], dir));
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/gates|Invalid/i);
  });

  it('refuses CLI evaluation when the config file is unreadable', async () => {
    const dir = tmpbox('b1');
    mkdirSync(join(dir, '.aiwg'), { recursive: true });
    writeFileSync(join(dir, '.aiwg/aiwg.config'), '{not-json\n');
    const { binding, bindingPath, metricsPath, holdoutPath, upstreamPath, packPath } = cliFiles(dir, projectPack());
    const result = await gatesHandler.execute(cliCtx([
      'evaluate', '--binding', bindingPath, '--metrics', metricsPath,
      '--holdout', holdoutPath, '--upstream', upstreamPath,
      '--now', NOW, '--trusted-binding-digest', artifactDigest(binding),
      '--pack-dir', packPath,
    ], dir));
    expect(result.exitCode).toBe(1);
  });
});

describe('p1b B2: the default floor yields only to a tightening ceiling', () => {
  const weakInline: GatePack = {
    apiVersion: 'gates.aiwg.io/v1alpha1', kind: 'GatePack',
    metadata: { id: 'project:weak', version: '1.0.0', description: 'Weak suppressor.' },
    spec: {
      metrics: {},
      gates: [{
        id: 'integrity-ceiling', kind: 'predicate', description: 'Not a ceiling.',
        predicate: { op: 'exists', left: { source: 'input', pointer: '/parameters' } },
        scope: { mode: 'all' }, direction: 'higher-is-stricter', onFail: 'HOLD',
      }],
    },
  };

  it('flags an inline integrity-ceiling floor that is not an all-scoped upstream-ceiling gate', () => {
    expect(validateGatesConfig({ floors: [{ pack: weakInline }] }).length).toBeGreaterThan(0);
  });

  it('keeps the default floor when the suppressor does not tighten it', () => {
    const evade = projectPack('aiwg:test-gates/evade');
    const ceiling = evade.spec.gates.find(gate => gate.id === 'integrity-ceiling');
    if (ceiling === undefined) throw new Error('fixture lost its ceiling gate');
    Object.assign(ceiling, {
      kind: 'predicate',
      predicate: { op: 'exists', left: { source: 'input', pointer: '/parameters' } },
    });
    delete (ceiling as { metric?: unknown }).metric;
    const { registry } = testRegistry();
    registry.registerPack(evade, { namespace: 'aiwg', bundle: 'test-gates' });
    const binding = makeBindingForPack(evade, { metadata: { id: 'p1b/evade', version: '1.0.0', description: 'P1b evade binding.' } });
    const floors = resolveProjectFloors({ floors: [{ pack: weakInline }] });
    expect(() => registry.resolveBinding(binding, floors)).toThrow(/project floor/);
  });
});

describe('p1b B3: a project-wide default ceiling covers every study', () => {
  it('applies the star ceiling to bindings without their own key', () => {
    const { registry } = testRegistry();
    const binding = makeBindingForPack(projectPack(), { metadata: { id: 'p1b/any-study', version: '1.0.0', description: 'P1b ceiling binding.' } });
    registry.registerPack(projectPack(), { namespace: 'project' });
    const floors = resolveProjectFloors({ ceilings: { '*': 'HOLD' } });
    expect(() => registry.resolveBinding(binding, floors)).toThrow(/below the project ceiling/);
  });

  it('forbids per-study ceilings that loosen the star default', () => {
    expect(validateGatesConfig({ ceilings: { '*': 'HOLD', 's': 'PROMOTE' } }).length).toBeGreaterThan(0);
    expect(validateGatesConfig({ ceilings: { '*': 'HOLD', 's': 'ROLLBACK' } })).toEqual([]);
  });
});

describe('p1b B4: invalid gates config warns instead of bricking every command', () => {
  it('reads the config despite gates errors', async () => {
    const dir = tmpbox('b4');
    mkdirSync(join(dir, '.aiwg'), { recursive: true });
    writeFileSync(join(dir, '.aiwg/aiwg.config'),
      JSON.stringify({ version: '1', gates: { floors: [{ pack: { kind: 'GatePack' } }] } }));
    await expect(readAiwgConfig(dir)).resolves.toBeDefined();
  });
});

describe('p1b A7: gate-pack discovery labels', () => {
  const relevancePath = resolve(here, '../../fixtures/artifacts/discovery-relevance.jsonl');

  it('labels the compromise-rollback query as a capability, not a hard negative', () => {
    const rows = readFileSync(relevancePath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const row = rows.find(entry => entry.id === 'gate-pack-04');
    expect(row.query_class).toBe('capability');
  });

  it('gives gate-pack rows same-type hard negatives', () => {
    const rows = readFileSync(relevancePath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const gateRows = rows.filter(entry => entry.target_type === 'gate-pack');
    expect(gateRows.length).toBeGreaterThan(10);
    expect(gateRows.some(entry => (entry.hard_negative_ids as string[]).some(id => id.startsWith('gate-pack:')))).toBe(true);
  });

  it('registers the second fixture pack and gates on its coverage bound', async () => {
    const pack = JSON.parse(readFileSync(resolve(here, 'fixtures/coverage-floor-pack.json'), 'utf8')) as GatePack;
    const registry = new GateRegistry(createCoreProviderRegistry());
    registry.registerPack(pack, { namespace: 'aiwg', bundle: 'test-gates' });
    const digest = artifactDigest(pack);
    const binding: GateBinding = {
      apiVersion: 'gates.aiwg.io/v1alpha1', kind: 'GateBinding',
      metadata: { id: 'p1b/coverage', version: '1.0.0', description: 'Coverage floor binding.' },
      spec: {
        packs: [{ id: pack.metadata.id, version: pack.metadata.version, digest, resolvedDigest: digest }],
        parameters: { [`${pack.metadata.id}.coverageMinBps`]: 1500 },
        slices: ['a', 'b'],
        references: [{ name: 'always-review', kind: 'always-review' }],
        metricProviders: testRegistry().providers.map(provider => ({
          id: provider.id, version: provider.version, sourceDigest: provider.sourceDigest,
        })),
        ceiling: 'PROMOTE', registeredAt: REGISTERED_AT, frozenAt: FROZEN_AT, holdoutAccessedAt: null,
      },
    };
    const resolved = registry.resolveBinding(binding);
    expect(resolved.parameters[`${pack.metadata.id}.coverageMinBps`]).toBe(1500);
    const lowCoverage = proportionProvider.compute([
      ...Array.from({ length: 1000 }, () => ({ slice: 'a', metric: 'false-ready', event: false })),
      ...Array.from({ length: 1000 }, () => ({ slice: 'b', metric: 'false-ready', event: false })),
      ...Array.from({ length: 100 }, () => ({ slice: 'a', metric: 'coverage', event: true })),
      ...Array.from({ length: 900 }, () => ({ slice: 'a', metric: 'coverage', event: false })),
      ...Array.from({ length: 100 }, () => ({ slice: 'b', metric: 'coverage', event: true })),
      ...Array.from({ length: 900 }, () => ({ slice: 'b', metric: 'coverage', event: false })),
    ]);
    const metrics = {
      ...passingMetrics(),
      providers: { ...passingMetrics().providers, [proportionProvider.id]: lowCoverage },
    };
    const report = evaluateGates({
      binding, registry, trustedBindingDigest: trustedDigest(binding),
      holdout: testHoldout(binding), metrics,
      upstream: makeUpstream('promote'), now: NOW,
      floors: 'none-explicit-opt-out' as never,
    });
    // 10% pooled coverage drags the Wilson lower bound under the 1500bps
    // floor, so the coverage gate fails instead of promoting.
    expect(report.gateEvidence.find(entry => entry.gateId === 'coverage-lower')).toMatchObject({ status: 'fail' });
    expect(report.decision).toBe('HOLD');
  });
});
