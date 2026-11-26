import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCoverageReport } from '../../../tools/manifest/check-discovery-coverage.mjs';
import { buildIndex } from '../../../src/artifacts/index-builder.js';
import type { ArtifactIndex } from '../../../src/artifacts/types.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');

describe('shipped component discovery coverage', () => {
  let outputDir: string;
  let index: ArtifactIndex;

  beforeAll(async () => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-component-coverage-index-'));
    await buildIndex(REPO_ROOT, {
      graph: 'framework',
      force: true,
      outputDir,
    });
    index = JSON.parse(
      fs.readFileSync(path.join(outputDir, '.aiwg', '.index', 'framework', 'metadata.json'), 'utf8'),
    ) as ArtifactIndex;
  }, 30_000);

  afterAll(() => {
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  it('maps every shipped component to a driver that is present in the framework index', () => {
    const report = buildCoverageReport(REPO_ROOT);

    expect(report.ok).toBe(true);
    expect(report.counts).toMatchObject({
      total: 63,
      covered: 63,
      missing: 0,
      invalid: 0,
      missingRuntimeAssets: 0,
    });

    for (const component of report.components) {
      if (component.status === 'exempt') continue;
      expect(component.drivers.length, component.component).toBeGreaterThan(0);
      expect(component.runtimeAssets?.length ?? 0, `${component.component} runtime assets`).toBeGreaterThanOrEqual(0);
      for (const asset of component.runtimeAssets ?? []) {
        expect(asset.status, `${component.component} ${asset.type}:${asset.declaration}`).toBe('present');
        expect(asset.path, `${component.component} ${asset.declaration} path`).toBeTruthy();
        const entry = index.entries[asset.path];
        if (asset.type === 'schema') {
          expect(entry, `${component.component} schema ${asset.path}`).toBeDefined();
          expect(entry.type).toBe('schema');
        }
      }
      for (const driver of component.drivers) {
        const entry = index.entries[driver.path];
        expect(entry, `${component.component} → ${driver.path}`).toBeDefined();
        expect(entry.type).toBe(driver.type);
        expect(entry.capability, `${driver.path} capability`).toBeTruthy();
        expect(
          (entry.triggers?.length ?? 0) > 0 || Boolean(entry.capability),
          `${driver.path} search intent`,
        ).toBe(true);
        expect(driver.providerSupport.length, `${driver.path} provider support`).toBeGreaterThan(0);
      }
    }
  });

  it('emits one machine-readable component row with driver, trigger, and provider fields', () => {
    const report = buildCoverageReport(REPO_ROOT);
    expect(report.components).toHaveLength(report.counts.total);
    for (const component of report.components) {
      expect(component).toHaveProperty('component');
      expect(component).toHaveProperty('status');
      if (component.status !== 'covered') continue;
      expect(component).toHaveProperty('runtimeAssets');
      expect(component.drivers[0]).toMatchObject({
        path: expect.any(String),
        type: expect.any(String),
        triggers: expect.any(Array),
        providerSupport: expect.any(Array),
      });
    }
  });

  it('indexes the agentic-installer runtime assets declared in manifest.json', () => {
    const report = buildCoverageReport(REPO_ROOT);
    const installer = report.components.find((component) => component.component === 'agentic-installer');
    expect(installer).toBeDefined();
    const assets = installer!.runtimeAssets ?? [];
    expect(assets.map((asset) => `${asset.type}:${asset.declaration}`)).toEqual(expect.arrayContaining([
      'agent:installer-agent',
      'skill:setup-generate',
      'skill:setup-run',
      'skill:setup-validate',
      'rule:installer-safety',
      'rule:installer-authoring',
      'schema:schemas/v1/setup-manifest.schema.json',
    ]));
    for (const asset of assets) {
      expect(asset.status).toBe('present');
      const entry = index.entries[asset.path!];
      expect(entry, asset.path!).toBeDefined();
      expect(entry.type, asset.path!).toBe(asset.type);
    }
  });
});
