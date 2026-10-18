/**
 * Shared artifact source-file enumeration.
 *
 * Index builds and coverage reporting must use the same file set so project
 * context files cannot inflate the indexed count beyond the reported total.
 *
 * @implements jmagly/aiwg#146
 */

import fs from 'fs';
import path from 'path';
import {
  DEFAULT_INDEX_EXTENSIONS,
  GRAPH_CONFIGS,
  type GraphType,
  resolveGraphScanDir,
} from './types.js';
import {
  DEFAULT_PROJECT_AIWG_DIR,
  resolveProjectAiwgDir,
} from '../config/project-artifacts.js';
import { dropGitignored } from '../config/gitignore.js';
import { workspaceLinkedFiles } from '../smiths/context-pipeline/workspace-context.js';
import { discoverProjectLocalBundles } from '../extensions/project-local-discovery.js';

function pathContains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join('/');
}

export function indexPathFor(cwd: string, fullPath: string, graph?: GraphType): string {
  if (!graph || graph === 'project') {
    const artifactRoot = resolveProjectAiwgDir(cwd);
    if (pathContains(artifactRoot, fullPath)) {
      const relative = toPosixPath(path.relative(artifactRoot, fullPath));
      return relative ? `${DEFAULT_PROJECT_AIWG_DIR}/${relative}` : DEFAULT_PROJECT_AIWG_DIR;
    }
  }
  const relative = path.relative(cwd, fullPath);
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) return toPosixPath(relative);
  return fullPath;
}

export function findArtifactFiles(
  dir: string,
  extensions: readonly string[] = DEFAULT_INDEX_EXTENSIONS,
  acceptPath: (file: string) => boolean = () => true,
): string[] {
  return walkArtifactFiles(dir, extensions, new Set(), acceptPath);
}

/** Recursively find indexable files, excluding hidden directories such as .index. */
function walkArtifactFiles(
  dir: string,
  extensions: readonly string[],
  seenRealDirs: Set<string>,
  acceptPath: (file: string) => boolean,
): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir) || !acceptPath(dir)) return results;

  let realDir: string;
  try {
    if (fs.lstatSync(dir).isSymbolicLink()) return results;
    realDir = fs.realpathSync(dir);
  } catch {
    return results;
  }
  if (seenRealDirs.has(realDir)) return results;
  seenRealDirs.add(realDir);

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink() || !acceptPath(fullPath)) continue;
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (entry.name.startsWith('.')) continue;
      results.push(...walkArtifactFiles(fullPath, extensions, seenRealDirs, acceptPath));
    } else if (stat.isFile() && extensions.some(extension => entry.name.endsWith(extension))) {
      results.push(fullPath);
    }
  }
  return results;
}

/** Runtime and acquisition scratch beneath either the local or relocated artifact root. */
export const INDEX_SCRATCH_DIRS = [
  'working', 'sessions', 'scratch', 'tmp', 'temp', 'cache', '.index', '.cache', '.storage-cache',
] as const;

export interface ArtifactDiscoveryOptions {
  scope?: string;
  includeIgnored?: boolean;
}

/** Return the exact current source-file set used by a standard graph build. */
export async function collectGraphIndexFiles(
  cwd: string,
  graph?: GraphType,
  options: ArtifactDiscoveryOptions = {},
): Promise<string[]> {
  const config = graph ? GRAPH_CONFIGS[graph] : undefined;
  if (graph && !config) {
    throw new Error(`Unknown graph: ${graph}`);
  }
  const artifactRoot = resolveProjectAiwgDir(cwd);
  const excludedDirs = [path.join(cwd, DEFAULT_PROJECT_AIWG_DIR), artifactRoot]
    .flatMap(root => INDEX_SCRATCH_DIRS.map(name => path.resolve(root, name)));
  const acceptPath = (file: string): boolean => {
    if (excludedDirs.some(dir => pathContains(dir, file))) return false;
    // Explicit scopes and workspace links can start below a symlink. Check
    // their ancestors too, stopping at the authorized root (which may be external).
    const root = pathContains(artifactRoot, file) ? artifactRoot : cwd;
    let current = file;
    while (pathContains(root, current)) {
      try {
        if (fs.lstatSync(current).isSymbolicLink()) return false;
      } catch {
        return false;
      }
      if (current === root) break;
      current = path.dirname(current);
    }
    return true;
  };
  const scanDirs = options.scope
    ? [path.resolve(cwd, options.scope)]
    : config
      ? config.scanDirs.map(directory => resolveGraphScanDir(cwd, directory))
      : [artifactRoot];
  const extensions = options.scope ? DEFAULT_INDEX_EXTENSIONS : config?.extensions ?? DEFAULT_INDEX_EXTENSIONS;
  const files = new Set<string>();
  const ignoreRoots = new Set([cwd, ...scanDirs.filter(dir => !pathContains(cwd, dir))]);

  for (const scanDir of scanDirs) {
    for (const file of findArtifactFiles(scanDir, extensions, acceptPath)) files.add(file);
  }

  if (!options.scope && (!graph || graph === 'project')) {
    // Additional search roots authorize bundle payloads, not the surrounding
    // external corpus. Reuse deployment's validated source resolution, including
    // plugin payloads, and prevent payload symlinks from escaping that boundary.
    const { bundles } = await discoverProjectLocalBundles(cwd);
    for (const bundle of bundles) {
      if (scanDirs.some(scanDir => pathContains(scanDir, bundle.artifactPath))) continue;
      if (!pathContains(cwd, bundle.artifactPath)) ignoreRoots.add(bundle.artifactPath);
      for (const file of findArtifactFiles(bundle.artifactPath, extensions, acceptPath)) {
        files.add(file);
      }
    }

    const workspacePath = path.join(cwd, 'WORKSPACE.md');
    const contextFiles = [
      ...(fs.existsSync(workspacePath) ? [workspacePath] : []),
      ...await workspaceLinkedFiles(cwd),
    ];
    for (const contextFile of contextFiles) {
      if (acceptPath(contextFile) && extensions.some(extension => contextFile.endsWith(extension))) files.add(contextFile);
    }
  }

  let sources = [...files];
  if (!options.includeIgnored) {
    // Many projects ignore the whole artifact root (`.aiwg/`). Honoring that
    // would empty the index, so ignore rules apply only beneath a scan root
    // that is not itself ignored; runtime directories are excluded regardless.
    const exemptRoots = options.scope ? [] : scanDirs.filter(dir =>
      fs.existsSync(dir) && dropGitignored(path.dirname(dir), [dir]).length === 0);
    const isExempt = (file: string): boolean => exemptRoots.some(dir => pathContains(dir, file));
    // Git rejects paths outside its worktree. Filter authorized external roots
    // separately so they cannot disable ignore filtering for local sources.
    for (const root of ignoreRoots) {
      const candidates = sources.filter(file => pathContains(root, file) && !isExempt(file));
      const kept = new Set(dropGitignored(root, candidates));
      sources = sources.filter(file => !pathContains(root, file) || isExempt(file) || kept.has(file));
    }
  }
  return sources;
}
