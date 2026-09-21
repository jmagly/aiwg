/**
 * hook-bridge — cross-provider hook translation per ADR-3.
 *
 * Public API: bridgeAll(sources, providers, opts) translates every source
 * for every provider, returning a flat list of TranslateResult. Per ADR-3
 * §7 autoInstall policy, the orchestrator passes the explicitly-enabled
 * providers (operator opts in via --enable-cross-provider-hooks plus per-
 * provider flags); this module doesn't make that policy decision itself.
 *
 * @module smiths/hook-bridge
 */

import type { HookSource, TranslateOptions, TranslateResult, ProviderTranslator } from './types.js';
import { translateForCodex } from './codex-translator.js';
import { translateForCopilot } from './copilot-translator.js';
import { translateForFactory } from './factory-translator.js';
import { translateForHermes } from './hermes-translator.js';
import { translateForGrokBuild } from './grok-build-translator.js';
import { getProviderDefinition } from '../../providers/provider-definitions.js';

export type { HookSource, HookEvent, HookExitSemantic, TranslateOptions, TranslateResult, ProviderTranslator } from './types.js';
export { AIWG_ENV_VARS, NATIVE_ENV_VAR_MAP } from './types.js';
export { substituteEnvVars, generateShimBash, EXIT_CODE_MAP } from './shim.js';
export { translateForCodex, renderCodexHookToml, injectHookBlock as injectCodexHookBlock } from './codex-translator.js';
export { translateForCopilot } from './copilot-translator.js';
export { translateForFactory } from './factory-translator.js';
export { translateForHermes } from './hermes-translator.js';
export { translateForGrokBuild, GROK_EVENT_MAP } from './grok-build-translator.js';
export { loadHookSources } from './loader.js';

/**
 * Provider id → translator function. Adding a new provider requires:
 *   1. New file `<provider>-translator.ts` exporting a ProviderTranslator
 *   2. Entry below
 *   3. Native env var entry in types.ts NATIVE_ENV_VAR_MAP
 *   4. Native exit code entry in shim.ts EXIT_CODE_MAP
 *   5. Native event mapping in the per-provider file
 */
export const TRANSLATORS: Record<string, ProviderTranslator> = {
  codex: translateForCodex,
  copilot: translateForCopilot,
  factory: translateForFactory,
  hermes: translateForHermes,
  'grok-build': translateForGrokBuild,
};

function resolveHookTranslator(providerId: string): ProviderTranslator | undefined {
  const adapterKey = getProviderDefinition(providerId)?.adapters.hookBridge ?? providerId;
  return adapterKey ? TRANSLATORS[adapterKey] : undefined;
}

/**
 * Translate one source across an explicit list of providers. Per-provider
 * failures are captured as TranslateResult entries (skipped=true with
 * reason); they do not throw to the caller.
 */
export async function bridgeAll(
  sources: HookSource[],
  providers: string[],
  options: TranslateOptions,
): Promise<TranslateResult[]> {
  const results: TranslateResult[] = [];
  for (const source of sources) {
    for (const providerId of providers) {
      const translator = resolveHookTranslator(providerId);
      if (!translator) {
        results.push({
          provider: providerId,
          emittedPaths: [],
          warnings: [],
          skipped: true,
          skipReason: 'no translator registered',
        });
        continue;
      }
      try {
        const r = await translator(source, options);
        results.push(r);
      } catch (err) {
        results.push({
          provider: providerId,
          emittedPaths: [],
          warnings: [`translator threw: ${err instanceof Error ? err.message : String(err)}`],
          skipped: true,
          skipReason: 'translator error',
        });
      }
    }
  }
  return results;
}
