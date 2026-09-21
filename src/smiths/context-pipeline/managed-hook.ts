/**
 * Additive AIWG hook installer for operator-owned provider context files.
 *
 * Generalizes the CLAUDE.md hook pattern (`ensureClaudeMdHook`, #1437) to any
 * provider-facing main prompt/context file — AGENTS.md, WARP.md, .hermes.md.
 * When such a file exists but is not AIWG-managed (operator-authored), the prior
 * behavior was to warn and skip, leaving Codex/Warp/Hermes without the `@AIWG.md`
 * bridge. This installs the minimal managed hook block **additively** (operator
 * content preserved byte-for-byte), and never requires `--force` for the additive
 * path — `--force` stays reserved for replacing the whole file.
 *
 * @issue #1597 (AGENTS.md / Codex) — sibling #1579 (WARP.md / Warp)
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { buildProviderBootstrapBlock } from './workspace-context.js';
import { dominantLineEnding, withLineEnding } from './line-endings.js';
import { assertSafeContextFile } from './context-file-safety.js';

export const CONTEXT_HOOK_START = '<!-- AIWG:context-hook:start -->';
export const CONTEXT_HOOK_END = '<!-- AIWG:context-hook:end -->';

/** The managed block — loads canonical workspace context before framework context. */
export function buildContextHookBlock(provider = 'codex'): string {
  return [
    CONTEXT_HOOK_START,
    '',
    buildProviderBootstrapBlock(provider),
    '',
    '<!--',
    '  This block is managed by `aiwg regenerate` and `aiwg use`.',
    '  Operator content above and below this block is preserved on regenerate.',
    '  Edit .aiwg/AIWG.md (the normalized source) then run `aiwg regenerate`.',
    '-->',
    '',
    CONTEXT_HOOK_END,
  ].join('\n');
}

export interface ManagedHookResult {
  path: string;
  /** What happened to the file */
  action: 'created' | 'inserted' | 'updated' | 'unchanged' | 'skipped';
  warnings: string[];
}

/** Does the file already carry the canonical context hook? */
export function hasContextHook(content: string): boolean {
  return content.includes(CONTEXT_HOOK_START) || (
    /^[ \t]*@WORKSPACE\.md[ \t]*$/m.test(content) && /^[ \t]*@AIWG\.md[ \t]*$/m.test(content)
  );
}

/**
 * Ensure `filePath` contains the AIWG `@AIWG.md` hook block, preserving all
 * operator-authored content. Additive by default (no `--force` needed).
 */
export async function ensureManagedHook(filePath: string, opts: { force?: boolean; provider?: string } = {}): Promise<ManagedHookResult> {
  await assertSafeContextFile(filePath);
  const base = path.basename(filePath);
  let block = buildContextHookBlock(opts.provider);
  const result: ManagedHookResult = { path: filePath, action: 'skipped', warnings: [] };

  let existing: string;
  try {
    existing = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      await fs.writeFile(filePath, `${block}\n`, 'utf8');
      result.action = 'created';
      return result;
    }
    throw err;
  }

  const lineEnding = dominantLineEnding(existing);
  block = withLineEnding(block, lineEnding);

  // Already has both bare includes (operator wired them by hand) — nothing to do.
  if (!existing.includes(CONTEXT_HOOK_START) && /^[ \t]*@WORKSPACE\.md[ \t]*$/m.test(existing) && /^[ \t]*@AIWG\.md[ \t]*$/m.test(existing)) {
    result.action = 'unchanged';
    return result;
  }

  const s = existing.indexOf(CONTEXT_HOOK_START);
  const e = existing.indexOf(CONTEXT_HOOK_END);

  // No managed block — append it to the end, preserving everything above.
  if (s === -1 && e === -1) {
    const trimmed = existing.replace(/(?:\r?\n)+$/, lineEnding);
    await fs.writeFile(filePath, `${trimmed}${lineEnding}${block}${lineEnding}`, 'utf8');
    result.action = 'inserted';
    return result;
  }

  // Malformed (one marker only) — repair only with --force to avoid clobbering.
  if (s === -1 || e === -1) {
    if (opts.force) {
      const trimmed = existing.replace(/(?:\r?\n)+$/, lineEnding);
      await fs.writeFile(filePath, `${trimmed}${lineEnding}${block}${lineEnding}`, 'utf8');
      result.action = 'inserted';
      return result;
    }
    result.warnings.push(`${base} has a malformed AIWG hook block (one marker missing); re-run with --force to repair.`);
    return result;
  }

  // Block present — refresh it if it has drifted from canonical.
  const endOff = e + CONTEXT_HOOK_END.length;
  const current = existing.substring(s, endOff);
  if (current === block) {
    result.action = 'unchanged';
    return result;
  }
  await fs.writeFile(filePath, existing.substring(0, s) + block + existing.substring(endOff), 'utf8');
  result.action = 'updated';
  return result;
}
