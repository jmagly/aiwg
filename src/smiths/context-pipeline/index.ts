/**
 * context-pipeline — canonical workspace graph and provider adapter generator.
 *
 * Implements the cross-platform context delivery pipeline defined in
 * `.aiwg/architecture/adr-workspace-context-graph.md`. Emits a project graph:
 *
 * - WORKSPACE.md — protected provider-neutral project/operator context
 * - AIWG.md — generated framework/discovery context
 * - provider startup files — minimal WORKSPACE.md then AIWG.md adapters
 *
 * Distinct from `agentsmith/`, which creates subagent personas. The two modules
 * answer different questions: agentsmith asks "what should this agent persona look
 * like?"; context-pipeline asks "what files are deployed and how should the
 * provider's loader find them?".
 *
 * @module smiths/context-pipeline
 */

export * from './types.js';
export * from './workspace-context.js';
export * from './legacy-inject.js';
export {
  generate,
  buildAgentsMd,
  renderEntry,
  renderSection,
  isOverwriteSafe,
} from './generator.js';
export { sanitizeDescription, sanitizeTag, sanitizeTags } from './sanitizer.js';
export { checkPathAllowed } from './allowlist.js';
export {
  discoverDeployedArtifacts,
  discoverSection,
  type DiscoveryPaths,
} from './discovery.js';
export {
  AGENTS_MD_PROVIDERS,
  shouldEmitContextFiles,
  shouldEmitAiwgMd,
  shouldEmitAgentsMd,
  shouldEmitClaudeMdHook,
  buildMuseBridgeText,
  type AgentsMdProvider,
} from './provider-policy.js';
export { generateAiwgMd } from './aiwg-md.js';
export {
  CLAUDE_HOOK_START,
  CLAUDE_HOOK_END,
  buildClaudeHookBlock,
  ensureClaudeMdHook,
  type ClaudeHookOptions,
  type ClaudeHookResult,
} from './claude-hook.js';
export {
  FINALIZATION_START,
  FINALIZATION_END,
  buildContextFinalizationBlock,
  buildNormalizedAiwgMd,
  replaceOrAppendFinalizationBlock,
  writeNormalizedAiwgMd,
} from './finalization.js';
export {
  SOFT_WARN_BYTES,
  HARD_ERROR_BYTES,
  SPILLOVER_START,
  SPILLOVER_END,
  partitionForOverflow,
  injectSpilloverBlock,
  extractNonSpillover,
  SafetyCriticalOverflowError,
  type OverflowPriorityMap,
} from './overflow.js';
