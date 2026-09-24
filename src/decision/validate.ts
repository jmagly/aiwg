import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import { canonicalJson } from '../security/artifact-trust.js';
import { admitEntry, EntryAdmissionError } from './entry.js';
import { DECISION_API_VERSION, DECISION_API_VERSION_STRUCTURED } from './types.js';
import type {
  ArtifactPin,
  DecisionBinding,
  DecisionDefinition,
  DecisionPredicate,
  DecisionResult,
  DecisionRuleset,
  JsonSchema,
  JsonValue,
  RulesetResult,
} from './types.js';

const schemaFiles = {
  DecisionBinding: 'DecisionBinding.schema.json',
  DecisionDefinition: 'DecisionDefinition.schema.json',
  DecisionResult: 'DecisionResult.schema.json',
  DecisionRuleset: 'DecisionRuleset.schema.json',
  RulesetResult: 'RulesetResult.schema.json',
} as const;
const structuredSchemaFiles = {
  DecisionDefinition: 'DecisionDefinition.v1alpha2.schema.json',
  DecisionRuleset: 'DecisionRuleset.v1alpha2.schema.json',
  DecisionBinding: 'DecisionBinding.v1alpha2.schema.json',
  DecisionResult: 'DecisionResult.v1alpha2.schema.json',
  RulesetResult: 'RulesetResult.v1alpha2.schema.json',
} as const;

type DecisionKind = keyof typeof schemaFiles;

export class DecisionValidationError extends Error {
  constructor(message: string, readonly errors: ErrorObject[] = []) {
    super(message);
    this.name = 'DecisionValidationError';
  }
}

let validators: Map<string, ValidateFunction> | null = null;

function schemaRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(here, '../../schemas/decision'), resolve(here, '../../../schemas/decision')];
  const found = candidates.find(candidate => existsSync(resolve(candidate, schemaFiles.DecisionDefinition)));
  if (!found) throw new DecisionValidationError('Decision schema directory is unavailable');
  return found;
}

function getValidators(): Map<string, ValidateFunction> {
  if (validators) return validators;
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
  const admissionSchema = JSON.parse(readFileSync(resolve(schemaRoot(), 'DecisionAdmissionEvidence.v1.schema.json'), 'utf8')) as JsonSchema;
  const contextEvidenceSchema = JSON.parse(readFileSync(resolve(schemaRoot(), 'DecisionContextEvidence.v1.schema.json'), 'utf8')) as JsonSchema;
  const providerPrefixSchema = JSON.parse(readFileSync(resolve(schemaRoot(), 'DecisionProviderPrefixEvidence.v1.schema.json'), 'utf8')) as JsonSchema;
  ajv.addSchema(admissionSchema);
  ajv.addSchema(contextEvidenceSchema);
  ajv.addSchema(providerPrefixSchema);
  validators = new Map();
  for (const [kind, filename] of Object.entries(schemaFiles) as Array<[DecisionKind, string]>) {
    const schema = JSON.parse(readFileSync(resolve(schemaRoot(), filename), 'utf8')) as JsonSchema;
    validators.set(`decision.aiwg.io/v1alpha1:${kind}`, ajv.compile(schema));
  }
  for (const [kind, filename] of Object.entries(structuredSchemaFiles)) {
    const schema = JSON.parse(readFileSync(resolve(schemaRoot(), filename), 'utf8')) as JsonSchema;
    validators.set(`decision.aiwg.io/v1alpha2:${kind}`, ajv.compile(schema));
  }
  return validators;
}

export function artifactDigest(value: unknown): ArtifactPin['digest'] {
  const started = performance.now();
  admitEntry(value);
  const canonical = canonicalJson(value);
  if (performance.now() - started > 1000) {
    throw new EntryAdmissionError('time-budget', { bytes: Buffer.byteLength(canonical), entries: 0 });
  }
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

export function artifactPin(value: { metadata: { id: string; version: string } }): ArtifactPin {
  return { id: value.metadata.id, version: value.metadata.version, digest: artifactDigest(value) };
}

export function assertArtifactPin(value: { metadata: { id: string; version: string } }, pin: ArtifactPin, label: string): void {
  if (value.metadata.id !== pin.id || value.metadata.version !== pin.version) {
    throw new DecisionValidationError(`${label} identity/version does not match its pin`);
  }
  if (artifactDigest(value) !== pin.digest) throw new DecisionValidationError(`${label} digest does not match its pin`);
}

export function validateDecisionDocument(value: unknown): asserts value is
  DecisionDefinition | DecisionRuleset | DecisionBinding | DecisionResult | RulesetResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DecisionValidationError('Decision document must be an object');
  }
  try { admitEntry(value); }
  catch (error) {
    if (error instanceof EntryAdmissionError) throw new DecisionValidationError(error.message);
    throw error;
  }
  const kind = (value as { kind?: string }).kind as DecisionKind | undefined;
  const version = (value as { apiVersion?: string }).apiVersion;
  const key = `${version}:${kind}`;
  if (!kind || !getValidators().has(key)) throw new DecisionValidationError(`Unsupported decision kind/version '${key}'`);
  const validate = getValidators().get(key)!;
  if (!validate(value)) {
    throw new DecisionValidationError(`${kind} schema validation failed: ${ajvMessage(validate.errors)}`, validate.errors ?? []);
  }
}

export const DECISION_CHANGED_SEMANTICS = [
  'structured-entry', 'batch-receipt', 'acceptance-uncertainty', 'calibration-pin', 'trust-projection',
] as const;
export type DecisionChangedSemantic = typeof DECISION_CHANGED_SEMANTICS[number];

/** Writer gate shared by D02 and future D07-D10 emitters. */
export function assertDecisionWriterVersion(value: unknown, semantic: DecisionChangedSemantic): void {
  validateDecisionDocument(value);
  if (value.apiVersion !== DECISION_API_VERSION_STRUCTURED) {
    throw new DecisionValidationError(`${semantic} requires ${DECISION_API_VERSION_STRUCTURED}`);
  }
}

/** A rollback reader may inspect v1alpha2, but cannot execute or rewrite it. */
export function readDecisionDocumentForRollback(value: unknown, mode: 'read-only' | 'execute'): {
  document: Readonly<DecisionDefinition | DecisionRuleset | DecisionBinding | DecisionResult | RulesetResult>;
  writable: boolean;
} {
  validateDecisionDocument(value);
  if (mode === 'execute' && value.apiVersion !== DECISION_API_VERSION) {
    throw new DecisionValidationError('Rollback executor cannot execute v1alpha2 artifacts');
  }
  const document = structuredClone(value);
  if (mode === 'read-only') deepFreeze(document);
  return { document, writable: mode === 'execute' };
}

function deepFreeze(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) deepFreeze(child);
  Object.freeze(value);
}

/**
 * Compiled caller-schema validators, keyed by the sha256 of the schema's
 * canonical JSON, so equal content shares a validator and different content
 * never does. Each miss compiles a detached clone in a fresh Ajv instance, so
 * later mutation of the caller's object or another schema's `$id` cannot leak
 * into a cached entry. Bounded LRU; failed compiles are never cached.
 */
const SCHEMA_CACHE_LIMIT = 256;
const strictSchemaDigests = new Map<string, true>();
const permissiveValidators = new Map<string, ValidateFunction>();

function schemaDigest(schema: JsonSchema): string | null {
  try { return createHash('sha256').update(canonicalJson(schema)).digest('hex'); }
  catch { return null; } // Not canonical JSON (for example an undefined member): compile uncached.
}

/** Only a cacheable (canonical JSON) schema needs a private copy. */
function detached(schema: JsonSchema, digest: string | null): JsonSchema {
  return digest === null ? schema : structuredClone(schema);
}

function cached<T>(cache: Map<string, T>, digest: string | null, build: () => T): T {
  if (digest !== null) {
    const hit = cache.get(digest);
    if (hit !== undefined) {
      cache.delete(digest);
      cache.set(digest, hit);
      return hit;
    }
  }
  const value = build();
  if (digest !== null) {
    cache.set(digest, value);
    if (cache.size > SCHEMA_CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  }
  return value;
}

export function validateAgainstSchema(schema: JsonSchema, value: unknown, label: string): void {
  const digest = assertLocalSchema(schema, label);
  let validate: ValidateFunction;
  try {
    validate = cached(permissiveValidators, digest, () =>
      new Ajv2020({ strict: false, allErrors: true, validateFormats: false }).compile(detached(schema, digest)));
  } catch (error) {
    throw new DecisionValidationError(`${label} is not a supported local draft 2020-12 schema: ${errorMessage(error)}`);
  }
  if (!validate(value)) throw new DecisionValidationError(`${label} rejected value: ${ajvMessage(validate.errors)}`, validate.errors ?? []);
}

export function validateDefinition(definition: DecisionDefinition): void {
  validateDecisionDocument(definition);
  assertLocalSchema(definition.spec.inputSchema, `${definition.metadata.id}.inputSchema`);
  if (definition.spec.answer.kind === 'choice') {
    assertUnique(definition.spec.answer.options.map(option => option.id), 'choice option IDs');
  }
  if (definition.spec.answer.kind === 'ordinal-score') {
    const keys = definition.spec.answer.levels.map(level => canonicalJson(level));
    assertUnique(keys, 'ordinal levels');
  }
}

export function validateRuleset(ruleset: DecisionRuleset): void {
  validateDecisionDocument(ruleset);
  assertLocalSchema(ruleset.spec.inputSchema, `${ruleset.metadata.id}.inputSchema`);
  assertLocalSchema(ruleset.spec.outputSchema, `${ruleset.metadata.id}.outputSchema`);
  const aliases = ruleset.spec.evaluations.map(item => item.alias);
  assertUnique(aliases, 'evaluation aliases');
  assertUnique(ruleset.spec.rules.map(rule => rule.id), 'rule IDs');
  for (const rule of ruleset.spec.rules) assertPredicateAliases(rule.when, new Set(aliases));

  if (ruleset.spec.composition === 'collect') {
    const output = ruleset.spec.outputSchema;
    if (output.type !== 'array' || !output.items || Array.isArray(output.items) || output.prefixItems !== undefined) {
      throw new DecisionValidationError('collect outputSchema must be an array schema with one object-valued items schema');
    }
    const itemSchema = output.items as JsonSchema;
    if (itemSchema.type !== 'object') throw new DecisionValidationError('collect outputSchema.items must describe objects');
    for (const rule of ruleset.spec.rules) validateAgainstSchema(itemSchema, rule.outcome, `rule ${rule.id} outcome`);
  } else {
    for (const rule of ruleset.spec.rules) validateAgainstSchema(ruleset.spec.outputSchema, rule.outcome, `rule ${rule.id} outcome`);
  }
  validateAgainstSchema(ruleset.spec.outputSchema, ruleset.spec.defaultOutcome, 'defaultOutcome');
  validateAgainstSchema(ruleset.spec.outputSchema, ruleset.spec.failureOutcome, 'failureOutcome');
}

export function validateBinding(binding: DecisionBinding, ruleset: DecisionRuleset): void {
  validateDecisionDocument(binding);
  assertArtifactPin(ruleset, binding.spec.ruleset, 'ruleset');
  const declared = [...ruleset.spec.evaluations.map(item => item.alias)].sort();
  const bound = Object.keys(binding.spec.evaluations).sort();
  if (canonicalJson(declared) !== canonicalJson(bound)) {
    throw new DecisionValidationError('binding must map every ruleset evaluation alias exactly once');
  }
  for (const [alias, evaluation] of Object.entries(binding.spec.evaluations)) {
    for (const target of evaluation.targets) {
      if (target.acceptance.mode === 'primitive-policy' && binding.apiVersion !== DECISION_API_VERSION_STRUCTURED) {
        throw new DecisionValidationError(`${alias} primitive-aware acceptance requires ${DECISION_API_VERSION_STRUCTURED}`);
      }
      if (target.retry.maxDelayMs < target.retry.initialDelayMs) {
        throw new DecisionValidationError(`${alias} retry maxDelayMs must be >= initialDelayMs`);
      }
    }
  }
}

export function resolveJsonPointer(root: unknown, pointer: string): { found: boolean; value?: unknown } {
  if (pointer === '') return { found: true, value: root };
  if (!pointer.startsWith('/')) return { found: false };
  let current: unknown = root;
  for (const encoded of pointer.slice(1).split('/')) {
    const token = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(token)) return { found: false };
      const index = Number(token);
      if (index >= current.length) return { found: false };
      current = current[index];
    } else if (current && typeof current === 'object' && Object.prototype.hasOwnProperty.call(current, token)) {
      current = (current as Record<string, unknown>)[token];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: current };
}

export function validateDecisionValue(definition: DecisionDefinition, value: unknown): asserts value is string | number {
  const answer = definition.spec.answer;
  if (answer.kind === 'choice') {
    if (typeof value !== 'string' || !answer.options.some(option => option.id === value)) {
      throw new DecisionValidationError(`choice value must be one of: ${answer.options.map(option => option.id).join(', ')}`);
    }
    return;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new DecisionValidationError(`${answer.kind} value must be finite`);
  if (answer.kind === 'truth-probability' && (value < 0 || value > 1)) {
    throw new DecisionValidationError('truth-probability must be within [0,1]');
  }
  if (answer.kind === 'ordinal-score' && (value < 0 || value > answer.levels.length - 1)) {
    throw new DecisionValidationError(`ordinal-score must be within [0,${answer.levels.length - 1}]`);
  }
}

export function validateDistribution(definition: DecisionDefinition, distribution: Record<string, number>): void {
  const expected = definition.spec.answer.kind === 'choice'
    ? definition.spec.answer.options.map(option => option.id)
    : definition.spec.answer.kind === 'ordinal-score'
      ? definition.spec.answer.levels.map((_, index) => String(index))
      : ['false', 'true'];
  if (canonicalJson(Object.keys(distribution).sort()) !== canonicalJson([...expected].sort())) {
    throw new DecisionValidationError('distribution support must exactly match the declared answer domain');
  }
  const values = Object.values(distribution);
  if (values.some(value => !Number.isFinite(value) || value < 0 || value > 1)) {
    throw new DecisionValidationError('distribution values must be finite probabilities');
  }
  if (Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) > 1e-6) {
    throw new DecisionValidationError('distribution probabilities must sum to one');
  }
}

function assertLocalSchema(schema: JsonSchema, label: string): string | null {
  const visit = (value: unknown, stack: Set<unknown>, depth: number): void => {
    if (depth > 64) throw new DecisionValidationError(`${label} exceeds maximum schema depth`);
    if (!value || typeof value !== 'object') return;
    if (stack.has(value)) throw new DecisionValidationError(`${label} contains a cycle`);
    stack.add(value);
    if (!Array.isArray(value)) {
      const ref = (value as Record<string, unknown>).$ref;
      if (typeof ref === 'string' && !ref.startsWith('#/')) {
        throw new DecisionValidationError(`${label} contains a non-local $ref`);
      }
    }
    for (const child of Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)) visit(child, stack, depth + 1);
    stack.delete(value);
  };
  visit(schema, new Set(), 0);
  // The structural walk above runs on every call; only the strict compile is cached.
  const digest = schemaDigest(schema);
  try {
    cached(strictSchemaDigests, digest, () => {
      new Ajv2020({ strictSchema: true, strictTypes: false, strictTuples: false,
        strictRequired: false, validateFormats: false }).compile(detached(schema, digest));
      return true as const;
    });
  } catch (error) {
    throw new DecisionValidationError(`${label} uses an unsupported schema construct: ${errorMessage(error)}`);
  }
  return digest;
}

function assertPredicateAliases(predicate: DecisionPredicate, aliases: Set<string>): void {
  if ('all' in predicate) return predicate.all.forEach(item => assertPredicateAliases(item, aliases));
  if ('any' in predicate) return predicate.any.forEach(item => assertPredicateAliases(item, aliases));
  if ('not' in predicate) return assertPredicateAliases(predicate.not, aliases);
  if (predicate.left.source === 'decision' && (!predicate.left.alias || !aliases.has(predicate.left.alias))) {
    throw new DecisionValidationError(`predicate references undeclared decision alias '${predicate.left.alias ?? ''}'`);
  }
}

function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new DecisionValidationError(`${label} must be unique`);
}

function ajvMessage(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? []).map(error => `${error.instancePath || '/'} ${error.message ?? 'invalid'}`).join('; ');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function asJsonValue(value: unknown): JsonValue {
  canonicalJson(value);
  return value as JsonValue;
}
