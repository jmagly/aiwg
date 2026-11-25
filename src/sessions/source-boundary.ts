// Enforce selected directory boundaries for discovery and saved-manifest import.
import { lstat, opendir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import { SessionContractError } from './contracts.js';
import type { SessionDiscoveryManifest } from './workspace-discovery.js';

export function containsSource(root: string, locator: string): boolean {
  if (/^(?:[a-z]:[\\/]|\\\\)/i.test(root)) {
    const suffix = win32.relative(root, locator);
    return suffix === '' || (!win32.isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('..\\'));
  }
  const suffix = relative(root, locator);
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`));
}

function sameSourcePath(left: string, right: string): boolean {
  return containsSource(left, right) && containsSource(right, left);
}

export async function selectedClaudeRoots(directories?: readonly string[]): Promise<string[] | undefined> {
  if (!directories?.length) return undefined;
  const roots = [...new Set(directories.map(root => resolve(root)))].sort();
  for (const [index, root] of roots.entries()) {
    try {
      const details = await lstat(root);
      const canonical = await realpath(root);
      if (details.isSymbolicLink() || !sameSourcePath(canonical, root)) {
        throw new SessionContractError('SOURCE_SYMLINK', 'selected Claude project directories must not traverse links');
      }
      roots[index] = canonical;
      if (!details.isDirectory()) throw new SessionContractError('INVALID_ARGUMENT', 'Claude project directory must be a directory');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return [...new Set(roots)].sort();
}

export function assertClaudeRootSelection(roots: readonly string[], saved: readonly string[]): void {
  if (JSON.stringify([...new Set(roots)].sort()) !== JSON.stringify([...new Set(saved)].sort())) {
    throw new SessionContractError('INVALID_ARGUMENT', 'Claude project directories differ from the saved manifest; rediscover with --claude-project-dir');
  }
}

export async function assertClaudeManifestBoundary(manifest: SessionDiscoveryManifest, directories?: readonly string[]): Promise<void> {
  const roots = await selectedClaudeRoots(directories?.length ? directories : manifest.authorizedRoots?.claude);
  if (!roots) return;
  if (directories?.length) assertClaudeRootSelection(roots, manifest.authorizedRoots?.claude ?? []);
  for (const source of manifest.sources.filter(source => source.provider === 'claude')) {
    if (!roots.includes(source.authorizedRoot) || !roots.some(root => containsSource(root, source.locator))) {
      throw new SessionContractError('SOURCE_OUTSIDE_ALLOWED_ROOT', 'saved Claude source is outside selected project directories');
    }
    try {
      if (!sameSourcePath(await realpath(source.locator), resolve(source.locator))) {
        throw new SessionContractError('SOURCE_SYMLINK', 'saved Claude source must not traverse links');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

export async function* discoverJsonl(root: string, maxDepth: number): AsyncIterable<string> {
  const canonical = await realpath(root);
  const pending = [{ path: root, depth: 0 }];
  while (pending.length) {
    const current = pending.shift()!;
    let directory;
    try {
      const details = await lstat(current.path);
      if (details.isSymbolicLink() || !containsSource(canonical, await realpath(current.path))) continue;
      directory = await opendir(current.path);
    } catch {
      // A directory that cannot be enumerated is a reported unreadable source.
      yield current.path;
      continue;
    }
    const children: string[] = [];
    const files: string[] = [];
    for await (const entry of directory) {
      const path = resolve(current.path, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && current.depth < maxDepth) children.push(path);
      else if (entry.isFile() && /\.jsonl(?:\.[a-z0-9]+)?$/i.test(entry.name)) files.push(path);
    }
    for (const file of files.sort()) yield file;
    for (const path of children.sort()) pending.push({ path, depth: current.depth + 1 });
  }
}
