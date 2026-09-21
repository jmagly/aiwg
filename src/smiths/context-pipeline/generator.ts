/**
 * Canonical WORKSPACE.md context graph and provider adapter generator.
 *
 * WORKSPACE.md owns provider-neutral project/operator context; AIWG.md owns
 * generated discovery detail; provider startup files are minimal adapters.
 *
 * This file contains the public generator API. Callers are expected to have already
 * deployed artifacts and to pass pre-aggregated `AgentsMdSection[]` describing what
 * was deployed. The generator does not walk the filesystem to discover artifacts;
 * that's the caller's responsibility (per ADR-1 §7 generator-runs-after-deploy
 * invariant — the caller knows what landed).
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type {
  ContextPipelineOptions,
  ContextPipelineResult,
  AgentsMdSection,
  IndexEntry,
  IndexedArtifactType,
} from './types.js';
import { sanitizeDescription, sanitizeTags } from './sanitizer.js';
import { checkPathAllowed } from './allowlist.js';
import { generateAiwgMd } from './aiwg-md.js';
import { injectSpilloverBlock } from './overflow.js';
import { writeNormalizedAiwgMd } from './finalization.js';
import { shouldEmitAgentsMd, shouldEmitAiwgMd, shouldEmitClaudeMdHook } from './provider-policy.js';
import { ensureClaudeMdHook } from './claude-hook.js';
import { ensureManagedHook } from './managed-hook.js';
import { assertSafeContextFile } from './context-file-safety.js';
import {
  buildProviderBootstrapBlock,
  ensureWorkspaceContext,
  registerProviderContext,
} from './workspace-context.js';
import { projectControlPath } from '../../config/project-artifacts.js';

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
 * Build the full AGENTS.md content (in-memory; does not write).
 *
 * Per operator direction (#1239): AGENTS.md is a thin pointer to AIWG.md at
 * project root. AIWG.md mirrors CLAUDE.md (ADR-1 §0.5) and contains the full
 * framework guidance — including the kernel-skill discovery pattern
 * (`aiwg discover` / `aiwg show`). Inlining a full link-index here pushed the
 * file past Codex's 32KB cap on real deploys, triggered auto-split, and ran
 * every artifact description through the sanitizer (rejecting any with
 * backticks). The thin-pointer body sidesteps all of that: zero warnings on
 * any provider, regardless of how many artifacts are deployed.
 *
 * `opts.sections` is accepted for backwards compatibility with callers that
 * still aggregate a link-index (no internal use). `splitOccurred` is always
 * false; `spilloverContent` is always empty. The `partitionForOverflow` /
 * spillover utilities remain exported for any external consumer.
 */
export async function buildAgentsMd(opts: ContextPipelineOptions): Promise<{
  content: string;
  warnings: string[];
  spilloverContent: string;
  splitOccurred: boolean;
}> {
  const warnings: string[] = [];
  const parts: string[] = [];

  parts.push('# AGENTS.md');
  parts.push(`${AIWG_SIGNATURE_COMMENT}`);
  parts.push('<!-- Generated by AIWG. Edit AGENTS.override.md for operator additions. -->');
  parts.push('');
  parts.push(buildProviderBootstrapBlock(opts.provider));
  parts.push('');
  parts.push('## Framework Context');
  parts.push('');
  parts.push('See [AIWG.md](./AIWG.md) for the full AIWG framework context');
  parts.push('(active frameworks, addons, agents, behaviors, rules).');
  const configRelative = path.relative(opts.projectPath, projectControlPath(opts.projectPath, 'aiwg.config')).replace(/\\/g, '/');
  const configLink = configRelative.startsWith('.') ? configRelative : `./${configRelative}`;
  parts.push(`Tracker and delivery source of truth: [${configRelative}](${configLink}).`);
  parts.push('');
  parts.push('Deployed artifacts live under your provider\'s native directory');
  parts.push('(for example `.codex/agents/`, `.warp/agents/`, `.github/agents/`).');
  parts.push('Use `aiwg discover "<intent>"` and `aiwg show <type> <name>` to browse');
  parts.push('skills, agents, rules, and commands across the installation.');
  parts.push('');

  if (opts.projectContext && opts.projectContext.trim().length > 0) {
    warnings.push('projectContext is no longer inlined in provider startup files; place it in the protected WORKSPACE.md operator section.');
  }

  parts.push('---');
  parts.push('');
  parts.push('*See `AGENTS.override.md` for operator-authored additions.*');
  parts.push('');

  return { content: parts.join('\n'), warnings, spilloverContent: '', splitOccurred: false };
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
 * Atomically write a file via tmpfile + rename.
 *
 * Per ADR-4 §4 atomic write requirement; on failure no partial state is persisted.
 */
async function atomicWrite(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp.${process.pid}`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(tmp, content, 'utf8');
  try {
    await fs.rename(tmp, filePath);
  } catch (err) {
    // Best-effort cleanup of tmpfile on rename failure.
    await fs.unlink(tmp).catch(() => undefined);
    throw err;
  }
}

/**
 * Per-provider twin-file names for AGENTS.md emission per ADR-1 §4.
 *
 * Hermes scans `.hermes.md` first (priority 1) and falls back to AGENTS.md.
 * Warp prefers AGENTS.md but tooling expects `WARP.md` to exist. Both are
 * written with the same content as AGENTS.md, except Hermes — see
 * `applyTwinSuffix` below for the Hermes-specific MCP guidance suffix
 * (#1242).
 */
const TWIN_FILES_BY_PROVIDER: Record<string, ReadonlyArray<string>> = {
  copilot: ['.github/copilot-instructions.md'],
  hermes: ['.hermes.md'],
  warp: ['WARP.md'],
};

/**
 * Hermes-specific suffix appended to `.hermes.md` (#1242).
 *
 * The cross-platform AGENTS.md thin pointer (#1239) says *"See [AIWG.md] for
 * the full AIWG framework context."* From inside a Hermes turn that link is
 * a dead end — Hermes auto-loads AGENTS.md and CLAUDE.md but not AIWG.md.
 * The twin file gets a Hermes-correct alternative path so a model running
 * inside Hermes knows to call `artifact-read` over MCP rather than chase the
 * AIWG.md link.
 *
 * Suffix is ~390 chars (~95 tokens) — keeps the .hermes.md twin total under
 * Hermes's <1,000-char turn-budget target on top of the 579-byte primary.
 */
const HERMES_TWIN_SUFFIX = [
  '',
  '## For Hermes Sessions',
  '',
  'Hermes does not auto-load AIWG.md. Browse AIWG capabilities with:',
  '',
  '- `artifact-read AIWG.md` through AIWG MCP.',
  '- `aiwg discover "<intent>"` and `aiwg show <type> <name>`.',
  '- `delegate_task` through the AIWG-orchestrate skill.',
  '',
].join('\n');

/**
 * Apply provider-specific transformations to twin-file content.
 *
 * Currently used only for Hermes (#1242). Extend by adding more
 * provider-keyed branches as new twin formats need divergence.
 */
function applyTwinSuffix(provider: string, baseContent: string): string {
  if (provider === 'hermes') {
    return `${baseContent}${HERMES_TWIN_SUFFIX}`;
  }
  return baseContent;
}

/**
 * Write per-provider twin files (.hermes.md, WARP.md). Twin content is the
 * AGENTS.md body plus any provider-specific suffix from `applyTwinSuffix`.
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

  const twinContent = applyTwinSuffix(provider, agentsMdContent);

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
        result.twinPaths.push(twinPath);
        continue;
      }
    } else if (opts.force) {
      try {
        const original = await fs.readFile(twinPath, 'utf8');
        if (!original.includes(AIWG_SIGNATURE_COMMENT) && !/Generated by\s+(AIWG|aiwg)/i.test(original.split('\n').slice(0, 4).join('\n'))) {
          const backupPath = `${twinPath}.bak.${new Date().toISOString().replace(/[:.]/g, '-')}`;
          await fs.writeFile(backupPath, original, 'utf8');
          result.backupPaths.push(backupPath);
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }

    await atomicWrite(twinPath, twinContent);
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
 * Skeleton implementation: emits AGENTS.md with link-index sections; AIWG.md
 * generation is wired in commit 3 alongside the first issue closure (#1104).
 * For now AIWG.md emission delegates to a copy of CLAUDE.md when the source
 * is present; otherwise it is skipped with a warning.
 */
export async function generate(opts: ContextPipelineOptions): Promise<ContextPipelineResult> {
  // Check every startup/context output before writing the first one. A linked
  // AGENTS.md or CLAUDE.md must not become an input to generated context, even
  // when an additive hook or forced backup would otherwise read it.
  const plannedFiles = [
    ...(!opts.skip?.workspaceMd ? ['WORKSPACE.md'] : []),
    ...(!opts.skip?.agentsMd && shouldEmitAgentsMd(opts.provider) ? ['AGENTS.md'] : []),
    ...(!opts.skip?.aiwgMd && shouldEmitAiwgMd(opts.provider) ? ['AIWG.md'] : []),
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

  const normalizedAiwgPath = await writeNormalizedAiwgMd(opts.projectPath);
  result.normalizedAiwgMdPath = normalizedAiwgPath;

  // AGENTS.md emission is gated on the provider's link-mechanism: codex/copilot/
  // cursor/windsurf/hermes/warp/factory/opencode use AGENTS.md as their bridge
  // to AIWG.md. Claude uses CLAUDE.md hook instead (#1437); openclaw is
  // home-dir-only and 'generic' has no provider-local footprint.
  if (!opts.skip?.agentsMd && shouldEmitAgentsMd(opts.provider)) {
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
          await fs.writeFile(backupPath, original, 'utf8');
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
      await atomicWrite(agentsMdPath, built.content);
      result.agentsMdPath = agentsMdPath;
      result.agentsMdBytes = Buffer.byteLength(built.content, 'utf8');
      result.warnings.push(...built.warnings);
      if (built.splitOccurred) {
        await writeSpilloverBlock(opts.projectPath, built.spilloverContent, result);
      }
    } else {
      // #1597: AGENTS.md is operator-owned — don't skip it. Additively install the
      // canonical graph hook (preserve operator content; no --force needed) so Codex/
      // fallback consumers load the generated AIWG.md.
      const hook = await ensureManagedHook(agentsMdPath, { provider: opts.provider });
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

  if (!opts.skip?.aiwgMd && shouldEmitAiwgMd(opts.provider)) {
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
          await fs.writeFile(backupPath, original, 'utf8');
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

  return result;
}
