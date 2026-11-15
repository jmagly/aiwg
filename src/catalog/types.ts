/**
 * Model Catalog Type Definitions
 *
 * @implements @docs/models/supported-models.md
 * @module src/catalog/types
 */

/**
 * Provider identifiers supported by AIWG
 */
export type Provider = 'anthropic' | 'openai' | 'openrouter' | 'google' | 'custom';

/**
 * Model status indicating availability
 */
export type ModelStatus = 'active' | 'deprecated' | 'beta' | 'preview';

/**
 * Quality rating for model capabilities
 */
export type QualityRating = 'excellent' | 'good' | 'fair' | 'poor' | 'unknown';

/**
 * Model capabilities metadata
 */
export interface ModelCapabilities {
  contextWindow: number;
  maxOutputTokens: number;
  vision: boolean;
  toolUse: boolean;
  streaming: boolean;
  reasoning: QualityRating;
  coding: QualityRating;
  speed: QualityRating;
}

/**
 * Pricing information for a model
 */
export interface ModelPricing {
  inputPer1kTokens: number;
  outputPer1kTokens: number;
  currency: string;
  lastUpdated: string;
}

/**
 * Source of catalog entry
 */
export type CatalogSource = 'builtin' | 'discovered' | 'custom';

/**
 * Complete model definition in catalog
 */
export interface CatalogModel {
  id: string;
  provider: Provider;
  displayName: string;
  releaseDate?: string;
  status: ModelStatus;
  deprecated: boolean;
  deprecationDate?: string | null;
  successorModel?: string | null;
  capabilities: ModelCapabilities;
  pricing?: ModelPricing;
  aliases: string[];
  tags: string[];
  source: CatalogSource;
  lastVerified: string;
}

/**
 * Provider metadata
 */
export interface CatalogProvider {
  displayName: string;
  apiEndpoint?: string;
  modelsEndpoint?: string;
  docsUrl?: string;
  pricingUrl?: string;
}

/**
 * Catalog metadata
 */
export interface CatalogMetadata {
  version: string;
  lastRefresh: string;
  nextRefresh?: string;
  modelCount: number;
  providerCount: number;
}

/**
 * Complete model catalog structure
 */
export interface ModelCatalog {
  models: Record<string, CatalogModel>;
  providers: Record<string, CatalogProvider>;
  metadata: CatalogMetadata;
}

/**
 * Data source configuration for catalog refresh
 */
export interface DataSource {
  endpoint: string;
  requiresAuth: boolean;
  authEnvVar?: string;
  cacheDuration: string;
}

/**
 * Sources configuration
 */
export interface SourcesConfig {
  refreshSchedule: {
    automatic: boolean;
    intervalDays: number;
    onStartup: boolean;
    notifyOnNew: boolean;
  };
  sources: Record<string, DataSource & { enabled: boolean }>;
  fallbackBehavior: {
    onSourceFailure: 'use-cache' | 'fail';
    maxCacheAge: string;
    alertOnStale: boolean;
  };
}

/**
 * Result of catalog refresh operation
 */
export interface RefreshResult {
  newModels: string[];
  deprecatedModels: string[];
  errors: Array<{ source: string; error: string }>;
  timestamp: string;
}

/**
 * Filter options for catalog queries
 */
export interface CatalogFilter {
  provider?: Provider;
  status?: ModelStatus;
  tag?: string;
  capability?: keyof ModelCapabilities;
  minContext?: number;
}
