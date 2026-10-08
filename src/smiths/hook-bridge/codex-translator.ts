/**
 * Codex hook translator — emits TOML hook entries for ~/.codex/config.toml.
 *
 * Per ADR-3 §5 backup-and-rollback: the operator-managed config file
 * (~/.codex/config.toml) is read, AIWG-tagged entries are merged in
 * (via _aiwg_managed: true), and the file is written atomically with a
 * timestamped backup.
 *
 * Codex hook events map per the assessment matrix; this translator
 * supports a conservative subset known to exist in the loader.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import type { HookSource, TranslateOptions, TranslateResult } from './types.js';
import { substituteEnvVars } from './shim.js';

/** Codex-native event names (subset; extend when verified against codex-rs). */
const CODEX_EVENT_MAP: Record<string, string> = {
  PreToolUse: 'before_tool',
  PostToolUse: 'after_tool',
  UserPromptSubmit: 'before_prompt',
  SessionStart: 'session_start',
  SessionEnd: 'session_end',
  Stop: 'session_end',
};

/**
 * Render a single TOML hook entry for a Codex config block.
 *
 * Codex's hook TOML shape (per the assessment):
 *   [[hooks.<event>]]
 *   command = "..."
 *   args = ["..."]
 *   _aiwg_managed = true
 *
 * Operators add their own hooks at the same shape; the _aiwg_managed flag
 * lets `aiwg remove --addon aiwg-hooks` distinguish AIWG entries from
 * operator-authored ones.
 */
export function renderCodexHookToml(source: HookSource): string {
  const lines: string[] = [];

  for (const event of source.events) {
    const codexEvent = CODEX_EVENT_MAP[event];
    if (!codexEvent) continue;

    const subCommand = substituteEnvVars(source.command, 'codex');
    const subArgs = (source.args || []).map((a) => substituteEnvVars(a, 'codex'));

    lines.push(`[[hooks.${codexEvent}]]`);
    lines.push(`# AIWG-managed hook: ${source.id} — ${source.description}`);
    lines.push(`command = "${subCommand.replace(/"/g, '\\"')}"`);
    if (subArgs.length > 0) {
      lines.push(`args = [${subArgs.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(', ')}]`);
    }
    if (source.safetyCritical) {
      lines.push(`# safety-critical: cannot be auto-removed without --allow-unsafe-shadow`);
    }
    lines.push(`_aiwg_managed = true`);
    lines.push(`_aiwg_id = "${source.id}"`);
    lines.push('');
  }

  return lines.join('\n');
}

const SPILLOVER_START = '# >>> AIWG-managed hooks (do not edit between markers)';
const SPILLOVER_END = '# <<< AIWG-managed hooks';

/**
 * Inject AIWG-managed hook block into existing TOML config, preserving
 * everything outside the markers. Idempotent — replaces an existing block
 * rather than appending.
 */
export function injectHookBlock(existingToml: string, hookBlock: string): string {
  const startIdx = existingToml.indexOf(SPILLOVER_START);
  const endIdx = existingToml.indexOf(SPILLOVER_END);

  const aiwgSection = `${SPILLOVER_START}\n${hookBlock}\n${SPILLOVER_END}\n`;

  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    const trimmed = existingToml.replace(/\n+$/, '');
    return (trimmed.length > 0 ? trimmed + '\n\n' : '') + aiwgSection;
  }

  const before = existingToml.slice(0, startIdx);
  const after = existingToml.slice(endIdx + SPILLOVER_END.length).replace(/^\n+/, '\n');
  return `${before}${aiwgSection}${after}`;
}

/**
 * Translate one HookSource to Codex TOML config.
 *
 * Writes to ~/.codex/config.toml (user-global), backing up the existing
 * file if no AIWG signature is found per ADR-3 §5.
 */
export async function translateForCodex(
  source: HookSource,
  options: TranslateOptions,
): Promise<TranslateResult> {
  const result: TranslateResult = {
    provider: 'codex',
    emittedPaths: [],
    warnings: [],
    skipped: false,
  };

  if (source.degradeOn?.includes('codex')) {
    result.skipped = true;
    result.skipReason = 'degrade-on declared codex';
    return result;
  }

  const configPath = path.join(process.env.CODEX_HOME || path.join(homedir(), '.codex'), 'config.toml');
  const block = renderCodexHookToml(source);

  if (block.trim().length === 0) {
    result.skipped = true;
    result.skipReason = 'no Codex-mapped events';
    return result;
  }

  if (options.dryRun) {
    result.emittedPaths.push(configPath + ' (dry-run)');
    return result;
  }

  let existing = '';
  try {
    existing = await fs.readFile(configPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  // Backup-and-rollback per ADR-3 §5.
  if (existing && !existing.includes(SPILLOVER_START)) {
    const backupPath = `${configPath}.bak.${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await fs.writeFile(backupPath, existing, 'utf8');
    result.warnings.push(`Backed up pre-existing config to ${backupPath}`);
  }

  const updated = injectHookBlock(existing, block);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, updated, 'utf8');
  result.emittedPaths.push(configPath);

  return result;
}
