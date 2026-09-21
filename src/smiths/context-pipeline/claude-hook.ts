/**
 * CLAUDE.md hook injector — ensures CLAUDE.md contains an AIWG-managed
 * marker block with canonical `@WORKSPACE.md` then `@AIWG.md` includes.
 *
 * For provider=claude, AIWG.md still gets generated at project root the
 * same way as for other providers. The difference: claude reads CLAUDE.md
 * natively (not AGENTS.md), so we need a different bridge — a managed
 * block inside CLAUDE.md that pulls AIWG.md in via `@-mention`.
 *
 * Design:
 * - Marker block delimits AIWG-managed content; operator content outside
 *   the block is never touched.
 * - If CLAUDE.md exists without the block, append the block to the end.
 * - If CLAUDE.md exists with the block, update the block in place.
 * - If CLAUDE.md does not exist, create a minimal CLAUDE.md with just
 *   the marker block (operator will add their own content later).
 * - `--force` allows replacing the marker block content even when the
 *   block has been operator-modified inside (with backup).
 *
 * @issue #1437
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import {
  buildProviderBootstrapBlock,
  PROVIDER_BOOTSTRAP_START,
  PROVIDER_BOOTSTRAP_END,
} from './workspace-context.js';
import { dominantLineEnding, withLineEnding } from './line-endings.js';
import { assertSafeContextFile } from './context-file-safety.js';

export const CLAUDE_HOOK_START = '<!-- AIWG:claude-md-hook:start -->';
export const CLAUDE_HOOK_END = '<!-- AIWG:claude-md-hook:end -->';

/**
 * The managed block that gets inserted into CLAUDE.md. Tells Claude Code
 * to load AIWG.md as the project context entry point. Kept short — the
 * actual context lives in AIWG.md.
 */
type ClaudeArtifactOutputPolicy = { canonical?: string; provider_native?: string; destinations?: Record<string, { enabled?: boolean; use_when?: string }> };

function buildClaudeArtifactOutputPolicy(policy: ClaudeArtifactOutputPolicy = {}): string[] {
  const providerNative = policy.provider_native ?? 'explicit-only';
  const design = policy.destinations?.['claude-code.design'];
  const designEnabled = design?.enabled !== false && design?.use_when !== 'disabled';
  return [
    '## AIWG artifact output policy',
    '',
    `- Canonical durable artifacts: AIWG artifact store (policy: ${policy.canonical ?? 'aiwg'}).`,
    `- Provider-native presentation/export: ${providerNative}.`,
    `- Claude Design: ${designEnabled ? 'available only when explicitly selected by the resolved policy or requested by the user' : 'disabled by project policy'}.`,
    '- Never substitute, relocate, or omit the canonical AIWG plan/review artifact because Claude adds or changes a provider default.',
    '- When both canonical and presentation outputs are selected, write the canonical artifact first; treat Design as a derived export and record provenance linking it to the canonical source of truth.',
    '- Unknown provider-native destinations fail safe with a diagnostic. Higher-authority project policy overrides user preferences; explicit task selection overrides provider defaults only within the project policy ceiling.',
  ];
}

export function buildClaudeHookBlock(policy: ClaudeArtifactOutputPolicy = {}): string {
  return [
    CLAUDE_HOOK_START,
    '',
    buildProviderBootstrapBlock('claude'),
    '@.aiwg/aiwg.config',
    '',
    ...buildClaudeArtifactOutputPolicy(policy),
    '',
    '<!--',
    '  This block is managed by `aiwg regenerate` and `aiwg use`.',
    '  Operator content above and below this block is preserved on regenerate.',
    '  To change AIWG.md content, edit .aiwg/AIWG.md (the normalized source)',
    '  then run `aiwg regenerate`.',
    '-->',
    '',
    CLAUDE_HOOK_END,
  ].join('\n');
}

export interface ClaudeHookOptions {
  /** Whether to back up operator-modified content before replacing the block */
  force?: boolean;
  /** When true, refuse to update the block if it has drifted from canonical */
  detectExistingFiles?: boolean;
}

export interface ClaudeHookResult {
  /** Path of CLAUDE.md (always set if any action attempted) */
  claudeMdPath: string;
  /** What happened */
  action: 'created' | 'inserted' | 'updated' | 'unchanged' | 'skipped';
  /** Backup file path if --force replaced operator content */
  backupPath?: string;
  /** Non-fatal warnings */
  warnings: string[];
}

/**
 * Ensure CLAUDE.md at projectPath contains the AIWG-managed marker block
 * pointing at AIWG.md. Returns a result describing what was done.
 */
export async function ensureClaudeMdHook(
  projectPath: string,
  opts: ClaudeHookOptions = {},
): Promise<ClaudeHookResult> {
  const claudeMdPath = path.join(projectPath, 'CLAUDE.md');
  await assertSafeContextFile(claudeMdPath);
  const result: ClaudeHookResult = {
    claudeMdPath,
    action: 'skipped',
    warnings: [],
  };

  let policy: ClaudeArtifactOutputPolicy = {};
  try {
    const config = JSON.parse(await fs.readFile(path.join(projectPath, '.aiwg', 'aiwg.config'), 'utf8')) as { artifact_outputs?: ClaudeArtifactOutputPolicy };
    policy = config.artifact_outputs ?? {};
  } catch {
    // Missing/legacy/temporarily malformed config receives the safe default.
  }
  let block = buildClaudeHookBlock(policy);

  // Case 1: CLAUDE.md does not exist — create a minimal one with just the block.
  let existing: string;
  try {
    existing = await fs.readFile(claudeMdPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      const minimal = `${block}\n`;
      await fs.writeFile(claudeMdPath, minimal, 'utf8');
      result.action = 'created';
      return result;
    }
    throw err;
  }

  const lineEnding = dominantLineEnding(existing);
  block = withLineEnding(block, lineEnding);

  const startIdx = existing.indexOf(CLAUDE_HOOK_START);
  const endIdx = existing.indexOf(CLAUDE_HOOK_END);

  // Case 2: marker block does not exist — append the block to end of file.
  if (startIdx === -1 && endIdx === -1) {
    const bootstrapStarts = existing.split(PROVIDER_BOOTSTRAP_START).length - 1;
    const bootstrapEnds = existing.split(PROVIDER_BOOTSTRAP_END).length - 1;

    // Current and legacy AIWG initialization may have emitted the provider
    // bootstrap directly. Migrate that exact managed block in place instead
    // of appending a hook containing a second copy (#1867).
    if (bootstrapStarts === 1 && bootstrapEnds === 1) {
      const bootstrapStartIdx = existing.indexOf(PROVIDER_BOOTSTRAP_START);
      const bootstrapEndIdx = existing.indexOf(PROVIDER_BOOTSTRAP_END, bootstrapStartIdx)
        + PROVIDER_BOOTSTRAP_END.length;
      const updated =
        existing.substring(0, bootstrapStartIdx)
        + block
        + existing.substring(bootstrapEndIdx);
      await fs.writeFile(claudeMdPath, updated, 'utf8');
      result.action = 'updated';
      return result;
    }

    if (bootstrapStarts !== bootstrapEnds || bootstrapStarts > 1) {
      result.warnings.push(
        'CLAUDE.md has malformed or duplicate AIWG provider-bootstrap markers; refusing to append a second managed bootstrap.',
      );
      return result;
    }

    // Ensure the file ends with a single newline before appending.
    const trimmed = existing.replace(/(?:\r?\n)+$/, lineEnding);
    const updated = `${trimmed}${lineEnding}${block}${lineEnding}`;
    await fs.writeFile(claudeMdPath, updated, 'utf8');
    result.action = 'inserted';
    return result;
  }

  // Marker block is present but malformed (one of the two markers missing).
  if (startIdx === -1 || endIdx === -1) {
    result.warnings.push(
      `CLAUDE.md has a malformed AIWG hook block (one marker missing). Re-run with --force to repair.`,
    );
    if (!opts.force) {
      return result;
    }
    // With --force, back up and append a fresh block.
    if (opts.detectExistingFiles !== false) {
      const backupPath = `${claudeMdPath}.bak.${new Date().toISOString().replace(/[:.]/g, '-')}`;
      await fs.writeFile(backupPath, existing, 'utf8');
      result.backupPath = backupPath;
    }
    const trimmed = existing.replace(/(?:\r?\n)+$/, lineEnding);
    const updated = `${trimmed}${lineEnding}${block}${lineEnding}`;
    await fs.writeFile(claudeMdPath, updated, 'utf8');
    result.action = 'inserted';
    return result;
  }

  // Case 3: marker block exists — check whether the content matches canonical.
  const blockEndOffset = endIdx + CLAUDE_HOOK_END.length;
  const currentBlock = existing.substring(startIdx, blockEndOffset);

  if (currentBlock === block) {
    result.action = 'unchanged';
    return result;
  }

  // Block has drifted. Back up first if --force; warn-and-update otherwise
  // (the block is AIWG-managed, so we update by default; the backup is for
  // the case where an operator made deliberate edits inside the block).
  if (opts.force) {
    const backupPath = `${claudeMdPath}.bak.${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await fs.writeFile(backupPath, existing, 'utf8');
    result.backupPath = backupPath;
  } else {
    result.warnings.push(
      `CLAUDE.md AIWG hook block has been modified inside the markers; updating to canonical content. Operator content outside the block is preserved.`,
    );
  }

  const updated = existing.substring(0, startIdx) + block + existing.substring(blockEndOffset);
  await fs.writeFile(claudeMdPath, updated, 'utf8');
  result.action = 'updated';
  return result;
}
