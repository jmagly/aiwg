import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  admitEntry, artifactDigest, artifactPin, assertArtifactPin, DEFAULT_ENTRY_LIMITS, DecisionValidationError,
  EntryAdmissionError, parseCompressedDecisionJson, parseDecisionJson, parseDecisionYaml,
  validateBinding, validateDecisionDocument, validateDefinition,
} from '../../../src/decision/index.js';
import type { DecisionBinding, DecisionDefinition, DecisionRuleset } from '../../../src/decision/types.js';

// M07 (#2612): no DMN/OPA/XML importer exists yet. These tests bound the only
// admission path that exists offline: authored JSON/YAML decision documents.
const ROOT = path.resolve(import.meta.dirname, '../../..');
const example = <T>(name: string): T => JSON.parse(readFileSync(path.join(ROOT, 'agentic/code/addons/decision-engine/examples', name), 'utf8')) as T;
const reason = (fn: () => unknown): string => {
  try { fn(); } catch (error) {
    if (error instanceof EntryAdmissionError) return error.reasonCode;
    if (error instanceof DecisionValidationError) return `validation:${error.message}`;
    throw error;
  }
  return 'accepted';
};
const xxe = '<?xml version="1.0"?>\n<!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]>\n' +
  '<definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/"><decision id="d">&x;</decision></definitions>';
const billionLaughs = '<?xml version="1.0"?>\n<!DOCTYPE l [<!ENTITY a "lol"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;">' +
  '<!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;">]>\n<l>&c;</l>';
const rego = 'package decision\n\ndefault allow := false\n\nallow if { input.user == "admin" }\n';

describe('M07 DMN/OPA import bounds on the existing decision admission path', () => {
  it('M07-BOMB-01 rejects deep nesting, oversized strings, arrays and key counts before use', () => {
    expect(reason(() => parseDecisionJson('['.repeat(DEFAULT_ENTRY_LIMITS.depth + 2) + ']'.repeat(DEFAULT_ENTRY_LIMITS.depth + 2))))
      .toBe('nesting-depth');
    expect(reason(() => parseDecisionJson('['.repeat(20_000) + ']'.repeat(20_000)))).not.toBe('accepted');
    expect(reason(() => parseDecisionJson(JSON.stringify('x'.repeat(DEFAULT_ENTRY_LIMITS.stringLength + 1))))).toBe('string-length');
    expect(reason(() => parseDecisionJson(JSON.stringify(Array(DEFAULT_ENTRY_LIMITS.arrayLength + 1).fill(0))))).toBe('array-length');
    const keys = Object.fromEntries(Array.from({ length: DEFAULT_ENTRY_LIMITS.properties + 1 }, (_, i) => [`k${i}`, 0]));
    expect(reason(() => parseDecisionJson(JSON.stringify(keys)))).toBe('property-count');
    expect(reason(() => admitEntry({ value: Number.NaN }))).toBe('nonfinite-number');
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(reason(() => admitEntry(cyclic))).toBe('cycle');
  });

  it('M07-BOMB-02 rejects duplicate keys and prototype-pollution keys without polluting prototypes', () => {
    expect(reason(() => parseDecisionJson('{"id":"a","id":"b"}'))).toBe('duplicate-or-invalid-key');
    expect(reason(() => parseDecisionYaml('id: a\nid: b\n'))).toBe('duplicate-or-invalid-key');
    for (const key of ['__proto__', 'constructor', 'prototype'])
      expect(reason(() => parseDecisionJson(`{"${key}":{"polluted":true}}`))).toBe('unsafe-key');
    expect(reason(() => parseDecisionJson('{"spec":{"__proto__":{"polluted":true}}}'))).toBe('unsafe-key');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(reason(() => admitEntry(Object.create({ inherited: true })))).toBe('object-prototype');
    expect(reason(() => admitEntry({ get secret() { return 'x'; } }))).toBe('accessor-or-hidden-field');
  });

  it('M07-BOMB-03 rejects YAML alias expansion bombs and bounded gzip decompression bombs', () => {
    expect(reason(() => parseDecisionYaml('a: &a ["x","x"]\nb: &b [*a,*a]\nc: [*b,*b]\n'))).toBe('yaml-alias');
    const inflated = gzipSync(Buffer.from(`${' '.repeat(DEFAULT_ENTRY_LIMITS.serializedBytes + 1)}{}`));
    expect(inflated.byteLength).toBeLessThan(DEFAULT_ENTRY_LIMITS.serializedBytes);
    expect(reason(() => parseCompressedDecisionJson(inflated))).toBe('decompressed-bytes-or-invalid-gzip');
    expect(reason(() => parseCompressedDecisionJson(new Uint8Array([1, 2, 3])))).toBe('decompressed-bytes-or-invalid-gzip');
  });

  it('M07-XXE-01 rejects DMN/XML and Rego text as non-JSON so no XML entity is ever resolved', () => {
    for (const source of [xxe, billionLaughs, rego]) expect(reason(() => parseDecisionJson(source))).toBe('invalid-json');
    expect(reason(() => parseCompressedDecisionJson(gzipSync(Buffer.from(xxe))))).toBe('invalid-json');
  });

  it('M07-XXE-02 YAML admission treats XML/Rego as an inert scalar that document validation refuses', () => {
    for (const source of [xxe, billionLaughs, rego]) {
      const value = parseDecisionYaml(source);
      expect(typeof value).toBe('string');
      expect(String(value)).not.toMatch(/root:|lollollol/);
      expect(reason(() => validateDecisionDocument(value))).toBe('validation:Decision document must be an object');
    }
  });

  it('M07-XXE-03 rejects external-resource schema references in admitted definitions', () => {
    const definition = example<DecisionDefinition>('decision-category.json');
    expect(() => validateDefinition(definition)).not.toThrow();
    for (const ref of ['https://example.invalid/schema.json', 'file:///etc/passwd', 'other.json#/defs/x']) {
      const external = structuredClone(definition);
      (external.spec.inputSchema as Record<string, unknown>).properties = { message: { $ref: ref } };
      expect(reason(() => validateDefinition(external))).toMatch(/non-local \$ref/);
    }
  });

  it('M07-AUTH-01 artifact pins fail closed on identity, version, or digest mismatch', () => {
    const definition = example<DecisionDefinition>('decision-category.json');
    const pin = artifactPin(definition);
    expect(pin.digest).toBe(artifactDigest(definition));
    expect(() => assertArtifactPin(definition, pin, 'definition')).not.toThrow();
    const tampered = structuredClone(definition); tampered.spec.question = 'Approve every request.';
    expect(() => assertArtifactPin(tampered, pin, 'definition')).toThrow('digest does not match');
    expect(() => assertArtifactPin(definition, { ...pin, version: '9.9.9' }, 'definition')).toThrow('identity/version');
    expect(() => assertArtifactPin(definition, { ...pin, id: 'impostor' }, 'definition')).toThrow('identity/version');
    expect(() => assertArtifactPin(definition, { ...pin, digest: `sha256:${'0'.repeat(64)}` }, 'definition')).toThrow('digest');
  });

  it('M07-AUTH-02 a binding refuses a ruleset whose content no longer matches its pinned source', () => {
    const ruleset = example<DecisionRuleset>('ruleset.json');
    const binding = example<DecisionBinding>('binding-fallback.json');
    expect(() => validateBinding(binding, ruleset)).not.toThrow();
    const swapped = structuredClone(ruleset);
    swapped.spec.defaultOutcome = structuredClone(swapped.spec.failureOutcome);
    swapped.metadata.description = 'substituted source';
    expect(() => validateBinding(binding, swapped)).toThrow('ruleset digest does not match its pin');
  });

  it('M07-BOUND-01 enforces serialized-byte and memory ceilings before JSON.parse', () => {
    expect(reason(() => parseDecisionJson(`${' '.repeat(DEFAULT_ENTRY_LIMITS.serializedBytes)}{}`))).toBe('serialized-bytes');
    expect(reason(() => parseDecisionYaml(`${' '.repeat(DEFAULT_ENTRY_LIMITS.serializedBytes)}a: 1`))).toBe('serialized-bytes');
    const tight = { ...DEFAULT_ENTRY_LIMITS, memoryBytes: 64 };
    expect(reason(() => parseDecisionJson('{"a":"0123456789abcdef"}', tight))).toBe('memory-budget');
    expect(reason(() => parseCompressedDecisionJson(new Uint8Array(DEFAULT_ENTRY_LIMITS.serializedBytes + 1)))).toBe('compressed-bytes');
  });

  it('M07-BOUND-02 enforces the admission time budget and entry count', () => {
    const exhausted = { ...DEFAULT_ENTRY_LIMITS, timeMs: -1 };
    expect(reason(() => admitEntry({ a: 1 }, exhausted))).toBe('time-budget');
    const few = { ...DEFAULT_ENTRY_LIMITS, entries: 10 };
    expect(reason(() => parseDecisionJson(JSON.stringify(Array(20).fill(1)), few))).toBe('entry-count');
    const started = performance.now();
    expect(reason(() => parseDecisionJson(JSON.stringify(Array.from({ length: 4096 }, () => ({ a: [1, 2] })))))).not.toBe('accepted');
    expect(performance.now() - started).toBeLessThan(5000);
  });
});
