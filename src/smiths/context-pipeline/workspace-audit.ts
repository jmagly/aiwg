// Audit workspace instruction sources and directive overlap.
import { existsSync, promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { projectAiwgPath, resolveProjectAiwgDir } from '../../config/project-artifacts.js';
import { listProviderDefinitions } from '../../providers/provider-definitions.js';
import {
  isGeneratedRootContext,
  LEGACY_ROOT_FILES,
  readOptional,
  SCOPE_REVIEW_BYTES,
  sha256,
  stripGeneratedBlocks,
  WORKSPACE_OPERATOR_END,
  WORKSPACE_OPERATOR_START,
  WORKSPACE_SIGNATURE,
  WorkspaceContextAudit,
  WorkspaceContextRouting,
  WorkspaceContextSource,
  WorkspaceDirectiveOverlap,
} from './workspace-context-shared.js';
import { providerForPath } from './workspace-document.js';
import { extractExistingProjectContext } from './workspace-extraction.js';
import { projectOutputPath } from './workspace-migration.js';

export function directives(content: string): string[] {
  return [...new Set(content
    .split('\n')
    .map((line) => line.replace(/^\s*[-*+]\s+/, '').replace(/^#+\s+/, '').trim())
    .filter((line) => line.length >= 8 && !line.startsWith('<!--') && !/^https?:\/\//i.test(line)))];
}

export function directiveKey(directive: string): string | null {
  if (!/^(always|never|must|do not|don't|required|prefer|use|avoid|keep|preserve)\b/i.test(directive)) return null;
  return directive.toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/^(?:always|never|must|required|prefer|avoid|keep|preserve|do not|dont)\s+/, '')
    .replace(/^use\s+/, '')
    .split(/\s+/).slice(0, 5).join(' ');
}

export function directivePolarity(directive: string): 'positive' | 'negative' {
  return /^(?:never|do not|don't|avoid)\b/i.test(directive) ? 'negative' : 'positive';
}

export function sensitiveEvidence(content: string): string[] {
  return sensitiveLineEvidence(content).map((finding) => finding.evidence);
}

function sensitiveLineEvidence(content: string): Array<{ line: number; evidence: string }> {
  const findings: Array<{ line: number; evidence: string }> = [];
  for (const [index, line] of content.split('\n').entries()) {
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(line)) {
      findings.push({ line: index + 1, evidence: `private-key material (${sha256(line).slice(0, 12)})` });
    }
    // Inspect whole values before applying the length threshold: ellipses and
    // redaction characters are documentation, including inside quoted agent bodies.
    const assignments = line.matchAll(/\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?([A-Za-z0-9_\-/.+=…*]+)/gi);
    for (const [, value] of assignments) {
      if (value.length < 12 || /(?:\.{3}|…)$/.test(value)
        || /^(?:example|placeholder|\*{3})/i.test(value) || /^x+$/i.test(value)
        || (value.match(/\./g)?.length ?? 0) > value.length / 2) continue;
      findings.push({ line: index + 1, evidence: `credential-like assignment (${sha256(line).slice(0, 12)})` });
      break;
    }
  }
  return findings;
}

function operatorContext(relativePath: string, content: string, preserveLines = false): string {
  if (relativePath === 'WORKSPACE.md') {
    const start = content.indexOf(WORKSPACE_OPERATOR_START);
    const end = content.indexOf(WORKSPACE_OPERATOR_END);
    if (start >= 0 && end > start) {
      const offset = start + WORKSPACE_OPERATOR_START.length;
      const body = content.slice(offset, end);
      return preserveLines
        ? '\n'.repeat(content.slice(0, offset).split('\n').length - 1) + stripGeneratedBlocks(body, true)
        : body.trim();
    }
    return stripGeneratedBlocks(content, preserveLines);
  }
  return isGeneratedRootContext(relativePath, content) ? '' : stripGeneratedBlocks(content, preserveLines);
}

// Directory names the context-graph walk always skips, regardless of where
// the walk root is: VCS/build output that is never hand-authored project
// content (#277, pre-existing) plus two reserved, self-identifying names
// that are never legitimately a real project directory.
export const CONTEXT_WALK_ALWAYS_IGNORED_DIR_NAMES = new Set([
  '.git', 'node_modules', 'dist', 'build', 'coverage', '.aiwg',
]);

// Cache/registry directory names that are only skipped when the walk root
// is the home directory itself (#277 fix-round). A project subtree that
// happens to be named `.cache`, `target`, `.gradle`, etc. is NOT generated
// data and must still be scanned — these names are only reliably "cache,
// not project" when they sit directly under $HOME. `Library/Caches` and
// `.local/share` are two-segment (parent + name) patterns, handled
// separately below.
export const HOME_LEVEL_CACHE_DIR_NAMES = new Set([
  '.cache', '.cargo', '.rustup', '.npm', '.nvm', '.pnpm-store',
  '.gradle', '.m2', 'Trash',
]);

/** True when `dirPath` contains `markerFile` — a cheap, synchronous, read-only check. */
export function hasMarkerFile(dirPath: string, markerFile: string): boolean {
  return existsSync(path.join(dirPath, markerFile));
}

/** A `target` directory is Cargo/build output only when it carries the
 * standard `CACHEDIR.TAG` marker, or sits next to a `Cargo.toml` — not
 * merely because it is named `target` (#277 fix-round). */
export function isGeneratedTargetDir(dirPath: string): boolean {
  if (hasMarkerFile(dirPath, 'CACHEDIR.TAG')) return true;
  return existsSync(path.join(path.dirname(dirPath), 'Cargo.toml'));
}

/** A `venv`/`.venv` directory is a Python virtualenv only when it carries
 * `pyvenv.cfg` — not merely because of its name (#277 fix-round). */
export function isPythonVenvDir(dirPath: string): boolean {
  return hasMarkerFile(dirPath, 'pyvenv.cfg');
}

/**
 * Whether the context-graph walk should skip `entryName` (a directory
 * directly under `directory`) without descending into it.
 *
 * `isHomeRoot` gates the home-level cache list and the `Library/Caches` /
 * `.local/share` two-segment patterns — they apply only when the overall
 * walk root is $HOME, never for an arbitrary project subtree that happens
 * to share one of those names (#277 fix-round).
 */
export function shouldSkipContextWalkDir(directory: string, entryName: string, isHomeRoot: boolean): boolean {
  if (CONTEXT_WALK_ALWAYS_IGNORED_DIR_NAMES.has(entryName)) return true;
  if (entryName.startsWith('.context-migration-')) return true;
  const childPath = path.join(directory, entryName);
  if (entryName === 'target' && isGeneratedTargetDir(childPath)) return true;
  if ((entryName === 'venv' || entryName === '.venv') && isPythonVenvDir(childPath)) return true;
  // Codex's own plugin/temp scratch — a known, specific noise source named
  // in the original report, not a broad `.tmp` exclusion (#277 fix-round).
  if (entryName === '.tmp' && path.basename(directory) === '.codex') return true;
  if (isHomeRoot) {
    if (HOME_LEVEL_CACHE_DIR_NAMES.has(entryName)) return true;
    if (entryName === 'Caches' && path.basename(directory) === 'Library') return true;
    if (entryName === 'share' && path.basename(directory) === '.local') return true;
  }
  return false;
}

/** Walk depth/entry bounds for the context-graph walk (#277). A hit sets
 * `truncated: true` on the result instead of silently stopping. Overridable
 * via environment for tests that need to exercise the bound without
 * building a correspondingly large fixture tree. */
export function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
export const CONTEXT_WALK_MAX_DEPTH = readPositiveIntEnv('AIWG_CONTEXT_WALK_MAX_DEPTH', 10);
export const CONTEXT_WALK_MAX_DIRECTORIES = readPositiveIntEnv('AIWG_CONTEXT_WALK_MAX_DIRECTORIES', 20_000);

export interface NestedInstructionFilesResult {
  files: string[];
  truncated: boolean;
}

export async function nestedInstructionFiles(projectPath: string): Promise<NestedInstructionFilesResult> {
  const found: string[] = [];
  const artifactRoot = path.resolve(resolveProjectAiwgDir(projectPath));
  // Running from $HOME is the exact shape of #277: bound the walk to the
  // top level and apply the home-level cache exclusions instead of
  // recursing into every cache/registry/venv underneath it. A markerless
  // but otherwise ordinary (non-home) project root keeps the full bounded
  // walk — "no project marker" is not evidence the directory is generated
  // data (#277 fix-round).
  const isHomeDirectory = path.resolve(projectPath) === path.resolve(homedir());
  const maxDepth = isHomeDirectory ? 1 : CONTEXT_WALK_MAX_DEPTH;
  let visitedDirectories = 0;
  let truncated = false;
  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > maxDepth || visitedDirectories >= CONTEXT_WALK_MAX_DIRECTORIES) {
      truncated = true;
      return;
    }
    visitedDirectories += 1;
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      // Dirent.isDirectory() is false for symlinks (it reflects the entry
      // itself, not its target), so symlinked directories are never
      // followed out of the root by this walk.
      if (entry.isDirectory()) {
        const child = path.join(directory, entry.name);
        if (
          !shouldSkipContextWalkDir(directory, entry.name, isHomeDirectory)
          && path.resolve(child) !== artifactRoot
        ) await walk(child, depth + 1);
      } else if (['AGENTS.md', 'CLAUDE.md', 'WARP.md'].includes(entry.name)) {
        const relative = path.relative(projectPath, path.join(directory, entry.name)).replace(/\\/g, '/');
        const segments = relative.split('/');
        const generatedArtifactPath = segments.includes('templates') || segments.includes('fixtures');
        if (!generatedArtifactPath && !LEGACY_ROOT_FILES.includes(relative as typeof LEGACY_ROOT_FILES[number])) found.push(relative);
      }
    }
  }
  await walk(projectPath, 1);
  return { files: found.sort((a, b) => a.localeCompare(b)), truncated };
}

export async function migratedProviderFiles(projectPath: string): Promise<string[]> {
  const directory = projectAiwgPath(projectPath, 'context', 'providers');
  try {
    return (await fs.readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => projectOutputPath(projectPath, path.join(directory, entry.name)))
      .sort();
  } catch {
    return [];
  }
}

export async function auditWorkspaceContext(projectPath: string): Promise<WorkspaceContextAudit> {
  const extractedProject = await extractExistingProjectContext(projectPath);
  const nested = await nestedInstructionFiles(projectPath);
  const candidates = new Set<string>([
    'WORKSPACE.md',
    ...LEGACY_ROOT_FILES,
    ...nested.files,
    ...await migratedProviderFiles(projectPath),
  ]);
  const sources: WorkspaceContextSource[] = [];
  const sensitiveFindings: WorkspaceContextAudit['sensitiveFindings'] = [...extractedProject.sensitiveFindings];
  for (const relativePath of [...candidates].sort((a, b) => a.localeCompare(b))) {
    const content = await readOptional(path.join(projectPath, relativePath));
    if (content === null) continue;
    const operatorContent = operatorContext(relativePath, content);
    for (const finding of sensitiveLineEvidence(operatorContext(relativePath, content, true))) {
      sensitiveFindings.push({ path: relativePath, ...finding });
    }
    sources.push({
      path: relativePath,
      provider: providerForPath(relativePath),
      scope: LEGACY_ROOT_FILES.includes(relativePath as typeof LEGACY_ROOT_FILES[number]) || relativePath === 'WORKSPACE.md' ? 'root' : 'nested',
      managed: content.includes(WORKSPACE_SIGNATURE) || content.includes('AIWG:context-hook:start') || content.includes('AIWG:claude-md-hook:start'),
      operatorContent,
      checksum: sha256(content),
    });
  }

  const byDirective = new Map<string, string[]>();
  for (const source of sources) {
    for (const directive of directives(source.operatorContent)) {
      const paths = byDirective.get(directive) ?? [];
      paths.push(source.path);
      byDirective.set(directive, paths);
    }
  }
  const identical = [...byDirective]
    .filter(([, paths]) => paths.length > 1)
    .map(([directive, paths]) => ({ sources: [...paths].sort(), directives: [directive] }));

  const overlaps: WorkspaceDirectiveOverlap[] = [];
  for (let index = 0; index < sources.length; index += 1) {
    const left = new Set(directives(sources[index].operatorContent));
    for (let rightIndex = index + 1; rightIndex < sources.length; rightIndex += 1) {
      const common = directives(sources[rightIndex].operatorContent).filter((item) => left.has(item));
      if (common.length > 0) overlaps.push({ sources: [sources[index].path, sources[rightIndex].path], directives: common.sort() });
    }
  }

  const conflictMap = new Map<string, Array<{ path: string; directive: string; polarity: 'positive' | 'negative' }>>();
  for (const source of sources) {
    for (const directive of directives(source.operatorContent)) {
      const key = directiveKey(directive);
      if (!key) continue;
      const values = conflictMap.get(key) ?? [];
      values.push({ path: source.path, directive, polarity: directivePolarity(directive) });
      conflictMap.set(key, values);
    }
  }
  const conflicts = [...conflictMap]
    .filter(([, values]) => new Set(values.map((value) => value.polarity)).size > 1)
    .map(([key, values]) => ({ key, sources: values.map(({ path: sourcePath, directive }) => ({ path: sourcePath, directive })).sort((a, b) => a.path.localeCompare(b.path)) }));

  const rootOperator = sources.filter((source) => source.scope === 'root' && source.operatorContent.trim());
  // Provider startup files (CLAUDE.md, AGENTS.md, WARP.md, …) are bootstrap
  // surfaces: AIWG rewrites them to a managed bootstrap that `@`-imports
  // WORKSPACE.md. The operator content they carried therefore ports into the
  // WORKSPACE.md operator block, which every provider bootstrap loads and
  // which `aiwg use` and `aiwg regenerate` preserve byte-for-byte. Routing
  // it to `.aiwg/context/providers/` instead left it linked but never
  // loaded, and a later `aiwg use` dropped even the link (#2558).
  const neutralSources = rootOperator.map((source) => source.path);
  const providerSources: string[] = [];
  const providerOutputs: string[] = [];
  const workspaceExists = sources.some((source) => source.path === 'WORKSPACE.md');

  // Report volume and destination per source. A substantial provider-named
  // body is still surfaced for review (#2537): it now lands where every
  // provider reads it, so anything genuinely provider-only should be moved to
  // `.aiwg/context/providers/` by the operator after migration.
  const routing: WorkspaceContextRouting[] = rootOperator.map((source) => ({
    source: source.path,
    operatorBytes: Buffer.byteLength(source.operatorContent, 'utf8'),
    destination: 'WORKSPACE.md',
    scope: 'project-neutral',
    provider: source.path === 'WORKSPACE.md' ? null : source.provider,
  })).sort((a, b) => b.operatorBytes - a.operatorBytes);
  const scopeReview = routing.filter((entry) => entry.source !== 'WORKSPACE.md' && entry.operatorBytes >= SCOPE_REVIEW_BYTES);

  return {
    version: 1,
    projectPath,
    workspaceExists,
    legacyCompatible: !workspaceExists && sources.some((source) => LEGACY_ROOT_FILES.includes(source.path as typeof LEGACY_ROOT_FILES[number])),
    sources,
    identical,
    overlaps,
    conflicts,
    sensitiveFindings,
    contextWalkTruncated: nested.truncated,
    plan: {
      routing,
      scopeReview,
      neutralSources,
      providerSources,
      nestedSources: sources.filter((source) => source.scope === 'nested').map((source) => source.path),
      projectSources: extractedProject.sources,
      outputs: ['WORKSPACE.md', ...providerOutputs, ...listProviderDefinitions().flatMap((definition) => definition.context.bootstrapTargets)].filter((value, index, all) => all.indexOf(value) === index).sort(),
    },
  };
}
