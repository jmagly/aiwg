import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { requireFeaturePackage } from '../features/runtime.js';
import { acquireImportLease } from './import-lease.js';
import { SessionRepository } from './repository.js';
import { importDiscoveryManifest } from './batch-import.js';
import {
  defaultDiscoveryManifestPath,
  discoverWorkspaceHistories,
  readDiscoveryManifest,
  writeDiscoveryManifest,
} from './workspace-discovery.js';
import type { SessionProviderId } from './contracts.js';

export function sessionRefreshAvailable(): boolean {
  try {
    const Database = requireFeaturePackage('better-sqlite3') as new (file: string) => { close(): void };
    const probe = new Database(':memory:');
    probe.close();
    return true;
  } catch {
    return false;
  }
}

/** Refresh an existing catalog without inferring or granting provider access. */
export async function refreshSessionCatalog(
  workspace: string,
  full: boolean,
  waitMs: number,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const canonicalWorkspace = realpathSync(workspace);
  const database = path.join(workspace, '.aiwg/sessions/catalog.sqlite');
  const manifestPath = defaultDiscoveryManifestPath(canonicalWorkspace);
  let manifest;
  if (!full) {
    if (!existsSync(manifestPath)) return 'no authorized discovery manifest';
    const previous = await readDiscoveryManifest(manifestPath);
    if (previous.workspaceId !== canonicalWorkspace) throw new Error('discovery manifest workspace mismatch');
    const authorizedRoots = previous.authorizedRoots ?? {};
    if (!previous.authorizedRoots) {
      for (const source of previous.sources) {
        const roots = authorizedRoots[source.provider] ??= [];
        if (!roots.includes(source.authorizedRoot)) roots.push(source.authorizedRoot);
      }
    }
    const providers = Object.keys(authorizedRoots) as SessionProviderId[];
    if (!providers.length) return 'no authorized provider roots';
    manifest = await discoverWorkspaceHistories({
      workspace: canonicalWorkspace,
      expectedProviders: providers,
      authorizedRoots,
    });
  }
  const lease = await acquireImportLease(database, `index-refresh-${process.pid}`, { waitMs });
  try {
    const repository = new SessionRepository(database);
    try {
      if (full) repository.reindex(canonicalWorkspace);
      else {
        const prior = repository.getBatchImportRunForManifest(manifest!.manifestId, canonicalWorkspace);
        if (prior?.status === 'complete') return 'unchanged';
        // Persist the exact discovered batch before its confirmed import.
        await writeDiscoveryManifest(manifestPath, manifest!);
        const receipt = await importDiscoveryManifest({ manifest: manifest!, repository, signal });
        if (receipt.totals.rejected || receipt.totals.pending) {
          throw new Error(`session import incomplete: ${receipt.totals.rejected} rejected, ${receipt.totals.pending} pending`);
        }
      }
    } finally {
      repository.close();
    }
  } finally {
    await lease.release();
  }
  return undefined;
}
