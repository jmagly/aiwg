/**
 * Bundle Manifest Schema (Zod)
 *
 * Validates `.aiwg/{extensions,addons,frameworks,plugins,providers}/<name>/manifest.json`
 * for project-local artifact bundles. Implements the design in
 * `.aiwg/architecture/design-manifest-schema.md` (#1044).
 *
 * Layered above the per-artifact Extension type validation in `validation.ts`:
 * the bundle manifest declares the bundle (a directory containing artifacts);
 * the existing schemas validate individual artifact bodies inside the bundle.
 *
 * @implements #1044
 * @architecture .aiwg/architecture/design-manifest-schema.md
 */

import { z } from 'zod';
import {
  PlatformCompatibilitySchema,
  DeploymentConfigSchema,
  MemoryFootprintSchema,
  DeprecationSchema,
} from './validation.js';

// ============================================
// Limits (from #1042 threat model + #1044 design)
// ============================================

export const MANIFEST_MAX_BYTES = 64 * 1024;       // 64 KB
export const MAX_BUNDLES_PER_PROJECT = 200;
export const MAX_KEYWORDS_PER_MANIFEST = 50;
export const MAX_OVERRIDES_PER_MANIFEST = 20;

// ============================================
// Project-local bundle types (#1040)
// ============================================

export const ProjectLocalTypeSchema = z.enum([
  'extension',
  'addon',
  'framework',
  'plugin',
  'provider',
]);

export type ProjectLocalType = z.infer<typeof ProjectLocalTypeSchema>;

// ============================================
// Path safety helpers
// ============================================

/**
 * Relative paths within a bundle. No `..`, no leading `/`, alphanumeric +
 * underscore + hyphen, optional trailing slash.
 */
const safeRelativePath = z.string().regex(
  /^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\/?$/,
  'must be a relative path (alphanumeric + _-, no leading slash, no ..)'
);

const safeModuleFile = z.string().regex(
  /^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\.mjs$/,
  'must be a relative .mjs path (alphanumeric + _-, no leading slash, no ..)'
);

// Single-char ids are allowed; multi-char ids must end with alphanumeric
// (no trailing hyphen). This pattern: `[a-z0-9]([a-z0-9-]*[a-z0-9])?`
const bundleNamePattern = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

// ============================================
// Per-type config blocks
// ============================================

const ArtifactListsSchema = z.object({
  agents: z.array(z.string()).max(200).optional(),
  skills: z.array(z.string()).max(500).optional(),
  rules: z.array(z.string()).max(200).optional(),
  templates: z.array(z.string()).max(200).optional(),
  prompts: z.array(z.string()).max(200).optional(),
  hooks: z.array(z.string()).max(50).optional(),
  commands: z.array(z.string()).max(200).optional(),
  behaviors: z.array(z.string()).max(50).optional(),
});

const EntryPathsSchema = z.object({
  agents: safeRelativePath.optional(),
  skills: safeRelativePath.optional(),
  rules: safeRelativePath.optional(),
  templates: safeRelativePath.optional(),
  prompts: safeRelativePath.optional(),
  hooks: safeRelativePath.optional(),
  commands: safeRelativePath.optional(),
  behaviors: safeRelativePath.optional(),
}).strict();

export const AddonConfigSchema = z.object({
  entry: EntryPathsSchema.optional(),
  ...ArtifactListsSchema.shape,
  core: z.boolean().optional(),
  autoInstall: z.boolean().optional(),
}).strict();

export const FrameworkConfigSchema = z.object({
  path: safeRelativePath.optional(),
  files: z.array(safeRelativePath).max(100).optional(),
  ignore: z.array(safeRelativePath).max(100).optional(),
  contextContributions: z.object({
    hookFragment: safeRelativePath.optional(),
    sectionsDir: safeRelativePath.optional(),
    sectionsManifest: safeRelativePath.optional(),
    priority: z.number().int().min(0).max(100).optional(),
    description: z.string().max(512).optional(),
  }).strict().optional(),
}).strict();

export const ExtensionConfigSchema = z.object({
  entry: EntryPathsSchema.optional(),
  ...ArtifactListsSchema.shape,
}).strict();

export const PluginConfigSchema = z.object({
  payloadType: z.enum(['addon', 'framework', 'extension']),
  payloadPath: safeRelativePath,
}).strict();

const ProviderCapabilityFeatureSchema = z.enum([
  'cron',
  'agent_teams',
  'tasks',
  'mcp',
  'behaviors',
  'mission_control',
  'daemon',
]);

const ProviderCapabilityEmulationSchema = z.enum([
  'native',
  'hooks',
  'aiwg-mc',
  'aiwg-schedule',
  'aiwg-daemon',
  'external-trigger',
]).nullable();

const ProviderCapabilityOverridesSchema = z.object({
  nativeFeatures: z.record(ProviderCapabilityFeatureSchema, z.boolean()).optional(),
  emulation: z.record(ProviderCapabilityFeatureSchema, ProviderCapabilityEmulationSchema).optional(),
}).strict();

export const ProviderConfigSchema = z.object({
  extends: z.enum([
    'claude',
    'codex',
    'copilot',
    'cursor',
    'deepseek-harness',
    'factory',
    'grokbot',
    'hermes',
    'opencode',
    'openclaw',
    'openhuman',
    'omp',
    'pi',
    'warp',
    'windsurf',
  ]),
  displayName: z.string().min(1).max(128).optional(),
  aliases: z.array(z.string().min(1).max(64)).max(20).optional(),
  capabilities: ProviderCapabilityOverridesSchema.optional(),
}).strict();

export const CliCommandsSchema = z.object({
  namespace: z.string()
    .min(1)
    .max(64)
    .regex(bundleNamePattern, 'kebab-case alphanumeric, no leading/trailing hyphen'),
  description: z.string().min(1).max(512),
  entry: safeRelativePath.optional(),
  subcommands: z.record(
    z.string()
      .min(1)
      .max(64)
      .regex(bundleNamePattern, 'kebab-case alphanumeric, no leading/trailing hyphen'),
    z.object({
      file: safeModuleFile,
      description: z.string().min(1).max(512),
      hook_event: z.enum([
        'Stop',
        'SessionStart',
        'SessionEnd',
        'PreToolUse',
        'PostToolUse',
        'FeatureComplete',
      ]).optional(),
    }).strict(),
  ).refine((commands) => Object.keys(commands).length > 0, {
    message: 'at least one CLI subcommand is required',
  }),
}).strict();

// ============================================
// Top-level BundleManifestSchema
// ============================================

export const BundleManifestSchema = z.object({
  // Required core fields
  id: z.string()
    .min(1)
    .max(64)
    .regex(bundleNamePattern, 'kebab-case alphanumeric, no leading/trailing hyphen'),
  type: ProjectLocalTypeSchema,
  name: z.string().min(1).max(128),
  version: z.string().regex(/^\d+\.\d+\.\d+/, 'CalVer or SemVer (X.Y.Z[...])'),
  description: z.string().min(1).max(1024),
  manifestVersion: z.literal('1'),
  platforms: PlatformCompatibilitySchema,
  keywords: z.array(z.string().max(64)).min(1).max(MAX_KEYWORDS_PER_MANIFEST),
  deployment: DeploymentConfigSchema,

  // Optional standard metadata
  author: z.string().max(128).optional(),
  license: z.string().max(64).optional(),
  repository: z.string().url().max(512).optional(),

  // Type-discriminated nested config (exactly one matches `type`)
  addonConfig: AddonConfigSchema.optional(),
  frameworkConfig: FrameworkConfigSchema.optional(),
  extensionConfig: ExtensionConfigSchema.optional(),
  pluginConfig: PluginConfigSchema.optional(),
  providerConfig: ProviderConfigSchema.optional(),

  // Override / safety-critical declarations (#1041)
  'safety-critical': z.boolean().optional(),
  overrides: z.array(z.string().max(64)).max(MAX_OVERRIDES_PER_MANIFEST).optional(),

  // Optional patterns shared with existing extension validation
  deprecation: DeprecationSchema.optional(),
  memory: MemoryFootprintSchema.optional(),

  // Expandable CLI namespace contributed by an addon-shaped bundle.
  // The same block is accepted by bundled addon manifests.
  cli_commands: CliCommandsSchema.optional(),
})
  .strict()
  .refine(
    (m) => {
      // Discriminator alignment: type must match the present *Config block(s)
      const present = {
        addon: m.addonConfig !== undefined,
        framework: m.frameworkConfig !== undefined,
        extension: m.extensionConfig !== undefined,
        plugin: m.pluginConfig !== undefined,
        provider: m.providerConfig !== undefined,
      };
      const presentCount = Object.values(present).filter(Boolean).length;
      // Extension is the only type that may omit its config block; others require it
      if (m.type === 'extension') {
        return presentCount === 0 || (presentCount === 1 && present.extension);
      }
      return presentCount === 1 && present[m.type as keyof typeof present];
    },
    { message: 'type must match its corresponding *Config block (addon→addonConfig, framework→frameworkConfig, plugin→pluginConfig, provider→providerConfig; extension may omit extensionConfig)' }
  );

export type BundleManifest = z.infer<typeof BundleManifestSchema>;

// ============================================
// Validation error structures
// ============================================

export interface ManifestValidationError {
  /** Filesystem path of the manifest.json */
  path: string;
  /** Dot-path within the manifest (e.g., "addonConfig.entry.skills") */
  field: string;
  /** What the schema expected */
  expected: string;
  /** What was found */
  actual: string;
  /** Optional remediation hint */
  hint?: string;
  /** error severity */
  severity: 'error' | 'warning';
}

/**
 * Convert a Zod error into the structured ManifestValidationError shape used
 * by discovery and `aiwg validate-metadata`.
 */
export function zodErrorToValidationErrors(
  err: z.ZodError,
  manifestPath: string
): ManifestValidationError[] {
  return err.errors.map((issue) => ({
    path: manifestPath,
    field: issue.path.join('.') || '(root)',
    expected: issue.message,
    actual: 'received' in issue ? String((issue as { received: unknown }).received) : 'invalid',
    severity: 'error',
  }));
}
