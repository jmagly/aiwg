/**
 * Contributor Frontmatter Validation
 *
 * Zod schemas for known contributor kinds (`status`, `research`). Schemas are
 * keyed by kind so future consumers register their schema without forking the
 * discovery module.
 *
 * @architecture @docs/contributing/contributor-quickstart.md
 * @issue #938
 */

import { z } from 'zod';
import { integer } from '../schema/zod-validation.mjs';
import type { ContributorKind } from './types.js';

/**
 * Detection spec — declarative globs + counts. Common to every kind.
 */
const DetectionSpecSchema = z.object({
  glob: z.array(z.string()).min(1, 'detect.glob must have at least one pattern'),
  minCount: integer().positive().optional(),
  conditions: z.record(z.string(), z.string()).optional(),
});

/**
 * Base frontmatter shared by every kind. Per-kind schemas extend this.
 */
const ContributorBaseSchema = z.object({
  kind: z.string().min(1),
  domain: z.string().min(1, 'domain is required'),
  description: z.string().min(1, 'description is required'),
  detect: DetectionSpecSchema,
});

/**
 * `kind: status` frontmatter. Reports observed state of a framework/domain
 * (phase, counts, dates). Fields beyond the base schema are descriptive only —
 * no prescriptive `next:` arrays per ADR-023 §Output voice.
 */
export const StatusContributorSchema = ContributorBaseSchema.extend({
  kind: z.literal('status'),
  /**
   * Optional declarative field extractors. Each entry pulls a value out of a
   * file using regex or count. Keeps contributors data-driven rather than
   * code-driven; the aggregator reads these to populate the report block.
   */
  fields: z
    .record(
      z.string(),
      z.object({
        type: z.enum(['string', 'number', 'date']),
        source: z.string(),
        regex: z.string().optional(),
        count: z.string().optional(),
      })
    )
    .optional(),
});

/**
 * `kind: research` frontmatter. Configures research fan-out for a framework's
 * domain — focus areas, source preferences, recency window.
 */
export const ResearchContributorSchema = ContributorBaseSchema.extend({
  kind: z.literal('research'),
  sources: z
    .object({
      preferred: z.array(z.string()).optional(),
      exclude: z.array(z.string()).optional(),
    })
    .optional(),
  focus_areas: z.array(z.string()).min(1, 'research contributors must declare at least one focus area'),
  recency_default_months: integer().positive().optional(),
});

/**
 * Schema registry. Adding a new kind means adding its schema here — no other
 * code changes are required for the discovery module to validate it.
 */
const SCHEMA_REGISTRY: Record<string, z.ZodType<unknown>> = {
  status: StatusContributorSchema,
  research: ResearchContributorSchema,
};

/**
 * Look up the zod schema for a kind. Throws if no schema is registered —
 * unknown kinds must be deliberately added rather than silently accepted.
 */
export function getSchemaForKind(kind: ContributorKind): z.ZodType<unknown> {
  const schema = SCHEMA_REGISTRY[kind];
  if (!schema) {
    throw new Error(
      `Unknown contributor kind '${kind}'. Register a zod schema in src/contributors/validation.ts before using it.`
    );
  }
  return schema;
}

/**
 * List all registered kinds. Used by validate-metadata to scan for
 * orphaned contributor files (kind in frontmatter but no schema registered).
 */
export function getRegisteredKinds(): string[] {
  return Object.keys(SCHEMA_REGISTRY);
}

/**
 * Validate a parsed frontmatter object against its kind's schema. Returns
 * either the typed data or an error with formatted issue messages.
 */
export function validateContributor(
  data: Record<string, unknown>
): { ok: true; data: unknown } | { ok: false; errors: string[] } {
  const kind = data.kind;
  if (typeof kind !== 'string' || kind.length === 0) {
    return { ok: false, errors: ['frontmatter is missing required field `kind`'] };
  }
  let schema: z.ZodType<unknown>;
  try {
    schema = getSchemaForKind(kind);
  } catch (err) {
    return { ok: false, errors: [(err as Error).message] };
  }
  const result = schema.safeParse(data);
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.map(e => `${e.path.join('.') || '<root>'}: ${e.message}`),
    };
  }
  return { ok: true, data: result.data };
}
