/**
 * Model Catalog CLI Commands
 *
 * Provides CLI interface for catalog operations:
 * - list: List all models with filtering
 * - info: Show detailed model information
 * - search: Search models by query
 *
 * @implements @.aiwg/architecture/enhanced-model-selection-design.md#9-model-catalog-system
 * @module src/catalog/cli
 */

import type { CatalogModel, CatalogFilter, Provider, ModelStatus } from './types.js';
import {
  loadCatalog,
  getModel,
  listModels,
  getProvider,
  searchModels,
} from './loader.js';

/**
 * Format quality rating as stars
 */
function formatQualityRating(rating: string): string {
  const ratingMap: Record<string, string> = {
    excellent: '★★★★★',
    good: '★★★★☆',
    fair: '★★★☆☆',
    poor: '★★☆☆☆',
    unknown: '☆☆☆☆☆',
  };
  return ratingMap[rating] || '☆☆☆☆☆';
}

/**
 * Format currency amount
 */
function formatPrice(amount: number): string {
  return `$${amount.toFixed(5)}`;
}

/**
 * Format large numbers with commas
 */
function formatNumber(num: number): string {
  return num.toLocaleString();
}

/**
 * Display a table of models
 */
function displayModelsTable(models: CatalogModel[]): void {
  if (models.length === 0) {
    console.log('No models found.');
    return;
  }

  console.log('');
  console.log(
    '┌─────────────────────────────────┬───────────┬──────────┬─────────┬──────────┐'
  );
  console.log(
    '│ Model ID                        │ Display   │ Context  │ Vision  │ Status   │'
  );
  console.log(
    '├─────────────────────────────────┼───────────┼──────────┼─────────┼──────────┤'
  );

  for (const model of models) {
    const id = model.id.padEnd(31).substring(0, 31);
    const display = model.displayName.padEnd(9).substring(0, 9);
    const context = `${Math.floor(model.capabilities.contextWindow / 1000)}K`.padEnd(8);
    const vision = model.capabilities.vision ? '✓' : ' ';
    const status = model.status.padEnd(8);

    console.log(`│ ${id} │ ${display} │ ${context} │ ${vision}       │ ${status} │`);
  }

  console.log(
    '└─────────────────────────────────┴───────────┴──────────┴─────────┴──────────┘'
  );
  console.log('');
}

/**
 * Display detailed model information
 */
function displayModelInfo(model: CatalogModel): void {
  console.log('');
  console.log(`Model: ${model.id}`);
  console.log('');
  console.log(`Provider:       ${model.provider}`);
  console.log(`Display Name:   ${model.displayName}`);
  if (model.releaseDate) {
    console.log(`Release Date:   ${model.releaseDate}`);
  }
  console.log(`Status:         ${model.status}`);

  if (model.deprecated) {
    console.log('');
    console.log('⚠ DEPRECATED');
    if (model.deprecationDate) {
      console.log(`Deprecated:     ${model.deprecationDate}`);
    }
    if (model.successorModel) {
      console.log(`Successor:      ${model.successorModel}`);
    }
  }

  console.log('');
  console.log('Capabilities:');
  console.log(`  Context Window:   ${formatNumber(model.capabilities.contextWindow)} tokens`);
  console.log(`  Max Output:       ${formatNumber(model.capabilities.maxOutputTokens)} tokens`);
  console.log(`  Vision:           ${model.capabilities.vision ? '✓' : '✗'}`);
  console.log(`  Tool Use:         ${model.capabilities.toolUse ? '✓' : '✗'}`);
  console.log(`  Streaming:        ${model.capabilities.streaming ? '✓' : '✗'}`);

  console.log('');
  console.log('Quality Ratings:');
  console.log(
    `  Reasoning:        ${formatQualityRating(model.capabilities.reasoning)} ${model.capabilities.reasoning}`
  );
  console.log(
    `  Coding:           ${formatQualityRating(model.capabilities.coding)} ${model.capabilities.coding}`
  );
  console.log(
    `  Speed:            ${formatQualityRating(model.capabilities.speed)} ${model.capabilities.speed}`
  );

  if (model.pricing) {
    console.log('');
    console.log(`Pricing (${model.pricing.currency} per 1K tokens):`);
    console.log(`  Input:   ${formatPrice(model.pricing.inputPer1kTokens)}`);
    console.log(`  Output:  ${formatPrice(model.pricing.outputPer1kTokens)}`);
    console.log(`  (Last updated: ${model.pricing.lastUpdated})`);
  }

  if (model.aliases.length > 0) {
    console.log('');
    console.log(`Aliases:        ${model.aliases.join(', ')}`);
  }

  if (model.tags.length > 0) {
    console.log(`Tags:           ${model.tags.join(', ')}`);
  }

  console.log('');
  console.log(`Source:         ${model.source}`);
  console.log(`Last Verified:  ${model.lastVerified}`);
  console.log('');
}

/**
 * Handle 'catalog list' command
 */
export async function handleCatalogList(args: string[]): Promise<void> {
  const filter: CatalogFilter = {};

  // Parse filter arguments
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--provider' && i + 1 < args.length) {
      filter.provider = args[i + 1] as Provider;
      i++;
    } else if (args[i] === '--status' && i + 1 < args.length) {
      filter.status = args[i + 1] as ModelStatus;
      i++;
    } else if (args[i] === '--tag' && i + 1 < args.length) {
      filter.tag = args[i + 1];
      i++;
    } else if (args[i] === '--min-context' && i + 1 < args.length) {
      filter.minContext = parseInt(args[i + 1], 10);
      i++;
    }
  }

  const models = await listModels(filter);

  // Group by provider if no provider filter
  if (!filter.provider) {
    const providers = new Set(models.map((m) => m.provider));
    for (const provider of providers) {
      const providerModels = models.filter((m) => m.provider === provider);
      const providerInfo = await getProvider(provider);

      console.log('');
      console.log(
        `AIWG Model Catalog - ${providerInfo?.displayName || provider.toUpperCase()}`
      );

      displayModelsTable(providerModels);
    }
  } else {
    const providerInfo = await getProvider(filter.provider);
    console.log('');
    console.log(
      `AIWG Model Catalog - ${providerInfo?.displayName || filter.provider.toUpperCase()}`
    );

    displayModelsTable(models);
  }

  const catalog = await loadCatalog();
  console.log(`Last refreshed: ${catalog.metadata.lastRefresh}`);
  console.log("Run 'aiwg catalog refresh' to update");
  console.log('');
}

/**
 * Handle 'catalog info' command
 */
export async function handleCatalogInfo(args: string[]): Promise<void> {
  const modelId = args[0];

  if (!modelId) {
    console.error('Error: Model ID required');
    console.log('Usage: aiwg catalog info <model-id>');
    process.exit(1);
  }

  const model = await getModel(modelId);

  if (!model) {
    console.error(`Error: Model '${modelId}' not found in catalog`);
    console.log("Run 'aiwg catalog list' to see available models");
    process.exit(1);
  }

  displayModelInfo(model);
}

/**
 * Handle 'catalog search' command
 */
export async function handleCatalogSearch(args: string[]): Promise<void> {
  const query = args.join(' ');

  if (!query) {
    console.error('Error: Search query required');
    console.log('Usage: aiwg catalog search <query>');
    process.exit(1);
  }

  const models = await searchModels(query);

  console.log('');
  console.log(`Search results for: "${query}"`);

  displayModelsTable(models);
}

export function printCatalogHelp(): void {
  console.log(`Usage: aiwg catalog <command> [options]

Commands:
  list             List models with optional filters
  info <id>        Show detailed model information
  search <query>   Search models by query

Options (list):
  --provider <id>     Filter by provider
  --status <status>   Filter by model status
  --tag <tag>         Filter by tag
  --min-context <n>   Minimum context window in tokens

Examples:
  aiwg catalog list
  aiwg catalog list --provider anthropic
  aiwg catalog info claude-opus-5
  aiwg catalog search opus`);
}

/**
 * Main catalog command router
 */
export async function main(args: string[]): Promise<void> {
  const subcommand = args[0];
  const subcommandArgs = args.slice(1);

  switch (subcommand) {
    case 'list':
      await handleCatalogList(subcommandArgs);
      break;

    case 'info':
      await handleCatalogInfo(subcommandArgs);
      break;

    case 'search':
      await handleCatalogSearch(subcommandArgs);
      break;

    case undefined:
      console.error('Error: Catalog subcommand required');
      printCatalogHelp();
      process.exit(1);
      break;

    default:
      console.error(`Error: Unknown catalog subcommand '${subcommand}'`);
      console.log('Available: list, info, search');
      process.exit(1);
  }
}
