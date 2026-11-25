// Test the public flag, offline boundary, and lexical parity with isolated metadata.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverCapability } from '../../../src/artifacts/query-engine-discover.js';
import { main } from '../../../src/artifacts/cli.js';
import { getGraphIndexDir, type ArtifactIndex, type MetadataEntry } from '../../../src/artifacts/types.js';
import type { DiscoverParams } from '../../../src/artifacts/query-engine-options.js';
import * as relations from '../../../src/artifacts/relations.js';

let root: string;
let metadata: string;
let log: ReturnType<typeof vi.spyOn>;
const a: MetadataEntry = {
  path: 'a', name: 'orbit', title: 'Orbit', type: 'skill', summary: 'workspace orbit', capability: 'workspace orbit',
  phase: '', tags: [], created: '', updated: '', checksum: '', dependencies: [], dependents: [],
};
const c: MetadataEntry = { ...a, path: 'c', type: 'memory', name: 'remember', title: 'Remember', capability: 'retained context', summary: 'retained context' };
const params: DiscoverParams = { phrase: 'workspace orbit', graph: 'project', noBuild: true, backend: 'local', json: true, typeFilter: ['skill', 'memory'] };
const read = () => JSON.parse(String(log.mock.calls.at(-1)?.[0]));
function write(input: unknown = undefined) {
  fs.writeFileSync(metadata, JSON.stringify({ entries: { a, c }, experimentalGraph: input }));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-experimental-graph-'));
  for (const key of ['HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) vi.stubEnv(key, path.join(root, key));
  for (const key of ['AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR',
    'AIWG_PROJECT_LOCAL_PATHS', 'AIWG_FRAMEWORK_INDEX_CACHE', 'AIWG_FRAMEWORK_INDEX_CACHE_SOURCE']) vi.stubEnv(key, '');
  vi.stubEnv('AIWG_ROOT', path.join(root, 'runtime'));
  vi.stubEnv('AIWG_CONFIG', path.join(root, 'config'));
  metadata = path.join(getGraphIndexDir(root, 'project'), 'metadata.json');
  fs.mkdirSync(path.dirname(metadata), { recursive: true });
  write({ coUse: { windows: 100, occurrences: { a: 10, c: 10 }, pairs: [{ source: 'a', target: 'c', count: 5 }] } });
  vi.spyOn(Date, 'now').mockReturnValue(1000);
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('discover --experimental-graph', () => {
  it('matches the existing flag-off lexical contract, and false equals absent byte-for-byte', async () => {
    await discoverCapability(root, params);
    const absent = String(log.mock.calls.at(-1)?.[0]);
    expect(read().results.map((item: { name: string }) => item.name)).toEqual(['orbit']);
    await discoverCapability(root, { ...params, experimentalGraph: false });
    expect(String(log.mock.calls.at(-1)?.[0])).toBe(absent);
    write({ coUse: { windows: -1 } });
    await discoverCapability(root, params);
    expect(String(log.mock.calls.at(-1)?.[0])).toBe(absent);
  });

  it('expands through supplied offline edges before truncation', async () => {
    await discoverCapability(root, { ...params, experimentalGraph: true });
    expect(read().results.map((item: { name: string }) => item.name)).toEqual(['orbit', 'remember']);
    await discoverCapability(root, { ...params, experimentalGraph: true, typeFilter: ['skill'], limit: 1 });
    expect(read().results.map((item: { name: string }) => item.name)).toEqual(['orbit']);
  });

  it('wires the boolean CLI switch without swallowing the following phrase', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    await main(['discover', '--experimental-graph', 'workspace orbit', '--graph', 'project', '--type', 'skill,memory', '--json']);
    expect(read().results.map((item: { name: string }) => item.name)).toEqual(['orbit', 'remember']);
  });

  it('keeps an experiment without supplied observations lexical and read-only', async () => {
    write();
    const before = fs.readFileSync(metadata, 'utf8');
    await discoverCapability(root, { ...params, experimentalGraph: true, noBuild: false });
    expect(read().results.map((item: { name: string }) => item.name)).toEqual(['orbit']);
    expect(fs.readFileSync(metadata, 'utf8')).toBe(before);
    expect(fs.readdirSync(path.dirname(metadata))).toEqual(['metadata.json']);
  });

  it('rejects web resources before any network access', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    await expect(discoverCapability(root, { ...params, experimentalGraph: true, resourceSource: 'web' }))
      .rejects.toThrow(/experimental.*local/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps framework output from building relationship sidecars', async () => {
    const destination = path.join(getGraphIndexDir(root, 'framework'), 'metadata.json');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(metadata, destination);
    const ensure = vi.spyOn(relations, 'ensureRelations').mockResolvedValue(null);
    await discoverCapability(root, { ...params, graph: 'framework', noBuild: false, experimentalGraph: true });
    expect(ensure).not.toHaveBeenCalled();
    expect(fs.readdirSync(path.dirname(destination))).toEqual(['metadata.json']);
  });

  it('accepts offline input in the existing index contract', () => {
    const index: Partial<ArtifactIndex> = { entries: { a }, experimentalGraph: { similarities: [] } };
    expect(index.experimentalGraph?.similarities).toEqual([]);
  });
});
