/**
 * Marketplace Local Cache
 *
 * Manages the ~/.aiwg/marketplace-cache/ directory that stores fetched plugins.
 *
 * Layout: ~/.aiwg/marketplace-cache/<source>/<packageId>/<version>/
 *
 * @implements #787
 */

import { createHash, randomUUID } from 'node:crypto';
import { validateSearchSnapshot } from './search-contract.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { MarketplaceSourceId, PackageBundle, PackageMetadata, SearchSourceId, SearchSnapshot } from './types.js';

/**
 * Resolve the cache root. Supports AIWG_CACHE_DIR override for testing.
 */
export function getCacheRoot(): string {
  if (process.env.AIWG_CACHE_DIR) {
    return process.env.AIWG_CACHE_DIR;
  }
  return path.join(os.homedir(), '.aiwg', 'marketplace-cache');
}

/**
 * Resolve the path for a specific package version
 */
export function getPackagePath(
  source: MarketplaceSourceId,
  packageId: string,
  version: string
): string {
  // Sanitize package ID for filesystem safety (replace / and : with -)
  const safePackageId = packageId.replace(/[/:]/g, '__');
  return path.join(getCacheRoot(), source, safePackageId, version);
}

/**
 * Check whether a package version is cached
 */
export function isCached(
  source: MarketplaceSourceId,
  packageId: string,
  version: string
): boolean {
  const packagePath = getPackagePath(source, packageId, version);
  const manifestPath = path.join(packagePath, 'manifest.json');
  return fs.existsSync(manifestPath);
}

/**
 * Write a package bundle to the cache
 */
export function cachePackage(bundle: PackageBundle): string {
  const packagePath = getPackagePath(
    bundle.metadata.source,
    bundle.metadata.name,
    bundle.metadata.version
  );

  fs.mkdirSync(packagePath, { recursive: true });

  // Write normalized manifest
  fs.writeFileSync(
    path.join(packagePath, 'manifest.json'),
    JSON.stringify(bundle.metadata, null, 2) + '\n',
    'utf-8'
  );

  // Write raw source manifest for update detection
  fs.writeFileSync(
    path.join(packagePath, 'raw-manifest.json'),
    JSON.stringify(bundle.rawManifest, null, 2) + '\n',
    'utf-8'
  );

  // Note: actual artifact files are expected to be in bundle.localPath already;
  // in a complete implementation we'd copy them into packagePath here.

  return packagePath;
}

/**
 * List all cached packages.
 */
export interface CachedPackageEntry {
  source: MarketplaceSourceId;
  packageId: string;
  version: string;
  cachedAt: Date;
  metadata: PackageMetadata;
}

export function listCachedPackages(): CachedPackageEntry[] {
  const root = getCacheRoot();
  if (!fs.existsSync(root)) return [];

  const entries: CachedPackageEntry[] = [];

  // Walk <source>/<packageId>/<version>/manifest.json
  const sources = fs.readdirSync(root);
  for (const source of sources) {
    const sourcePath = path.join(root, source);
    if (!fs.statSync(sourcePath).isDirectory()) continue;

    const packages = fs.readdirSync(sourcePath);
    for (const pkg of packages) {
      const pkgPath = path.join(sourcePath, pkg);
      if (!fs.statSync(pkgPath).isDirectory()) continue;

      const versions = fs.readdirSync(pkgPath);
      for (const version of versions) {
        const manifestPath = path.join(pkgPath, version, 'manifest.json');
        if (!fs.existsSync(manifestPath)) continue;

        try {
          const metadata = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as PackageMetadata;
          const stat = fs.statSync(manifestPath);
          entries.push({
            source: source as MarketplaceSourceId,
            packageId: pkg.replace(/__/g, '/'),
            version,
            cachedAt: stat.mtime,
            metadata,
          });
        } catch {
          // Skip malformed entries
        }
      }
    }
  }

  return entries;
}

/**
 * Remove a specific cached package (all versions or a specific one)
 */
export function uncachePackage(
  source: MarketplaceSourceId,
  packageId: string,
  version?: string
): boolean {
  const safePackageId = packageId.replace(/[/:]/g, '__');
  const pkgPath = path.join(getCacheRoot(), source, safePackageId);

  if (version) {
    const versionPath = path.join(pkgPath, version);
    if (!fs.existsSync(versionPath)) return false;
    fs.rmSync(versionPath, { recursive: true, force: true });
    return true;
  }

  if (!fs.existsSync(pkgPath)) return false;
  fs.rmSync(pkgPath, { recursive: true, force: true });
  return true;
}

/** Query-scoped discovery data lives alongside the existing package caches. */
export function getSearchCachePath(source: SearchSourceId, query: string, home?: string): string {
  const root = home ? path.join(home, '.aiwg/marketplace-cache') : getCacheRoot();
  return path.join(root, source, 'search', `${createHash('sha256').update(query).digest('hex')}.json`);
}
export function readSearchCache(source: SearchSourceId, query: string, home?: string): SearchSnapshot | null {
  const file = getSearchCachePath(source, query, home);
  if (!fs.existsSync(file)) return null;
  const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!validateSearchSnapshot(value) || value.source !== source || value.query !== query) {
    throw new Error('Invalid discovery cache');
  }
  return value;
}
export function writeSearchCache(snapshot: SearchSnapshot, home?: string): void {
  if (!validateSearchSnapshot(snapshot)) throw new Error('Invalid discovery snapshot');
  const file = getSearchCachePath(snapshot.source, snapshot.query, home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(snapshot, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
