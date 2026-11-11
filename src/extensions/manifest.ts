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
import { integer, dateTime, url } from '../schema/zod-validation.mjs';
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

const safeJsonFile = z.string().regex(
  /^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\.json$/,
  'must be a relative .json path (alphanumeric + _-, no leading slash, no ..)'
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
  gatePacks: z.array(z.string().min(1).max(128)).max(50).optional(),
});

const EntryPathsSchema = z.strictObject({
  agents: safeRelativePath.optional(),
  skills: safeRelativePath.optional(),
  rules: safeRelativePath.optional(),
  templates: safeRelativePath.optional(),
  prompts: safeRelativePath.optional(),
  hooks: safeRelativePath.optional(),
  commands: safeRelativePath.optional(),
  behaviors: safeRelativePath.optional(),
  gatePacks: safeRelativePath.optional(),
});

export const AddonConfigSchema = z.strictObject({
  entry: EntryPathsSchema.optional(),
  ...ArtifactListsSchema.shape,
  core: z.boolean().optional(),
  autoInstall: z.boolean().optional(),
});

export const FrameworkConfigSchema = z.strictObject({
  path: safeRelativePath.optional(),
  files: z.array(safeRelativePath).max(100).optional(),
  ignore: z.array(safeRelativePath).max(100).optional(),
  gatePacks: z.array(z.string().min(1).max(128)).max(50).optional(),
  entry: z.strictObject({
    gatePacks: safeRelativePath.optional(),
  }).optional(),
  contextContributions: z.strictObject({
    hookFragment: safeRelativePath.optional(),
    sectionsDir: safeRelativePath.optional(),
    sectionsManifest: safeRelativePath.optional(),
    priority: integer().min(0).max(100).optional(),
    description: z.string().max(512).optional(),
  }).optional(),
});

export const ExtensionConfigSchema = z.strictObject({
  entry: EntryPathsSchema.optional(),
  ...ArtifactListsSchema.shape,
});

export const PluginConfigSchema = z.strictObject({
  payloadType: z.enum(['addon', 'framework', 'extension']),
  payloadPath: safeRelativePath,
});

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

const ProviderCapabilityOverridesSchema = z.strictObject({
  nativeFeatures: z.partialRecord(ProviderCapabilityFeatureSchema, z.boolean()).optional(),
  emulation: z.partialRecord(ProviderCapabilityFeatureSchema, ProviderCapabilityEmulationSchema).optional(),
});

export const ProviderConfigSchema = z.strictObject({
  extends: z.enum([
    'claude',
    'codex',
    'copilot',
    'cursor',
    'deepseek-harness',
    'factory',
    'grokbot',
    'hermes',
    'muse',
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
});

/**
 * Review attestation for one gate metric provider (#2831).
 *
 * A reviewer records who reviewed which exact provider bytes and when. The
 * `codeDigest` must equal the loader-computed code digest over the provider
 * module plus its resolved local imports (and lockfile-pinned externals);
 * registration refuses absent attestations and digest mismatches. Null or
 * unknown digests never verify: they fail closed.
 */
export const GateProviderReviewSchema = z.strictObject({
  reviewer: z.string().min(1).max(128),
  reviewedAt: dateTime(),
  codeDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/, 'must be a sha256 digest'),
});

export type GateProviderReview = z.infer<typeof GateProviderReviewSchema>;

/**
 * One addon/extension gate metric provider declared by a bundle manifest
 * (#2831). The module is loaded ONLY through the gates registry from this
 * declaration, inside the bundle root (no traversal, no escaping symlinks,
 * no absolute paths, size-limited), never by arbitrary import. Core
 * providers remain the default; this field is optional and disabled unless
 * the caller explicitly enables bundle providers.
 */
export const GateProviderEntrySchema = z.strictObject({
  id: z.string().min(1).max(128).regex(
    /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/,
    'must be a namespaced provider id <scope>/<name> (alphanumeric plus . _ -)',
  ),
  version: z.string().regex(/^\d+\.\d+\.\d+/, 'CalVer or SemVer (X.Y.Z[...])'),
  module: safeModuleFile,
  description: z.string().min(1).max(512),
  review: GateProviderReviewSchema.optional(),
  reviewFile: safeJsonFile.optional(),
}).refine(
  (entry) => (entry.review !== undefined) !== (entry.reviewFile !== undefined),
  { error: 'exactly one of review or reviewFile is required' },
);

export type GateProviderEntry = z.infer<typeof GateProviderEntrySchema>;

export const GateProvidersSchema = z.array(GateProviderEntrySchema).max(20).refine(
  (entries) => new Set(entries.map((entry) => entry.id)).size === entries.length,
  { error: 'gate provider ids must be unique within a bundle' },
).refine(
  (entries) => new Set(entries.map((entry) => entry.module)).size === entries.length,
  { error: 'gate provider modules must be unique within a bundle' },
);

export const CliCommandsSchema = z.strictObject({
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
    z.strictObject({
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
    }),
  ).refine((commands) => Object.keys(commands).length > 0, {
    error: 'at least one CLI subcommand is required',
  }),
});

// ============================================
// Top-level BundleManifestSchema
// ============================================

export const BundleManifestSchema = z.strictObject({
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
  repository: url().max(512).optional(),

  // Addon inventory/flags use the same top-level shape as validate-addon and
  // upstream manifests. Nested *Config declarations remain supported.
  ...ArtifactListsSchema.shape,
  core: z.boolean().optional(),
  autoInstall: z.boolean().optional(),
  devOnly: z.boolean().optional(),

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

  // Addon/extension gate metric providers (#2831). Optional and disabled by
  // default: the gates loader resolves each `module` inside the bundle root
  // only, verifies the review attestation digest against the computed code
  // digest, and registers the provider through the gates registry. Core
  // providers remain the default when this field is absent.
  gateProviders: GateProvidersSchema.optional(),
})
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
    { error: 'type must match its corresponding *Config block (addon→addonConfig, framework→frameworkConfig, plugin→pluginConfig, provider→providerConfig; extension may omit extensionConfig)' }
  );

export type BundleManifest = z.infer<typeof BundleManifestSchema>;

// ============================================
// Validation error structures
// ============================================

export interface ManifestValidationError {
  /** Readable bundle identity retained even when other manifest fields fail. */
  bundleId?: string;
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
  manifestPath: string,
  input?: unknown,
): ManifestValidationError[] {
  const hasInput = arguments.length >= 3;
  const issues = err.issues.flatMap(issue => {
    // Partial enum maps report unknown keys at the map in v4; discovery's
    // existing field contract identifies each rejected capability key.
    if (issue.code === 'unrecognized_keys'
      && issue.path.length === 3 && issue.path[0] === 'providerConfig'
      && issue.path[1] === 'capabilities'
      && ['nativeFeatures', 'emulation'].includes(String(issue.path[2]))) {
      return issue.keys.map(key => ({ ...issue, path: [...issue.path, key], keys: [key] }));
    }
    return [issue];
  });
  return issues.map((issue) => {
    let actual = 'invalid';
    if (issue.code === 'unrecognized_keys') {
      // Name each rejected key so doctor/use output identifies the culprit
      // (#3724: a typo'd or unknown platform key must not vanish into
      // a bare "invalid").
      const keys = issue.keys.map((key) => `"${String(key)}"`).join(', ');
      actual = `unknown key(s): ${keys}`;
    }
    if (issue.code === 'invalid_type' && hasInput) {
      let value: unknown = input;
      for (const segment of issue.path) {
        value = value !== null && typeof value === 'object' && Object.hasOwn(value, segment)
          ? (value as Record<PropertyKey, unknown>)[segment] : undefined;
      }
      // Emit only the former type classification, never rejected values.
      actual = value === null ? 'null' : Array.isArray(value) ? 'array'
        : typeof value === 'number' && Number.isNaN(value) ? 'nan'
        : (issue.expected as string) === 'int' && typeof value === 'number' ? 'float'
        : typeof value;
    }
    return {
      path: manifestPath,
      field: issue.path.join('.') || '(root)',
      expected: issue.message,
      actual,
      severity: 'error',
    };
  });
}
