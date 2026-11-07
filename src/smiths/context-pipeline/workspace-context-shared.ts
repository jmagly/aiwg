// Shared workspace context markers, types and safe file helpers.
import { maskCodeRegions } from './code-regions.js';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { resolveProjectAiwgDir } from '../../config/project-artifacts.js';
import { writeContextFileSync } from './context-file-safety.js';
import { dominantLineEnding, withLineEnding } from './line-endings.js';

export const WORKSPACE_MANAGED_START = '<!-- AIWG:workspace-context:start -->';
export const WORKSPACE_MANAGED_END = '<!-- AIWG:workspace-context:end -->';
export const RESIDENT_MEMORY_START = '<!-- AIWG:resident-memory:start -->';
export const RESIDENT_MEMORY_END = '<!-- AIWG:resident-memory:end -->';
export const WORKSPACE_OPERATOR_START = '<!-- AIWG:workspace-operator:start -->';
export const WORKSPACE_OPERATOR_END = '<!-- AIWG:workspace-operator:end -->';
export const PROJECT_EXTRACTION_START = '<!-- AIWG:project-extraction:start -->';
export const PROJECT_EXTRACTION_END = '<!-- AIWG:project-extraction:end -->';
export const PROVIDER_BOOTSTRAP_START = '<!-- AIWG:provider-bootstrap:start -->';
export const PROVIDER_BOOTSTRAP_END = '<!-- AIWG:provider-bootstrap:end -->';
export const WORKSPACE_SIGNATURE = '<!-- aiwg-managed -->';

export const LEGACY_ROOT_FILES = [
  'CLAUDE.md',
  'AGENTS.md',
  'AGENTS.override.md',
  'WARP.md',
  '.hermes.md',
  '.github/copilot-instructions.md',
  'AIWG.md',
] as const;

/**
 * Operator-content volume above which a provider-named source is surfaced for a scope
 * decision instead of being routed on filename alone (#2537). A genuine provider adapter
 * is a few hundred bytes; a migrated project contract is tens of KB.
 */
export const SCOPE_REVIEW_BYTES = 4096;

export const GENERATED_BLOCKS: Array<[string, string]> = [
  [PROVIDER_BOOTSTRAP_START, PROVIDER_BOOTSTRAP_END],
  ['<!-- AIWG:context-hook:start -->', '<!-- AIWG:context-hook:end -->'],
  ['<!-- AIWG:claude-md-hook:start -->', '<!-- AIWG:claude-md-hook:end -->'],
  ['<!-- BEGIN AIWG -->', '<!-- END AIWG -->'],
  [WORKSPACE_MANAGED_START, WORKSPACE_MANAGED_END],
  ['<!-- spillover-from-AGENTS.md:START -->', '<!-- spillover-from-AGENTS.md:END -->'],
];

export const PROJECT_CONTEXT_PLACEHOLDER = [
  '## Project Context',
  '',
  'Add project conventions, local hook/context pointers, and links to deeper project documents here.',
].join('\n');

export interface WorkspaceContextEnsureResult {
  path: string;
  action: 'created' | 'updated' | 'unchanged' | 'preserved';
  backupPath?: string;
  warnings: string[];
}

export interface WorkspaceContextSource {
  path: string;
  provider: string | null;
  scope: 'root' | 'nested';
  managed: boolean;
  operatorContent: string;
  checksum: string;
}

export interface WorkspaceDirectiveOverlap {
  sources: string[];
  directives: string[];
}

export interface WorkspaceDirectiveConflict {
  key: string;
  sources: Array<{ path: string; directive: string }>;
}

export interface WorkspaceContextAudit {
  version: 1;
  projectPath: string;
  workspaceExists: boolean;
  legacyCompatible: boolean;
  sources: WorkspaceContextSource[];
  identical: WorkspaceDirectiveOverlap[];
  overlaps: WorkspaceDirectiveOverlap[];
  conflicts: WorkspaceDirectiveConflict[];
  sensitiveFindings: Array<{ path: string; line?: number; evidence: string }>;
  /** True when the nested-instruction-file walk hit its depth or directory-count
   * bound before finishing (#277) — the context graph may be incomplete. */
  contextWalkTruncated: boolean;
  plan: {
    neutralSources: string[];
    providerSources: string[];
    nestedSources: string[];
    projectSources: string[];
    outputs: string[];
    /** Per-source destination and volume, so a dry run says what moves where (#2537). */
    routing: WorkspaceContextRouting[];
    /** Provider-named sources carrying enough operator content to warrant a scope decision (#2537). */
    scopeReview: WorkspaceContextRouting[];
  };
}

export interface WorkspaceContextRouting {
  source: string;
  operatorBytes: number;
  destination: string;
  /** `project-neutral` is read by every provider; `<provider>-only` is read by one. */
  scope: string;
  provider: string | null;
}

export interface ExistingProjectContext {
  content: string;
  sources: string[];
  sensitiveFindings: Array<{ path: string; evidence: string }>;
}

export interface WorkspaceMigrationManifest {
  version: 1;
  id: string;
  createdAt: string;
  projectPath: string;
  status: 'prepared' | 'applied' | 'rolled-back';
  files: Array<{
    path: string;
    existed: boolean;
    preimage: string | null;
    outputChecksum: string;
  }>;
}

export interface WorkspaceMigrationResult {
  audit: WorkspaceContextAudit;
  dryRun: boolean;
  changed: boolean;
  transactionId?: string;
  written: string[];
  backups: string[];
}

export interface WorkspaceContextDiagnostic {
  severity: 'info' | 'warning' | 'error';
  code: string;
  message: string;
  path?: string;
}

export function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export async function readOptional(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function atomicWrite(filePath: string, content: string): Promise<void> {
  writeContextFileSync(filePath, content);
}

export function resolveProjectRelative(projectPath: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) throw new Error(`Unsafe absolute migration path: ${relativePath}`);
  const root = path.resolve(projectPath);
  const resolved = path.resolve(root, relativePath);
  const artifactRoot = path.resolve(resolveProjectAiwgDir(projectPath));
  const insideProject = resolved === root || resolved.startsWith(`${root}${path.sep}`);
  const insideArtifactRoot = resolved === artifactRoot || resolved.startsWith(`${artifactRoot}${path.sep}`);
  if (!insideProject && !insideArtifactRoot) {
    throw new Error(`Unsafe migration path outside project: ${relativePath}`);
  }
  return resolved;
}

export function replaceBlock(content: string, start: string, end: string, block: string): string | null {
  const startIndex = content.indexOf(start);
  const endIndex = content.indexOf(end);
  // A one-sided marker can be operator documentation, not a managed block.
  if (startIndex < 0 || endIndex < 0) return null;
  if (endIndex < startIndex) throw new Error(`Malformed managed block: ${start} / ${end}`);
  const renderedBlock = withLineEnding(block, dominantLineEnding(content));
  return content.slice(0, startIndex) + renderedBlock + content.slice(endIndex + end.length);
}

export function stripGeneratedBlocks(content: string, preserveLines = false): string {
  let stripped = content;
  for (const [start, end] of GENERATED_BLOCKS) {
    while (stripped.includes(start) || stripped.includes(end)) {
      const startIndex = stripped.indexOf(start);
      const endIndex = stripped.indexOf(end);
      const replacement = preserveLines && startIndex >= 0 && endIndex > startIndex
        ? '\n'.repeat(stripped.slice(startIndex, endIndex + end.length).split('\n').length - 1)
        : '';
      const replaced = replaceBlock(stripped, start, end, replacement);
      if (replaced === null) break;
      stripped = replaced;
    }
  }
  const removeMetadata = (text: string) => preserveLines ? text.replace(/[^\n]/g, '') : '';
  stripped = stripped
    .replace(/^(?:\uFEFF)?<!-- aiwg-managed -->[ \t]*(?:\r?\n|$)/, removeMetadata)
    .replace(/^<!-- Generated by AIWG[^\r\n]*-->[ \t]*(?:\r?\n|$)/, removeMetadata);
  return preserveLines ? stripped : stripped.trim();
}

export function isGeneratedRootContext(relativePath: string, content: string): boolean {
  const head = maskCodeRegions(content.replace(/^\uFEFF/, '')).split('\n').slice(0, 12).join('\n');
  if (/^<!-- aiwg-managed -->\r?$/m.test(head)) return true;
  if (/<!--\s*Generated by\s+(?:AIWG|aiwg)(?:\s+use)?\b[^>]*-->/i.test(head)) return true;
  return relativePath === 'AIWG.md' && /^# AIWG Framework Context\b/m.test(head);
}
