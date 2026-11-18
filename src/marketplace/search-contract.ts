// Validate unsigned discovery snapshots against the existing marketplace catalog owner.
import fs from 'node:fs';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { SearchSnapshot } from './types.js';

let validator: ValidateFunction<SearchSnapshot> | undefined;
export function validateSearchSnapshot(value: unknown): value is SearchSnapshot {
  if (!validator) {
    const owner = '../../schemas/marketplace/aiwg-marketplace-catalog.v1.schema.json';
    const file = [new URL(owner, import.meta.url), new URL(`../${owner}`, import.meta.url)].find(url => fs.existsSync(url));
    if (!file) throw new Error('Marketplace catalog schema is unavailable');
    const schema = JSON.parse(fs.readFileSync(file, 'utf8'));
    const ajv = addFormats(new Ajv2020({ strict: true, allErrors: true }));
    // Only compile the discovery definition; signed entries keep their own verifier.
    validator = ajv.compile<SearchSnapshot>({ $defs: schema.$defs, $ref: '#/$defs/searchCache' });
  }
  return validator(value);
}
