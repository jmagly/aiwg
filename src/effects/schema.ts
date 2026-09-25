/**
 * Runtime validation of every effect ledger document against the committed
 * v1 schemas (`schemas/effects/*`). Compiled lazily, once per process.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { integrityError } from './errors.js';

export const EFFECT_SCHEMA_IDS = Object.freeze({
  record: 'https://aiwg.io/schemas/effects/EffectRecord.v1.schema.json',
  checkpoint: 'https://aiwg.io/schemas/effects/EffectCheckpoint.v1.schema.json',
  keyring: 'https://aiwg.io/schemas/effects/EffectKeyring.v1.schema.json',
  verifierResult: 'https://aiwg.io/schemas/effects/EffectVerifierResult.v1.schema.json',
} as const);

export type EffectSchemaName = keyof typeof EFFECT_SCHEMA_IDS;

const SCHEMA_FILES: Record<EffectSchemaName, string> = {
  record: 'EffectRecord.v1.schema.json',
  checkpoint: 'EffectCheckpoint.v1.schema.json',
  keyring: 'EffectKeyring.v1.schema.json',
  verifierResult: 'EffectVerifierResult.v1.schema.json',
};

function packageRoot(start: string): string {
  let current = resolve(start);
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(current, 'package.json'), 'utf8')) as { name?: string };
      // The release packager renames the installed package to `@aiwg/cli`.
      if (pkg.name === 'aiwg' || pkg.name === '@aiwg/cli') return current;
    } catch { /* keep walking */ }
    const parent = dirname(current);
    if (parent === current) throw new Error('effect ledger: could not locate the package root for schemas/effects');
    current = parent;
  }
}

let validators: Record<EffectSchemaName, ValidateFunction> | undefined;

function compiled(): Record<EffectSchemaName, ValidateFunction> {
  if (validators) return validators;
  const directory = join(packageRoot(dirname(fileURLToPath(import.meta.url))), 'schemas', 'effects');
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  for (const file of Object.values(SCHEMA_FILES)) ajv.addSchema(JSON.parse(readFileSync(join(directory, file), 'utf8')) as object);
  const entries = (Object.keys(EFFECT_SCHEMA_IDS) as EffectSchemaName[]).map((name) => {
    const validate = ajv.getSchema(EFFECT_SCHEMA_IDS[name]);
    if (!validate) throw new Error(`effect ledger: schema ${name} did not compile`);
    return [name, validate] as const;
  });
  validators = Object.fromEntries(entries) as Record<EffectSchemaName, ValidateFunction>;
  return validators;
}

/** True when `value` conforms to the named v1 schema. */
export function isEffectSchemaValid(name: EffectSchemaName, value: unknown): boolean {
  return compiled()[name](value) === true;
}

/** Instance paths of schema violations, without echoing instance values. */
export function effectSchemaErrors(name: EffectSchemaName, value: unknown): string[] {
  const validate = compiled()[name];
  if (validate(value)) return [];
  return (validate.errors ?? []).map(error => `${error.instancePath || '/'} ${error.keyword}`);
}

/** Refuse a document that does not conform; the reason names the schema only. */
export function assertEffectSchema(name: EffectSchemaName, value: unknown): void {
  if (!isEffectSchemaValid(name, value)) throw integrityError(`schema-invalid:${name}`, `Effect ledger ${name} document does not conform to its v1 schema`);
}
