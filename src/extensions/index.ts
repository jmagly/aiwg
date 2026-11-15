/**
 * Extensions Module
 *
 * Unified extension system for AIWG - provides types, registry, validation,
 * capability indexing, and loading functionality for all extension types.
 *
 * @implements @.aiwg/requirements/use-cases/UC-004-extension-system.md
 * @architecture @docs/architecture/cli/extending-cli.md
 */

// Core types
export * from './types.js';

// Registry
export {
  ExtensionRegistry,
  getRegistry,
  createRegistry,
} from './registry.js';

// Capability index
export { CapabilityIndex } from './capability-index.js';

// Validation
export {
  validateExtension,
  isValidExtension,
  validateExtensionStrict,
} from './validation.js';

// Loader
export {
  loadRegistry,
  getLoadedRegistry,
  linkHandlers,
  type LoaderOptions,
  type LoadedRegistry,
} from './loader.js';

// Command definitions
export { commandDefinitions } from './commands/definitions.js';
