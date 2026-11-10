// Diagnose the generated context graph and linked files.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { Platform } from '../../agents/types.js';
import { getProviderDefinition, type ProviderContextContract } from '../../providers/provider-definitions.js';
import { readAiwgOperatorNotes } from './finalization.js';
import { auditWorkspaceContext } from './workspace-audit.js';
import {
  PROVIDER_BOOTSTRAP_START,
  readOptional,
  resolveProjectRelative,
  WORKSPACE_MANAGED_START,
  WORKSPACE_OPERATOR_START,
  WORKSPACE_SIGNATURE,
  WorkspaceContextDiagnostic,
} from './workspace-context-shared.js';
import { BOOTSTRAP_AUTHORITY_SIGNATURE, WORKSPACE_PRECEDENCE_SIGNATURE, WORKSPACE_PRECEDENCE_SUPERSEDED } from './workspace-document.js';
import { configuredProviders } from './workspace-migration.js';
import { diagnoseUserHookCommands } from '../../extensions/user-hook-diagnostics.js';
import { diagnoseCodexHookTrust } from '../hook-bridge/codex-trust.js';
import { diagnoseFactoryHookTrust } from '../hook-bridge/factory-trust.js';
import { diagnoseHermesHookAcceptance } from '../hook-bridge/hermes-trust.js';

import { maskCodeRegions } from './code-regions.js';
export { maskCodeRegions } from './code-regions.js';

export function markdownLinks(content: string): string[] {
  const prose = maskCodeRegions(content);
  return [...prose.matchAll(/\[[^\]]+\]\((\.\/?[^)#]+)(?:#[^)]+)?\)/g)].map((match) => match[1]);
}

export async function workspaceLinkedFiles(projectPath: string): Promise<string[]> {
  const content = await readOptional(path.join(projectPath, 'WORKSPACE.md'));
  if (!content) return [];
  const files: string[] = [];
  for (const link of markdownLinks(content)) {
    const normalized = link.replace(/^\.\//, '');
    const resolved = path.resolve(projectPath, normalized);
    if (resolved !== projectPath && !resolved.startsWith(`${path.resolve(projectPath)}${path.sep}`)) continue;
    try {
      const stat = await fs.stat(resolved);
      if (stat.isFile()) files.push(resolved);
    } catch {
      // Missing optional linked files are reported by doctor, not index builds.
    }
  }
  return [...new Set(files)].sort();
}

export async function diagnoseWorkspaceContext(projectPath: string): Promise<WorkspaceContextDiagnostic[]> {
  const diagnostics: WorkspaceContextDiagnostic[] = await diagnoseUserHookCommands();
  const codexTrust = await diagnoseCodexHookTrust(projectPath);
  if (codexTrust) diagnostics.push(codexTrust);
  const factoryTrust = await diagnoseFactoryHookTrust(projectPath);
  if (factoryTrust) diagnostics.push(factoryTrust);
  const hermesAcceptance = await diagnoseHermesHookAcceptance();
  if (hermesAcceptance) diagnostics.push(hermesAcceptance);
  const root = path.resolve(projectPath);
  const scopes = new Map<string, Promise<string | null>>();
  // Ordinary subdirectories share root policy; repository/project markers start a separate scope.
  function directoryScope(directory: string): Promise<string | null> {
    if (directory === root || !directory.startsWith(`${root}${path.sep}`)) return Promise.resolve(null);
    let scope = scopes.get(directory);
    if (!scope) {
      scope = (async () => {
        const markers = await Promise.all(['.git', '.aiwg/aiwg.config'].map(async (marker) => {
          try { await fs.stat(path.join(directory, marker)); return true; } catch { return false; }
        }));
        return markers.some(Boolean)
          ? path.relative(root, directory).replace(/\\/g, '/')
          : directoryScope(path.dirname(directory));
      })();
      scopes.set(directory, scope);
    }
    return scope;
  }
  async function reportSourceDiagnostic(diagnostic: WorkspaceContextDiagnostic, sources: string[]): Promise<void> {
    const sourceScopes = await Promise.all(sources.map((source) => directoryScope(path.dirname(path.resolve(root, source)))));
    const nestedOnly = sourceScopes.length > 0 && sourceScopes.every((scope) => scope !== null);
    diagnostics.push(nestedOnly ? {
      ...diagnostic,
      severity: diagnostic.severity === 'error' ? 'warning' : diagnostic.severity,
      message: `Advisory for nested project(s) ${[...new Set(sourceScopes)].join(', ')}: ${diagnostic.message}`,
    } : diagnostic);
  }
  const { existing, notes } = await readAiwgOperatorNotes(projectPath);
  if (existing !== null && existing !== notes) diagnostics.push({
    severity: 'warning', code: 'duplicate-generated-context', path: '.aiwg/AIWG.md',
    message: 'Legacy generated context remains in the optional operator notes file; run `aiwg regenerate --workspace` to migrate it without dropping notes.',
  });
  const audit = await auditWorkspaceContext(projectPath);
  if (audit.contextWalkTruncated) {
    diagnostics.push({
      severity: 'info',
      code: 'context-walk-truncated',
      message: 'Nested-instruction-file walk stopped early (depth/entry bound reached, or the root looks like $HOME or has no project markers); the context graph may be incomplete.',
    });
  }
  const workspacePath = path.join(projectPath, 'WORKSPACE.md');
  const workspace = await readOptional(workspacePath);
  if (!workspace) {
    diagnostics.push({ severity: 'info', code: 'legacy-layout', message: 'Legacy provider context layout is supported; run `aiwg workspace-context migrate --dry-run` for opt-in conversion.' });
    return diagnostics;
  }
  if (!workspace.includes(WORKSPACE_MANAGED_START) || !workspace.includes(WORKSPACE_OPERATOR_START)) {
    diagnostics.push({ severity: 'warning', code: 'workspace-unmanaged', message: 'WORKSPACE.md lacks complete AIWG ownership markers.', path: 'WORKSPACE.md' });
  }
  if (workspace.includes(PROVIDER_BOOTSTRAP_START)) {
    diagnostics.push({ severity: 'error', code: 'include-loop', message: 'WORKSPACE.md contains a provider bootstrap marker and could create a self-referential context loop.', path: 'WORKSPACE.md' });
  }
  for (const link of markdownLinks(workspace)) {
    const normalized = link.replace(/^\.\//, '');
    if (normalized.includes('WORKSPACE.md')) continue;
    let linkedPath: string;
    try {
      linkedPath = resolveProjectRelative(projectPath, normalized);
    } catch {
      diagnostics.push({ severity: 'error', code: 'unsafe-link', message: `Linked context path escapes the project: ${normalized}`, path: 'WORKSPACE.md' });
      continue;
    }
    let exists = false;
    try { await fs.stat(linkedPath); exists = true; } catch { exists = false; }
    if (!exists && !normalized.endsWith('quickref.json')) {
      diagnostics.push({ severity: 'warning', code: 'missing-link', message: `Linked context file is missing: ${normalized}`, path: 'WORKSPACE.md' });
    }
  }
  for (const conflict of audit.conflicts) {
    await reportSourceDiagnostic({ severity: 'error', code: 'directive-conflict', message: `Conflicting duplicate directive group '${conflict.key}' appears in ${conflict.sources.map((source) => source.path).join(', ')}.` }, conflict.sources.map((source) => source.path));
  }
  // One diagnostic per source pair, not one per duplicated line: a shared
  // pointer stub otherwise reports every line as a separate policy conflict
  // and degrades the workspace over content that agrees with itself (#2558).
  const duplicatesByPair = new Map<string, number>();
  for (const overlap of audit.identical) {
    const key = overlap.sources.join(', ');
    duplicatesByPair.set(key, (duplicatesByPair.get(key) ?? 0) + overlap.directives.length);
  }
  const operatorBodies = new Map(audit.sources.map((source) => [source.path, source.operatorContent.trim()]));
  for (const [pair, count] of duplicatesByPair) {
    const paths = pair.split(', ');
    const bodies = paths.map((item) => operatorBodies.get(item) ?? '');
    const wholeFileDuplicate = bodies.every((body) => body.length > 0 && body === bodies[0]);
    await reportSourceDiagnostic({
      severity: wholeFileDuplicate ? 'info' : 'warning',
      code: 'duplicate-directive',
      message: wholeFileDuplicate
        ? `${pair} carry identical operator content (${count} directive(s)); keep one copy or accept the shared stub.`
        : `${count} identical directive(s) duplicated across ${pair}.`,
    }, paths);
  }
  for (const source of audit.sources) {
    if (!source.path.replace(/\\/g, '/').includes('/context/providers/') || !source.operatorContent.trim()) continue;
    diagnostics.push({
      severity: 'info',
      code: 'provider-context-not-loaded',
      message: `${source.path} is linked from WORKSPACE.md but no provider bootstrap auto-loads it; move its operator content into the WORKSPACE.md Project Context section (\`aiwg regenerate --existing-project\` ports startup files there) or keep it as reference only.`,
      path: source.path,
    });
  }
  for (const finding of audit.sensitiveFindings) {
    const location = finding.line ? `${finding.path}:${finding.line}` : finding.path;
    await reportSourceDiagnostic({ severity: 'error', code: 'possible-secret', message: `Possible credential value found in ${location}; remove it.`, path: finding.path }, [finding.path]);
  }
  // #2512 — "points at WORKSPACE.md" is not the same as "carries current policy".
  // Without this, a workspace generated before the precedence correction reads
  // as healthy while still telling agents that harness directives outrank AIWG
  // rules, and nothing ever prompts the regenerate that would fix it.
  if (workspace.includes(WORKSPACE_PRECEDENCE_SUPERSEDED)) {
    diagnostics.push({
      severity: 'warning',
      code: 'precedence-superseded',
      message: 'WORKSPACE.md carries the superseded precedence that ranks provider and harness instructions above AIWG rules. Run `aiwg regenerate`.',
      path: 'WORKSPACE.md',
    });
  } else if (!workspace.includes(WORKSPACE_PRECEDENCE_SIGNATURE)) {
    diagnostics.push({
      severity: 'warning',
      code: 'precedence-missing',
      message: 'WORKSPACE.md does not state that AIWG rules bind over provider, harness, and session directives. Run `aiwg regenerate`.',
      path: 'WORKSPACE.md',
    });
  }

  const providers = await configuredProviders(projectPath);
  for (const provider of providers) {
    const definition = getProviderDefinition(provider);
    if (!definition) continue;
    for (const target of definition.context.bootstrapTargets) {
      const targetContent = await readOptional(path.join(projectPath, target));
      if (targetContent?.includes(WORKSPACE_SIGNATURE) && !targetContent.includes('WORKSPACE.md')) {
        diagnostics.push({ severity: 'error', code: 'bootstrap-drift', message: `${target} is AIWG-managed but no longer points to WORKSPACE.md first.`, path: target });
      }
      // The bootstrap file is read before WORKSPACE.md, so a directive arriving
      // mid-session wins unless authority is asserted here too.
      if (targetContent?.includes(PROVIDER_BOOTSTRAP_START) && !targetContent.includes(BOOTSTRAP_AUTHORITY_SIGNATURE)) {
        diagnostics.push({
          severity: 'warning',
          code: 'authority-missing',
          message: `${target} does not assert that AIWG rules are binding. Run \`aiwg regenerate\`.`,
          path: target,
        });
      }
    }
    if (definition.context.configRegistration) {
      const registration = definition.context.configRegistration;
      const config = await readOptional(path.join(projectPath, registration.file));
      if (config) {
        try {
          const parsed = JSON.parse(config) as Record<string, unknown>;
          const values = Array.isArray(parsed[registration.key]) ? parsed[registration.key] as unknown[] : [];
          for (const required of ['WORKSPACE.md', 'AIWG.md']) {
            if (!values.includes(required)) diagnostics.push({ severity: 'error', code: 'registration-drift', message: `${registration.file} does not register ${required}.`, path: registration.file });
          }
        } catch {
          diagnostics.push({ severity: 'error', code: 'registration-invalid', message: `${registration.file} is invalid JSON.`, path: registration.file });
        }
      }
    }
  }
  if (diagnostics.length === 0) diagnostics.push({ severity: 'info', code: 'healthy', message: 'Workspace context graph is healthy.' });
  return diagnostics;
}

export function providerContextContract(provider: Platform | string): ProviderContextContract | undefined {
  return getProviderDefinition(provider)?.context;
}
