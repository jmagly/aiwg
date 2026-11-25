import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute } from 'node:path';
import { SessionContractError, type SourceDescriptor } from './contracts.js';
import { grokbotConversationIdFromLocator } from './adapters/grokbot-locator.js';

export interface SourceExclusion {
  entry: string;
  kind: 'session-id' | 'path-glob';
}

export function validateImportExclusions(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || !value.every(entry => typeof entry === 'string' && entry.trim().length > 0)) {
    throw new SessionContractError('INVALID_ARGUMENT', 'sessions.import.exclude must be an array of non-empty strings');
  }
  for (const entry of value) {
    if (!isAbsolute(entry) && entry !== '~' && !entry.startsWith('~/') && /[/*?\\~]/.test(entry)) {
      throw new SessionContractError('INVALID_ARGUMENT', 'sessions.import.exclude path globs must be absolute or ~/ prefixed');
    }
  }
}

export function resolveImportExclusions(
  config?: { exclude?: string[] },
  flags: readonly string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const configured = config?.exclude === undefined ? [] : config.exclude;
  validateImportExclusions(configured);
  const entries = [...configured, ...(env.AIWG_SESSIONS_IMPORT_EXCLUDE === undefined
    ? [] : env.AIWG_SESSIONS_IMPORT_EXCLUDE.split(',').map(entry => entry.trim())), ...flags];
  validateImportExclusions(entries);
  return [...new Set(entries)];
}

/** Use only discovery metadata and locator names; never inspect source content. */
export function matchImportExclusion(
  source: SourceDescriptor,
  entries: readonly string[],
): SourceExclusion | undefined {
  const ids = [source.nativeSessionId, nativeSessionIdFromLocator(source)];
  for (const entry of entries) {
    if (isAbsolute(entry) || entry === '~' || entry.startsWith('~/')) {
      const pattern = entry.startsWith('~') ? homedir() + entry.slice(1) : entry;
      if (globExpression(pattern).test(source.locator)) return { entry, kind: 'path-glob' };
    } else if (ids.includes(entry)) return { entry, kind: 'session-id' };
  }
  return undefined;
}

export function nativeSessionIdFromLocator(source: SourceDescriptor): string | undefined {
  if (source.provider === 'grokbot') return grokbotConversationIdFromLocator(source.locator) ?? undefined;
  if (source.provider === 'muse') return basename(dirname(source.locator));
  const locator = source.provider === 'codex' ? source.locator.replace(/\.zst$/i, '') : source.locator;
  const name = basename(locator, extname(locator));
  if (source.provider === 'codex' || source.provider === 'pi') {
    return /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(name)?.[1] ?? name;
  }
  return name;
}

function globExpression(pattern: string): RegExp {
  let expression = '^';
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        index++;
        if (pattern[index + 1] === '/') { expression += '(?:.*/)?'; index++; }
        else expression += '.*';
      } else expression += '[^/]*';
    } else if (character === '?') expression += '[^/]';
    else expression += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(expression + '$');
}
