import { mkdtempSync } from '../../helpers/temp-dir.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { artifactDigest } from '../../../src/decision/validate.js';
import { evaluateGates, sealGateHoldout, sealUpstream } from '../../../src/gates/evaluate.js';
import { resolveProjectFloors, type ProjectFloors } from '../../../src/gates/floors.js';
import * as loader from '../../../src/gates/providers/loader.js';
import { MetricProviderRegistry } from '../../../src/gates/providers/registry.js';
import { createCoreProviderRegistry } from '../../../src/gates/providers/index.js';
import { GateRegistry } from '../../../src/gates/registry.js';
import type { GateBinding, GatePack, Sha256Digest } from '../../../src/gates/types.js';
import { SANDBOX_READY, describeSandboxed } from './sandbox-helper.js';
import { FROZEN_AT, NOW, REGISTERED_AT, cleanIntegrity, makeBinding, testRegistry } from './helper.js';

/**
 * Round-3 regression tests for the isolated provider runner (#2831). Ported
 * from the reviewer probes (review-scratch/gates-p1b/d: pst, esc, dyn, esc2,
 * forge, probe-c snapshot swap). Each case escaped, forged or raced on
 * 139cf558e and must be contained now.
 */

const { GateProviderError, computeProviderCodeDigest, invokeBundleProvider, loadGateBundleProviders,
  providerBindingPin, sealProviderSection, snapshotProviderDir } = loader;

// The isolation boundary is bubblewrap. Without a usable bwrap the provider
// runner refuses (fail closed); the behavioural cases then skip VISIBLY.
const sandboxed = describeSandboxed;

const PROVIDER_ID = 'test.sandbox/v1';
const BUNDLE_ID = 'sandbox-bundle';
const CLOCK_MS = Date.parse(NOW);
const box = (prefix: string): string => mkdtempSync(join(tmpdir(), `aiwg-gates-sbx-${prefix}-`));

type Bundle = { dir: string; manifest: { id: string; gateProviders: unknown } };

function writeBundle(entrySource: string, extra: Record<string, string> = {}): Bundle {
  const dir = box('bundle');
  mkdirSync(join(dir, 'gp'), { recursive: true });
  writeFileSync(join(dir, 'gp/p.mjs'), `${entrySource}\n`);
  for (const [name, content] of Object.entries(extra)) writeFileSync(join(dir, 'gp', name), `${content}\n`);
  const codeDigest = computeProviderCodeDigest(dir, 'gp/p.mjs').codeDigest;
  return {
    dir,
    manifest: {
      id: BUNDLE_ID,
      gateProviders: [{
        id: PROVIDER_ID, version: '1.0.0', module: 'gp/p.mjs', description: 'Sandbox fixture provider.',
        review: { reviewer: 'Sandbox Reviewer', reviewedAt: NOW, codeDigest },
      }],
    },
  };
}

async function load(bundle: Bundle) {
  const codeDigest = computeProviderCodeDigest(bundle.dir, 'gp/p.mjs').codeDigest;
  const [provider] = await loadGateBundleProviders(bundle.dir, bundle.manifest, {
    allowBundleProviders: true, now: NOW,
    allowlist: [{ bundleId: BUNDLE_ID, providerId: PROVIDER_ID, codeDigest, reviewer: 'Sandbox Reviewer', reviewedAt: NOW }],
  });
  return provider!;
}

const providerSource = (computeBody: string, opts: { async?: boolean; prelude?: string } = {}): string =>
  `${opts.prelude ?? ''}\nexport const provider = {\n  id: '${PROVIDER_ID}',\n  version: '1.0.0',\n`
  + `  description: 'Sandbox fixture provider.',\n  metrics: { m: { kind: 'scalar', description: 'm' } },\n`
  + `  ${opts.async === true ? 'async ' : ''}compute(records) {\n${computeBody}\n  },\n};`;

const invoke = (provider: unknown, records: readonly unknown[] = [], extra: Record<string, unknown> = {}) =>
  invokeBundleProvider(provider as never, records, { timeoutMs: 8000, clockMs: CLOCK_MS, ...extra } as never);

const metricOf = (result: unknown): Record<string, unknown> =>
  (result as { metrics: { m: Record<string, unknown> } }).metrics.m;

/** Rejects or resolves; never lets an escape marker through. */
async function settle(promise: Promise<unknown>): Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

sandboxed(`C1a: code generation from strings is disabled in the provider context`, () => {
  it('blocks Function/eval/generator/async constructors reached from any intrinsic (probe pst)', async () => {
    const provider = await load(writeBundle(providerSource([
      '    const o = {};',
      '    const tries = {',
      '      objectCtor: () => ({}).constructor.constructor(\'return 1\')(),',
      '      arrowCtor: () => (() => 0).constructor(\'return 2\')(),',
      '      generatorCtor: () => (function* () {}).constructor(\'return 3\')().next().value,',
      '      asyncCtor: () => typeof (async function () {}).constructor(\'return 4\'),',
      '      globalCtor: () => globalThis.constructor.constructor(\'return 5\')(),',
      '      newFunction: () => new ((() => 0).constructor)(\'return 6\')(),',
      '      indirectEval: () => (0, ({}).constructor.constructor(\'return eval\'))(\'7\'),',
      '    };',
      '    for (const [k, f] of Object.entries(tries)) {',
      '      try { o[k] = \'ran:\' + String(f()); } catch (e) { o[k] = \'blocked:\' + String(e && e.name); }',
      '    }',
      '    return { metrics: { m: o } };',
    ].join('\n'))));
    const m = metricOf(await invoke(provider));
    for (const [name, value] of Object.entries(m)) {
      expect(value, name).toMatch(/^blocked:/);
    }
    expect(Object.keys(m)).toHaveLength(7);
  });
});

sandboxed(`C1b: only context-realm objects cross into provider code`, () => {
  it('hands thenable results context-realm resolvers that cannot generate code (probe esc)', async () => {
    const provider = await load(writeBundle(providerSource([
      '    return { then(res, rej) {',
      '      const out = {};',
      '      const F = res.constructor;',
      '      out.sameRealm = F === ({}).constructor.constructor;',
      '      try { out.generated = F(\'return 41\')() + 1; } catch (e) { out.generated = String(e && e.name); }',
      '      try { const p = F(\'return process\')(); out.pid = typeof p.pid; out.envKeys = Object.keys(p.env).length; }',
      '      catch (e) { out.err = String(e && e.name); }',
      '      res({ metrics: { m: out } });',
      '    } };',
    ].join('\n'))));
    const m = metricOf(await invoke(provider));
    expect(m.pid).toBeUndefined();
    expect(m.envKeys).toBeUndefined();
    expect(m.sameRealm).toBe(true);
    expect(m.generated).toBe('EvalError');
    expect(m.err).toBe('EvalError');
  });

  it('rejects dynamic import() with a context-realm error, even past the lexical scan (probe dyn)', async () => {
    // The regex literal `/'/` desynchronises the lexical scan (it reads a
    // string to the end of the line), so `import(` reaches the vm: the
    // runtime trap must answer with a context-realm value.
    const provider = await load(writeBundle(providerSource([
      '    const o = {};',
      '    const r = /\'/; const pending = import(\'node:fs\'); // \'',
      '    try { await pending; o.dyn = \'imported\'; } catch (e) {',
      '      o.contextRealm = e instanceof Error;',
      '      try { const p = e.constructor.constructor(\'return process\')(); o.escaped = typeof p.pid; }',
      '      catch (x) { o.contained = String(x && x.name); }',
      '    }',
      '    o.r = String(r);',
      '    return { metrics: { m: o } };',
    ].join('\n'), { async: true })));
    const m = metricOf(await invoke(provider));
    expect(m.dyn).toBeUndefined();
    expect(m.escaped).toBeUndefined();
    expect(m.contextRealm).toBe(true);
    expect(m.contained).toBe('EvalError');
  });

  it('leaves no path to the real clock (shim prototype and constructor links)', async () => {
    const provider = await load(writeBundle(providerSource([
      '    const o = {};',
      '    const viaProto = () => new (Object.getPrototypeOf(Date))().getTime();',
      '    const viaCtor = () => new (new Date(0).constructor)().getTime();',
      '    const viaSubclass = () => { class D extends Date {} return new D().getTime(); };',
      '    for (const [k, f] of Object.entries({ viaProto, viaCtor, viaSubclass })) {',
      '      try { o[k] = f(); } catch (e) { o[k] = \'blocked:\' + String(e && e.name); }',
      '    }',
      '    o.call = Date();',
      '    return { metrics: { m: o } };',
    ].join('\n'))));
    const m = metricOf(await invoke(provider));
    expect([CLOCK_MS, 'blocked:TypeError']).toContain(m.viaProto);
    expect(m.viaCtor).toBe(CLOCK_MS);
    expect(m.viaSubclass).toBe(CLOCK_MS);
    expect(Date.parse(m.call as string)).toBe(CLOCK_MS);
  });

  it('keeps intrinsics frozen so host awaits and stack hooks cannot be hijacked', async () => {
    const provider = await load(writeBundle(providerSource([
      '    const o = {};',
      '    const attempts = {',
      '      promiseThen: () => { Promise.prototype.then = function () {}; },',
      '      promiseCtor: () => { Object.defineProperty(Promise.prototype, \'constructor\', { get() { return 1; } }); },',
      '      prepareStackTrace: () => { Error.prepareStackTrace = () => \'x\'; },',
      '      objectProto: () => { Object.prototype.polluted = 1; },',
      '      functionProto: () => { Function.prototype.call = null; },',
      '    };',
      '    for (const [k, f] of Object.entries(attempts)) {',
      '      try { f(); o[k] = \'mutated\'; } catch (e) { o[k] = \'frozen\'; }',
      '    }',
      '    return { metrics: { m: o } };',
    ].join('\n'))));
    const m = metricOf(await invoke(provider));
    expect(m).toEqual({
      promiseThen: 'frozen', promiseCtor: 'frozen', prepareStackTrace: 'frozen', objectProto: 'frozen', functionProto: 'frozen',
    });
  });

  // The esc2/forge chain: a lexical-scan bypass reaches import(), the host
  // dynamic-import trap's Error leaks the host Function, and host `process`
  // reads secrets/network and forges the parent's stdout message.
  const ESCAPE_PRELUDE = [
    '    let p = null; const o = {};',
    '    const r = /\'/; const pending = import(\'x\'); // \'',
    '    try { await pending; } catch (e) { try { p = e.constructor.constructor(\'return process\')(); } catch (x) { o.contained = String(x && x.name); } }',
    '    o.r = String(r);',
  ];

  it('contains the import()->host Error->process escape chain (probe esc2)', async () => {
    const marker = join(box('esc2'), 'written');
    const provider = await load(writeBundle(providerSource([
      ...ESCAPE_PRELUDE,
      '    if (p !== null) {',
      '      o.envKeys = Object.keys(p.env).length;',
      '      o.realYear = new (p.constructor.constructor(\'return Date\')())().getFullYear();',
      `      try { p.getBuiltinModule('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); o.fsWrite = 'ALLOWED'; } catch (e) { o.fsWrite = e.code; }`,
      '      o.net = await new Promise(res => { const s = p.getBuiltinModule(\'net\').connect({ host: \'127.0.0.1\', port: 1 });',
      '        s.on(\'error\', e => res(\'reachable:\' + e.code)); s.on(\'connect\', () => res(\'connected\')); });',
      '    }',
      '    return { metrics: { m: o } };',
    ].join('\n'), { async: true })));
    const m = metricOf(await invoke(provider));
    expect(m.envKeys).toBeUndefined();
    expect(m.realYear).toBeUndefined();
    expect(m.net).toBeUndefined();
    expect(m.contained).toBe('EvalError');
    expect(existsSync(marker)).toBe(false);
  });

  it('rejects a provider that forges the parent message on stdout (probe forge)', async () => {
    const provider = await load(writeBundle(providerSource([
      ...ESCAPE_PRELUDE,
      '    if (p !== null) {',
      '      p.stdout.write(JSON.stringify({ ok: true, result: { metrics: { m: \'forged-via-ipc\' } } }) + \'\\n\', () => p.exit(0));',
      '      await new Promise(() => {});',
      '    }',
      '    throw new Error(\'escape contained\');',
    ].join('\n'), { async: true })));
    const outcome = await settle(invoke(provider));
    expect(outcome.ok).toBe(false);
    expect((outcome as { error: unknown }).error).toBeInstanceOf(GateProviderError);
  });
});

sandboxed(`C1c/C1d: OS-level sandbox (bubblewrap) with an empty environment`, () => {
  it('self-test proves an empty env, private namespaces, no host paths and no host network', async () => {
    const probe = (loader as unknown as {
      probeIsolationSandbox?: (options?: { connectPort?: number }) => Promise<Record<string, unknown>>;
    }).probeIsolationSandbox;
    expect(typeof probe).toBe('function');
    const server = createServer(socket => socket.destroy());
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const report = await probe!({ connectPort: port });
      expect(report.ok).toBe(true);
      expect(report.envKeys).toEqual([]);
      expect(report.sharedNamespaces).toEqual([]);
      expect(report.hostPathsVisible).toEqual([]);
      expect(report.connect).not.toBe('connected');
    } finally {
      server.close();
    }
  });

  it('launches bwrap with --unshare-all/--clearenv/--die-with-parent/--new-session and an empty spawn env', () => {
    const plan = (loader as unknown as {
      isolationLaunchPlan?: () => { command: string; args: string[]; env: Record<string, string> };
    }).isolationLaunchPlan;
    expect(typeof plan).toBe('function');
    const launch = plan!();
    expect(launch.command).toMatch(/bwrap$/);
    expect(launch.env).toEqual({});
    for (const flag of ['--unshare-all', '--clearenv', '--die-with-parent', '--new-session', '--disable-userns']) {
      expect(launch.args, flag).toContain(flag);
    }
    // Nothing writable from the host is bound in: only read-only binds, tmpfs, proc and dev.
    expect(launch.args).not.toContain('--bind');
    expect(launch.args).not.toContain('--dev-bind');
    const nodeIndex = launch.args.indexOf('--permission');
    expect(nodeIndex).toBeGreaterThan(0);
    expect(launch.args).toContain('--disallow-code-generation-from-strings');
    expect(launch.args.some(arg => arg.startsWith('--allow-fs'))).toBe(false);
    // Host paths appear only as read-only bind SOURCES (node binary, libraries);
    // no bind target exposes the home directory or the working tree.
    const sandboxArgs = launch.args.slice(0, launch.args.indexOf('--'));
    const targets: string[] = [];
    sandboxArgs.forEach((arg, index) => { if (arg === '--ro-bind') targets.push(sandboxArgs[index + 2]!); });
    expect(targets.length).toBeGreaterThan(1);
    for (const target of targets) {
      expect(target.startsWith(process.env.HOME ?? '/nonexistent-home'), target).toBe(false);
      expect(target.startsWith(process.cwd()), target).toBe(false);
    }
    const nodeArgs = launch.args.slice(launch.args.indexOf('--') + 1);
    expect(nodeArgs.join(' ')).not.toContain(process.env.HOME ?? '/nonexistent-home');
  });

  it('fails closed when bwrap is missing or fails its capability self-test (never unsandboxed)', async () => {
    const configure = (loader as unknown as {
      configureIsolationSandboxForTests?: (options: { bwrapPath?: string } | null) => void;
    }).configureIsolationSandboxForTests;
    expect(typeof configure).toBe('function');
    const bundle = writeBundle(providerSource('    return { metrics: { m: 1 } };'));
    const provider = await load(bundle);
    for (const fake of ['/nonexistent/bwrap', '/bin/true']) {
      configure!({ bwrapPath: fake });
      try {
        await expect(invoke(provider), fake).rejects.toMatchObject({ name: 'GateProviderError', code: 'sandbox-unavailable' });
        await expect(load(writeBundle(providerSource('    return { metrics: { m: 2 } };'))), fake)
          .rejects.toMatchObject({ code: 'sandbox-unavailable' });
      } finally {
        configure!(null);
      }
    }
    expect(metricOf(await invoke(provider)).toString()).toBeDefined();
  });
});

describe('C1d: hosts without a working sandbox refuse bundle providers', () => {
  // Runs only where the sandbox is unavailable (e.g. containers without
  // bwrap/user namespaces): the refusal itself is the guarantee there.
  it.runIf(!SANDBOX_READY)('refuses loading with sandbox-unavailable instead of running unsandboxed', async () => {
    const bundle = writeBundle(providerSource('    return { metrics: { m: 1 } };'));
    await expect(load(bundle)).rejects.toMatchObject({ name: 'GateProviderError', code: 'sandbox-unavailable' });
  });
});

sandboxed(`C2: the evaluator executes only its own digest-verified copy`, () => {
  const PACK_ID = 'addon:sandbox-bundle/count-v1';
  const countSource = (bias: number): string => providerSource([
    '    let failed = 0;',
    '    for (const row of records) if (row.failed) failed++;',
    `    return { metrics: { flakes: { bySlice: { a: { n: records.length, events: failed + ${bias} } },`,
    `      pooled: { n: records.length, events: failed + ${bias} } } } };`,
  ].join('\n')).replace('m: { kind: \'scalar\', description: \'m\' }', 'flakes: { kind: \'proportion\', description: \'f\' }');

  function pack(): GatePack {
    return {
      apiVersion: 'gates.aiwg.io/v1alpha1', kind: 'GatePack',
      metadata: { id: PACK_ID, version: '1.0.0', description: 'Sandbox count pack.' },
      spec: {
        metrics: { flakes: { provider: PROVIDER_ID, kind: 'proportion' } },
        gates: [{
          id: 'flakes-cap', kind: 'count-max', metric: { provider: PROVIDER_ID, name: 'flakes' },
          threshold: { op: 'lte', value: 0 }, scope: { mode: 'all' }, direction: 'lower-is-stricter', onFail: 'ROLLBACK',
        }],
      },
    };
  }

  it('ignores caller-swapped snapshot dirs and forged runtime providers (probe-c snapshot swap)', async () => {
    const honest = await load(writeBundle(countSource(0)));
    const evilBundle = writeBundle(countSource(1));
    const evilSnapshot = (snapshotProviderDir(evilBundle.dir, 'gp/p.mjs') as { snapshotDir?: string }).snapshotDir;
    // Swap the loaded snapshot's bytes in place where one exists on disk.
    const ownDir = (honest as { snapshotDir?: string }).snapshotDir;
    if (ownDir !== undefined) writeFileSync(join(ownDir, 'gp/p.mjs'), readFileSync(join(evilBundle.dir, 'gp/p.mjs')));
    const providers = createCoreProviderRegistry();
    providers.register(honest as never);
    const registry = new GateRegistry(providers);
    registry.registerPack(pack(), { namespace: 'addon', bundle: BUNDLE_ID });
    const records = [{ failed: false }, { failed: false }];
    const digest = artifactDigest(pack()) as Sha256Digest;
    const binding: GateBinding = {
      apiVersion: 'gates.aiwg.io/v1alpha1', kind: 'GateBinding',
      metadata: { id: 'sandbox/run-v1', version: '1.0.0', description: 'Sandbox binding.' },
      spec: {
        packs: [{ id: PACK_ID, version: '1.0.0', digest, resolvedDigest: digest }],
        parameters: {}, slices: ['a'], references: [],
        metricProviders: [providerBindingPin(honest, records)],
        ceiling: 'PROMOTE', registeredAt: REGISTERED_AT, frozenAt: FROZEN_AT,
      },
    };
    const trusted = artifactDigest(binding) as Sha256Digest;
    const forgedRuntime = { ...honest, snapshotDir: evilSnapshot ?? ownDir };
    const report = evaluateGates({
      floors: 'none-explicit-opt-out', binding, registry, trustedBindingDigest: trusted,
      holdout: sealGateHoldout({ frozenDigest: trusted, firstAccessedAt: null }),
      metrics: { providers: {} }, upstream: sealUpstream(cleanIntegrity()), now: NOW,
      providerRuntime: { providers: [forgedRuntime as never], records: { [PROVIDER_ID]: records } },
    });
    expect(report.decision).toBe('PROMOTE');
    expect(report.gateEvidence.find(entry => entry.gateId === 'flakes-cap')?.events).toBe(0);
  });

  it('refuses to invoke provider objects the loader did not issue', async () => {
    const honest = await load(writeBundle(providerSource('    return { metrics: { m: \'honest\' } };')));
    const evil = writeBundle(providerSource('    return { metrics: { m: \'evil\' } };'));
    const evilSnapshot = (snapshotProviderDir(evil.dir, 'gp/p.mjs') as { snapshotDir?: string }).snapshotDir;
    const copy = { ...honest, snapshotDir: evilSnapshot };
    await expect(invoke(copy)).rejects.toMatchObject({ name: 'GateProviderError', code: 'unregistered' });
    expect(metricOf(await invoke(honest))).toBe('honest');
  });
});

sandboxed(`C3: bundle providers register only with the loader-issued token`, () => {
  it('refuses direct registration of codeDigest providers that the loader did not issue', async () => {
    const honest = await load(writeBundle(providerSource('    return { metrics: { m: 1 } };')));
    const registry = new MetricProviderRegistry();
    expect(() => registry.register({ ...honest } as never)).toThrow(/loader/);
    const handMade = {
      id: 'hand.made/v1', version: '1.0.0', description: 'x', metrics: { m: { kind: 'scalar', description: 'm' } },
      sourceDigest: honest.sourceDigest, codeDigest: honest.codeDigest, compute: () => ({ metrics: {} }),
    };
    expect(() => registry.register(handMade as never)).toThrow(/loader/);
    // The loader-issued object itself registers; core providers are unaffected.
    expect(() => registry.register(honest as never)).not.toThrow();
    expect(() => createCoreProviderRegistry()).not.toThrow();
  });
});

sandboxed(`C4: concurrent invocations never share request state`, () => {
  it('keeps two concurrent invokes with different records isolated', async () => {
    const provider = await load(writeBundle(providerSource(
      '    return { metrics: { m: records.map(row => row.tag).join(\',\') } };')));
    const a = Array.from({ length: 3 }, () => ({ tag: 'A' }));
    const b = Array.from({ length: 5 }, () => ({ tag: 'B' }));
    const [ra, rb, ra2] = await Promise.all([invoke(provider, a), invoke(provider, b), invoke(provider, a)]);
    expect(metricOf(ra)).toBe('A,A,A');
    expect(metricOf(rb)).toBe('B,B,B,B,B');
    expect(metricOf(ra2)).toBe('A,A,A');
  });
});

sandboxed(`C5: invokeBundleProvider requires an explicit clock`, () => {
  it('refuses a missing clockMs instead of defaulting to the real clock', async () => {
    const provider = await load(writeBundle(providerSource('    return { metrics: { m: Date.now() } };')));
    await expect(invokeBundleProvider(provider, [], { timeoutMs: 5000 }))
      .rejects.toMatchObject({ name: 'GateProviderError', code: 'invalid-records' });
    expect(metricOf(await invoke(provider))).toBe(CLOCK_MS);
  });
});

describe('C6: per-study ceilings require the star default at resolution too', () => {
  it('resolveProjectFloors refuses starless per-study ceilings', () => {
    expect(() => resolveProjectFloors({ ceilings: { 'study-a': 'HOLD' } })).toThrow(/'\*'/);
    expect(resolveProjectFloors({ ceilings: { '*': 'HOLD', 'study-a': 'ROLLBACK' } }).ceilings)
      .toEqual({ '*': 'HOLD', 'study-a': 'ROLLBACK' });
    expect(() => resolveProjectFloors({ ceilings: { '*': 'HOLD', 'study-a': 'PROMOTE' } })).toThrow(/loosen/);
  });

  it('resolveBinding refuses starless per-study ceilings handed in directly', () => {
    const { registry } = testRegistry();
    const binding = makeBinding();
    const starless = { floors: [], ceilings: { 'unrelated-study': 'HOLD' } } as ProjectFloors;
    expect(() => registry.resolveBinding(binding, starless)).toThrow(/'\*'/);
    expect(() => registry.resolveBinding(binding, { floors: [], ceilings: { '*': 'PROMOTE', 'unrelated-study': 'HOLD' } }))
      .not.toThrow();
  });
});
