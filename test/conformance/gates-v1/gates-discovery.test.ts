import { mkdtempSync } from '../../helpers/temp-dir.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { OPERATIONAL_DISCOVERY_TYPES, OPERATIONAL_SHOW_TYPES } from '../../../src/artifacts/types.js';
import { parseGatePackDoc } from '../../../src/artifacts/index-builder.js';
import { BundleManifestSchema } from '../../../src/extensions/manifest.js';
import { GateRegistry } from '../../../src/gates/registry.js';
import { createCoreProviderRegistry } from '../../../src/gates/providers/index.js';
import {
  discoverShippedGatePacks, loadGatePackFile, registerBundleGatePacks,
} from '../../../src/gates/discovery.js';
import type { GatePack } from '../../../src/gates/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const bundledPackPath = resolve(repoRoot, 'agentic/code/addons/decision-engine/gate-packs/integrity-ceiling.gatepack.yaml');

const fixturePack = (): GatePack =>
  JSON.parse(readFileSync(resolve(here, 'fixtures/valid-pack.json'), 'utf8')) as GatePack;

function writePack(dir: string, filename: string, content: string): string {
  mkdirSync(join(dir, 'gate-packs'), { recursive: true });
  const file = join(dir, 'gate-packs', filename);
  writeFileSync(file, content);
  return file;
}

function bundleWithPack(kind: 'framework' | 'addon' | 'extension', bundle: string, namespace: string, name: string): { dir: string; id: string } {
  const dir = mkdtempSync(join(tmpdir(), `aiwg-gate-${kind}-`));
  const pack = fixturePack();
  const id = `${namespace}:${bundle}/${name}`;
  pack.metadata = { ...pack.metadata, id };
  delete pack.spec.extends;
  const file = writePack(dir, `${name}.gatepack.json`, JSON.stringify(pack, null, 2));
  void file;
  return { dir, id };
}

describe('gate-pack discovery type', () => {
  it('is on the operational discovery and show surfaces', () => {
    expect((OPERATIONAL_DISCOVERY_TYPES as readonly string[])).toContain('gate-pack');
    expect((OPERATIONAL_SHOW_TYPES as readonly string[])).toContain('gate-pack');
  });

  it('classifies valid .gatepack files and never HITL gates/ files', () => {
    const pack = fixturePack();
    const parsed = parseGatePackDoc(JSON.stringify(pack), 'agentic/code/addons/test/gate-packs/example.gatepack.json');
    expect(parsed).toMatchObject({ type: 'gate-pack', kind: 'GatePack', name: pack.metadata.id });
    expect(parsed?.tags).toContain('gates');
    expect(parsed?.searchTerms).toContain('false-ready-upper');
    // HITL boundary: gates/*.yaml without the .gatepack infix never classifies,
    // even when the bytes carry a GatePack kind.
    expect(parseGatePackDoc(JSON.stringify(pack), 'agentic/code/addons/agent-persistence/gates/review.yaml')).toBeNull();
    expect(parseGatePackDoc(JSON.stringify(pack), 'agentic/code/addons/test/gate-packs/example.yaml')).toBeNull();
  });

  it('refuses invalid packs at discovery so they are never listed', () => {
    const invalid = JSON.parse(readFileSync(resolve(here, 'fixtures/invalid-pack-kind.json'), 'utf8'));
    expect(parseGatePackDoc(JSON.stringify(invalid), 'x/gate-packs/bad.gatepack.json')).toBeNull();
    const extra = JSON.parse(readFileSync(resolve(here, 'fixtures/invalid-pack-extra-prop.json'), 'utf8'));
    expect(parseGatePackDoc(JSON.stringify(extra), 'x/gate-packs/bad.gatepack.json')).toBeNull();
  });
});

describe('gate-pack bundle registry', () => {
  it('resolves framework, addon and extension fixture packs under their namespaces', () => {
    const framework = bundleWithPack('framework', 'test-fw', 'framework', 'example');
    const addon = bundleWithPack('addon', 'test-addon', 'addon', 'example');
    const extension = bundleWithPack('extension', 'test-ext', 'extension', 'example');
    const registry = new GateRegistry(createCoreProviderRegistry());
    expect(registerBundleGatePacks(registry, framework.dir, { namespace: 'framework', bundle: 'test-fw' }))
      .toEqual([framework.id]);
    expect(registerBundleGatePacks(registry, addon.dir, { namespace: 'addon', bundle: 'test-addon' }))
      .toEqual([addon.id]);
    expect(registerBundleGatePacks(registry, extension.dir, { namespace: 'extension', bundle: 'test-ext' }))
      .toEqual([extension.id]);
    expect(registry.getPack(framework.id).metadata.id).toBe(framework.id);
    expect(registry.getPack(addon.id).metadata.id).toBe(addon.id);
    expect(registry.getPack(extension.id).metadata.id).toBe(extension.id);
    expect(registry.resolvePack('test-fw/example').authored.metadata.id).toBe(framework.id);
  });

  it('rejects invalid packs at load with a file-pathed diagnostic', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aiwg-gate-invalid-'));
    const invalid = readFileSync(resolve(here, 'fixtures/invalid-pack-threshold.json'), 'utf8');
    writePack(dir, 'bad.gatepack.json', invalid);
    const registry = new GateRegistry(createCoreProviderRegistry());
    expect(() => registerBundleGatePacks(registry, dir, { namespace: 'addon', bundle: 'x' }))
      .toThrow(/gate pack (invalid|rejected|unparseable): .*bad\.gatepack\.json/);
    expect(() => loadGatePackFile(join(dir, 'gate-packs/missing.gatepack.json'))).toThrow(/gate pack unreadable/);
  });

  it('ships a validating integrity-ceiling pack under the decision-engine addon', () => {
    const pack = loadGatePackFile(bundledPackPath);
    expect(pack.metadata).toMatchObject({ id: 'aiwg:decision-engine/integrity-ceiling', version: '1.0.0' });
    expect(pack.spec.gates.map(gate => gate.kind)).toEqual(['upstream-ceiling']);
    const registry = new GateRegistry(createCoreProviderRegistry());
    const loaded = discoverShippedGatePacks(repoRoot, registry);
    expect(loaded).toContain('aiwg:decision-engine/integrity-ceiling');
    expect(registry.getPack('aiwg:decision-engine/integrity-ceiling').metadata.id)
      .toBe('aiwg:decision-engine/integrity-ceiling');
  });

  it('discovers shipped packs with wall-clock drift using thread CPU', () => {
    const cpuClock = vi.spyOn(process, 'threadCpuUsage').mockReturnValue({ user: 0, system: 0 });
    const nowSpy = vi.spyOn(performance, 'now');
    let fakeNow = 0;
    nowSpy.mockImplementation(() => { fakeNow += 10_000; return fakeNow; });
    try {
      const registry = new GateRegistry(createCoreProviderRegistry());
      expect(() => discoverShippedGatePacks(repoRoot, registry)).not.toThrow();
      expect(registry.getPack('aiwg:decision-engine/integrity-ceiling').metadata.id)
        .toBe('aiwg:decision-engine/integrity-ceiling');
      expect(cpuClock).toHaveBeenCalled();
      expect(nowSpy).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
      cpuClock.mockRestore();
    }
  });
});

describe('gatePacks manifest field', () => {
  const addonBase = {
    id: 'foo', type: 'addon', name: 'Foo', version: '1.0.0', description: 'A test addon',
    manifestVersion: '1', platforms: { claude: 'full' }, keywords: ['test'],
    deployment: { pathTemplate: '.{platform}/skills/{id}.md' },
    addonConfig: { entry: { skills: 'skills/' } },
  };

  it('accepts gatePacks on addon, extension and framework manifests', () => {
    const addon = {
      ...addonBase,
      addonConfig: { entry: { skills: 'skills/', gatePacks: 'gate-packs/' }, gatePacks: ['integrity-ceiling'] },
    };
    expect(BundleManifestSchema.safeParse(addon).success).toBe(true);
    const extension = { ...addonBase, type: 'extension', extensionConfig: { entry: { gatePacks: 'gate-packs/' }, gatePacks: ['a'] } };
    delete (extension as Record<string, unknown>).addonConfig;
    expect(BundleManifestSchema.safeParse(extension).success).toBe(true);
    const framework = {
      ...addonBase, type: 'framework',
      frameworkConfig: { path: 'src/', entry: { gatePacks: 'gate-packs/' }, gatePacks: ['a'] },
    };
    delete (framework as Record<string, unknown>).addonConfig;
    expect(BundleManifestSchema.safeParse(framework).success).toBe(true);
  });

  it('rejects an invalid gatePacks entry path', () => {
    const bad = {
      ...addonBase,
      addonConfig: { entry: { gatePacks: '../escape/' }, gatePacks: ['a'] },
    };
    expect(BundleManifestSchema.safeParse(bad).success).toBe(false);
  });
});

describe('gates disabled-by-default', () => {
  it('leaves the decision runtime surface byte-identical', async () => {
    const decision = await import('../../../src/decision/index.js');
    expect('evaluateGates' in decision).toBe(false);
    expect('GateRegistry' in decision).toBe(false);
    const { decisionCapabilities } = await import('../../../src/decision/driver.js');
    const before = JSON.stringify(decisionCapabilities({ cwd: repoRoot, frameworkRoot: repoRoot }));
    await import('../../../src/gates/driver.js');
    await import('../../../src/cli/handlers/gates.js');
    const after = JSON.stringify(decisionCapabilities({ cwd: repoRoot, frameworkRoot: repoRoot }));
    expect(after).toBe(before);
  });
});
