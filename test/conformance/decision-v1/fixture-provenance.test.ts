import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { QUALIFICATION_VECTOR_SUITES } from './vectors/registry.js';
import { CACHE_LAYERS } from './vectors/layers.js';

interface FixtureRecord {
  id: string; path: string; origin: string; author: string; date: string;
  permission: string; sanitization: string; schemaVersion: string;
  digest: string; expectedOutcome: string; links: string[]; assumptions?: string[];
}

const manifestPath = 'test/fixtures/decision/qualification-fixtures-v1.json';
// Every file under these roots is a vector input, golden or retained evidence and must be manifested.
const FIXTURE_ROOTS = ['test/fixtures/decision', 'examples/decision', 'docs/decision/evidence'];
const UNMANIFESTED = new Set([manifestPath, 'examples/decision/README.md']);

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? filesUnder(join(dir, entry.name))
    : Promise.resolve([join(dir, entry.name)])))).flat();
}

function declaredSchema(path: string, bytes: Buffer): string {
  if (!path.endsWith('.json')) return 'source-module';
  const value = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
  if (typeof value.schemaVersion === 'string') return value.schemaVersion;
  if (typeof value.schema === 'string') return value.schema;
  if (value.apiVersion && value.kind) return `${String(value.apiVersion)}:${String(value.kind)}`;
  return 'unversioned-json';
}

const load = async () => JSON.parse(await readFile(manifestPath, 'utf8')) as { schemaVersion: string; fixtures: FixtureRecord[] };

describe('decision qualification fixture provenance', () => {
  it('pins named fixture bytes and required origin/permission/sanitization metadata', async () => {
    const manifest = await load();
    expect(manifest.schemaVersion).toBe('decision-qualification-fixtures/v1');
    expect(new Set(manifest.fixtures.map(item => item.id)).size).toBe(manifest.fixtures.length);
    expect(new Set(manifest.fixtures.map(item => item.path)).size).toBe(manifest.fixtures.length);
    for (const item of manifest.fixtures) {
      expect(item.id).toMatch(/^DEC-[A-Z]+-[0-9]{2}$/);
      expect(item.path).toMatch(/^(?:test\/fixtures\/decision|examples\/decision|docs\/decision\/evidence)\/[A-Za-z0-9_/.-]+\.(?:json|ts|mjs)$/);
      expect(item.origin).toBe('repository-authored');
      expect(item.author.length).toBeGreaterThan(0);
      expect(item.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(item.permission).toBe('MIT (repository LICENSE)');
      expect(item.sanitization).toBe('synthetic; no personal inputs');
      expect(item.expectedOutcome.length).toBeGreaterThan(0);
      expect(item.links).toContain('JEV-16');
      const bytes = await readFile(resolve(item.path));
      expect(item.digest, item.path).toBe(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
      expect(item.schemaVersion, item.path).toBe(declaredSchema(item.path, bytes));
    }
  });

  it('manifests every fixture, example and retained evidence file, with no stale entries', async () => {
    const manifested = new Set((await load()).fixtures.map(item => item.path));
    const onDisk = (await Promise.all(FIXTURE_ROOTS.map(filesUnder))).flat().filter(path => !UNMANIFESTED.has(path)).sort();
    expect(onDisk.filter(path => !manifested.has(path)), 'unmanifested fixture files').toEqual([]);
    expect([...manifested].filter(path => !onDisk.includes(path)), 'manifest entries without a file').toEqual([]);
  });

  it('manifests every checked-in source that a registered vector or cache layer binds as evidence', async () => {
    const manifested = new Set((await load()).fixtures.map(item => item.path));
    const sources = [...QUALIFICATION_VECTOR_SUITES.flatMap(suite => suite.sources), ...Object.values(CACHE_LAYERS).flatMap(layer => layer.sources)]
      .filter(path => FIXTURE_ROOTS.some(root => path.startsWith(`${root}/`)));
    expect(sources.length).toBeGreaterThan(0);
    for (const path of sources) expect(manifested.has(path), path).toBe(true);
  });

  it('records the reconstruction assumption for vendor vectors whose definitions are not in the repository', async () => {
    const vendor = (await load()).fixtures.find(item => item.path === 'test/fixtures/decision/vendor-vectors-v1.json');
    expect(vendor?.assumptions?.join(' ')).toMatch(/not in the repository/);
    const catalog = JSON.parse(await readFile('test/fixtures/decision/vendor-vectors-v1.json', 'utf8')) as {
      vectors: Array<{ id: string; assumption: string }>;
    };
    expect(catalog.vectors).toHaveLength(25);
    expect(catalog.vectors.every(item => item.assumption.length > 20)).toBe(true);
  });
});
