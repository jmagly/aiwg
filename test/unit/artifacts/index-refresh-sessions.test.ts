import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  defaultDiscoveryManifestPath, discoverWorkspaceHistories, readDiscoveryManifest, writeDiscoveryManifest,
} from '../../../src/sessions/workspace-discovery.js';
import { refreshSessionCatalog, sessionRefreshAvailable } from '../../../src/sessions/refresh.js';
import { acquireImportLease } from '../../../src/sessions/import-lease.js';

const mocks = vi.hoisted(() => ({
  prior: vi.fn(), reindex: vi.fn(), close: vi.fn(), importBatch: vi.fn(), feature: vi.fn(),
}));
vi.mock('../../../src/sessions/repository.js', () => ({
  SessionRepository: class {
    getBatchImportRunForManifest = mocks.prior;
    reindex = mocks.reindex;
    close = mocks.close;
  },
}));
vi.mock('../../../src/sessions/batch-import.js', () => ({ importDiscoveryManifest: mocks.importBatch }));
vi.mock('../../../src/features/runtime.js', () => ({ requireFeaturePackage: mocks.feature }));

let root: string;
let workspace: string;
let authorized: string;
let database: string;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prior.mockReturnValue(null);
  mocks.importBatch.mockResolvedValue({ run: { status: 'complete' }, totals: { rejected: 0, pending: 0 } });
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-refresh-sessions-'));
  workspace = path.join(root, 'workspace');
  authorized = path.join(root, 'authorized');
  database = path.join(workspace, '.aiwg/sessions/catalog.sqlite');
  fs.mkdirSync(path.dirname(database), { recursive: true });
  fs.mkdirSync(authorized);
  fs.writeFileSync(database, 'existing catalog');
  fs.writeFileSync(path.join(authorized, 'one.jsonl'), JSON.stringify({
    type: 'user', sessionId: 'one', cwd: workspace, message: { role: 'user', content: 'hello' },
  }) + '\n');
  vi.stubEnv('HOME', path.join(root, 'home'));
  vi.stubEnv('XDG_DATA_HOME', path.join(root, 'data'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

async function saveAuthorization(): Promise<void> {
  const manifest = await discoverWorkspaceHistories({
    workspace, expectedProviders: ['claude'], authorizedRoots: { claude: [authorized] },
  });
  await writeDiscoveryManifest(defaultDiscoveryManifestPath(workspace), manifest);
}

describe('session refresh integration boundaries', () => {
  it('discovers new files only within saved authorized roots and confirms the exact saved manifest under the import lease', async () => {
    await saveAuthorization();
    fs.writeFileSync(path.join(authorized, 'two.jsonl'), JSON.stringify({
      type: 'user', sessionId: 'two', cwd: workspace, message: { role: 'user', content: 'second' },
    }) + '\n');
    mocks.importBatch.mockImplementationOnce(async ({ manifest }) => {
      expect(fs.existsSync(`${database}.import.lock`)).toBe(true);
      expect(await readDiscoveryManifest(defaultDiscoveryManifestPath(workspace))).toEqual(manifest);
      return { totals: { rejected: 0, pending: 0 } };
    });
    expect(await refreshSessionCatalog(workspace, false, 0)).toBeUndefined();
    const imported = mocks.importBatch.mock.calls[0][0].manifest;
    expect(imported.sources).toHaveLength(2);
    expect(imported.authorizedRoots).toEqual({ claude: [authorized] });
    expect(fs.existsSync(`${database}.import.lock`)).toBe(false);
    expect(mocks.close).toHaveBeenCalledOnce();

    mocks.prior.mockReturnValue({ status: 'complete' });
    const before = fs.readFileSync(defaultDiscoveryManifestPath(workspace), 'utf8');
    expect(await refreshSessionCatalog(workspace, false, 0)).toBe('unchanged');
    expect(mocks.importBatch).toHaveBeenCalledOnce();
    expect(fs.readFileSync(defaultDiscoveryManifestPath(workspace), 'utf8')).toBe(before);
  });

  it('skips catalogs with no saved authorization without accessing provider homes', async () => {
    expect(await refreshSessionCatalog(workspace, false, 0)).toBe('no authorized discovery manifest');
    expect(mocks.importBatch).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();
    expect(fs.existsSync(defaultDiscoveryManifestPath(workspace))).toBe(false);
  });

  it('rejects a saved root redirected through a symlink without importing', async () => {
    await saveAuthorization();
    const elsewhere = path.join(root, 'elsewhere');
    fs.renameSync(authorized, elsewhere);
    fs.symlinkSync(elsewhere, authorized, 'dir');
    await expect(refreshSessionCatalog(workspace, false, 0)).rejects.toThrow('previously authorized provider root changed');
    expect(mocks.importBatch).not.toHaveBeenCalled();
  });

  it('reindexes with --full under the existing import lease without discovery', async () => {
    expect(await refreshSessionCatalog(workspace, true, 0)).toBeUndefined();
    expect(mocks.reindex).toHaveBeenCalledWith(workspace);
    expect(mocks.importBatch).not.toHaveBeenCalled();
    expect(fs.existsSync(defaultDiscoveryManifestPath(workspace))).toBe(false);
    const lease = await acquireImportLease(database, 'another-writer');
    try {
      await expect(refreshSessionCatalog(workspace, true, 0)).rejects.toThrow(/lease is held/);
      expect(mocks.reindex).toHaveBeenCalledOnce();
    } finally { await lease.release(); }
  });

  it('treats rejected imports as errors and releases the catalog lease', async () => {
    await saveAuthorization();
    mocks.importBatch.mockResolvedValueOnce({ totals: { rejected: 1, pending: 0 } });
    await expect(refreshSessionCatalog(workspace, false, 0)).rejects.toThrow('1 rejected');
    expect(fs.existsSync(`${database}.import.lock`)).toBe(false);
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('handles missing packages and broken native bindings as optional-feature unavailability', () => {
    mocks.feature.mockImplementationOnce(() => { throw new Error('missing sqlite'); });
    expect(sessionRefreshAvailable()).toBe(false);
    mocks.feature.mockReturnValueOnce(class { constructor() { throw new Error('binding unavailable'); } });
    expect(sessionRefreshAvailable()).toBe(false);
    mocks.feature.mockReturnValueOnce(class { close = mocks.close; });
    expect(sessionRefreshAvailable()).toBe(true);
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
