// Bind prebuilt framework exports to their package/source identity and repair path.
import fs from 'node:fs';
import path from 'node:path';
import { frameworkSourceDigest } from './framework-source-digest.js';
import { inferInstallationMethod } from '../installation/manager.mjs';

export function prebuiltFrameworkFreshnessReason(root: string, manifest: {
  package_version?: unknown; source_digest?: unknown;
}): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (typeof manifest.package_version !== 'string' || manifest.package_version !== pkg.version) {
      return `prebuilt package version '${manifest.package_version ?? 'missing'}' differs from current package version '${pkg.version}'`;
    }
    if (typeof manifest.source_digest !== 'string' || manifest.source_digest !== frameworkSourceDigest(root, false)) {
      return 'prebuilt source digest differs from current framework sources (modified, added or removed source)';
    }
    return null;
  } catch (error) {
    return `prebuilt source identity is unreadable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export function fortemiCorePrebuiltRepairHint(root: string): string {
  if (inferInstallationMethod(root) === 'source') {
    const quotedRoot = `'${root.replaceAll("'", "'\\''")}'`;
    return `run npm --prefix ${quotedRoot} run release:fortemi-index to rebuild this source checkout's framework index`;
  }
  return 'run "aiwg index sync --backend fortemi-core --graph framework" to rebuild the local framework cache';
}
