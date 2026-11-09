// Stage, apply and roll back transactional workspace adoption.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { readAiwgConfig } from '../../config/aiwg-config.js';
import { projectAiwgPath, projectControlPath } from '../../config/project-artifacts.js';
import { getProviderDefinition } from '../../providers/provider-definitions.js';
import { buildAiwgMdContent } from './aiwg-md.js';
import { writeContextFileSync } from './context-file-safety.js';
import { readAiwgOperatorNotes } from './finalization.js';
import { auditWorkspaceContext } from './workspace-audit.js';
import { buildProviderBootstrapFile } from './workspace-bootstrap.js';
import {
  atomicWrite,
  PROJECT_CONTEXT_PLACEHOLDER,
  readOptional,
  resolveProjectRelative,
  sha256,
  WorkspaceContextAudit,
  WorkspaceMigrationManifest,
  WorkspaceMigrationResult,
} from './workspace-context-shared.js';
import { buildWorkspaceDocument, residentMemoryForRegeneration } from './workspace-document.js';
import { extractExistingProjectContext, mergeProjectExtraction } from './workspace-extraction.js';

export function projectOutputPath(projectPath: string, absPath: string): string {
  return path.relative(projectPath, absPath).replace(/\\/g, '/');
}

export const LEGACY_PROJECT_CONTEXT_PLACEHOLDER = [
  '## Project Context',
  '',
  'Add provider-neutral project conventions and links here.',
].join('\n');

/**
 * Operator content for the WORKSPACE.md operator block after migration.
 *
 * Existing WORKSPACE.md operator content is kept verbatim; the operator body
 * of each provider startup file is appended once, verbatim, under an
 * attributed heading. Tables, procedures, and code blocks survive intact —
 * the earlier line-flattened directive list lost exactly the runbook content
 * operators keep in CLAUDE.md (#2558). Re-running the migration is a no-op:
 * a body that already appears in the block is not appended again.
 */
export function neutralMigrationContent(audit: WorkspaceContextAudit): string {
  const workspace = audit.sources.find((source) => source.path === 'WORKSPACE.md');
  let base = workspace?.operatorContent.trim() ?? '';
  if (base === PROJECT_CONTEXT_PLACEHOLDER || base === LEGACY_PROJECT_CONTEXT_PLACEHOLDER) base = '';
  const sections: string[] = [];
  let accumulated = base;
  for (const source of audit.sources) {
    if (source.path === 'WORKSPACE.md' || !audit.plan.neutralSources.includes(source.path)) continue;
    const body = source.operatorContent.trim();
    if (!body || accumulated.includes(body)) continue;
    sections.push([
      `### Migrated from ${source.path}`,
      '',
      `Source attribution: migrated from \`${source.path}\`; checksum \`${source.checksum}\`.`,
      '',
      body,
    ].join('\n'));
    accumulated = `${accumulated}\n${body}`;
  }
  const parts = [base || '## Project Context', ...sections];
  if (!base && sections.length === 0) {
    parts.push('Add project conventions, local hook/context pointers, and links to deeper project documents here.');
  }
  return parts.join('\n\n').trim();
}

export async function configuredProviders(projectPath: string): Promise<string[]> {
  try {
    const config = await readAiwgConfig(projectPath);
    if (config) return config.providers.filter((provider): provider is string => typeof provider === 'string');
  } catch {
    // Audit/migration reports malformed provider config through the normal CLI path.
  }
  return ['claude'];
}

export async function stageMigrationWrites(
  projectPath: string,
  audit: WorkspaceContextAudit,
  options: { extractProject?: boolean; includeGeneratedContext?: boolean } = {},
): Promise<Map<string, string>> {
  const writes = new Map<string, string>();
  const providerFiles = [...new Set(
    audit.sources.filter((source) => source.path.replace(/\\/g, '/').includes('/context/providers/')).map((source) => source.path),
  )].sort();
  let workspaceOperatorContent = neutralMigrationContent(audit);
  if (options.extractProject) {
    const extracted = await extractExistingProjectContext(projectPath);
    workspaceOperatorContent = mergeProjectExtraction(workspaceOperatorContent, extracted.content);
  }
  writes.set('WORKSPACE.md', buildWorkspaceDocument(projectPath, workspaceOperatorContent, providerFiles, await residentMemoryForRegeneration(projectPath)));

  const providers = await configuredProviders(projectPath);
  const targetProviders = new Map<string, string[]>();
  for (const provider of providers) {
    const definition = getProviderDefinition(provider);
    if (!definition) continue;
    for (const target of definition.context.bootstrapTargets) {
      const values = targetProviders.get(target) ?? [];
      values.push(provider);
      targetProviders.set(target, values);
    }
  }
  for (const [target, targetProviderIds] of targetProviders) {
    // Shared AGENTS.md is deliberately provider-neutral prose so sequential
    // multi-provider deployment cannot make the last provider win.
    const provider = targetProviderIds.length === 1 ? targetProviderIds[0] : 'generic';
    const content = buildProviderBootstrapFile(provider);
    writes.set(target, content);
  }

  // Any detected operator-owned root startup file participates in the explicit
  // adoption even when that provider is not currently enabled. Its authored
  // content is already staged in an attributed provider file above; replacing
  // the active root with a bootstrap completes the move and prevents two
  // divergent sources of truth.
  for (const source of audit.sources.filter((item) => audit.plan.providerSources.includes(item.path))) {
    if (source.scope === 'root' && source.provider && source.path !== 'AIWG.md' && !targetProviders.has(source.path)) {
      writes.set(source.path, buildProviderBootstrapFile(source.provider));
    }
  }

  const activeCodexOverride = audit.sources.find((source) => source.path === 'AGENTS.override.md' && source.operatorContent.trim());
  if (providers.includes('codex') && activeCodexOverride) {
    writes.set('AGENTS.override.md', buildProviderBootstrapFile('codex'));
  }

  for (const provider of providers) {
    const contract = getProviderDefinition(provider)?.context;
    if (!contract?.configRegistration) continue;
    const configPath = contract.configRegistration.file;
    const existing = await readOptional(path.join(projectPath, configPath));
    let config: Record<string, unknown> = {};
    if (existing !== null) config = JSON.parse(existing) as Record<string, unknown>;
    const key = contract.configRegistration.key;
    const current = Array.isArray(config[key]) ? (config[key] as unknown[]).filter((item): item is string => typeof item === 'string') : [];
    config[key] = [...new Set([...current, 'WORKSPACE.md', 'AIWG.md'])];
    if (!('$schema' in config) && path.basename(configPath) === 'opencode.json') config = { $schema: 'https://opencode.ai/config.json', ...config };
    writes.set(configPath, `${JSON.stringify(config, null, 2)}\n`);
  }
  if (options.includeGeneratedContext) {
    const normalizedPath = projectOutputPath(projectPath, projectControlPath(projectPath, 'AIWG.md'));
    const { existing, notes } = await readAiwgOperatorNotes(projectPath);
    if (existing !== null && existing !== notes) writes.set(normalizedPath, notes);
    const stagedClaude = writes.has('CLAUDE.md')
      ? writes.get('CLAUDE.md') as string
      : await readOptional(path.join(projectPath, 'CLAUDE.md'));
    writes.set('AIWG.md', await buildAiwgMdContent(projectPath, stagedClaude));
  }
  return writes;
}

export function safePreimageName(relativePath: string): string {
  return `${sha256(relativePath).slice(0, 16)}-${path.basename(relativePath)}`;
}

export async function migrateWorkspaceContext(
  projectPath: string,
  options: {
    dryRun?: boolean;
    apply?: boolean;
    allowConflicts?: boolean;
    extractProject?: boolean;
    includeGeneratedContext?: boolean;
  } = {},
): Promise<WorkspaceMigrationResult> {
  const audit = await auditWorkspaceContext(projectPath);
  const sensitiveFindingCount = audit.sensitiveFindings.length;
  if (sensitiveFindingCount > 0) {
    const locations = audit.sensitiveFindings.map((finding) => finding.line ? `${finding.path}:${finding.line}` : finding.path);
    throw new Error(`Migration refused: ${sensitiveFindingCount} possible secret/credential value(s) found in ${locations.join(', ')}. Remove them before migration.`);
  }
  if (audit.conflicts.length > 0 && !options.allowConflicts) {
    throw new Error(`Migration refused: ${audit.conflicts.length} ambiguous directive conflict(s). Review the deterministic audit or pass --allow-conflicts to preserve each source separately.`);
  }
  const writes = await stageMigrationWrites(projectPath, audit, {
    extractProject: options.extractProject,
    includeGeneratedContext: options.includeGeneratedContext,
  });
  const changedEntries: Array<[string, string]> = [];
  for (const [relativePath, content] of writes) {
    if (await readOptional(path.join(projectPath, relativePath)) !== content) changedEntries.push([relativePath, content]);
  }
  if (options.dryRun || !options.apply) {
    return { audit, dryRun: true, changed: changedEntries.length > 0, written: changedEntries.map(([relative]) => relative), backups: [] };
  }
  if (changedEntries.length === 0) return { audit, dryRun: false, changed: false, written: [], backups: [] };

  const createdAt = new Date().toISOString();
  const id = `${createdAt.replace(/[:.]/g, '-')}-${sha256(JSON.stringify(audit.plan)).slice(0, 8)}`;
  const transactionDir = projectAiwgPath(projectPath, 'context-migrations', id);
  const preimageDir = path.join(transactionDir, 'preimages');
  await fs.mkdir(preimageDir, { recursive: true });
  const manifest: WorkspaceMigrationManifest = { version: 1, id, createdAt, projectPath, status: 'prepared', files: [] };
  const backups: string[] = [];
  for (const [relativePath, content] of changedEntries) {
    const target = path.join(projectPath, relativePath);
    const existing = await readOptional(target);
    let preimage: string | null = null;
    if (existing !== null) {
      preimage = path.relative(projectPath, path.join(preimageDir, safePreimageName(relativePath))).replace(/\\/g, '/');
      writeContextFileSync(path.join(projectPath, preimage), existing, 'utf8');
      backups.push(preimage);
    }
    manifest.files.push({ path: relativePath, existed: existing !== null, preimage, outputChecksum: sha256(content) });
  }
  const manifestPath = path.join(transactionDir, 'manifest.json');
  await atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  try {
    for (const [relativePath, content] of changedEntries.sort(([left], [right]) => left.localeCompare(right))) {
      await atomicWrite(path.join(projectPath, relativePath), content);
    }
    manifest.status = 'applied';
    await atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  } catch (error) {
    await restoreMigrationManifest(projectPath, manifest);
    throw error;
  }
  return { audit, dryRun: false, changed: true, transactionId: id, written: changedEntries.map(([relative]) => relative).sort(), backups };
}

export async function restoreMigrationManifest(projectPath: string, manifest: WorkspaceMigrationManifest): Promise<void> {
  for (const file of [...manifest.files].reverse()) {
    const target = resolveProjectRelative(projectPath, file.path);
    if (file.existed && file.preimage) {
      const preimage = await fs.readFile(resolveProjectRelative(projectPath, file.preimage), 'utf8');
      await atomicWrite(target, preimage);
    } else {
      await fs.rm(target, { force: true });
    }
  }
}

export async function rollbackWorkspaceContext(projectPath: string, requestedId?: string): Promise<{ id: string; restored: string[] }> {
  const root = projectAiwgPath(projectPath, 'context-migrations');
  let ids: string[];
  try { ids = (await fs.readdir(root)).sort().reverse(); } catch { throw new Error('No workspace-context migration transactions found.'); }
  const id = requestedId ?? ids[0];
  if (!id || id.includes('/') || id.includes('\\')) throw new Error('Invalid workspace-context migration id.');
  const manifestPath = path.join(root, id, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as WorkspaceMigrationManifest;
  if (manifest.status === 'rolled-back') return { id, restored: [] };
  for (const file of manifest.files) {
    const current = await readOptional(resolveProjectRelative(projectPath, file.path));
    if (current === null || sha256(current) !== file.outputChecksum) {
      throw new Error(`Rollback refused: ${file.path} changed after migration. Preserve or reconcile that work before restoring transaction ${id}.`);
    }
  }
  await restoreMigrationManifest(projectPath, manifest);
  manifest.status = 'rolled-back';
  await atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { id, restored: manifest.files.map((file) => file.path) };
}
