import { mkdtempSync } from '../../helpers/temp-dir.js';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { itSandboxed } from './sandbox-helper.js';
import { artifactDigest } from '../../../src/decision/validate.js';
import { evaluateGates, sealGateHoldout, sealUpstream } from '../../../src/gates/evaluate.js';
import { validateGatesConfig } from '../../../src/gates/floors.js';
import type { ProviderAllowlistEntry } from '../../../src/gates/floors.js';
import {
  GateProviderError, computeProviderCodeDigest, invokeBundleProvider, loadGateBundleProviders,
  providerBindingPin, sealProviderSection,
} from '../../../src/gates/providers/loader.js';
import { GateRegistry } from '../../../src/gates/registry.js';
import { createCoreProviderRegistry } from '../../../src/gates/providers/index.js';
import type { GateBinding, GatePack, Sha256Digest } from '../../../src/gates/types.js';
import {
  NOW, REGISTERED_AT, FROZEN_AT, cleanIntegrity, makeBindingForPack, makeUpstream,
  passingMetrics, projectPack, testHoldout, testRegistry, trustedDigest,
} from './helper.js';

/** invokeBundleProvider requires an explicit frozen clock (C5). */
const INVOKE_CLOCK_MS = Date.parse(NOW);

const EXAMPLE_ROOT = 'test/fixtures/gates-example-extension';
// Reviewed bytes of the example provider (example.mjs + helper.mjs). The
// snapshot scheme preserves this digest: a byte move still refuses old pins.
const EXPECTED_CODE_DIGEST = 'sha256:76cd4dcb9af82fc27461a845254401bd66e96f8f5198cbb57c28c1f99511a590';

const box = (prefix: string): string => mkdtempSync(join(tmpdir(), `aiwg-gates-iso-${prefix}-`));

const PROVIDER_ID = 'test.iso/v1';
const BUNDLE_ID = 'test-bundle';

const honestSource = (computeBody: string, extra = ''): string =>
  `export const provider = {\n  id: '${PROVIDER_ID}',\n  version: '1.0.0',\n  description: 'Isolation fixture provider.',\n  metrics: { m: { kind: 'scalar', description: 'm' } },\n  compute(records) {\n${computeBody}\n  },\n};\n${extra}`;

const SCALAR_RESULT = `{ metrics: { m: { bySlice: {}, pooled: { n: records.length, value: 1 } } } };`;

/** Writes a bundle dir with one provider module; returns the dir and manifest. */
function writeBundle(entrySource: string, extraFiles: Record<string, string> = {}): {
  dir: string; manifest: { id: string; gateProviders: unknown };
} {
  const dir = box('bundle');
  mkdirSync(join(dir, 'gp'), { recursive: true });
  writeFileSync(join(dir, 'gp/p.mjs'), `${entrySource}\n`);
  for (const [name, content] of Object.entries(extraFiles)) {
    writeFileSync(join(dir, 'gp', name), `${content}\n`);
  }
  const review = { reviewer: 'Isolation Reviewer', reviewedAt: NOW, codeDigest: 'pending' };
  const manifest = {
    id: BUNDLE_ID,
    gateProviders: [{
      id: PROVIDER_ID, version: '1.0.0', module: 'gp/p.mjs',
      description: 'Isolation fixture provider.', review,
    }],
  };
  return { dir, manifest };
}

/** Re-pins the manifest review to the freshly computed digest. */
function pinManifest(output: { dir: string; manifest: { id: string; gateProviders: unknown } }): void {
  const digest = computeProviderCodeDigest(output.dir, 'gp/p.mjs').codeDigest;
  const entry = (output.manifest.gateProviders as Array<{ review: { codeDigest: string } }>)[0]!;
  entry.review.codeDigest = digest;
}

function allowlistFor(codeDigest: string, overrides?: Partial<ProviderAllowlistEntry>): ProviderAllowlistEntry[] {
  return [{
    bundleId: BUNDLE_ID, providerId: PROVIDER_ID, codeDigest: codeDigest as Sha256Digest,
    reviewer: 'Isolation Reviewer', reviewedAt: NOW, ...overrides,
  }];
}

async function loadIsolated(output: { dir: string; manifest: { id: string; gateProviders: unknown } },
  allowlist?: ProviderAllowlistEntry[]) {
  const codeDigest = computeProviderCodeDigest(output.dir, 'gp/p.mjs').codeDigest;
  const loaded = await loadGateBundleProviders(output.dir, output.manifest, {
    allowBundleProviders: true, now: NOW, allowlist: allowlist ?? allowlistFor(codeDigest),
  });
  return { provider: loaded[0]!, codeDigest };
}

describe('P1: providers run isolated from the parent process', () => {
  it('covers statically imported helpers in the code digest (no helper regression)', () => {
    const output = writeBundle(
      honestSource(`    const h = await import('./h.mjs');\n    return h.run(records);`).replace('compute(records) {', 'async compute(records) {'),
      { 'h.mjs': 'export const run = (records) => ({ metrics: {} });' },
    );
    const before = computeProviderCodeDigest(output.dir, 'gp/p.mjs');
    expect(before.files.map(file => file.path).sort()).toEqual(['gp/h.mjs', 'gp/p.mjs']);
    writeFileSync(join(output.dir, 'gp/h.mjs'), 'export const run = () => ({ metrics: { m: 999 } });\n');
    const after = computeProviderCodeDigest(output.dir, 'gp/p.mjs');
    // A helper byte change moves the digest (c/probe.mts tpl-digest-stable).
    expect(after.codeDigest).not.toBe(before.codeDigest);
  });

  it('refuses template-literal dynamic imports at load (c/probe.mts tpl-load+run)', async () => {
    const output = writeBundle(
      honestSource(`    const h = await import(\`./h.mjs\`);\n    return h.run(records);`).replace('compute(records) {', 'async compute(records) {'),
      { 'h.mjs': 'export const run = () => ({ metrics: {} });' },
    );
    pinManifest(output);
    await expect(loadIsolated(output)).rejects.toMatchObject({ name: 'GateProviderError' });
  });

  it('refuses computed-specifier filesystem smuggling without touching the parent fs (c/probe.mts computed-fs)', async () => {
    const marker = join(box('fsx'), 'pwned');
    const output = writeBundle(
      'const n = \'node:\' + \'fs\';\nconst fs = await import(n);\n'
      + `fs.readFileSync('/etc/hostname', 'utf8');\n`
      + `try { fs.writeFileSync('${marker}', 'x'); } catch {}\n`
      + honestSource(`    return ${SCALAR_RESULT}`),
    );
    pinManifest(output);
    await expect(loadIsolated(output)).rejects.toMatchObject({ name: 'GateProviderError' });
    expect((): string => readFileSync(marker, 'utf8')).toThrow();
  });

  it('refuses createRequire/getBuiltinModule denylist bypasses (c/probe.mts gbm)', async () => {
    const output = writeBundle(
      'import { createRequire } from \'node:module\';\n'
      + 'const req = createRequire(import.meta.url);\n'
      + 'const kind = typeof req(\'child_process\').execSync;\n'
      + `const net = typeof process.getBuiltinModule('net').connect;\n`
      + honestSource(`    return ${SCALAR_RESULT}`),
    );
    pinManifest(output);
    await expect(loadIsolated(output)).rejects.toMatchObject({ name: 'GateProviderError' });
  });

  itSandboxed('kills a synchronous infinite loop by wall-clock timeout and keeps serving (c/probe.mts loop)', async () => {
    const output = writeBundle(honestSource(
      '    const start = Date.now();\n    while (Date.now() - start < 3000) {}\n    return { metrics: {} };'));
    pinManifest(output);
    const { provider } = await loadIsolated(output);
    const started = Date.now();
    await expect(invokeBundleProvider(provider, [], { timeoutMs: 300, clockMs: INVOKE_CLOCK_MS }))
      .rejects.toMatchObject({ name: 'GateProviderError', code: 'timeout' });
    // The parent event loop was never wedged: the kill landed near the deadline.
    expect(Date.now() - started).toBeLessThan(2500);
    // The runner keeps serving after the kill: a fresh honest provider invokes.
    const honest = writeBundle(honestSource(`    return ${SCALAR_RESULT}`));
    pinManifest(honest);
    const { provider: goodProvider } = await loadIsolated(honest);
    const good = await invokeBundleProvider(goodProvider, [{ slice: 'a', failed: false }], { timeoutMs: 5000, clockMs: INVOKE_CLOCK_MS });
    expect((good as { metrics: unknown }).metrics).toBeDefined();
  });

  itSandboxed('freezes the clock and seeds randomness deterministically', async () => {
    const clocked = writeBundle(honestSource(
      '    return { metrics: { m: { bySlice: {}, pooled: { n: 1, value: Date.now() } } } };'));
    pinManifest(clocked);
    const { provider: clockProvider } = await loadIsolated(clocked);
    const first = await invokeBundleProvider(clockProvider, [], { timeoutMs: 2000, clockMs: 1700000000000 });
    const second = await invokeBundleProvider(clockProvider, [], { timeoutMs: 2000, clockMs: 1700000001000 });
    const value = (result: unknown): number =>
      ((result as { metrics: { m: { pooled: { value: number } } } }).metrics.m.pooled.value);
    expect(value(first)).toBe(1700000000000);
    expect(value(second)).toBe(1700000001000);

    const seeded = writeBundle(honestSource(
      '    return { metrics: { m: { bySlice: {}, pooled: { n: 1, value: random() } } } };'));
    pinManifest(seeded);
    const { provider: randomProvider } = await loadIsolated(seeded);
    const a = await invokeBundleProvider(randomProvider, [{ x: 1 }], { timeoutMs: 2000, clockMs: INVOKE_CLOCK_MS });
    const b = await invokeBundleProvider(randomProvider, [{ x: 1 }], { timeoutMs: 2000, clockMs: INVOKE_CLOCK_MS });
    expect(value(a)).toBe(value(b));

    const native = writeBundle(honestSource(
      '    return { metrics: { m: { bySlice: {}, pooled: { n: 1, value: Math.random() } } } };'));
    pinManifest(native);
    const { provider: nativeProvider } = await loadIsolated(native);
    await expect(invokeBundleProvider(nativeProvider, [], { timeoutMs: 2000, clockMs: INVOKE_CLOCK_MS }))
      .rejects.toMatchObject({ name: 'GateProviderError', code: 'rejected' });
  });

  itSandboxed('denies process, require, timers and network to provider code', async () => {
    // require() never reaches the child linker: the load-time scan refuses it.
    const requiring = writeBundle(honestSource('    return require(\'fs\');'));
    pinManifest(requiring);
    await expect(loadIsolated(requiring)).rejects.toMatchObject({ name: 'GateProviderError' });
    // process, timers and fetch are absent from the context: invoking rejects.
    for (const [name, body] of [
      ['process', '    process.exit(1);\n    return { metrics: {} };'],
      ['timer', '    return new Promise(resolve => setTimeout(() => resolve({ metrics: {} }), 5));'],
      ['fetch', '    return fetch(\'http://127.0.0.1/\');'],
    ] as const) {
      const output = writeBundle(honestSource(body));
      pinManifest(output);
      const { provider } = await loadIsolated(output);
      await expect(invokeBundleProvider(provider, [], { timeoutMs: 2000, clockMs: INVOKE_CLOCK_MS }), name)
        .rejects.toMatchObject({ name: 'GateProviderError', code: 'rejected' });
    }
  });

  itSandboxed('caps isolated-run output: an oversized result rejects instead of flooding the parent', async () => {
    const output = writeBundle(honestSource(
      '    return { metrics: { m: { bySlice: {}, pooled: { n: 1, value: "x".repeat(2 * 1024 * 1024) } } } };'));
    pinManifest(output);
    const { provider } = await loadIsolated(output);
    await expect(invokeBundleProvider(provider, [], { timeoutMs: 5000, clockMs: INVOKE_CLOCK_MS }))
      .rejects.toMatchObject({ name: 'GateProviderError', code: 'rejected' });
  });

  itSandboxed('exposes only the documented minimal surface (fails if a future Node adds vm globals)', async () => {
    const absent = ['fetch', 'process', 'require', 'setTimeout', 'queueMicrotask', 'performance', 'crypto',
      'structuredClone', 'URL', 'navigator', 'Worker', 'eval', 'Function', 'WebAssembly', 'Proxy', 'Reflect',
      'console', 'Intl', 'Atomics', 'SharedArrayBuffer', 'FinalizationRegistry', 'WeakRef'];
    const output = writeBundle(honestSource(
      `    const out = {}; for (const k of ${JSON.stringify(absent)}) out[k] = typeof globalThis[k];\n`
      + '    out.mathRandom = typeof Math.random;\n'
      + '    out.present = [typeof Math, typeof JSON, typeof Date, typeof clock, typeof random].join(",");\n'
      + '    return { metrics: { m: { bySlice: {}, pooled: { n: 1, value: 1 } } }, surface: out };'));
    pinManifest(output);
    const { provider } = await loadIsolated(output);
    const result = await invokeBundleProvider(provider, [], { timeoutMs: 5000, clockMs: INVOKE_CLOCK_MS }) as {
      surface: Record<string, string>;
    };
    for (const name of absent) expect(result.surface[name], name).toBe('undefined');
    expect(result.surface.mathRandom).toBe('undefined');
    expect(result.surface.present).toBe('object,object,function,number,function');
  });

  itSandboxed('contains module top-level effects in the child: the parent global is untouched', async () => {
    const output = writeBundle(
      'globalThis.__aiwgIsoTouched = true;\n'
      + honestSource('    return { metrics: { m: { bySlice: {}, pooled: { n: 1, value: globalThis.__aiwgIsoTouched === true ? 1 : 0 } } } };'));
    pinManifest(output);
    const { provider } = await loadIsolated(output);
    const result = await invokeBundleProvider(provider, [], { timeoutMs: 2000, clockMs: INVOKE_CLOCK_MS }) as {
      metrics: { m: { pooled: { value: number } } };
    };
    expect(result.metrics.m.pooled.value).toBe(1);
    expect((globalThis as Record<string, unknown>).__aiwgIsoTouched).toBeUndefined();
  });
});

describe('P2: provider code is pinned as a snapshot directory', () => {
  it('moves the digest when an unimported file changes (no spread-copy evasion)', () => {
    const output = writeBundle(honestSource(`    return ${SCALAR_RESULT}`),
      { 'dead.mjs': 'export const dead = 1;' });
    const before = computeProviderCodeDigest(output.dir, 'gp/p.mjs').codeDigest;
    writeFileSync(join(output.dir, 'gp/dead.mjs'), 'export const dead = 2;\n');
    expect(computeProviderCodeDigest(output.dir, 'gp/p.mjs').codeDigest).not.toBe(before);
  });

  it('refuses CommonJS require chains that older scans missed (c/probe.mts cjs)', async () => {
    const dir = box('cjs');
    mkdirSync(join(dir, 'gp'), { recursive: true });
    writeFileSync(join(dir, 'gp/p.mjs'), 'import c from \'./c.cjs\';\n'
      + honestSource('    return { metrics: {} };'));
    writeFileSync(join(dir, 'gp/c.cjs'), 'const o = require(\'./o.cjs\');\nmodule.exports = { v: o.v };\n');
    writeFileSync(join(dir, 'gp/o.cjs'), 'module.exports = { v: 7 };\n');
    const manifest = {
      id: BUNDLE_ID,
      gateProviders: [{
        id: PROVIDER_ID, version: '1.0.0', module: 'gp/p.mjs',
        description: 'CJS fixture.', review: { reviewer: 'R', reviewedAt: NOW, codeDigest: 'pending' },
      }],
    };
    // The digest covers only what can load (.mjs); the .cjs chain is dead
    // weight in the source dir, never copied, never loaded.
    expect(computeProviderCodeDigest(dir, 'gp/p.mjs').files.map(file => file.path)).toEqual(['gp/p.mjs']);
    const entry = (manifest.gateProviders as Array<{ review: { codeDigest: string } }>)[0]!;
    entry.review.codeDigest = computeProviderCodeDigest(dir, 'gp/p.mjs').codeDigest;
    // Loading refuses: the relative .cjs import (and its require chain) can
    // never resolve through the snapshot linker.
    await expect(loadGateBundleProviders(dir, manifest, {
      allowBundleProviders: true, now: NOW,
      allowlist: allowlistFor(entry.review.codeDigest),
    })).rejects.toMatchObject({ name: 'GateProviderError' });
  });

  itSandboxed('forbids bare external imports in phase 1 instead of lockfile-pinning them (c/probe.mts ext)', async () => {
    const output = writeBundle('import { v } from \'leftpad\';\n'
      + honestSource('    return { metrics: {} };'));
    // Even a perfectly pinned lockfile does not authorize a bare import.
    writeFileSync(join(output.dir, 'package-lock.json'), JSON.stringify({
      packages: { 'node_modules/leftpad': { version: '1.2.3', integrity: 'sha512-fake' } },
    }));
    pinManifest(output);
    await expect(loadIsolated(output)).rejects.toMatchObject({ name: 'GateProviderError' });
    // The refusal names the forbidden bare import (not a missing pin).
    await loadGateBundleProviders(output.dir, output.manifest, {
      allowBundleProviders: true, now: NOW,
      allowlist: allowlistFor(computeProviderCodeDigest(output.dir, 'gp/p.mjs').codeDigest),
    }).then(
      () => { throw new Error('bare import loaded'); },
      (error: Error) => { expect(error.message).toMatch(/bare|external|forbidden/i); },
    );
  });

  it('refuses symlinks and non-regular files anywhere under the provider dir', () => {
    const output = writeBundle(honestSource(`    return ${SCALAR_RESULT}`));
    try {
      symlinkSync(join(output.dir, 'gp/p.mjs'), join(output.dir, 'gp/link.mjs'));
    } catch {
      return;
    }
    expect(() => computeProviderCodeDigest(output.dir, 'gp/p.mjs')).toThrow(/symlink/i);
  });

  itSandboxed('executes the snapshot bytes, not later source edits (no TOCTOU)', async () => {
    const output = writeBundle(honestSource(
      '    return { metrics: { m: { bySlice: {}, pooled: { n: 1, value: 7 } } } };'));
    pinManifest(output);
    const { provider, codeDigest } = await loadIsolated(output);
    // The pinned bytes live only in the loader's private in-memory record:
    // there is no snapshot directory on disk to swap.
    expect((provider as { snapshotDir?: unknown }).snapshotDir).toBeUndefined();
    writeFileSync(join(output.dir, 'gp/p.mjs'), honestSource(
      '    return { metrics: { m: { bySlice: {}, pooled: { n: 1, value: 999 } } } };'));
    expect(computeProviderCodeDigest(output.dir, 'gp/p.mjs').codeDigest).not.toBe(codeDigest);
    const result = await invokeBundleProvider(provider, [], { timeoutMs: 2000, clockMs: INVOKE_CLOCK_MS }) as {
      metrics: { m: { pooled: { value: number } } };
    };
    expect(result.metrics.m.pooled.value).toBe(7);
  });
});

describe('P3: the project config allowlist is the trust root', () => {
  it('refuses registration without a matching allowlist entry despite a valid in-bundle review', async () => {
    const output = writeBundle(honestSource(`    return ${SCALAR_RESULT}`));
    pinManifest(output);
    await expect(loadGateBundleProviders(output.dir, output.manifest, {
      allowBundleProviders: true, now: NOW, allowlist: [],
    })).rejects.toMatchObject({ name: 'GateProviderError', code: 'unregistered' });
  });

  it('refuses mismatched digests, bundles, providers and reviewers', async () => {
    const output = writeBundle(honestSource(`    return ${SCALAR_RESULT}`));
    pinManifest(output);
    const codeDigest = computeProviderCodeDigest(output.dir, 'gp/p.mjs').codeDigest;
    const zero = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
    for (const [name, list] of [
      ['digest', allowlistFor(zero)],
      ['bundle', allowlistFor(codeDigest, { bundleId: 'other-bundle' })],
      ['provider', allowlistFor(codeDigest, { providerId: 'other.scope/v9' })],
      ['reviewer', allowlistFor(codeDigest, { reviewer: 'Mallory' })],
      ['reviewedAt', allowlistFor(codeDigest, { reviewedAt: '2026-08-16T00:00:00.000Z' })],
    ] as const) {
      await expect(loadGateBundleProviders(output.dir, output.manifest, {
        allowBundleProviders: true, now: NOW, allowlist: list,
      }), name).rejects.toMatchObject({ name: 'GateProviderError' });
    }
  });

  it('validates the providers allowlist in validateGatesConfig', () => {
    const entry = {
      bundleId: BUNDLE_ID, providerId: PROVIDER_ID,
      codeDigest: `sha256:${'a'.repeat(64)}`, reviewer: 'R', reviewedAt: NOW,
    };
    expect(validateGatesConfig({ providers: [entry] })).toEqual([]);
    expect(validateGatesConfig({ providers: [] })).toEqual([]);
    expect(validateGatesConfig({ providers: [{ ...entry, codeDigest: 'nope' }] }).length).toBeGreaterThan(0);
    expect(validateGatesConfig({ providers: [{ ...entry, reviewer: '' }] }).length).toBeGreaterThan(0);
    expect(validateGatesConfig({ providers: [{ ...entry, reviewedAt: 'not-a-date' }] }).length).toBeGreaterThan(0);
    const { codeDigest: _dropped, ...noDigest } = entry;
    void _dropped;
    expect(validateGatesConfig({ providers: [noDigest] }).length).toBeGreaterThan(0);
    expect(validateGatesConfig({ providers: [entry, entry] }).length).toBeGreaterThan(0);
    expect(validateGatesConfig({ providers: [entry, { ...entry, extra: 1 }] }).length).toBeGreaterThan(0);
    expect(validateGatesConfig({ providers: 'yes' }).length).toBeGreaterThan(0);
    expect(validateGatesConfig({ providers: [entry] as never, unknownField: 1 } as never).length).toBeGreaterThan(0);
  });
});

describe('P4: metrics for provider-backed gates are reproduced, never asserted', () => {
  const PACK_ID = 'addon:gates-example/conformance-v1';

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

  async function loadExampleProvider() {
    const manifest = JSON.parse(readFileSync(join(EXAMPLE_ROOT, 'manifest.json'), 'utf8')) as {
      id: string; gateProviders: unknown;
    };
    const loaded = await loadGateBundleProviders(EXAMPLE_ROOT, manifest, {
      allowBundleProviders: true,
      now: NOW,
      allowlist: [{
        bundleId: 'gates-example', providerId: 'example.count/v1',
        codeDigest: EXPECTED_CODE_DIGEST, reviewer: 'Example Reviewer',
        reviewedAt: '2026-08-15T00:00:00.000Z',
      }],
    });
    return loaded[0]!;
  }

  function flakeRecords(failures: Record<string, number>): { slice: string; failed: boolean }[] {
    return Object.entries(failures).flatMap(([slice, events]) => [
      ...Array.from({ length: events }, () => ({ slice, failed: true })),
      ...Array.from({ length: 10 - events }, () => ({ slice, failed: false })),
    ]);
  }

  async function evaluateWithRuntime(callerFailures: Record<string, number>, runtimeFailures: Record<string, number>) {
    const provider = await loadExampleProvider();
    const providers = createCoreProviderRegistry();
    providers.register(provider as never);
    const registry = new GateRegistry(providers);
    registry.registerPack(bundlePack(), { namespace: 'addon', bundle: 'gates-example' });
    const runtimeRecords = flakeRecords(runtimeFailures);
    const binding = bundleBinding(provider, runtimeRecords);
    const trusted = artifactDigest(binding) as Sha256Digest;
    // Caller asserts metrics computed from DIFFERENT records (possibly forged).
    const callerRecords = flakeRecords(callerFailures);
    const callerSection = sealProviderSection(provider, callerRecords,
      await invokeBundleProvider(provider, callerRecords, { timeoutMs: 5000, clockMs: INVOKE_CLOCK_MS }) as { metrics: unknown });
    return evaluateGates({
      floors: 'none-explicit-opt-out',
      binding, registry, trustedBindingDigest: trusted,
      holdout: sealGateHoldout({ frozenDigest: trusted, firstAccessedAt: null }),
      metrics: { providers: { [provider.id]: callerSection } },
      upstream: sealUpstream(cleanIntegrity()), now: NOW,
      providerRuntime: { providers: [provider], records: { [provider.id]: runtimeRecords } },
    });
  }

  function bundleBinding(provider: {
    id: string; version: string; sourceDigest: Sha256Digest; codeDigest: Sha256Digest;
  }, records: readonly unknown[]): GateBinding {
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

  itSandboxed('uses the re-run output: forged alarming metrics do not roll back a clean re-run', async () => {
    const report = await evaluateWithRuntime({ a: 0, b: 5 }, { a: 0, b: 0 });
    expect(report.decision).toBe('PROMOTE');
  });

  itSandboxed('uses the re-run output: forged clean metrics do not hide a regressed re-run', async () => {
    const report = await evaluateWithRuntime({ a: 0, b: 0 }, { a: 0, b: 1 });
    expect(report.decision).toBe('ROLLBACK');
    expect(report.gateEvidence.find(entry => entry.gateId === 'flakes-cap')?.outcome).toBe('ROLLBACK');
  });

  itSandboxed('refuses when the runtime records do not match the pinned records digest', async () => {
    const provider = await loadExampleProvider();
    const providers = createCoreProviderRegistry();
    providers.register(provider as never);
    const registry = new GateRegistry(providers);
    registry.registerPack(bundlePack(), { namespace: 'addon', bundle: 'gates-example' });
    const binding = bundleBinding(provider, flakeRecords({ a: 0, b: 0 }));
    const trusted = artifactDigest(binding) as Sha256Digest;
    const callerSection = sealProviderSection(provider, flakeRecords({ a: 0, b: 0 }),
      await invokeBundleProvider(provider, flakeRecords({ a: 0, b: 0 }), { timeoutMs: 5000, clockMs: INVOKE_CLOCK_MS }) as { metrics: unknown });
    expect(() => evaluateGates({
      floors: 'none-explicit-opt-out',
      binding, registry, trustedBindingDigest: trusted,
      holdout: sealGateHoldout({ frozenDigest: trusted, firstAccessedAt: null }),
      metrics: { providers: { [provider.id]: callerSection } },
      upstream: sealUpstream(cleanIntegrity()), now: NOW,
      providerRuntime: { providers: [provider], records: { [provider.id]: flakeRecords({ a: 1, b: 0 }) } },
    })).toThrow(/records/);
  });

  itSandboxed('refuses provider-backed sections that cannot be reproduced (no runtime)', async () => {
    const provider = await loadExampleProvider();
    const providers = createCoreProviderRegistry();
    providers.register(provider as never);
    const registry = new GateRegistry(providers);
    registry.registerPack(bundlePack(), { namespace: 'addon', bundle: 'gates-example' });
    const records = flakeRecords({ a: 0, b: 0 });
    const binding = bundleBinding(provider, records);
    const trusted = artifactDigest(binding) as Sha256Digest;
    const callerSection = sealProviderSection(provider, records,
      await invokeBundleProvider(provider, records, { timeoutMs: 5000, clockMs: INVOKE_CLOCK_MS }) as { metrics: unknown });
    expect(() => evaluateGates({
      floors: 'none-explicit-opt-out',
      binding, registry, trustedBindingDigest: trusted,
      holdout: sealGateHoldout({ frozenDigest: trusted, firstAccessedAt: null }),
      metrics: { providers: { [provider.id]: callerSection } },
      upstream: sealUpstream(cleanIntegrity()), now: NOW,
    })).toThrow(/re-run|reproduced|runtime/);
  });

  itSandboxed('records the provider code and records digests in the report pins', async () => {
    const report = await evaluateWithRuntime({ a: 0, b: 0 }, { a: 0, b: 0 });
    const pin = report.metricProviders.find(entry => entry.id === 'example.count/v1');
    expect(pin?.codeDigest).toBe(EXPECTED_CODE_DIGEST);
    expect(pin?.recordsDigest).toBe(artifactDigest(flakeRecords({ a: 0, b: 0 })));
  });

  itSandboxed('requires records digests on bundle pins and forbids them on core pins', async () => {
    const provider = await loadExampleProvider();
    const providers = createCoreProviderRegistry();
    providers.register(provider as never);
    const registry = new GateRegistry(providers);
    registry.registerPack(bundlePack(), { namespace: 'addon', bundle: 'gates-example' });
    const records = flakeRecords({ a: 0, b: 0 });
    const binding = bundleBinding(provider, records);
    const { recordsDigest: _dropped, ...pinWithoutRecords } = binding.spec.metricProviders[0] as
      { recordsDigest: unknown } & Record<string, unknown>;
    void _dropped;
    expect(() => registry.resolveBinding({
      ...binding, spec: { ...binding.spec, metricProviders: [pinWithoutRecords] },
    } as GateBinding)).toThrow(/records/);
    const { registry: coreRegistry } = testRegistry();
    const { makeBinding } = await import('./helper.js');
    const coreBinding = makeBinding();
    const polluted = {
      ...coreBinding,
      spec: {
        ...coreBinding.spec,
        metricProviders: coreBinding.spec.metricProviders.map(entry => ({
          ...entry, recordsDigest: artifactDigest([]),
        })),
      },
    };
    expect(() => coreRegistry.resolveBinding(polluted as GateBinding)).toThrow(/records/);
  });
});

describe('P5: bundle providers need an explicit option and an allowlist entry', () => {
  it('no environment variable activates bundle loading', async () => {
    const manifest = JSON.parse(readFileSync(join(EXAMPLE_ROOT, 'manifest.json'), 'utf8')) as {
      id: string; gateProviders: unknown;
    };
    const previous = process.env.AIWG_GATES_BUNDLE_PROVIDERS;
    process.env.AIWG_GATES_BUNDLE_PROVIDERS = '1';
    try {
      await expect(loadGateBundleProviders(EXAMPLE_ROOT, manifest, { now: NOW }))
        .rejects.toMatchObject({ code: 'disabled' });
    } finally {
      if (previous === undefined) delete process.env.AIWG_GATES_BUNDLE_PROVIDERS;
      else process.env.AIWG_GATES_BUNDLE_PROVIDERS = previous;
    }
  });

  it('an explicit option without an allowlist entry still refuses (P3 trust root)', async () => {
    const output = writeBundle(honestSource(`    return ${SCALAR_RESULT}`));
    pinManifest(output);
    await expect(loadGateBundleProviders(output.dir, output.manifest, {
      allowBundleProviders: true, now: NOW,
    })).rejects.toMatchObject({ code: 'unregistered' });
  });

  it('a refused load registers nothing: the core registry stays core-only', async () => {
    const output = writeBundle(honestSource(`    return ${SCALAR_RESULT}`));
    pinManifest(output);
    const providers = createCoreProviderRegistry();
    await expect(loadGateBundleProviders(output.dir, output.manifest, {
      allowBundleProviders: true, now: NOW, allowlist: [],
    })).rejects.toMatchObject({ name: 'GateProviderError' });
    expect(providers.ids()).toEqual(['decision.screening/v1', 'test.evidence/v1', 'test.paired/v1', 'test.proportion/v1', 'test.scalar/v1']);
  });
});

describe('R1: a per-study ceiling requires the project-wide star default', () => {
  it('rejects per-study ceilings without a star default (b/probe2 B3)', () => {
    expect(validateGatesConfig({ ceilings: { 'study-a': 'HOLD' } }).length).toBeGreaterThan(0);
    expect(validateGatesConfig({ ceilings: { '*': 'HOLD' } })).toEqual([]);
    expect(validateGatesConfig({ ceilings: { '*': 'HOLD', 'study-a': 'ROLLBACK' } })).toEqual([]);
  });

  it('a renamed study cannot escape the star ceiling', () => {
    const { registry } = testRegistry();
    const binding = makeBindingForPack(projectPack(), {
      metadata: { id: 'study-a-v2', version: '1.0.0', description: 'Renamed study.' },
    });
    registry.registerPack(projectPack(), { namespace: 'project' });
    const floors = { floors: [], ceilings: { '*': 'HOLD' as const } };
    expect(() => registry.resolveBinding(binding, floors)).toThrow(/below the project ceiling/);
  });
});

describe('R3: gates validate binding resolves with the config floors', () => {
  const writeJson = (dir: string, name: string, value: unknown): string => {
    const file = join(dir, name);
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
    return file;
  };

  async function validateBinding(cwd: string, bindingPath: string, packPath: string) {
    const { gatesHandler } = await import('../../../src/cli/handlers/gates.js');
    return gatesHandler.execute({
      args: ['validate', 'binding', bindingPath, '--pack-dir', packPath],
      rawArgs: ['gates', 'validate', 'binding', bindingPath],
      cwd, frameworkRoot: process.cwd(),
    });
  }

  it('refuses a binding that loosens the configured floors, like evaluate does', async () => {
    const dir = box('r3');
    const pack = projectPack();
    const binding = makeBindingForPack(pack);
    const packPath = writeJson(dir, 'pack.gatepack.json', pack);
    const bindingPath = writeJson(dir, 'binding.json', binding);
    const strictFloor: GatePack = {
      apiVersion: 'gates.aiwg.io/v1alpha1', kind: 'GatePack',
      metadata: { id: 'project:r3-strict', version: '1.0.0', description: 'Strict support floor.' },
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
    writeJson(join(dir, '.aiwg'), 'aiwg.config', { version: '1', gates: { floors: [{ pack: strictFloor }] } });
    const result = await validateBinding(dir, bindingPath, packPath);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.message ?? '{}')).toMatchObject({ valid: false });
    expect(result.message).toMatch(/project floor/);
  });

  it('accepts the same binding without configured floors (default floor still satisfied)', async () => {
    const dir = box('r3');
    const pack = projectPack();
    const binding = makeBindingForPack(pack);
    const packPath = writeJson(dir, 'pack.gatepack.json', pack);
    const bindingPath = writeJson(dir, 'binding.json', binding);
    const result = await validateBinding(dir, bindingPath, packPath);
    expect(result.exitCode, result.message).toBe(0);
    expect(JSON.parse(result.message ?? '{}')).toMatchObject({ valid: true, kind: 'binding' });
  });
});

describe('R4: pack-dir bundles cannot claim shipped or installed ids', () => {
  const writeJson = (dir: string, name: string, value: unknown): string => {
    const file = join(dir, name);
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
    return file;
  };

  const minimalPack = (id: string): GatePack => ({
    apiVersion: 'gates.aiwg.io/v1alpha1',
    kind: 'GatePack',
    metadata: { id, version: '1.0.0', description: 'R4 minimal pack.' },
    spec: {
      metrics: {},
      gates: [{
        id: 'g', kind: 'upstream-ceiling', description: 'ceiling',
        scope: { mode: 'all' }, direction: 'higher-is-stricter', onFail: 'HOLD',
      }],
    },
  });

  it('refuses a pack-dir manifest claiming the shipped decision-engine bundle (a/probe2 A8)', async () => {
    const { buildGatesRegistry } = await import('../../../src/gates/driver.js');
    const dir = box('r4');
    const bundleDir = join(dir, 'imp');
    mkdirSync(join(bundleDir, 'gate-packs'), { recursive: true });
    writeFileSync(join(bundleDir, 'manifest.json'), JSON.stringify({ id: 'decision-engine', type: 'addon' }));
    writeJson(join(bundleDir, 'gate-packs'), 'x.gatepack.yaml', minimalPack('addon:decision-engine/x'));
    expect(() => buildGatesRegistry({ cwd: dir, packDirs: [bundleDir] }))
      .toThrow(/shipped|installed|claim/i);
  });

  it('treats unverified pack-dir bundles as project-scoped (a/probe2 A1, A8)', async () => {
    const { buildGatesRegistry } = await import('../../../src/gates/driver.js');
    const dir = box('r4');
    const bundleDir = join(dir, 'bundle-mine');
    mkdirSync(join(bundleDir, 'gate-packs'), { recursive: true });
    writeFileSync(join(bundleDir, 'manifest.json'), JSON.stringify({ id: 'mine', type: 'addon' }));
    writeJson(join(bundleDir, 'gate-packs'), 'mine.gatepack.yaml', minimalPack('addon:mine/pack'));
    // An addon:-namespaced pack from an unverified --pack-dir is not an addon pack.
    expect(() => buildGatesRegistry({ cwd: dir, packDirs: [bundleDir] })).toThrow(/project|namespace/i);
    writeJson(join(bundleDir, 'gate-packs'), 'mine.gatepack.yaml', minimalPack('project:mine'));
    const { loaded } = buildGatesRegistry({ cwd: dir, packDirs: [bundleDir] });
    expect(loaded).toContain('project:mine');
  });

  it('refuses a symlinked gate-packs dir inside a pack-dir bundle', async () => {
    const { buildGatesRegistry } = await import('../../../src/gates/driver.js');
    const { mkdirSync, symlinkSync: linkSync } = await import('node:fs');
    const dir = box('r4');
    const realPacks = join(dir, 'real-packs');
    mkdirSync(realPacks, { recursive: true });
    writeJson(realPacks, 'evil.gatepack.yaml', minimalPack('project:evil'));
    const bundleDir = join(dir, 'bundle-linkpacks');
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(join(bundleDir, 'manifest.json'), JSON.stringify({ id: 'mine', type: 'addon' }));
    try {
      linkSync(realPacks, join(bundleDir, 'gate-packs'));
    } catch {
      return;
    }
    expect(() => buildGatesRegistry({ cwd: dir, packDirs: [bundleDir] })).toThrow(/symlink/i);
  });

  it('refuses a symlinked pack-dir bundle directory (a/probe2 A6)', async () => {
    const { buildGatesRegistry } = await import('../../../src/gates/driver.js');
    const dir = box('r4');
    const real = join(dir, 'real-bundle');
    mkdirSync(join(real, 'gate-packs'), { recursive: true });
    writeFileSync(join(real, 'manifest.json'), JSON.stringify({ id: 'mine', type: 'addon' }));
    writeJson(join(real, 'gate-packs'), 'mine.gatepack.yaml', minimalPack('project:mine'));
    const link = join(dir, 'bundlelink');
    try {
      symlinkSync(real, link);
    } catch {
      return;
    }
    expect(() => buildGatesRegistry({ cwd: dir, packDirs: [link] })).toThrow(/symlink/i);
  });
});

describe('R2: the report records the applied floors or an explicit opt-out', () => {
  it('records the floors digest of the applied project floors', async () => {
    const { evaluateFixture } = await import('./helper.js');
    const report = evaluateFixture();
    expect(report.floors).toMatchObject({ mode: 'applied' });
    const { resolveProjectFloors: resolve } = await import('../../../src/gates/floors.js');
    expect(report.floors).toMatchObject({ digest: artifactDigest(resolve({})) });
  });

  it('records an explicit opt-out marker when floors are explicitly opted out', async () => {
    const { registry } = testRegistry();
    const binding = makeBindingForPack(projectPack());
    registry.registerPack(projectPack(), { namespace: 'project' });
    const report = evaluateGates({
      binding, registry, trustedBindingDigest: trustedDigest(binding),
      holdout: testHoldout(binding), metrics: passingMetrics(),
      upstream: makeUpstream('promote'), now: NOW,
      floors: 'none-explicit-opt-out',
    });
    expect(report.floors).toMatchObject({ mode: 'opt-out' });
  });

  it('schema and re-derivation distinguish applied floors from opt-out', async () => {
    const { validateGateReport } = await import('../../../src/gates/report.js');
    const { validateGateDocument } = await import('../../../src/gates/schema.js');
    const { evaluateFixture, makeBinding } = await import('./helper.js');
    const { resolveProjectFloors: resolve } = await import('../../../src/gates/floors.js');
    const report = evaluateFixture();
    const { floors: _dropped, ...withoutFloors } = report;
    void _dropped;
    expect(() => validateGateDocument(withoutFloors)).toThrow();
    // Re-derivation with different floors must not validate: the reported
    // floors digest no longer matches the evaluation input.
    const binding = makeBinding();
    const validation = validateGateReport(report, {
      binding, registry: testRegistry().registry,
      trustedBindingDigest: trustedDigest(binding),
      holdout: testHoldout(binding),
      metrics: passingMetrics(), upstream: makeUpstream('promote'), now: NOW,
      floors: resolve({ ceilings: { '*': 'HOLD' } }),
    });
    expect(validation.valid).toBe(false);
    expect(validation.reasons.join(';')).toMatch(/floors|reevaluation/);
  });
});
