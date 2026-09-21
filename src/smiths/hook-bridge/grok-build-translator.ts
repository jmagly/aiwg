/** Grok Build hook translator. Deployment writes project JSON only; trust remains an operator action. */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { HookEvent, HookSource, TranslateOptions, TranslateResult } from './types.js';

export const GROK_EVENT_MAP: Partial<Record<HookEvent, string>> = {
  SessionStart: 'SessionStart',
  SessionEnd: 'SessionEnd',
  UserPromptSubmit: 'UserPromptSubmit',
  PreToolUse: 'PreToolUse',
  PostToolUse: 'PostToolUse',
  Stop: 'Stop',
};

function safeId(id: string): string | null {
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(id) ? id : null;
}

export async function translateForGrokBuild(
  source: HookSource,
  options: TranslateOptions,
): Promise<TranslateResult> {
  const result: TranslateResult = { provider: 'grok-build', emittedPaths: [], warnings: [], skipped: false };
  if (source.degradeOn?.includes('grok-build')) return { ...result, skipped: true, skipReason: 'degrade-on declared grok-build' };
  const id = safeId(source.id);
  if (!id) return { ...result, skipped: true, skipReason: 'hook id is not a safe Grok file name' };
  const mapped = source.events.map(event => GROK_EVENT_MAP[event]).filter((event): event is string => Boolean(event));
  const unsupported = source.events.filter(event => !GROK_EVENT_MAP[event]);
  if (unsupported.length) result.warnings.push(`Unsupported Grok hook events: ${unsupported.join(', ')}`);
  if (!mapped.length) return { ...result, skipped: true, skipReason: 'no equivalent Grok hook events' };

  const hooksDir = path.resolve(options.projectPath, '.grok', 'hooks');
  const filePath = path.resolve(hooksDir, `aiwg-${id}.json`);
  if (!filePath.startsWith(`${hooksDir}${path.sep}`)) return { ...result, skipped: true, skipReason: 'hook path escapes project hook root' };
  const hooks = Object.fromEntries(mapped.map(event => [event, [{ hooks: [{ type: 'command', command: [source.command, ...(source.args || [])].join(' '), timeout: 10 }] }]]));
  const document = { _aiwg_managed: true, _aiwg_id: id, hooks };
  result.warnings.push('Project hook emitted without granting Grok trust; use /hooks-trust separately after review.');
  if (source.events.includes('PreToolUse')) {
    result.warnings.push('Only explicit PreToolUse JSON denial blocks; crashes, timeouts, malformed output, and all passive hook failures fail open.');
  }
  if (options.dryRun) { result.emittedPaths.push(`${filePath} (dry-run)`); return result; }
  await fs.mkdir(hooksDir, { recursive: true });
  const dirInfo = await fs.lstat(hooksDir);
  if (dirInfo.isSymbolicLink()) throw new Error('Refusing to write Grok hooks through a symbolic link');
  try {
    const info = await fs.lstat(filePath);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('Refusing unsafe Grok hook target');
    const current = JSON.parse(await fs.readFile(filePath, 'utf8')) as Record<string, unknown>;
    if (current._aiwg_managed !== true || current._aiwg_id !== id) throw new Error(`Refusing to replace operator-managed Grok hook ${filePath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temp = `${filePath}.tmp-${process.pid}`;
  await fs.writeFile(temp, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await fs.rename(temp, filePath);
  result.emittedPaths.push(filePath);
  return result;
}
