import fs from 'node:fs';
import path from 'node:path';

import { createHash } from 'node:crypto';
import { getGraphIndexDir } from './types.js';
import { frameworkSourceDigest } from './framework-source-digest.js';
import { acquireDirectoryLock, DirectoryLockContentionError } from './prebuilt-build-lock.js';
import { FRAMEWORK_CORPUS_KINDS as CORPUS_KINDS, resolveFrameworkCorpusRoot } from './framework-index-paths.js';

export { resolveFrameworkCorpusRoot } from './framework-index-paths.js';

/** Permission failures allow query callers to serve existing indexes without writes. */
export function isIndexWritePermissionError(error: unknown): boolean {
  return ['EROFS', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException | null)?.code ?? '');
}

function readText(file: string): string {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

/** Resolve HEAD without spawning git, including worktrees and packed refs. */
function gitHead(root: string): string {
  let gitDir = path.join(root, '.git');
  const pointer = readText(gitDir).trim();
  if (pointer.startsWith('gitdir: ')) gitDir = path.resolve(root, pointer.slice(8));
  const head = readText(path.join(gitDir, 'HEAD')).trim();
  if (!head.startsWith('ref: ')) return head;
  const ref = head.slice(5);
  const common = readText(path.join(gitDir, 'commondir')).trim();
  const commonDir = common ? path.resolve(gitDir, common) : gitDir;
  return readText(path.join(gitDir, ref)).trim()
    || readText(path.join(commonDir, ref)).trim()
    || readText(path.join(commonDir, 'packed-refs')).split('\n').find(line => line.endsWith(` ${ref}`))
    || head;
}

/**
 * Root/version identity plus the portable corpus digest. Its per-root stat
 * receipt avoids rereading unchanged source contents and detects uncommitted
 * edits as well as manifest/package/HEAD changes.
 */
function sourceFingerprint(root: string, sourceDigest?: string): string {
  const hash = createHash('sha256').update('framework-capabilities-v2');
  hash.update(path.resolve(root));
  try { hash.update(JSON.parse(readText(path.join(root, 'package.json'))).version ?? ''); } catch { /* fixture root */ }
  hash.update(gitHead(root));
  hash.update(sourceDigest ?? frameworkSourceDigest(root));
  for (const kind of CORPUS_KINDS) {
    const dir = path.join(root, 'agentic/code', kind);
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    hash.update(kind).update(readText(path.join(dir, 'manifest.json')));
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      hash.update(entry.name).update(readText(path.join(dir, entry.name, 'manifest.json')));
    }
  }
  return hash.digest('hex');
}

/** Stat signatures also notice manual rebuilds, deleted caches, and replacement indexes. */
function fileSignature(file: string): string {
  try {
    const stat = fs.statSync(file, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch { return ''; }
}

interface CapabilityReceipt {
  source: string;
  index: string;
  fortemi?: string;
  relations: string;
}

function readReceipt(file: string): CapabilityReceipt | null {
  try { return JSON.parse(readText(file)) as CapabilityReceipt; } catch { return null; }
}

/**
 * Reconcile only when a cheap source/index receipt changes. Contenders serve an
 * existing index after a short wait; cold starts wait for the first builder.
 * The shared directory lock recovers owners proven dead on this host.
 */
export async function refreshFrameworkCapabilities(
  root: string,
  syncFortemi = true,
  options: { force?: boolean; sourceDigest?: string } = {},
): Promise<void> {
  const corpusRoot = resolveFrameworkCorpusRoot(root);
  if (!corpusRoot) return;
  root = corpusRoot;
  const dir = getGraphIndexDir(root, 'framework');
  const receiptPath = path.join(dir, 'capability-sources.json');
  const metadataPath = path.join(dir, 'metadata.json');
  const fortemiDir = path.join(path.dirname(dir), 'fortemi-core', 'framework');
  const fortemiSignature = (): string => [
    'manifest.json', 'aiwg-fortemi-index-v2.json',
  ].map(file => fileSignature(path.join(fortemiDir, file))).join('|');
  const source = sourceFingerprint(root, options.sourceDigest);
  const current = (): CapabilityReceipt => ({
    source, index: fileSignature(metadataPath), relations: fileSignature(path.join(dir, 'relations.json')), ...(syncFortemi ? { fortemi: fortemiSignature() } : {}),
  });
  const matches = (receipt: CapabilityReceipt | null, probe: CapabilityReceipt): boolean =>
    Boolean(!options.force && receipt && probe.index && probe.relations && receipt.relations === probe.relations && receipt.source === probe.source
      && receipt.index === probe.index && (!syncFortemi || receipt.fortemi === probe.fortemi));
  if (matches(readReceipt(receiptPath), current())) return;

  let release: () => Promise<void>;
  try {
    release = await acquireDirectoryLock(path.join(dir, 'capability-refresh.lock'), {
      timeoutMs: fs.existsSync(metadataPath) ? 150 : 60_000,
      pollMs: 25,
      reclaimDeadOwner: true,
    });
  } catch (error) {
    if (error instanceof DirectoryLockContentionError && fs.existsSync(metadataPath)) return;
    throw error;
  }
  try {
    // Another process may have completed reconciliation while we waited.
    const receipt = readReceipt(receiptPath);
    const probe = current();
    if (matches(receipt, probe)) return;
    if (options.force || !receipt || !probe.index || receipt.source !== source || receipt.index !== probe.index || !probe.relations || receipt.relations !== probe.relations) {
      const { buildIndex } = await import('./index-builder.js');
      await buildIndex(root, { graph: 'framework', explicit: false, quiet: true });
    }
    // A forced source scan can be a no-op. The prior successful receipt still
    // validates the exact index/export files, so avoid hashing the export again.
    const updated = current();
    const cacheUnchanged = receipt && updated.index && receipt.source === source
      && receipt.index === updated.index && receipt.fortemi === updated.fortemi;
    if (syncFortemi && !cacheUnchanged) {
      const { getFortemiCoreSyncStatus, syncFortemiCoreIndex } = await import('./fortemi-core-sync.js');
      const status = getFortemiCoreSyncStatus(root, 'framework');
      const indexChanged = receipt?.index ? receipt.index !== updated.index : probe.index !== updated.index;
      if (indexChanged || !status.built || status.stale) syncFortemiCoreIndex(root, { graph: 'framework' });
    }
    // Publish only after success. A failed rebuild/sync is retried next call.
    const temp = `${receiptPath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(current()));
    fs.renameSync(temp, receiptPath);
  } finally {
    await release();
  }
}

/** Installation is recorded in project config, independently of index coverage. */
export async function isCorpusBundleInstalled(
  cwd: string,
  root: string,
  kind: 'framework' | 'addon' | 'extension' | 'plugin' | null,
  id: string | null,
): Promise<boolean> {
  if (!kind || !id) return false;
  const { readAiwgConfigCandidate } = await import('../config/aiwg-config.js');
  const config = await readAiwgConfigCandidate(cwd);
  if (!config) return false;
  // Every normal deployment includes aiwg-utils, even when only the requested
  // framework is recorded. Standard skills are loaded from the source corpus.
  if (kind === 'addon' && id === 'aiwg-utils' && Object.values(config.installed).some(entry =>
    Object.values(entry.deployedTo ?? {}).some(deployment => deployment.skipUtils !== true))) return true;
  if (config.installed[id] || (kind === 'framework' && config.installed.all)) return true;
  try {
    const manifest = JSON.parse(fs.readFileSync(
      path.join(root, 'agentic/code', `${kind}s`, id, 'manifest.json'), 'utf8',
    )) as { modeAliases?: string[] };
    return (manifest.modeAliases ?? []).some(alias => Boolean(config.installed[alias]));
  } catch {
    return false;
  }
}
