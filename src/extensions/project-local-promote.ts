/**
 * Project-Local Bundle Promotion (Graduate)
 *
 * Operationalizes the identical-form portability invariant from
 * @docs/customization/project-local-lifecycle.md (#1038): a
 * project-local bundle should graduate to upstream (or to a private
 * corpus path) by byte-identical copy.
 *
 * Per the design at @docs/customization/project-local-lifecycle.md
 * (#1049), promote performs:
 *   1. Pre-flight checks (bundle exists, manifest valid, no project-
 *      local @-refs, destination doesn't exist, identical-form layout)
 *   2. Hash snapshot of source files
 *   3. Recursive copy to destination
 *   4. Re-hash destination — roll back (delete) on any mismatch
 *   5. Update registry source: project-local → bundled (or corpus)
 *   6. Optional --cleanup: remove .aiwg/<type>/<name>/ source
 *   7. Activity log entry
 *
 * @design @docs/customization/project-local-lifecycle.md
 * @implements #1037
 */

import { createHash } from 'crypto';
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
} from 'fs/promises';
import { resolve, join, relative } from 'path';
import { discoverProjectLocalBundles } from './project-local-discovery.js';
import { appendProjectLocalActivity } from './project-local-activity.js';
import type { AiwgConfig } from '../config/aiwg-config.js';
import type { ProjectLocalType } from './manifest.js';

export type PromoteDestinationKind = 'upstream' | 'corpus';

export interface PromoteOptions {
  /** Where to copy: upstream tree or corpus path. Default: 'upstream'. */
  to?: PromoteDestinationKind;
  /** Required when to === 'corpus'. */
  corpusPath?: string;
  /** Print plan; no filesystem writes, no registry mutation. */
  dryRun?: boolean;
  /** Remove .aiwg/<type>/<name>/ source after a successful copy. */
  cleanup?: boolean;
  /**
   * Bypass the safety-critical shadow / @-reference refusals.
   * Does not bypass: destination-already-exists, hash-mismatch rollback.
   */
  force?: boolean;
  /** Override frameworkRoot for the upstream destination. */
  frameworkRoot?: string;
}

export type PromoteFailureReason =
  | 'bundle-not-found'
  | 'destination-required'
  | 'destination-exists'
  | 'project-local-references'
  | 'hash-mismatch'
  | 'copy-failed';

export interface PromotePlan {
  bundleId: string;
  type: ProjectLocalType;
  source: string;
  destination: string;
  /** Source-relative file paths that would be copied. */
  files: string[];
  totalBytes: number;
}

export interface PromoteResult {
  /** True when promotion (or its dry-run plan) succeeded. */
  ok: boolean;
  plan?: PromotePlan;
  failureReason?: PromoteFailureReason;
  message?: string;
  /** Files actually copied (empty in dry-run / failure). */
  copied?: string[];
}

const TYPE_TO_UPSTREAM_DIR: Record<ProjectLocalType, string> = {
  extension: 'agentic/code/addons',
  addon: 'agentic/code/addons',
  framework: 'agentic/code/frameworks',
  plugin: 'agentic/code/addons',
  provider: 'agentic/code/providers',
};

async function sha256(absPath: string): Promise<string> {
  const buf = await readFile(absPath);
  return createHash('sha256').update(buf).digest('hex');
}

async function walk(rootAbs: string): Promise<string[]> {
  const out: string[] = [];
  async function recurse(dirAbs: string): Promise<void> {
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
    try {
      entries = await readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childAbs = join(dirAbs, e.name);
      if (e.isDirectory()) {
        await recurse(childAbs);
      } else if (e.isFile()) {
        out.push(childAbs);
      }
    }
  }
  await recurse(rootAbs);
  return out;
}

async function fileSize(absPath: string): Promise<number> {
  try {
    const st = await stat(absPath);
    return st.size;
  } catch {
    return 0;
  }
}

/** Scan for `@.aiwg/...` references in artifact body files. */
async function findProjectLocalReferences(bundlePath: string): Promise<string[]> {
  const out: string[] = [];
  const files = await walk(bundlePath);
  for (const f of files) {
    if (!f.endsWith('.md') && !f.endsWith('.json') && !f.endsWith('.yaml') && !f.endsWith('.yml')) continue;
    try {
      const content = await readFile(f, 'utf-8');
      if (content.includes('@.aiwg/')) {
        out.push(relative(bundlePath, f));
      }
    } catch {
      // Skip unreadable files
    }
  }
  return out;
}

/**
 * Promote a project-local bundle to its upstream home or a corpus path.
 *
 * Pure function over (config, projectDir, bundleId, opts). Mutates
 * config.installed when the operation succeeds (caller persists).
 */
export async function promoteProjectLocalBundle(
  config: AiwgConfig,
  projectDir: string,
  bundleId: string,
  opts: PromoteOptions = {},
): Promise<PromoteResult> {
  const {
    to = 'upstream',
    corpusPath,
    dryRun = false,
    cleanup = false,
    force = false,
    frameworkRoot = projectDir,
  } = opts;

  // Pre-flight 1: discover the bundle
  const discovery = await discoverProjectLocalBundles(projectDir);
  const bundle = discovery.bundles.find(b => b.id === bundleId);
  if (!bundle) {
    return { ok: false, failureReason: 'bundle-not-found', message: `No project-local bundle '${bundleId}' under configured project-local roots` };
  }

  // Pre-flight 2: corpus path required for --to corpus
  if (to === 'corpus' && !corpusPath) {
    return { ok: false, failureReason: 'destination-required', message: '--to corpus requires a path argument' };
  }

  // Resolve destination
  const destinationParent = to === 'corpus'
    ? resolve(projectDir, corpusPath!)
    : resolve(frameworkRoot, TYPE_TO_UPSTREAM_DIR[bundle.type]);
  const destination = join(destinationParent, bundleId);

  // Pre-flight 3: destination must not already exist
  let destExists = false;
  try {
    await stat(destination);
    destExists = true;
  } catch {
    // Doesn't exist — good
  }
  if (destExists) {
    return { ok: false, failureReason: 'destination-exists', message: `Destination '${destination}' already exists. Promote refuses to overwrite — remove it first.` };
  }

  // Pre-flight 4: project-local @-references would dangle
  const refs = await findProjectLocalReferences(bundle.bundlePath);
  if (refs.length > 0 && !force) {
    return {
      ok: false,
      failureReason: 'project-local-references',
      message: `Bundle contains @.aiwg/ references that would dangle after promote: ${refs.slice(0, 3).join(', ')}${refs.length > 3 ? `, +${refs.length - 3} more` : ''}. Use --force to promote anyway.`,
    };
  }

  // Build the plan
  const sourceFiles = await walk(bundle.bundlePath);
  const sourceRels = sourceFiles.map(f => relative(bundle.bundlePath, f));
  let totalBytes = 0;
  for (const f of sourceFiles) totalBytes += await fileSize(f);

  const plan: PromotePlan = {
    bundleId,
    type: bundle.type,
    source: bundle.localPath,
    destination,
    files: sourceRels,
    totalBytes,
  };

  if (dryRun) {
    return { ok: true, plan };
  }

  // Snapshot source hashes
  const expectedHashes: Record<string, string> = {};
  for (const abs of sourceFiles) {
    const rel = relative(bundle.bundlePath, abs);
    expectedHashes[rel] = await sha256(abs);
  }

  // Copy
  try {
    await mkdir(destinationParent, { recursive: true });
    await cp(bundle.bundlePath, destination, { recursive: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await appendProjectLocalActivity({
      event: 'promote-failed',
      name: bundleId,
      type: bundle.type,
      summary: `copy failed: ${msg}`,
    });
    return { ok: false, failureReason: 'copy-failed', message: `Copy failed: ${msg}` };
  }

  // Verify hashes; roll back on mismatch
  for (const [rel, expected] of Object.entries(expectedHashes)) {
    const destAbs = join(destination, rel);
    const actual = await sha256(destAbs).catch(() => null);
    if (actual !== expected) {
      try { await rm(destination, { recursive: true, force: true }); } catch { /* best effort */ }
      await appendProjectLocalActivity({
        event: 'promote-failed',
        name: bundleId,
        type: bundle.type,
        summary: `hash mismatch on ${rel} — rolled back`,
      });
      return { ok: false, failureReason: 'hash-mismatch', message: `Hash mismatch on ${rel} after copy. Rolled back.` };
    }
  }

  // Registry update: source flips
  const entry = config.installed[bundleId];
  if (entry) {
    entry.source = to === 'upstream' ? 'bundled' : 'corpus';
    delete entry.localPath;
    delete entry.localType;
    delete entry.manifestVersion;
    // Keep artifactHashes — they remain valid for drift detection of the new install
  }

  // Cleanup source if requested
  if (cleanup) {
    try {
      await rm(bundle.bundlePath, { recursive: true, force: true });
    } catch (err) {
      // Non-fatal — promote already succeeded
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`promote --cleanup failed (non-fatal): ${msg}\n`);
    }
  }

  await appendProjectLocalActivity({
    event: 'promote',
    name: bundleId,
    type: bundle.type,
    summary: `${destination}${cleanup ? ' (source cleaned up)' : ''}`,
  });

  return { ok: true, plan, copied: sourceRels };
}
