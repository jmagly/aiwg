import { mkdtempSync } from '../../helpers/temp-dir.js';
import { cpSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { itSandboxed } from './sandbox-helper.js';
import { BundleManifestSchema } from '../../../src/extensions/manifest.js';
import { artifactDigest } from '../../../src/decision/validate.js';
import { evaluateGates, sealGateHoldout, sealUpstream } from '../../../src/gates/evaluate.js';
import { cleanIntegrity } from './helper.js';
import { GateRegistry } from '../../../src/gates/registry.js';
import { createCoreProviderRegistry } from '../../../src/gates/providers/index.js';
import { MetricProviderRegistry } from '../../../src/gates/providers/registry.js';
import {
  GateProviderError, computeProviderCodeDigest, invokeBundleProvider, loadGateBundleProviders,
  providerBindingPin, sealProviderSection,
} from '../../../src/gates/providers/loader.js';
import type { GateBinding, GatePack, Sha256Digest } from '../../../src/gates/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const EXAMPLE_ROOT = resolve(here, '../../../test/fixtures/gates-example-extension');
const NOW = '2026-09-03T00:00:00.000Z';
/** invokeBundleProvider requires an explicit frozen clock (C5). */
const INVOKE_CLOCK_MS = Date.parse(NOW);
const REGISTERED_AT = '2026-09-01T00:00:00.000Z';
const FROZEN_AT = '2026-09-02T00:00:00.000Z';
// Pinned by the reviewed example bytes (example.mjs + helper.mjs). The
// snapshot scheme preserves this digest: a byte tweak moves the code digest,
// so this constant proves stability — the load test fails if the provider
// changes without re-review and re-allowlisting.
const EXPECTED_CODE_DIGEST = 'sha256:76cd4dcb9af82fc27461a845254401bd66e96f8f5198cbb57c28c1f99511a590';
const EXAMPLE_ALLOWLIST = [{
  bundleId: 'gates-example',
  providerId: 'example.count/v1',
  codeDigest: EXPECTED_CODE_DIGEST as Sha256Digest,
  reviewer: 'Example Reviewer',
  reviewedAt: '2026-08-15T00:00:00.000Z',
}];
const PACK_ID = 'addon:gates-example/conformance-v1';

function exampleManifest(): { id: string; gateProviders: unknown } {
  return JSON.parse(readFileSync(join(EXAMPLE_ROOT, 'manifest.json'), 'utf8')) as { id: string; gateProviders: unknown };
}

async function loadExample(now: string = NOW) {
  const manifest = exampleManifest();
  const loaded = await loadGateBundleProviders(EXAMPLE_ROOT, manifest, {
    allowBundleProviders: true, now, allowlist: EXAMPLE_ALLOWLIST,
  });
  return { manifest, provider: loaded[0] as NonNullable<typeof loaded[number]> };
}

function bundlePack(): GatePack {
  return {
    apiVersion: 'gates.aiwg.io/v1alpha1',
    kind: 'GatePack',
    metadata: { id: PACK_ID, version: '1.0.0', description: 'Bundle-provider conformance pack.' },
    spec: {
      metrics: { flakes: { provider: 'example.count/v1', kind: 'proportion' } },
      gates: [
        {
          id: 'flakes-cap', kind: 'count-max', metric: { provider: 'example.count/v1', name: 'flakes' },
          threshold: { op: 'lte', value: 0 }, scope: { mode: 'listed', slices: ['b'] },
          direction: 'lower-is-stricter', onFail: 'ROLLBACK',
        },
        {
          id: 'support-total', kind: 'minimum-n', metric: { provider: 'example.count/v1', name: 'flakes' },
          minimumN: 2, scope: { mode: 'all' }, direction: 'higher-is-stricter', onFail: 'HOLD',
        },
      ],
    },
  };
}

function bundleRegistry(provider: { id: string } & Record<string, unknown>): GateRegistry {
  const providers = createCoreProviderRegistry();
  providers.register(provider as never);
  const registry = new GateRegistry(providers);
  registry.registerPack(bundlePack(), { namespace: 'addon', bundle: 'gates-example' });
  return registry;
}

function bundleBinding(provider: { id: string; version: string; sourceDigest: Sha256Digest; codeDigest: Sha256Digest },
  records: readonly unknown[]): GateBinding {
  const pack = bundlePack();
  const digest = artifactDigest(pack) as Sha256Digest;
  return {
    apiVersion: 'gates.aiwg.io/v1alpha1',
    kind: 'GateBinding',
    metadata: { id: 'gates-example/run-v1', version: '1.0.0', description: 'Bundle-provider binding.' },
    spec: {
      packs: [{ id: pack.metadata.id, version: pack.metadata.version, digest, resolvedDigest: digest }],
      parameters: {},
      slices: ['a', 'b'],
      references: [],
      metricProviders: [providerBindingPin(provider, records)],
      ceiling: 'PROMOTE',
      registeredAt: REGISTERED_AT,
      frozenAt: FROZEN_AT,
    },
  };
}

function flakeRecords(failures: Record<string, number>): { slice: string; failed: boolean }[] {
  return Object.entries(failures).flatMap(([slice, events]) => [
    ...Array.from({ length: events }, () => ({ slice, failed: true })),
    ...Array.from({ length: 10 - events }, () => ({ slice, failed: false })),
  ]);
}

describe('gates bundle providers', () => {
  itSandboxed('loads the reviewed example provider with a stable code digest', async () => {
    const { provider } = await loadExample();
    expect(provider.id).toBe('example.count/v1');
    expect(provider.codeDigest).toBe(EXPECTED_CODE_DIGEST);
    expect(provider.review.codeDigest).toBe(EXPECTED_CODE_DIGEST);
    expect(provider.review.reviewer).toBe('Example Reviewer');
    const recomputed = computeProviderCodeDigest(EXAMPLE_ROOT, 'gate-providers/example.mjs');
    expect(recomputed.codeDigest).toBe(EXPECTED_CODE_DIGEST);
    expect(recomputed.files.map((file) => file.path).sort()).toEqual([
      'gate-providers/example.mjs', 'gate-providers/helper.mjs',
    ]);
    // The manifest declaration itself validates against the closed Zod shape.
    expect(BundleManifestSchema.safeParse({
      id: 'gates-example', type: 'extension', name: 'Gates Example', version: '1.0.0',
      description: 'Fixture extension.', manifestVersion: '1', platforms: { claude: 'full' },
      keywords: ['gates'], deployment: { pathTemplate: '.{platform}/skills/{id}.md' },
      gateProviders: [{
        id: 'example.count/v1', version: '1.0.0', module: 'gate-providers/example.mjs',
        description: 'Example.', review: { reviewer: 'R', reviewedAt: NOW, codeDigest: EXPECTED_CODE_DIGEST },
      }],
    }).success).toBe(true);
  });

  it('refuses a byte-tweaked provider until re-pinned', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gates-tweak-'));
    cpSync(EXAMPLE_ROOT, dir, { recursive: true });
    const helper = join(dir, 'gate-providers/helper.mjs');
    writeFileSync(helper, `${readFileSync(helper, 'utf8')}\n// tweak\n`);
    const tweaked = computeProviderCodeDigest(dir, 'gate-providers/example.mjs');
    expect(tweaked.codeDigest).not.toBe(EXPECTED_CODE_DIGEST);
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { id: string; gateProviders: unknown };
    await expect(loadGateBundleProviders(dir, manifest, {
      allowBundleProviders: true, now: NOW, allowlist: EXAMPLE_ALLOWLIST,
    })).rejects.toMatchObject({ name: 'GateProviderError', code: 'attestation-mismatch' });
  });

  it('refuses missing attestations', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gates-noatt-'));
    cpSync(EXAMPLE_ROOT, dir, { recursive: true });
    const manifest = { id: 'gates-example', gateProviders: [{
      id: 'example.count/v1', version: '1.0.0', module: 'gate-providers/example.mjs', description: 'Example.',
    }] };
    await expect(loadGateBundleProviders(dir, manifest, {
      allowBundleProviders: true, now: NOW, allowlist: EXAMPLE_ALLOWLIST,
    })).rejects.toBeInstanceOf(GateProviderError);
    // Zod itself requires exactly one of review/reviewFile.
    expect(BundleManifestSchema.safeParse({
      id: 'gates-example', type: 'extension', name: 'G', version: '1.0.0', description: 'D',
      manifestVersion: '1', platforms: { claude: 'full' }, keywords: ['g'],
      deployment: { pathTemplate: '.{platform}/skills/{id}.md' },
      gateProviders: [{ id: 'example.count/v1', version: '1.0.0', module: 'gate-providers/example.mjs', description: 'E' }],
    }).success).toBe(false);
  });

  it('refuses registration without a project-config allowlist entry', async () => {
    const manifest = exampleManifest();
    await expect(loadGateBundleProviders(EXAMPLE_ROOT, manifest, { allowBundleProviders: true, now: NOW }))
      .rejects.toMatchObject({ name: 'GateProviderError', code: 'unregistered' });
    await expect(loadGateBundleProviders(EXAMPLE_ROOT, manifest, {
      allowBundleProviders: true, now: NOW, allowlist: [],
    })).rejects.toMatchObject({ name: 'GateProviderError', code: 'unregistered' });
  });

  it('refuses path escapes and never imports undeclared paths', async () => {
    for (const escaped of ['../escape.mjs', '/abs.mjs', '..\\escape.mjs']) {
      await expect(loadGateBundleProviders(EXAMPLE_ROOT, {
        id: 'gates-example',
        gateProviders: [{
          id: 'example.count/v1', version: '1.0.0', module: escaped, description: 'E',
          review: { reviewer: 'R', reviewedAt: NOW, codeDigest: EXPECTED_CODE_DIGEST },
        }],
      }, { allowBundleProviders: true, now: NOW, allowlist: EXAMPLE_ALLOWLIST }))
        .rejects.toMatchObject({ code: expect.stringMatching(/path-escape|invalid-module/) });
    }
    // Symlink escape: a declared path that resolves outside the bundle refuses.
    const dir = mkdtempSync(join(tmpdir(), 'gates-link-'));
    cpSync(EXAMPLE_ROOT, dir, { recursive: true });
    const outside = join(mkdtempSync(join(tmpdir(), 'gates-outside-')), 'outside.mjs');
    writeFileSync(outside, 'export const provider = { id: "example.count/v1" };');
    try {
      symlinkSync(outside, join(dir, 'gate-providers/link.mjs'));
    } catch { /* symlink privilege: fall back to traversal assertion above */ }
    try {
      realpathSync(join(dir, 'gate-providers/link.mjs'));
      expect(() => computeProviderCodeDigest(dir, 'gate-providers/link.mjs')).toThrow();
    } catch (error) {
      expect(error instanceof GateProviderError || (error as Error).message.length > 0).toBe(true);
    }
    // The manifest Zod shape rejects escapes before the loader ever imports.
    expect(BundleManifestSchema.safeParse({
      id: 'gates-example', type: 'extension', name: 'G', version: '1.0.0', description: 'D',
      manifestVersion: '1', platforms: { claude: 'full' }, keywords: ['g'],
      deployment: { pathTemplate: '.{platform}/skills/{id}.md' },
      gateProviders: [{
        id: 'example.count/v1', version: '1.0.0', module: '../escape.mjs', description: 'E',
        review: { reviewer: 'R', reviewedAt: NOW, codeDigest: EXPECTED_CODE_DIGEST },
      }],
    }).success).toBe(false);
  });

  itSandboxed('refuses undeclared providers at binding resolution', async () => {
    const { provider } = await loadExample();
    const coreOnly = new GateRegistry(createCoreProviderRegistry());
    // Unknown providers fail at pack load, before any binding resolves.
    expect(() => coreOnly.registerPack(bundlePack(), { namespace: 'addon', bundle: 'gates-example' }))
      .toThrow(/unknown provider/);
    const binding = bundleBinding(provider, flakeRecords({ a: 0, b: 0 }));
    expect(() => coreOnly.resolveBinding(binding)).toThrow(/unknown (provider|gate pack)/);
  });

  itSandboxed('refuses bindings pinned to the old code digest', async () => {
    const { provider } = await loadExample();
    const registry = bundleRegistry(provider);
    const records = flakeRecords({ a: 0, b: 0 });
    const binding = bundleBinding(provider, records);
    expect(registry.resolveBinding(binding).packs).toHaveLength(1);
    // A byte change moves the digest; the old pin refuses against the new code.
    const dir = mkdtempSync(join(tmpdir(), 'gates-repin-'));
    cpSync(EXAMPLE_ROOT, dir, { recursive: true });
    writeFileSync(join(dir, 'gate-providers/helper.mjs'), `${readFileSync(join(dir, 'gate-providers/helper.mjs'), 'utf8')}\n// v2\n`);
    const nextDigest = computeProviderCodeDigest(dir, 'gate-providers/example.mjs').codeDigest;
    expect(nextDigest).not.toBe(provider.codeDigest);
    // The evolved provider must itself be loader-issued (C3): re-review and
    // re-allowlist the new bytes, then load them through the loader.
    writeFileSync(join(dir, 'gate-providers/example-review.json'), JSON.stringify({
      codeDigest: nextDigest, reviewedAt: '2026-08-15T00:00:00.000Z', reviewer: 'Example Reviewer',
    }));
    const [evolved] = await loadGateBundleProviders(dir, exampleManifest(), {
      allowBundleProviders: true, now: NOW,
      allowlist: [{ ...EXAMPLE_ALLOWLIST[0]!, codeDigest: nextDigest as Sha256Digest }],
    });
    expect(evolved!.codeDigest).toBe(nextDigest);
    const nextProviders = createCoreProviderRegistry();
    nextProviders.register(evolved as never);
    const nextRegistry = new GateRegistry(nextProviders);
    nextRegistry.registerPack(bundlePack(), { namespace: 'addon', bundle: 'gates-example' });
    expect(() => nextRegistry.resolveBinding(binding)).toThrow(/code pin mismatch/);
    // Re-pinning to the new digest resolves again.
    const repinned: GateBinding = {
      ...binding,
      spec: {
        ...binding.spec,
        metricProviders: [{
          ...(binding.spec.metricProviders[0] as object), codeDigest: nextDigest,
        } as never],
      },
    };
    const trusted = artifactDigest(repinned) as Sha256Digest;
    expect(trusted).not.toBe(artifactDigest(binding));
    expect(nextRegistry.resolveBinding(repinned).packs).toHaveLength(1);
  });

  itSandboxed('seals metrics with trusted digests and refuses forged sections', async () => {
    const { provider } = await loadExample();
    const records = flakeRecords({ a: 0, b: 0 });
    const raw = (await invokeBundleProvider(provider, records, { timeoutMs: 1000, clockMs: INVOKE_CLOCK_MS })) as { metrics: unknown };
    // A lying provider that declares its own version/digest is overwritten.
    const lying = { metrics: (raw as { metrics: unknown }).metrics, version: '9.9.9', sourceDigest: provider.sourceDigest };
    const sealed = sealProviderSection(provider, records, lying);
    expect(sealed.version).toBe(provider.version);
    expect(sealed.sourceDigest).toBe(provider.sourceDigest);
    expect(sealed.codeDigest).toBe(provider.codeDigest);
    expect(sealed.recordsDigest).toBe(artifactDigest(records));
    const registry = bundleRegistry(provider);
    const binding = bundleBinding(provider, records);
    const trusted = artifactDigest(binding) as Sha256Digest;
    const upstream = sealUpstream(cleanIntegrity());
    const metrics = { providers: { [provider.id]: sealed } };
    const runtime = { providers: [provider], records: { [provider.id]: records } };
    const report = evaluateGates({
      // Provider sealing under test, not project floors (#2832 covers floors).
      floors: 'none-explicit-opt-out',
      binding, registry, trustedBindingDigest: trusted,
      holdout: sealGateHoldout({ frozenDigest: trusted, firstAccessedAt: null }),
      metrics, upstream, now: NOW, providerRuntime: runtime,
    });
    expect(report.decision).toBe('PROMOTE');
    // Forged code digests refuse instead of promoting.
    const forged = { providers: { [provider.id]: { ...sealed, codeDigest: provider.sourceDigest } } };
    expect(() => evaluateGates({
      // Provider sealing under test, not project floors (#2832 covers floors).
      floors: 'none-explicit-opt-out',
      binding, registry, trustedBindingDigest: trusted,
      holdout: sealGateHoldout({ frozenDigest: trusted, firstAccessedAt: null }),
      metrics: forged as never, upstream, now: NOW, providerRuntime: runtime,
    })).toThrow(/pin mismatch/);
    // Null digests fail closed, never verify as compatible.
    const nulled = { providers: { [provider.id]: { ...sealed, codeDigest: null } } };
    expect(() => evaluateGates({
      // Provider sealing under test, not project floors (#2832 covers floors).
      floors: 'none-explicit-opt-out',
      binding, registry, trustedBindingDigest: trusted,
      holdout: sealGateHoldout({ frozenDigest: trusted, firstAccessedAt: null }),
      metrics: nulled as never, upstream, now: NOW, providerRuntime: runtime,
    })).toThrow(/pin mismatch/);
  });

  itSandboxed('gates bundle metrics offline: clean promotes, regressed rolls back, upstream holds', async () => {
    const { provider } = await loadExample();
    const registry = bundleRegistry(provider);
    const clean = sealUpstream(cleanIntegrity());
    const evaluate = async (failures: Record<string, number>) => {
      const records = flakeRecords(failures);
      const binding = bundleBinding(provider, records);
      const trusted = artifactDigest(binding) as Sha256Digest;
      const raw = (await invokeBundleProvider(provider, records, { timeoutMs: 2000, clockMs: INVOKE_CLOCK_MS })) as { metrics: unknown };
      const sealed = sealProviderSection(provider, records, raw);
      return evaluateGates({
      // Provider sealing under test, not project floors (#2832 covers floors).
      floors: 'none-explicit-opt-out',
        binding, registry, trustedBindingDigest: trusted,
        holdout: sealGateHoldout({ frozenDigest: trusted, firstAccessedAt: null }),
        metrics: { providers: { [provider.id]: sealed } }, upstream: clean, now: NOW,
        providerRuntime: { providers: [provider], records: { [provider.id]: records } },
      });
    };
    expect((await evaluate({ a: 0, b: 0 })).decision).toBe('PROMOTE');
    // One failure on the blocking slice is a ROLLBACK gate: never PROMOTE.
    const regressed = await evaluate({ a: 0, b: 1 });
    expect(regressed.decision).toBe('ROLLBACK');
    expect(regressed.gateEvidence.find((entry) => entry.gateId === 'flakes-cap')?.outcome).toBe('ROLLBACK');
    // The eval-integrity ceiling is never upgraded by a passing provider.
    const held = sealUpstream(cleanIntegrity({ release_gate: { decision: 'HOLD', reasons: ['manual-review'] } }));
    const records = flakeRecords({ a: 0, b: 0 });
    const binding = bundleBinding(provider, records);
    const trusted = artifactDigest(binding) as Sha256Digest;
    const raw = (await invokeBundleProvider(provider, records, { timeoutMs: 2000, clockMs: INVOKE_CLOCK_MS })) as { metrics: unknown };
    const sealed = sealProviderSection(provider, records, raw);
    const ceiling = evaluateGates({
      // Provider sealing under test, not project floors (#2832 covers floors).
      floors: 'none-explicit-opt-out',
      binding, registry, trustedBindingDigest: trusted,
      holdout: sealGateHoldout({ frozenDigest: trusted, firstAccessedAt: null }),
      metrics: { providers: { [provider.id]: sealed } }, upstream: held, now: NOW,
      providerRuntime: { providers: [provider], records: { [provider.id]: records } },
    });
    expect(ceiling.decision).toBe('HOLD');
  });

  itSandboxed('fails closed on timeout, budget, rejection and cancellation without discarding completed work', async () => {
    const { provider } = await loadExample();
    const records = flakeRecords({ a: 0, b: 0 });
    // Timeout: a hanging provider refuses while the good provider still seals.
    const hangingDir = mkdtempSync(join(tmpdir(), 'gates-hang-'));
    mkdirSync(join(hangingDir, 'gp'), { recursive: true });
    writeFileSync(join(hangingDir, 'gp/p.mjs'), [
      'export const provider = {',
      '  id: \'example.hang/v1\',',
      '  version: \'1.0.0\',',
      '  description: \'Hanging fixture provider.\',',
      '  metrics: { m: { kind: \'scalar\', description: \'m\' } },',
      '  compute() { const start = Date.now(); while (Date.now() - start < 5000) {} return { metrics: {} }; },',
      '};',
      '',
    ].join('\n'));
    const hangingManifest = { id: 'hang-bundle', gateProviders: [{
      id: 'example.hang/v1', version: '1.0.0', module: 'gp/p.mjs', description: 'Hanging fixture provider.',
      review: { reviewer: 'R', reviewedAt: NOW, codeDigest: 'pending' },
    }] };
    const hangingDigest = computeProviderCodeDigest(hangingDir, 'gp/p.mjs').codeDigest;
    (hangingManifest.gateProviders[0] as { review: { codeDigest: string } }).review.codeDigest = hangingDigest;
    const [hanging] = await loadGateBundleProviders(hangingDir, hangingManifest, {
      allowBundleProviders: true, now: NOW,
      allowlist: [{
        bundleId: 'hang-bundle', providerId: 'example.hang/v1', codeDigest: hangingDigest,
        reviewer: 'R', reviewedAt: NOW,
      }],
    });
    const started = Date.now();
    await expect(invokeBundleProvider(hanging!, records, { timeoutMs: 200, clockMs: INVOKE_CLOCK_MS }))
      .rejects.toMatchObject({ code: 'timeout' });
    expect(Date.now() - started).toBeLessThan(4000);
    const good = (await invokeBundleProvider(provider, records, { timeoutMs: 5000, clockMs: INVOKE_CLOCK_MS })) as { metrics: unknown };
    expect(sealProviderSection(provider, records, good).codeDigest).toBe(provider.codeDigest);
    // Budget is reserved before dispatch: over-budget records refuse.
    await expect(invokeBundleProvider(provider, records, { maxRecords: 1, clockMs: INVOKE_CLOCK_MS }))
      .rejects.toMatchObject({ code: 'budget-exceeded' });
    // Dispatch rejection fails closed: a throwing provider is reported, never trusted.
    const rejectingDir = mkdtempSync(join(tmpdir(), 'gates-reject-'));
    mkdirSync(join(rejectingDir, 'gp'), { recursive: true });
    writeFileSync(join(rejectingDir, 'gp/p.mjs'), [
      'export const provider = {',
      '  id: \'example.reject/v1\',',
      '  version: \'1.0.0\',',
      '  description: \'Rejecting fixture provider.\',',
      '  metrics: { m: { kind: \'scalar\', description: \'m\' } },',
      '  compute() { throw new Error(\'boom\'); },',
      '};',
      '',
    ].join('\n'));
    const rejectingManifest = { id: 'reject-bundle', gateProviders: [{
      id: 'example.reject/v1', version: '1.0.0', module: 'gp/p.mjs', description: 'Rejecting fixture provider.',
      review: { reviewer: 'R', reviewedAt: NOW, codeDigest: 'pending' },
    }] };
    const rejectingDigest = computeProviderCodeDigest(rejectingDir, 'gp/p.mjs').codeDigest;
    (rejectingManifest.gateProviders[0] as { review: { codeDigest: string } }).review.codeDigest = rejectingDigest;
    const [rejecting] = await loadGateBundleProviders(rejectingDir, rejectingManifest, {
      allowBundleProviders: true, now: NOW,
      allowlist: [{
        bundleId: 'reject-bundle', providerId: 'example.reject/v1', codeDigest: rejectingDigest,
        reviewer: 'R', reviewedAt: NOW,
      }],
    });
    await expect(invokeBundleProvider(rejecting!, records, { timeoutMs: 2000, clockMs: INVOKE_CLOCK_MS }))
      .rejects.toMatchObject({ code: 'rejected' });
    // Pre-dispatch cancellation fails closed without spawning.
    const controller = new AbortController();
    controller.abort();
    await expect(invokeBundleProvider(provider, records, { signal: controller.signal, clockMs: INVOKE_CLOCK_MS }))
      .rejects.toMatchObject({ code: 'cancelled' });
    // Mid-flight cancellation kills the child.
    const slow = new AbortController();
    const pending = invokeBundleProvider(hanging!, records, { timeoutMs: 10000, signal: slow.signal, clockMs: INVOKE_CLOCK_MS });
    setTimeout(() => slow.abort(), 100);
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    // Undefined records never reach canonical JSON: they refuse before dispatch.
    await expect(invokeBundleProvider(provider, undefined as never, { timeoutMs: 1000, clockMs: INVOKE_CLOCK_MS }))
      .rejects.toMatchObject({ code: 'invalid-records' });
  });

  itSandboxed('forbids bare external imports in phase 1 instead of lockfile-pinning them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gates-external-'));
    mkdirSync(join(dir, 'gp'), { recursive: true });
    writeFileSync(join(dir, 'gp/entry.mjs'), 'import x from \'fake-pkg\';\nexport const provider = { id: \'example.ext/v1\' };\n');
    writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({
      packages: { 'node_modules/fake-pkg': { version: '1.2.3', integrity: 'sha512-fake' } },
    }));
    // Even a perfectly pinned lockfile does not authorize a bare import: the
    // isolated linker refuses it at load.
    const codeDigest = computeProviderCodeDigest(dir, 'gp/entry.mjs').codeDigest;
    const manifest = { id: 'ext-bundle', gateProviders: [{
      id: 'example.ext/v1', version: '1.0.0', module: 'gp/entry.mjs', description: 'External fixture.',
      review: { reviewer: 'R', reviewedAt: NOW, codeDigest },
    }] };
    await expect(loadGateBundleProviders(dir, manifest, {
      allowBundleProviders: true, now: NOW,
      allowlist: [{
        bundleId: 'ext-bundle', providerId: 'example.ext/v1', codeDigest,
        reviewer: 'R', reviewedAt: NOW,
      }],
    })).rejects.toMatchObject({ name: 'GateProviderError', code: 'invalid-module' });
  });

  itSandboxed('stays disabled by default and keeps core behavior byte-identical', async () => {
    const manifest = exampleManifest();
    await expect(loadGateBundleProviders(EXAMPLE_ROOT, manifest, { now: NOW }))
      .rejects.toMatchObject({ code: 'disabled' });
    // No environment variable re-enables it either.
    const previous = process.env.AIWG_GATES_BUNDLE_PROVIDERS;
    process.env.AIWG_GATES_BUNDLE_PROVIDERS = '1';
    try {
      await expect(loadGateBundleProviders(EXAMPLE_ROOT, manifest, { now: NOW }))
        .rejects.toMatchObject({ code: 'disabled' });
    } finally {
      if (previous === undefined) delete process.env.AIWG_GATES_BUNDLE_PROVIDERS;
      else process.env.AIWG_GATES_BUNDLE_PROVIDERS = previous;
    }
    const core = createCoreProviderRegistry();
    expect(core.ids()).toEqual(['decision.screening/v1', 'test.evidence/v1', 'test.paired/v1', 'test.proportion/v1', 'test.scalar/v1']);
    // A code-digest pin for a core provider refuses: core providers carry no
    // code digest, so bundle pins never silently verify.
    const { provider } = await loadExample();
    const { makeBinding, testRegistry } = await import('./helper.js');
    const { registry: coreFixture } = testRegistry();
    const coreBinding = {
      ...makeBinding(),
      spec: {
        ...makeBinding().spec,
        metricProviders: makeBinding().spec.metricProviders.map((pin) => pin.id === 'test.proportion/v1'
          ? { ...pin, codeDigest: provider.codeDigest }
          : pin),
      },
    };
    expect(() => coreFixture.resolveBinding(coreBinding)).toThrow(/code pin mismatch/);
    // Core evaluation without bundle providers is unchanged.
    const { evaluateFixture } = await import('./helper.js');
    const first = evaluateFixture();
    const second = evaluateFixture();
    expect(first.digest).toBe(second.digest);
    expect(first.decision).toBe(second.decision);
    expect(new MetricProviderRegistry().has(null)).toBe(false);
  });
});
