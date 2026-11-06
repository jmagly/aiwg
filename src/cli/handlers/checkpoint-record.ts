// Validate CLI checkpoint records against their canonical catalog contract at persistence boundaries.
import { loadSchemaCatalog, SchemaResolver, SchemaValidator } from '../../schema/index.js';
import { findPackageRoot } from '../find-package-root.js';

export interface Checkpoint {
  id: string;
  name?: string;
  createdAt: string;
  cwd: string;
  gitHead?: string;
  phase?: string;
  step?: string;
  artifacts: string[];
  note?: string;
  handoffPath?: string;
  nextSessionPromptPath?: string;
}

export const CHECKPOINT_SCHEMA_ID = 'https://aiwg.io/schemas/artifacts/checkpoint-record.v1.schema.json';
let validator: SchemaValidator | undefined;

export function assertCheckpointRecord(value: unknown, source: string): asserts value is Checkpoint {
  if (!validator) {
    const rootDir = findPackageRoot(import.meta.dirname);
    if (!rootDir) throw new Error('Cannot locate checkpoint schema package root');
    const loaded = loadSchemaCatalog({ rootDir });
    if (!loaded.valid || !loaded.catalog) throw new Error('Invalid checkpoint schema catalog');
    validator = new SchemaValidator(new SchemaResolver(loaded.catalog, { rootDir }), { rootDir });
  }
  if (!validator.validate(CHECKPOINT_SCHEMA_ID, value).valid) {
    throw new Error(`Invalid checkpoint record: ${source}`);
  }
}
