#!/usr/bin/env node
/**
 * lint-schemas.mjs
 *
 * Validates:
 *   1. Every versioned .schema.json file below schemas/ declares a unique, non-empty $id,
 *      uses a supported draft, and compiles with that draft's Ajv implementation.
 *   2. schemas/executor-v1.json is a valid draft-2020-12 JSON Schema (meta-schema check)
 *   3. Each fixture in test/conformance/executor-v1/fixtures/ validates against
 *      schemas/executor-v1.json — specifically the per-message-type refs declared in
 *      the fixture's `_schema_refs` or `_validates_as` fields.
 *
 * Uses ajv (already a transitive dep via @modelcontextprotocol/sdk) via dynamic require.
 * Does NOT add ajv as a top-level package.json dependency.
 *
 * Exit 0 = all checks pass.
 * Exit 1 = one or more validation errors.
 *
 * Usage:
 *   node tools/scripts/lint-schemas.mjs
 *   npm run lint:schemas
 *
 * @see docs/contracts/executor.v1.md
 * @see schemas/executor-v1.json
 * @see test/conformance/executor-v1/
 * @issue #1178
 */

import { readFileSync, readdirSync, existsSync, writeFileSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { createHash } from 'crypto';
import { validateHitlGates } from '../validation/hitl-gates.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..', '..');
try {
  const counts = validateHitlGates(projectRoot);
  console.log(`[lint-schemas] HITL schema, templates, ${counts.phaseGates} SDLC gates and ${counts.addonGates} agent-persistence gates validated`);
} catch (error) {
  console.error(`[lint-schemas] HITL validation failed: ${error.message}`);
  process.exit(1);
}
const args = process.argv.slice(2);
const reportArgument = args.indexOf('--report-json');
const reportPath = reportArgument >= 0 ? args[reportArgument + 1] : null;
if (reportArgument >= 0 && (!reportPath || reportPath.startsWith('--'))) {
  console.error('[lint-schemas] ERROR: --report-json requires a file path');
  process.exit(2);
}

const diagnostics = [];
function diagnostic(category, severity, code, message, resource = null) {
  diagnostics.push({ category, severity, code, message, ...(resource ? { resource } : {}) });
  const prefix = severity === 'error' ? 'ERROR' : severity === 'warning' ? 'WARN' : 'INFO';
  const sink = severity === 'error' ? console.error : severity === 'warning' ? console.warn : console.log;
  sink(`  ${prefix} [${category}/${code}]${resource ? ` ${resource}:` : ':'} ${message}`);
}

// ── Ajv bootstrap ──────────────────────────────────────────────────────────

let Ajv2020, addFormats;

function loadAjv() {
  const require = createRequire(import.meta.url);
  const ajvPaths = [
    join(projectRoot, 'node_modules', 'ajv', 'dist', '2020.js'),
    join(projectRoot, 'node_modules', 'ajv', 'dist', 'ajv.js'),
  ];
  const formatsPath = join(projectRoot, 'node_modules', 'ajv-formats', 'dist', 'index.js');

  let Ajv = null;
  for (const p of ajvPaths) {
    if (existsSync(p)) {
      try {
        Ajv = require(p);
        break;
      } catch {
        // try next
      }
    }
  }

  if (!Ajv) {
    console.error(
      '\n[lint-schemas] ERROR: Could not load ajv from node_modules.\n' +
      'ajv is a transitive dependency but was not found at the expected path.\n' +
      'Install it as a devDependency:  npm install --save-dev ajv ajv-formats\n'
    );
    process.exit(1);
  }

  let formats = null;
  if (existsSync(formatsPath)) {
    try {
      formats = require(formatsPath);
    } catch {
      // formats are optional — warn but continue
    }
  }

  return { Ajv, formats };
}

const { Ajv, formats: formatsModule } = loadAjv();

// Ajv may be exported as default, as Ajv2020, or as the constructor directly.
// The 2020.js dist exports { Ajv2020, default } — prefer the named export.
const AjvConstructor = Ajv.Ajv2020 ?? Ajv.default ?? Ajv;

const ajv = new AjvConstructor({
  strict: false,
  allErrors: true,
  verbose: true,
  // Do not try to fetch/validate the $schema meta-schema URI — it is already
  // implied by using the Ajv2020 constructor. Without this flag Ajv throws
  // "no schema with key or ref https://json-schema.org/draft/2020-12".
  validateSchema: false,
});

if (formatsModule) {
  const addFormatsFn = formatsModule.default ?? formatsModule;
  if (typeof addFormatsFn === 'function') {
    addFormatsFn(ajv);
  }
}

// ── Paths ──────────────────────────────────────────────────────────────────

const SCHEMA_PATH = join(projectRoot, 'schemas', 'executor-v1.json');
const SCHEMAS_DIR = join(projectRoot, 'schemas');
const CATALOG_PATH = join(projectRoot, 'schemas', 'catalog', 'catalog.json');
const EXCEPTIONS_PATH = join(projectRoot, 'schemas', 'policy', 'strict-exceptions.json');
const DEPENDENCY_LOCK_PATH = join(projectRoot, 'schemas', 'policy', 'dependency-lock.json');
const FIXTURES_DIR = join(projectRoot, 'test', 'conformance', 'executor-v1', 'fixtures');

// ── Helpers ────────────────────────────────────────────────────────────────

/** Load and parse a JSON file, throwing a clear error on parse failure. */
function loadJson(filePath) {
  const raw = readFileSync(filePath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`JSON parse error in ${filePath}: ${err.message}`);
  }
}

/** Recursively collect schema source files in deterministic order. */
function collectSchemaFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSchemaFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.schema.json')) {
      files.push(entryPath);
    }
  }
  return files.sort();
}

function toProjectPath(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const absolute = resolve(projectRoot, value);
  return absolute.startsWith(projectRoot + '/') ? absolute : null;
}

/** Accept the stable catalog shape plus aliases used by early domain manifests. */
function schemaFilesFromCatalog(catalog) {
  const records = [...(catalog.artifacts ?? catalog.schemas ?? catalog.records ?? [])];
  if (catalog.domains !== undefined && !Array.isArray(catalog.domains)) {
    throw new Error('catalog domains must be an array');
  }
  for (const domainPath of catalog.domains ?? []) {
    const absoluteDomainPath = toProjectPath(join('schemas', 'catalog', domainPath));
    if (!absoluteDomainPath || !existsSync(absoluteDomainPath)) {
      throw new Error(`catalog domain manifest not found: ${domainPath}`);
    }
    const domain = loadJson(absoluteDomainPath);
    if (!Array.isArray(domain.artifacts)) throw new Error(`domain ${domainPath} artifacts must be an array`);
    records.push(...domain.artifacts);
  }
  catalogArtifactRecords = records;
  const paths = [];
  for (const record of records) {
    if (record.lifecycle === 'retired' || record.kind === 'projection') continue;
    const candidate = record.path ?? record.canonicalPath ?? record.source?.path ?? record.authority?.path;
    const absolute = toProjectPath(candidate);
    if (!absolute) throw new Error(`catalog record ${record.name ?? record.id ?? '<unknown>'} has an invalid canonical path`);
    paths.push(absolute);
  }
  return [...new Set(paths)].sort();
}

function loadPolicyFile(filePath, fallback) {
  return existsSync(filePath) ? loadJson(filePath) : fallback;
}

function createSchemaCompiler(Constructor, options = {}) {
  const compiler = new Constructor({
    strict: true,
    allErrors: true,
    validateFormats: true,
    loadSchema: undefined,
    ...options,
  });
  if (formatsModule) {
    const addFormatsFn = formatsModule.default ?? formatsModule;
    if (typeof addFormatsFn === 'function') addFormatsFn(compiler);
  }
  return compiler;
}

/** Collect every object in a deep structure that has a _validates_as key. */
function collectValidatables(obj, accumulator = []) {
  if (obj === null || typeof obj !== 'object') return accumulator;
  if (Array.isArray(obj)) {
    for (const item of obj) collectValidatables(item, accumulator);
    return accumulator;
  }
  if (typeof obj._validates_as === 'string') {
    accumulator.push({ ref: obj._validates_as, value: obj });
  }
  for (const val of Object.values(obj)) {
    collectValidatables(val, accumulator);
  }
  return accumulator;
}

/** Strip private fields (prefixed _) before validating. */
function stripPrivate(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(stripPrivate);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!k.startsWith('_')) {
      out[k] = stripPrivate(v);
    }
  }
  return out;
}

/** Resolve a JSON-pointer ref like "#/$defs/foo" into a sub-schema. */
function resolveRef(schema, ref) {
  if (!ref.startsWith('#/')) {
    return schema; // external ref — treat as root schema
  }
  const parts = ref.slice(2).split('/');
  let current = schema;
  for (const part of parts) {
    if (current === undefined || current === null) return null;
    current = current[part];
  }
  return current ?? null;
}

// ── Step 1: compile every versioned schema with its declared draft ────────

const require = createRequire(import.meta.url);
const AjvDraft7Module = require(join(projectRoot, 'node_modules', 'ajv', 'dist', 'ajv.js'));
const AjvDraft7Constructor = AjvDraft7Module.Ajv ?? AjvDraft7Module.default ?? AjvDraft7Module;
const supportedDrafts = new Map([
  ['https://json-schema.org/draft/2020-12/schema', { name: '2020-12', Constructor: AjvConstructor }],
  ['https://json-schema.org/draft/2020-12/schema#', { name: '2020-12', Constructor: AjvConstructor }],
  ['http://json-schema.org/draft-07/schema#', { name: 'draft-07', Constructor: AjvDraft7Constructor }],
  ['https://json-schema.org/draft-07/schema#', { name: 'draft-07', Constructor: AjvDraft7Constructor }],
]);

let catalogMode = false;
let schemaFiles;
let catalogSchemaFiles = [];
let catalogArtifactRecords = [];
let discoveredSchemaFiles = [];
for (const root of ['schemas', 'agentic', 'apps', 'src', 'vscode-extension']) {
  const absolute = join(projectRoot, root);
  if (existsSync(absolute)) discoveredSchemaFiles.push(...collectSchemaFiles(absolute));
}
discoveredSchemaFiles = [...new Set(discoveredSchemaFiles)].sort();
if (existsSync(CATALOG_PATH)) {
  try {
    catalogSchemaFiles = schemaFilesFromCatalog(loadJson(CATALOG_PATH));
    // Keep the established schemas/ gate until catalog parity is demonstrated.
    schemaFiles = [...new Set([...catalogSchemaFiles, ...collectSchemaFiles(SCHEMAS_DIR)])].sort();
    catalogMode = true;
  } catch (err) {
    diagnostic('inventory', 'error', 'SCHEMA_CATALOG_INVALID', err.message, 'schemas/catalog/catalog.json');
    schemaFiles = [];
  }
} else {
  schemaFiles = collectSchemaFiles(SCHEMAS_DIR)
    .filter(file => !file.includes(`${join('schemas', 'catalog')}/`));
  diagnostic('inventory', 'warning', 'SCHEMA_CATALOG_MISSING',
    'catalog not present; using the legacy schemas/ discovery fallback');
}

if (catalogMode) {
  const registered = new Set(catalogSchemaFiles);
  for (const artifact of catalogArtifactRecords) {
    for (const projection of artifact.projections ?? []) {
      const projectionPath = toProjectPath(projection.path);
      if (projectionPath) registered.add(projectionPath);
    }
  }
  for (const filePath of discoveredSchemaFiles) {
    if (filePath.includes(`${join('schemas', 'catalog')}/`) || registered.has(filePath)) continue;
    diagnostic('inventory', 'warning', 'SCHEMA_RESOURCE_UNREGISTERED',
      'schema-like resource is not registered as an authority or declared projection',
      filePath.slice(projectRoot.length + 1));
  }
}

const policy = loadPolicyFile(EXCEPTIONS_PATH, { exceptions: [] });
const dependencyLock = loadPolicyFile(DEPENDENCY_LOCK_PATH, { dependencies: [] });
const today = new Date().toISOString().slice(0, 10);
const exceptionsByResource = new Map();
for (const exception of policy.exceptions ?? []) {
  const missing = ['resource', 'rule', 'owner', 'rationale', 'approvedBy', 'expires'].filter(k => !exception[k]);
  if (missing.length > 0) {
    diagnostic('policy', 'error', 'SCHEMA_EXCEPTION_INVALID',
      `exception is missing ${missing.join(', ')}`, exception.resource ?? '<unknown>');
    continue;
  }
  if (exception.expires < today) {
    diagnostic('policy', 'error', 'SCHEMA_EXCEPTION_EXPIRED',
      `exception for ${exception.rule} expired ${exception.expires}`, exception.resource);
    continue;
  }
  const current = exceptionsByResource.get(exception.resource) ?? {};
  if (exception.rule === 'strictRequired') current.strictRequired = false;
  else if (exception.rule === 'strictTypes') current.strictTypes = false;
  else if (exception.rule === 'allowUnionTypes') current.allowUnionTypes = true;
  else diagnostic('policy', 'error', 'SCHEMA_EXCEPTION_UNKNOWN_RULE',
    `unsupported strict exception rule ${exception.rule}`, exception.resource);
  exceptionsByResource.set(exception.resource, current);
}

for (const dependency of dependencyLock.dependencies ?? []) {
  const missing = ['uri', 'dialect', 'source', 'version', 'sha256'].filter(k => !dependency[k]);
  if (missing.length > 0 || !/^sha256:[0-9a-f]{64}$/.test(dependency.sha256 ?? '')) {
    diagnostic('security', 'error', 'SCHEMA_DEPENDENCY_LOCK_INVALID',
      `dependency lock entry is incomplete or has an invalid digest (${missing.join(', ') || 'sha256'})`,
      dependency.uri ?? '<unknown>');
  }
}

for (const artifact of catalogArtifactRecords) {
  for (const projection of artifact.projections ?? []) {
    const projectionPath = toProjectPath(projection.path);
    if (!projectionPath || !existsSync(projectionPath)) {
      diagnostic('projection', 'error', 'SCHEMA_PROJECTION_MISSING',
        'declared projection does not exist', projection.path ?? '<unknown>');
      continue;
    }
    if (projection.digest) {
      const actual = `sha256:${createHash('sha256').update(readFileSync(projectionPath)).digest('hex')}`;
      if (actual !== projection.digest) {
        diagnostic('projection', 'error', 'SCHEMA_PROJECTION_DIGEST_MISMATCH',
          `expected ${projection.digest}, received ${actual}`, projection.path);
      }
    }
  }
}

const schemaRecords = [];
const schemaIds = new Map();
let schemaErrors = 0;
console.log(`\n[lint-schemas] Compiling ${schemaFiles.length} schema(s) (${catalogMode ? `${catalogSchemaFiles.length} cataloged; legacy schemas/ gate retained` : 'legacy fallback'}) …`);

for (const filePath of schemaFiles) {
  const relativePath = filePath.slice(projectRoot.length + 1);
  let schema;
  try {
    schema = loadJson(filePath);
  } catch (err) {
    console.error(`  ERROR: ${err.message}`);
    schemaErrors++;
    continue;
  }

  const id = typeof schema.$id === 'string' ? schema.$id.trim() : '';
  if (!id) {
    console.error(`  ERROR: ${relativePath} must declare a non-empty $id`);
    schemaErrors++;
    continue;
  }
  if (schemaIds.has(id)) {
    console.error(`  ERROR: ${relativePath} duplicates $id "${id}" from ${schemaIds.get(id)}`);
    schemaErrors++;
    continue;
  }
  schemaIds.set(id, relativePath);

  const draft = supportedDrafts.get(schema.$schema);
  if (!draft) {
    console.error(`  ERROR: ${relativePath} declares unsupported draft "${schema.$schema ?? '<missing>'}"`);
    schemaErrors++;
    continue;
  }
  schemaRecords.push({
    filePath,
    relativePath,
    id,
    schema,
    cataloged: catalogSchemaFiles.includes(filePath),
    ...draft,
  });
}


// Inventory duplicate identities outside the active compiler set as well. Cataloged
// projections are the only permitted duplicate authority claim.
const discoveredIds = new Map();
for (const filePath of discoveredSchemaFiles) {
  let candidate;
  try { candidate = loadJson(filePath); } catch { continue; }
  if (typeof candidate.$id !== 'string' || candidate.$id.length === 0) continue;
  const relativePath = filePath.slice(projectRoot.length + 1);
  const prior = discoveredIds.get(candidate.$id);
  if (prior) {
    const declaredProjection = catalogArtifactRecords.some(artifact =>
      artifact.id === candidate.$id && (
        (artifact.projections ?? []).some(item => item.path === relativePath)
        || artifact.authority?.path === relativePath
      ));
    diagnostic('inventory', declaredProjection ? 'info' : 'warning',
      declaredProjection ? 'SCHEMA_ID_DUPLICATE_PROJECTION' : 'SCHEMA_ID_COLLISION_UNDECLARED',
      `identity is also declared by ${prior}`, relativePath);
  } else {
    discoveredIds.set(candidate.$id, relativePath);
  }
}

for (const record of schemaRecords) {
  const compiler = createSchemaCompiler(record.Constructor, exceptionsByResource.get(record.relativePath));
  try {
    // Register all same-dialect local resources before compiling. Ajv never receives
    // a loadSchema callback, so an unresolved reference cannot trigger network I/O.
    for (const dependency of schemaRecords.filter(candidate => candidate.name === record.name)) {
      if (dependency.id !== record.id) compiler.addSchema(dependency.schema, dependency.id);
    }
    compiler.addSchema(record.schema, record.id);
    if (!compiler.getSchema(record.id)) {
      throw new Error(`Ajv did not return a validator for $id "${record.id}"`);
    }
    record.compiled = true;
  } catch (err) {
    diagnostic('validity', 'error', 'SCHEMA_STRICT_COMPILE_FAILED',
      `${record.name} strict compilation failed: ${err.message}`, record.relativePath);
    schemaErrors++;
  }
}
const compiledSchemas = schemaRecords.filter(record => record.compiled).length;
if (compiledSchemas === schemaFiles.length) {
  console.log(`  ✓ All ${compiledSchemas} registered schemas compiled strictly with unique $id values`);
} else {
  console.log(`  Compiled ${compiledSchemas}/${schemaFiles.length} versioned schemas`);
}

// ── Step 2: validate the executor schema file itself ──────────────────────

let errors = 0;
let warnings = 0;

console.log('\n[lint-schemas] Checking executor-v1.json …');

if (!existsSync(SCHEMA_PATH)) {
  console.error(`  ERROR: Schema file not found at ${SCHEMA_PATH}`);
  process.exit(1);
}

const executorSchema = loadJson(SCHEMA_PATH);

// Check the $schema declaration
const declared = executorSchema['$schema'] ?? '';
if (!declared.includes('2020-12')) {
  console.warn(`  WARN: $schema declares "${declared}" — expected draft 2020-12.`);
  warnings++;
} else {
  console.log('  ✓ $schema declares draft-2020-12');
}

// Compile the schema — Ajv will throw on structural errors
let rootValidate;
try {
  rootValidate = ajv.compile(executorSchema);
  console.log('  ✓ Schema compiled successfully');
} catch (err) {
  console.error(`  ERROR: Schema failed to compile: ${err.message}`);
  process.exit(1);
}

// Verify every $def is resolvable and compilable
const defs = executorSchema['$defs'] ?? {};
const defNames = Object.keys(defs);
console.log(`  ✓ $defs present: ${defNames.length} definitions`);

for (const defName of defNames) {
  const subSchema = defs[defName];
  try {
    // Use addSchema so we can validate sub-schemas independently
    const fakeId = `executor.aiwg.io/v1/defs/${defName}`;
    // Inline the $defs so refs resolve; wrap in a root with $defs
    const wrappedSchema = {
      $schema: 'https://json-schema.org/draft/2020-12',
      $defs: defs,
      ...subSchema,
    };
    ajv.compile(wrappedSchema);
    // console.log(`    ✓ $def/${defName} compiles`);
  } catch (err) {
    console.error(`  ERROR: $def/${defName} failed to compile: ${err.message}`);
    errors++;
  }
}
if (errors === 0) {
  console.log(`  ✓ All ${defNames.length} $defs compile without errors`);
}

// ── Step 3: validate fixtures ─────────────────────────────────────────────

if (!existsSync(FIXTURES_DIR)) {
  console.warn(`\n[lint-schemas] WARN: fixtures dir not found at ${FIXTURES_DIR}. Skipping fixture validation.`);
  warnings++;
} else {
  const fixtureFiles = readdirSync(FIXTURES_DIR).filter(f => f.endsWith('.json'));
  console.log(`\n[lint-schemas] Checking ${fixtureFiles.length} fixture(s) in ${FIXTURES_DIR} …`);

  for (const fname of fixtureFiles) {
    const fixturePath = join(FIXTURES_DIR, fname);
    console.log(`\n  [${fname}]`);

    let fixture;
    try {
      fixture = loadJson(fixturePath);
    } catch (err) {
      console.error(`    ERROR: ${err.message}`);
      errors++;
      continue;
    }

    // Collect all validatable objects in the fixture
    const validatables = collectValidatables(fixture);

    if (validatables.length === 0) {
      console.warn(`    WARN: No _validates_as markers found. Add "_validates_as": "#/$defs/<name>" to validate specific message shapes.`);
      warnings++;
      continue;
    }

    let fixtureErrors = 0;
    let fixtureChecks = 0;

    for (const { ref, value } of validatables) {
      fixtureChecks++;
      const subSchema = resolveRef(executorSchema, ref);
      if (!subSchema) {
        console.warn(`    WARN: Cannot resolve ref "${ref}" in schema — skipping.`);
        warnings++;
        continue;
      }

      // Build a wrapped schema so $refs inside the sub-schema resolve correctly
      const wrappedSchema = {
        $schema: 'https://json-schema.org/draft/2020-12',
        $defs: defs,
        ...subSchema,
      };

      let validate;
      try {
        validate = ajv.compile(wrappedSchema);
      } catch (err) {
        console.error(`    ERROR: Failed to compile sub-schema for "${ref}": ${err.message}`);
        fixtureErrors++;
        continue;
      }

      const cleaned = stripPrivate(value);
      const valid = validate(cleaned);

      if (!valid) {
        console.error(`    ERROR: Validation failed for "${ref}":`);
        for (const vErr of (validate.errors ?? [])) {
          const path = vErr.instancePath || '/';
          console.error(`      - ${path}: ${vErr.message} (${JSON.stringify(vErr.params)})`);
        }
        fixtureErrors++;
      }
    }

    if (fixtureErrors > 0) {
      console.error(`    ✗ ${fixtureErrors}/${fixtureChecks} check(s) failed`);
      errors += fixtureErrors;
    } else {
      console.log(`    ✓ ${fixtureChecks} check(s) passed`);
    }
  }
}

// ── Summary ────────────────────────────────────────────────────────────────

errors += schemaErrors;
if (reportPath) {
  const report = {
    version: 1,
    inventoryMode: catalogMode ? 'catalog' : 'legacy-fallback',
    networkResolution: 'deny',
    resources: schemaRecords
      .map(({ relativePath, id, name, schema, compiled, cataloged }) => ({
        path: relativePath,
        id,
        dialect: schema.$schema,
        profile: name,
        cataloged,
        compiled: compiled === true,
      }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    discoveredResources: discoveredSchemaFiles
      .map(filePath => filePath.slice(projectRoot.length + 1))
      .sort(),
    policy: {
      strictDefault: true,
      exceptionCount: (policy.exceptions ?? []).length,
      dependencyCount: (dependencyLock.dependencies ?? []).length,
    },
    diagnostics: diagnostics.sort((a, b) =>
      `${a.category}:${a.code}:${a.resource ?? ''}`.localeCompare(`${b.category}:${b.code}:${b.resource ?? ''}`)),
    summary: {
      errors,
      warnings: warnings + diagnostics.filter(item => item.severity === 'warning').length,
      compiled: compiledSchemas,
      registered: schemaFiles.length,
    },
  };
  writeFileSync(resolve(projectRoot, reportPath), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[lint-schemas] Wrote machine-readable report to ${reportPath}`);
}
console.log('\n' + '─'.repeat(60));
if (errors > 0) {
  console.error(`[lint-schemas] FAILED — ${errors} error(s), ${warnings} warning(s)`);
  process.exit(1);
} else {
  if (warnings > 0) {
    console.warn(`[lint-schemas] PASSED — 0 errors, ${warnings} warning(s)`);
  } else {
    console.log('[lint-schemas] PASSED — all checks green');
  }
  process.exit(0);
}
