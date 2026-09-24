import { randomUUID } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DecisionValidationError, validateAgainstSchema } from '../../../src/decision/validate.js';
import type { JsonSchema } from '../../../src/decision/types.js';

// Compiled validators are cached by canonical schema digest (#2660). Each test
// uses a unique `title` so the module-level cache cannot leak across tests.
const unique = (schema: Record<string, unknown>): JsonSchema => ({ title: randomUUID(), ...schema }) as JsonSchema;
const compileSpy = () => vi.spyOn(Ajv2020.prototype, 'compile');

afterEach(() => { vi.restoreAllMocks(); });

describe('decision schema validator cache', () => {
  it('compiles each distinct schema once and reuses it for equal content', () => {
    const schema = unique({ type: 'object', required: ['n'], properties: { n: { type: 'integer', minimum: 1 } } });
    const compile = compileSpy();
    validateAgainstSchema(schema, { n: 1 }, 'first');
    // One strict admission compile plus one permissive validator compile.
    expect(compile).toHaveBeenCalledTimes(2);
    // Structurally equal content with a different key order is a cache hit.
    const reordered = JSON.parse(JSON.stringify({ properties: schema.properties, required: schema.required, type: schema.type, title: schema.title }));
    for (let i = 0; i < 20; i += 1) validateAgainstSchema(i % 2 ? schema : reordered, { n: i + 1 }, 'repeat');
    expect(compile).toHaveBeenCalledTimes(2);
  });

  it('keeps rejecting invalid values through a cached validator', () => {
    const schema = unique({ type: 'object', required: ['n'], properties: { n: { type: 'integer', minimum: 1 } }, additionalProperties: false });
    validateAgainstSchema(schema, { n: 2 }, 'warm');
    expect(() => validateAgainstSchema(schema, { n: 0 }, 'input')).toThrow(/input rejected value/);
    expect(() => validateAgainstSchema(schema, { n: 1, extra: true }, 'input')).toThrow(DecisionValidationError);
    expect(() => validateAgainstSchema(schema, {}, 'input')).toThrow(/n/);
    expect(() => validateAgainstSchema(schema, { n: 3 }, 'input')).not.toThrow();
  });

  it('never confuses schemas that differ only in constraint values or $id', () => {
    const title = randomUUID();
    const a = { title, type: 'string', enum: ['alpha'] } as JsonSchema;
    const b = { title, type: 'string', enum: ['beta'] } as JsonSchema;
    validateAgainstSchema(a, 'alpha', 'a');
    validateAgainstSchema(b, 'beta', 'b');
    expect(() => validateAgainstSchema(a, 'beta', 'a')).toThrow(/a rejected value/);
    expect(() => validateAgainstSchema(b, 'alpha', 'b')).toThrow(/b rejected value/);

    // A shared Ajv instance would refuse the second schema with a duplicate $id.
    const id = `urn:test:${randomUUID()}`;
    validateAgainstSchema({ $id: id, type: 'integer' } as JsonSchema, 1, 'id-int');
    validateAgainstSchema({ $id: id, type: 'string' } as JsonSchema, 'x', 'id-string');
    expect(() => validateAgainstSchema({ $id: id, type: 'string' } as JsonSchema, 1, 'id-string')).toThrow(/rejected value/);
  });

  it('is unaffected by mutating a caller schema after it was cached', () => {
    const schema = unique({ type: 'string', enum: ['original'] }) as JsonSchema & { enum: string[] };
    const snapshot = structuredClone(schema);
    validateAgainstSchema(schema, 'original', 'before');
    schema.enum.push('mutated');
    // The mutated content is a different digest and compiles its own validator.
    expect(() => validateAgainstSchema(schema, 'mutated', 'after')).not.toThrow();
    // The original content still resolves to a validator that rejects it.
    expect(() => validateAgainstSchema(snapshot, 'mutated', 'snapshot')).toThrow(/snapshot rejected value/);
  });

  it('does not cache failed compiles', () => {
    const schema = unique({ type: 'string', unknownKeyword: true });
    const compile = compileSpy();
    expect(() => validateAgainstSchema(schema, 'x', 'bad')).toThrow(/unsupported schema construct/);
    expect(() => validateAgainstSchema(schema, 'x', 'bad')).toThrow(/unsupported schema construct/);
    expect(compile).toHaveBeenCalledTimes(2);
  });

  it('still validates schemas that are not canonical JSON, uncached', () => {
    const schema = unique({ type: 'integer', description: undefined });
    const compile = compileSpy();
    validateAgainstSchema(schema, 1, 'loose');
    validateAgainstSchema(schema, 2, 'loose');
    expect(compile).toHaveBeenCalledTimes(4);
    expect(() => validateAgainstSchema(schema, 'x', 'loose')).toThrow(/loose rejected value/);
  });

  it('bounds the cache and recompiles evicted schemas', () => {
    const first = unique({ type: 'integer' });
    validateAgainstSchema(first, 1, 'first');
    // One past the 256-entry bound evicts the least recently used entry.
    for (let i = 0; i < 257; i += 1) validateAgainstSchema(unique({ type: 'integer' }), i, 'filler');
    const compile = compileSpy();
    validateAgainstSchema(first, 1, 'first');
    expect(compile).toHaveBeenCalledTimes(2);
    expect(() => validateAgainstSchema(first, 'x', 'first')).toThrow(/first rejected value/);
  });
});
