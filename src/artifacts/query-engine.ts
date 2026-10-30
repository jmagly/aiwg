/**
 * Artifact Query Engine
 *
 * Searches the artifact index by keyword, type, phase, tags, and path pattern.
 * Returns ranked results in human-readable or JSON format.
 *
 * @implements #416
 * @source @src/artifacts/types.ts
 * @tests @test/unit/artifacts/query-engine.test.ts
 */

export {
  type QueryOptions,
  type DiscoverParams,
  type ShowParams,
  type ShowMetadataParams,
} from './query-engine-options.js';
export { isOrdinaryMemoryEntry, compareDiscoverResults } from './query-engine-entries.js';
export { queryIndex } from './query-engine-index.js';
export { discoverCapability } from './query-engine-discover.js';
export { loadLocalCapabilityEntries, loadLocalOverrideCapabilityEntries } from './query-engine-show-load.js';
export { createRuleBindingTargetResolver, resolveRuleBindingTarget } from './query-engine-matching.js';
export {
  rulesBoundTo,
  relationshipRules,
  type GoverningRule,
  RULE_CHECK_OBLIGATION,
  compoundGoverningRules,
  governingRuleStats,
  governingRuleFields,
  relationshipRuleStats,
} from './query-engine-rules.js';
export { showArtifact, showMetadata } from './query-engine-show.js';
