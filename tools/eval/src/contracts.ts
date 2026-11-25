// Compile the existing eval dataset/result contracts from their single authority.
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';

const schema = JSON.parse(readFileSync(new URL('../datasets/contracts.v1.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ strict: true, allErrors: true });
ajv.addSchema(schema);
const validators = new Map<string, ValidateFunction>();

export function validateEvalContract(definition: string, value: unknown): void {
  let validate = validators.get(definition);
  if (!validate) {
    validate = ajv.compile({ $ref: `${schema.$id}#/$defs/${definition}` });
    validators.set(definition, validate);
  }
  if (!validate(value)) throw new Error(`Eval contract ${definition}: ${ajv.errorsText(validate.errors)}`);
}
