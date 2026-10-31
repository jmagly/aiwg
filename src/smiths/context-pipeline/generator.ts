// Generate canonical workspace context and provider adapters after artifact deployment.
import { writeFlueContext } from './flue-context.js';
import { ensureCoreStartup } from '../../rules/core-startup.mjs';
import { preserveBridgeOperatorText } from './bridge-ownership.js';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import type {
  ContextPipelineOptions,
  ContextPipelineResult,
  AgentsMdSection,
  IndexEntry,
  IndexedArtifactType,
} from './types.js';
import { sanitizeDescription, sanitizeTags } from './sanitizer.js';
import { checkPathAllowed } from './allowlist.js';
import { generateAiwgMdForPipeline as generateAiwgMd } from './aiwg-md.js';
import { injectSpilloverBlock } from './overflow.js';
import { migrateAiwgOperatorNotes } from './finalization.js';
import { shouldEmitAgentsMd, shouldEmitClaudeMdHook } from './provider-policy.js';
import { ensureClaudeMdHook } from './claude-hook.js';
import { ensureManagedHook } from './managed-hook.js';
import { assertSafeContextFile, writeContextFileSync } from './context-file-safety.js';
import {
  ensureWorkspaceContext,
  registerProviderContext,
} from './workspace-context.js';
import { buildAgentsMd } from './agents-md.js';
/** True when deployed native Claude rules already carry the compact core set. */
function hasNativeClaudeCore(projectDir: string): boolean {
  try {
    return readdirSync(path.join(projectDir, '.claude', 'rules'))
      .some(name => /^core-.+\.md$/.test(name) && /aiwg:managed/.test(readFileSync(path.join(projectDir, '.claude', 'rules', name), 'utf8')));
  } catch { return false; }
}

export { buildAgentsMd } from './agents-md.js';

const SECTION_TITLES: Record<IndexedArtifactType, string> = {
  agents: 'Agents',
  rules: 'Rules',
  skills: 'Skills',
  behaviors: 'Behaviors',
};

const AIWG_SIGNATURE_COMMENT = '<!-- aiwg-managed -->';

/**
 * Build the loud warning emitted when a pre-existing, non-AIWG-managed twin or
 * bridge file is left untouched (#1579). The terse legacy notice ("exists and
 * is not AIWG-managed; not overwritten") buried the real consequence: the stale
 * file keeps loading and its Discover-First Protocol never reaches the agent,
 * so the agent fabricates CLI commands (the #1522 / #1411 failure mode).
 *
 * This message names that consequence and the exact remediation, and is
 * prefixed `WARNING:` so the CLI consumers (`aiwg use`, `aiwg regenerate`)
 * render it prominently rather than dimmed.
 */
function nonManagedTwinWarning(fileName: string, remediation: string): string {
  return (
    `WARNING: ${fileName} exists and is not AIWG-managed — left untouched. ` +
    `The stale file keeps loading instead of the lean managed bridge, so the ` +
    `Discover-First Protocol never reaches the agent and it may fabricate CLI ` +
    `commands. Run \`${remediation}\` to back up and replace it.`
  );
}

/**
 * Render a single link-index entry as markdown.
 *
 * Returns null if the entry is rejected by sanitizer or allowlist; the caller can
 * accumulate warnings about dropped entries.
 */
export function renderEntry(entry: IndexEntry): { markdown: string | null; warning: string } {
  const desc = sanitizeDescription(entry.description);
  if (!desc.ok) {
    return {
      markdown: null,
      warning: `dropped entry '${entry.id}': description rejected (${desc.rejectedFor})`,
    };
  }

  const allowed = checkPathAllowed(entry.path);
  if (!allowed.ok) {
    return {
      markdown: null,
      warning: `dropped entry '${entry.id}': path rejected (${allowed.rejectedFor})`,
    };
  }

  let suffix = '';
  if (entry.safetyCritical) {
    suffix = entry.shadowedBy
      ? ` *(SAFETY-CRITICAL, SHADOWED → ${entry.shadowedBy})*`
      : ' *(SAFETY-CRITICAL)*';
  }

  const tagPart = entry.tags && entry.tags.length > 0
    ? `\n  - Tags: ${sanitizeTags(entry.tags).kept.join(', ')}`
    : '';

  const userScopeMarker = allowed.isUserScope
    ? '\n  <!-- user-scope; loader may not auto-resolve -->'
    : '';

  const markdown = `- **${entry.id}**${suffix} — ${desc.value}\n  - Path: \`${entry.path}\`${tagPart}${userScopeMarker}`;

  return { markdown, warning: '' };
}

/**
 * Render one section (e.g. ## Agents) of an AGENTS.md.
 */
export function renderSection(section: AgentsMdSection): { markdown: string; warnings: string[] } {
  const title = SECTION_TITLES[section.type];
  const warnings: string[] = [];
  const lines: string[] = [];

  for (const entry of section.entries) {
    const { markdown, warning } = renderEntry(entry);
    if (markdown) {
      lines.push(markdown);
    } else if (warning) {
      warnings.push(warning);
    }
  }

  if (lines.length === 0) {
    // Empty sections are omitted per ADR-1 §1
    return { markdown: '', warnings };
  }

  return {
    markdown: `## ${title}\n\n${lines.join('\n\n')}\n`,
    warnings,
  };
}

/**
 * Detect whether a pre-existing file at `filePath` carries the AIWG signature.
 *
 * Returns `true` if the file is missing or is AIWG-managed (safe to overwrite).
 * Returns `false` if the file exists and does not carry the signature comment
 * (operator-claimed).
 */
export async function isOverwriteSafe(filePath: string): Promise<boolean> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    // First 4 lines: canonical signature lookup.
    const head = content.split('\n').slice(0, 4).join('\n');
    if (head.includes(AIWG_SIGNATURE_COMMENT)) return true;
    if (/Generated by\s+(AIWG|aiwg)/i.test(head)) return true;

    // Provider templates use a different ownership marker. Adopt only wholly
    // generated files; text outside managed blocks still belongs to the operator.
    if (content.includes('<!-- BEGIN AIWG-managed (auto-generated;')) {
      const remainder = content
        .replace(/<!-- BEGIN AIWG-managed \(auto-generated;[^\n]*-->[\s\S]*?<!-- END AIWG-managed -->/g, '')
        .replace(/<!-- AIWG:([\w-]+):start -->[\s\S]*?<!-- AIWG:\1:end -->/g, '');
      return remainder.trim().length === 0;
    }

    // Backwards-compatibility scan: pre-ADR-1 emitters wrote AGENTS.md /
    // WARP.md / .hermes.md without the canonical signature. Those files
    // typically include AIWG-specific markers somewhere in the first ~50
    // lines. Detect them so existing repos upgrade cleanly without
    // requiring --force.
    const headExtended = content.split('\n').slice(0, 50).join('\n');
    const legacyMarkers: ReadonlyArray<RegExp> = [
      /AIWG\s+SDLC\s+(Framework|framework)/i,
      /AIWG\s+(auto-updated|managed)/i,
      /AIWG\s+Integration/i,
      /<!--\s*AIWG\s+/i,
      /aiwg\s+use\s+sdlc/i,
    ];
    return legacyMarkers.some((re) => re.test(headExtended));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return true;
    }
    throw err;
  }
}

/**
 * Preserve rule-owned blocks, then write through the safe context boundary.
 * The deploy journal retains the preimage even if a later step fails.
 */
async function atomicWrite(filePath: string, content: string, provider?: string): Promise<number> {
  // Rule delivery owns this block. Context regeneration runs after deployment
  // and must retain the selected kernel even when rebuilding the adapter.
  const existing = await fs.readFile(filePath, 'utf8').catch(() => '');
  content = preserveBridgeOperatorText(existing, content);
  for (const owner of ['rule-startup', 'rule-core', ...[...existing.matchAll(/<!-- AIWG:(rule-hook-[\w-]+):start -->/g)].map(match => match[1]), 'hermes-context', 'hermes-routing', 'warp-context']) {
    if (content.includes(`<!-- AIWG:${owner}:start -->`)) continue;
    const managed = existing.match(new RegExp(`<!-- AIWG:${owner}:start -->[\\s\\S]*?<!-- AIWG:${owner}:end -->`));
    if (managed) content = `${content.trimEnd()}\n\n${managed[0]}\n`;
  }
  // Claude loads core natively from .claude/rules/core-*.md once deployed; inject into CLAUDE.md
  // only when those native files are absent (for example a regenerate before any `aiwg use`).
  const nativeCore = provider === 'claude' && hasNativeClaudeCore(path.dirname(filePath));
  if (provider && !nativeCore) content = ensureCoreStartup(content);
  else if (nativeCore) content = content.replace(/\n*<!-- AIWG:rule-core:start -->[\s\S]*?<!-- AIWG:rule-core:end -->\n?/, '\n');
  const bytes = Buffer.byteLength(content, 'utf8');
  if (provider === 'codex' && path.basename(filePath) === 'AGENTS.md' && bytes >= 32768) {
    throw new Error('Codex AGENTS.md exceeds its 32 KB hard cap');
  }
  if (provider === 'hermes' && ['AGENTS.md', '.hermes.md'].includes(path.basename(filePath)) && content.length > 19000) {
    throw new Error(`Hermes ${path.basename(filePath)} exceeds hard cap of 19000 characters`);
  }
  writeContextFileSync(filePath, content);
  return bytes;
}

/**
 * Per-provider twin-file names for AGENTS.md emission per ADR-1 §4.
 *
 * Hermes scans `.hermes.md` first (priority 1) and falls back to AGENTS.md.
 * Warp prefers AGENTS.md but tooling expects `WARP.md` to exist. Both are
 * written with the same minimal bootstrap content as AGENTS.md.
 */
const TWIN_FILES_BY_PROVIDER: Record<string, ReadonlyArray<string>> = {
  copilot: ['.github/copilot-instructions.md'],
  hermes: ['.hermes.md'],
  warp: ['WARP.md'],
};

/**
 * Write per-provider twin files (.hermes.md, WARP.md). Twin content is the
 * same minimal AGENTS.md bootstrap body.
 * Operator-claimed twin files are not overwritten unless --force is set,
 * matching the AGENTS.md guard.
 */
async function writeTwinFiles(
  provider: string,
  projectPath: string,
  agentsMdContent: string,
  opts: ContextPipelineOptions,
  result: ContextPipelineResult,
): Promise<void> {
  const twinNames = TWIN_FILES_BY_PROVIDER[provider];
  if (!twinNames || twinNames.length === 0) return;

  const twinContent = agentsMdContent;

  for (const twinName of twinNames) {
    const twinPath = path.join(projectPath, twinName);
    if (opts.detectExistingFiles && !opts.force) {
      const safe = await isOverwriteSafe(twinPath);
      if (!safe) {
        // #1579: don't skip an operator-owned twin — additively install the
        // canonical graph hook so discover-first isn't buried (preserve content).
        const hook = await ensureManagedHook(twinPath, { provider });
        result.warnings.push(
          hook.action === 'unchanged'
            ? `${twinName} is operator-owned and already loads WORKSPACE.md then AIWG.md — left as-is.`
            : `${twinName} is operator-owned; ${hook.action} the WORKSPACE.md → AIWG.md hook additively (existing content preserved). Pass --force to replace the whole file.`,
        );
        await atomicWrite(twinPath, await fs.readFile(twinPath, 'utf8'), provider);
        result.twinPaths.push(twinPath);
        continue;
      }
    } else if (opts.force) {
      try {
        const original = await fs.readFile(twinPath, 'utf8');
        if (!original.includes(AIWG_SIGNATURE_COMMENT) && !/Generated by\s+(AIWG|aiwg)/i.test(original.split('\n').slice(0, 4).join('\n'))) {
          const backupPath = `${twinPath}.bak.${new Date().toISOString().replace(/[:.]/g, '-')}`;
          writeContextFileSync(backupPath, original, 'utf8');
          result.backupPaths.push(backupPath);
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }

    await atomicWrite(twinPath, twinContent, provider);
    result.twinPaths.push(twinPath);
  }
}

/**
 * Inject a spillover block into AGENTS.override.md, preserving operator-authored
 * content outside the block. Per ADR-1 §5: shared file partitioning with the
 * `<!-- spillover-from-AGENTS.md:START/END -->` markers. Generator only writes
 * inside that block.
 */
async function writeSpilloverBlock(
  projectPath: string,
  spilloverMarkdown: string,
  result: ContextPipelineResult,
): Promise<void> {
  const overridePath = path.join(projectPath, 'AGENTS.override.md');
  let existing = '';
  try {
    existing = await fs.readFile(overridePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
    // Create AGENTS.override.md with a header explaining the partition.
    existing = [
      '# AGENTS.override.md',
      '',
      '<!-- Operator-authored additions go here. The block below is AIWG-managed spillover; -->',
      '<!-- do not edit between the spillover markers. Content outside is preserved across runs. -->',
      '',
    ].join('\n');
  }
  const updated = injectSpilloverBlock(existing, spilloverMarkdown);
  await atomicWrite(overridePath, updated);
  result.warnings.push(`spillover written to AGENTS.override.md (${Buffer.byteLength(spilloverMarkdown, 'utf8')}b)`);
}

/**
 * Generate the canonical graph and provider startup adapters.
 *
 * Root AIWG.md is the single generated framework context, including optional
 * operator notes. Provider adapters declare their supported startup loader;
 * home-only providers can still read the root context explicitly.
 */
export async function generate(opts: ContextPipelineOptions): Promise<ContextPipelineResult> {
  // Check every startup/context output before writing the first one. A linked
  // AGENTS.md or CLAUDE.md must not become an input to generated context, even
  // when an additive hook or forced backup would otherwise read it.
  const plannedFiles = [
    ...(!opts.skip?.workspaceMd ? ['WORKSPACE.md'] : []),
    ...(!opts.skip?.agentsMd && shouldEmitAgentsMd(opts.provider) ? ['AGENTS.md'] : []),
    ...(!opts.skip?.aiwgMd ? ['AIWG.md'] : []),
    ...(shouldEmitClaudeMdHook(opts.provider) ? ['CLAUDE.md'] : []),
  ];
  for (const file of plannedFiles) await assertSafeContextFile(path.join(opts.projectPath, file));

  const result: ContextPipelineResult = {
    workspaceMdPath: '',
    aiwgMdPath: '',
    normalizedAiwgMdPath: '',
    agentsMdPath: '',
    twinPaths: [],
    contextRegistrationPaths: [],
    backupPaths: [],
    agentsMdBytes: 0,
    warnings: [],
  };

  if (!opts.skip?.workspaceMd) {
    const workspace = await ensureWorkspaceContext(opts.projectPath);
    result.workspaceMdAction = workspace.action;
    result.warnings.push(...workspace.warnings);
    if (workspace.action !== 'preserved') result.workspaceMdPath = workspace.path;
    if (workspace.backupPath) result.backupPaths.push(workspace.backupPath);
  }


  // AGENTS.md emission is gated on the provider's link-mechanism: codex/copilot/
  // cursor/windsurf/hermes/warp/factory/opencode use AGENTS.md as their bridge
  // to AIWG.md. Claude uses CLAUDE.md hook instead (#1437); openclaw is
  // home-dir-only and 'generic' has no provider-local footprint.
  if (opts.provider !== 'flue' && !opts.skip?.agentsMd && shouldEmitAgentsMd(opts.provider)) {
    const agentsMdPath = path.join(opts.projectPath, 'AGENTS.md');
    let canWrite = true;

    if (opts.detectExistingFiles && !opts.force) {
      canWrite = await isOverwriteSafe(agentsMdPath);
    } else if (opts.force) {
      // Backup before overwrite per ADR-1 §5 R1 mitigation.
      try {
        const original = await fs.readFile(agentsMdPath, 'utf8');
        if (!original.includes(AIWG_SIGNATURE_COMMENT)) {
          const backupPath = `${agentsMdPath}.bak.${new Date().toISOString().replace(/[:.]/g, '-')}`;
          writeContextFileSync(backupPath, original, 'utf8');
          result.backupPaths.push(backupPath);
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw err;
        }
      }
    }

    // Build the managed AGENTS.md content in-memory regardless — used for the full
    // write, and as the twin content downstream.
    const built = await buildAgentsMd(opts);
    if (canWrite) {
      result.agentsMdBytes = await atomicWrite(agentsMdPath, built.content, opts.provider);
      result.agentsMdPath = agentsMdPath;
      result.warnings.push(...built.warnings);
      if (built.splitOccurred) {
        await writeSpilloverBlock(opts.projectPath, built.spilloverContent, result);
      }
    } else {
      // #1597: AGENTS.md is operator-owned — don't skip it. Additively install the
      // canonical graph hook (preserve operator content; no --force needed) so Codex/
      // fallback consumers load the generated AIWG.md.
      const hook = await ensureManagedHook(agentsMdPath, { provider: opts.provider });
      result.agentsMdBytes = await atomicWrite(agentsMdPath, await fs.readFile(agentsMdPath, 'utf8'), opts.provider);
      result.agentsMdPath = agentsMdPath;
      result.warnings.push(
        hook.action === 'unchanged'
          ? `AGENTS.md is operator-owned and already loads WORKSPACE.md then AIWG.md — left as-is.`
          : `AGENTS.md is operator-owned; ${hook.action} the WORKSPACE.md → AIWG.md hook additively (existing content preserved). Pass --force to replace the whole file.`,
      );
    }
    // Per-provider twin emission per ADR-1 §4 (Hermes .hermes.md, Warp WARP.md);
    // each twin is guarded individually (managed → full write, operator-owned →
    // additive hook), so this runs whether or not AGENTS.md itself was rewritten.
    await writeTwinFiles(opts.provider, opts.projectPath, built.content, opts, result);
  }

  if (!opts.skip?.aiwgMd) {
    const aiwgMdPath = path.join(opts.projectPath, 'AIWG.md');

    let canWrite = true;
    if (opts.detectExistingFiles && !opts.force) {
      canWrite = await isOverwriteSafe(aiwgMdPath);
      if (!canWrite) {
        result.warnings.push(
          nonManagedTwinWarning('AIWG.md', 'aiwg regenerate --force'),
        );
      }
    } else if (opts.force) {
      // Backup before overwrite per ADR-1 §5 R1 mitigation.
      try {
        const original = await fs.readFile(aiwgMdPath, 'utf8');
        if (!original.includes(AIWG_SIGNATURE_COMMENT)) {
          const backupPath = `${aiwgMdPath}.bak.${new Date().toISOString().replace(/[:.]/g, '-')}`;
          writeContextFileSync(backupPath, original, 'utf8');
          result.backupPaths.push(backupPath);
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw err;
        }
      }
    }

    if (canWrite) {
      const content = await generateAiwgMd(opts.projectPath);
      await atomicWrite(aiwgMdPath, content);
      result.aiwgMdPath = aiwgMdPath;
      result.normalizedAiwgMdPath = aiwgMdPath; // Compatibility alias: there is only one generated context.
      await migrateAiwgOperatorNotes(opts.projectPath);
    }
  }

  // CLAUDE.md hook emission for the claude provider (#1437). Mirrors how
  // AGENTS.md is the bridge for other providers — CLAUDE.md gets a managed
  // marker block with an `@AIWG.md` include. Operator content outside the
  // block is preserved.
  if (shouldEmitClaudeMdHook(opts.provider)) {
    const hookResult = await ensureClaudeMdHook(opts.projectPath, {
      force: opts.force,
      detectExistingFiles: opts.detectExistingFiles,
    });
    await atomicWrite(hookResult.claudeMdPath, await fs.readFile(hookResult.claudeMdPath, 'utf8'), opts.provider);
    result.claudeMdHookPath = hookResult.claudeMdPath;
    result.claudeMdHookAction = hookResult.action;
    if (hookResult.backupPath) {
      result.backupPaths.push(hookResult.backupPath);
    }
    result.warnings.push(...hookResult.warnings);
  }

  if (!opts.skip?.workspaceMd) {
    const registration = await registerProviderContext(opts.provider, opts.projectPath);
    if (registration) {
      if (registration.changed) result.contextRegistrationPaths.push(registration.path);
      if (registration.warning) result.warnings.push(registration.warning);
    }
  }

  if (opts.provider === 'flue' && !opts.skip?.agentsMd) {
    result.agentsMdBytes = Buffer.byteLength(writeFlueContext(opts.projectPath));
    result.agentsMdPath = path.join(opts.projectPath, 'AGENTS.md');
  }
  return result;
}
