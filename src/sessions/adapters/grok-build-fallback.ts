// Acquire a bounded CLI export when an authorized native projection is unavailable.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveGrokHomeResult } from '../../providers/grok-build-paths.js';
import { SessionContractError, type SelectedSource } from '../contracts.js';
import type { GrokBuildCliOptions } from '../grok-build-cli.js';
import { authorizeGrokBuildNativeSource } from './grok-build-native.js';

export function canFallbackGrokNative(error: unknown, options?: GrokBuildCliOptions): boolean {
  return options !== undefined && process.env.AIWG_GROK_BUILD_NATIVE_EXPERIMENTAL === '1'
    && error instanceof SessionContractError
    && ['SCHEMA_DRIFT', 'UNKNOWN_SCHEMA_MAJOR', 'UNSUPPORTED_OPERATION', 'MALFORMED_SOURCE'].includes(error.code);
}
export async function withGrokCliFallback<T>(
  source: SelectedSource, options: GrokBuildCliOptions,
  operation: (source: SelectedSource) => Promise<T>,
): Promise<T> {
  if (process.env.AIWG_GROK_BUILD_NATIVE_EXPERIMENTAL !== '1') {
    throw new SessionContractError('UNSUPPORTED_OPERATION', 'Grok Build native fallback requires the experimental opt-in; use an explicit `grok export` instead.');
  }
  const { sessionId, cwd } = await authorizeGrokBuildNativeSource(source);
  const home = resolveGrokHomeResult(options.env ?? process.env);
  if (!home.ok || resolve(source.locator) !== join(home.path, 'sessions', encodeURIComponent(cwd), sessionId, 'chat_history.jsonl')) {
    throw new SessionContractError('SOURCE_NOT_AUTHORIZED', 'Grok Build CLI fallback requires the selected session to belong to $GROK_HOME/sessions; set GROK_HOME to the authorized source home.');
  }
  const directory = await mkdtemp(join(tmpdir(), 'aiwg-grok-fallback-'));
  try {
    const { grokBuildExport } = await import('../grok-build-cli.js');
    const locator = await grokBuildExport({ ...options, cwd }, sessionId, directory);
    return await operation({ ...source, locator, locatorClass: 'grok-build-cli-markdown-export',
      authorizedScope: { ...source.authorizedScope, allowedRoots: [directory] } });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
