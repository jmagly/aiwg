// Load a conductor-pinned evaluator-only manifest in the existing worker verification owner.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { strictJson, digest, jsonDigest } from './structured-artifact-json.mjs';
import { at, MISSING } from './structured-artifact-fields.mjs';
const schema = JSON.parse(readFileSync(new URL('../../../schemas/security/worker-acceptance-fixtures.v1.schema.json', import.meta.url)));
const ajv = new Ajv2020({ strict: true, allErrors: true, coerceTypes: false });
const validate = ajv.compile(schema);
const outputSchemas = new Map();
export function compileOutputSchema(schema) {
  const key = JSON.stringify(schema);
  if (!outputSchemas.has(key)) outputSchemas.set(key, new Ajv2020({ strict: true, allErrors: true, coerceTypes: false }).compile(schema));
  return outputSchemas.get(key);
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function assert(condition, message) { if (!condition) throw new Error(`Acceptance manifest: ${message}`); }
function validatePolicy(field, source) {
  const { expected: gold, metric } = field;
  assert(!field.path.split('/').slice(1).some(s => /~(?![01])/.test(s)), 'invalid JSON pointer');
  if (gold.state === 'UNKNOWN') assert(gold.value === null && gold.reason, 'unknown requires null and a reason');
  else {
    const span = gold.evidence;
    assert(span && span.start < span.end && span.end <= source.length, 'missing or invalid evidence span');
    if (gold.state === 'EXPLICIT_NULL') assert(gold.value === null, 'explicit null value required');
    if (gold.state === 'KNOWN_EMPTY') assert(Array.isArray(gold.value) && gold.value.length === 0, 'known-empty requires []');
    if (gold.state === 'PRESENT') assert(gold.value !== null, 'present cannot be null');
  }
  if (metric === 'integer') assert(field.type === 'integer' && (gold.state !== 'PRESENT' || Number.isSafeInteger(gold.value)), 'integer metric requires integer gold and type');
  assert(field.severity !== 'critical' || metric !== 'alias', 'aliases forbidden on critical fields');
  if (metric === 'alias') assert(field.type === 'string' && Array.isArray(field.aliases), 'alias table required');
  if (metric === 'quantity') {
    assert(typeof field.absTol === 'number' && Number.isFinite(field.absTol) && field.absTol >= 0
      && typeof field.relTol === 'number' && Number.isFinite(field.relTol) && field.relTol >= 0, 'finite tolerances required');
    assert(typeof gold.value === 'number' && Number.isFinite(gold.value), 'finite numeric gold required');
    assert(field.units && Object.hasOwn(field.units, field.unit) && Object.values(field.units).every(x => Number.isFinite(x) && x > 0), 'explicit positive unit conversions required');
  }
  if (metric === 'quote' && gold.state === 'PRESENT') {
    const norm = v => field.whitespace === 'collapse' ? v.replace(/\s+/g, ' ').trim() : v;
    assert(typeof gold.value === 'string' && norm(source.slice(gold.evidence.start, gold.evidence.end)) === norm(gold.value), 'quote gold must match evidence span');
  }
  if (metric === 'array') {
    assert(field.type === 'array' && typeof field.ordered === 'boolean', 'array ordering required');
    if (gold.state !== 'UNKNOWN') assert(Array.isArray(gold.value), 'array gold required');
    assert(!field.attributes?.length || field.itemKey, 'attribute scoring requires an explicit identity key');
    for (const attribute of field.attributes ?? []) {
      validatePolicy(attribute, source);
      assert((gold.value ?? []).every(item => at(item, attribute.path) !== MISSING), 'array attribute missing from gold');
    }
  }
}
function covered(schema, paths, pointer = '') {
  if (paths.has(pointer)) return;
  if (schema.type === 'object') {
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      const next = `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
      covered(child, paths, next);
    }
  } else assert(paths.has(pointer), `unscored schema field ${pointer}`);
}
export function loadFixtureManifest(path, expectedDigest) {
  const bytes = readFileSync(path);
  assert(/^sha256:[a-f0-9]{64}$/.test(expectedDigest) && digest(bytes) === expectedDigest, 'manifest digest mismatch');
  const manifest = strictJson(bytes);
  assert(validate(manifest), JSON.stringify(validate.errors));
  const suite = readFileSync(join(dirname(path), manifest.suite.file));
  assert(digest(suite) === manifest.suite.digest, 'suite digest mismatch');
  strictJson(suite);
  const ids = new Set();
  for (const c of manifest.cases) {
    assert(!ids.has(c.id), 'duplicate case id'); ids.add(c.id);
    assert(digest(c.source) === c.sourceDigest, `source digest mismatch: ${c.id}`);
    assert(jsonDigest(c.schema) === c.schemaDigest, `schema digest mismatch: ${c.id}`);
    compileOutputSchema(c.schema);
    const paths = new Set(c.fields.map(f => f.path));
    assert(paths.size === c.fields.length, 'duplicate field path');
    covered(c.schema, paths);
    c.fields.forEach(f => validatePolicy(f, c.source));
  }
  return freeze({ ...manifest, manifestDigest: expectedDigest });
}
export function candidateInput(fixture) {
  return freeze(structuredClone({ source: fixture.source, question: fixture.question, schema: fixture.schema }));
}
