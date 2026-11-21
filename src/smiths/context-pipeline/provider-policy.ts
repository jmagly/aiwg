/**
 * Provider policy for AIWG.md, AGENTS.md, and CLAUDE.md hook emission.
 *
 * Per ADR-1 §3: AIWG.md is the cross-provider context entry point. Most
 * providers reach it through AGENTS.md or a provider-native twin file
 * (Hermes `.hermes.md`, Warp `WARP.md`). Claude Code reaches it through
 * `CLAUDE.md` containing a `@AIWG.md` include — same pipeline, different
 * link mechanism.
 *
 * Previous design (pre-#1437) bailed out entirely for the claude provider
 * with the misleading rationale "claude uses CLAUDE.md natively." That
 * conflated two facts: claude DOES read CLAUDE.md without aiwg-side
 * wiring, but regenerate STILL needs to refresh AIWG.md and ensure the
 * `@AIWG.md` link is present in CLAUDE.md. The provider hooks remain granular;
 * root AIWG.md is now universal (#3762).
 *
 * @issue #1437
 */

import type { Platform } from '../../agents/types.js';
import { getProviderDefinition, listProviderDefinitions } from '../../providers/provider-definitions.js';

/**
 * Providers that receive AGENTS.md emission at project root.
 *
 * Sources kept in sync:
 * - ADR-1 §3 default-on rollout (`docs/configuration/workspace-context.md`)
 * - ADR-1 §4 per-provider variants table (file-name + twin-file emission)
 */
export const AGENTS_MD_PROVIDERS: ReadonlySet<Platform> = new Set(
  listProviderDefinitions()
    .filter((definition) => definition.paths.contextFiles.agentsMd)
    .map((definition) => definition.id),
);

export type AgentsMdProvider = Platform & ('antigravity' | 'codex' | 'copilot' | 'cursor' | 'devin' | 'hermes' | 'grokbot' | 'grok-build' | 'muse' | 'pi' | 'omp' | 'warp' | 'factory' | 'opencode');

/** Compatibility query: every registered provider receives root AIWG.md (#3762). */
export function shouldEmitContextFiles(provider: Platform): boolean {
  return shouldEmitAiwgMd(provider);
}

/**
 * Compatibility query, no longer an emission gate. Root AIWG.md is always
 * generated; only an explicit caller opt-out can suppress it (#3762).
 */
export function shouldEmitAiwgMd(provider: Platform): boolean {
  return getProviderDefinition(provider)?.paths.contextFiles.aiwgMd ?? false;
}

/**
 * Whether to emit AGENTS.md at project root. True for the AGENTS-MD
 * provider set (antigravity, codex, copilot, cursor, windsurf, hermes, warp,
 * factory, opencode). False for claude (uses CLAUDE.md hook instead), openclaw,
 * and generic.
 */
export function shouldEmitAgentsMd(provider: Platform): boolean {
  return getProviderDefinition(provider)?.paths.contextFiles.agentsMd ?? false;
}

/**
 * Whether to ensure the CLAUDE.md `@AIWG.md` hook is present. True only
 * for the claude provider. CLAUDE.md gets a managed marker block with an
 * `@AIWG.md` include; operator content outside the block is preserved.
 */
export function shouldEmitClaudeMdHook(provider: Platform): boolean {
  return getProviderDefinition(provider)?.paths.contextFiles.claudeMdHook ?? false;
}

// The Muse discover-first bridge text lives in ./muse-bridge.js (kept
// dependency-free so consumers like buildProviderBootstrapBlock do not pull
// this module's evaluation side effects into every import graph). Re-export
// it here so the provider-policy surface stays the canonical policy home.
export { buildMuseBridgeText } from './muse-bridge.js';
