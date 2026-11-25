#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import yaml from 'js-yaml';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function collectFiles(directory, predicate) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(entryPath, predicate));
    else if (entry.isFile() && predicate(entryPath)) files.push(entryPath);
  }
  return files.sort();
}

function loadJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function loadYaml(filePath) {
  const document = yaml.load(readFileSync(filePath, 'utf8'));
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('document root must be a mapping');
  }
  return document;
}

function compiler() {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv;
}

function diagnosticPath(error) {
  const suffix = error.keyword === 'additionalProperties'
    ? `/${error.params.additionalProperty}`
    : '';
  return `${error.instancePath || '/'}${suffix}`.replace(/\/+/g, '/');
}

function schemaDiagnostics(errors = []) {
  return errors.map(error => ({
    path: diagnosticPath(error),
    keyword: error.keyword,
    message: error.message || 'schema validation failed',
  }));
}

function walkStrings(value, visitor, pointer = '') {
  if (typeof value === 'string') {
    visitor(value, pointer || '/');
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkStrings(item, visitor, `${pointer}/${index}`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      walkStrings(child, visitor, `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`);
    }
  }
}

function referenceDiagnostics(document) {
  const diagnostics = [];
  if (!['OpsPlaybook', 'DevBuildPlaybook'].includes(document.kind)) return diagnostics;
  walkStrings(document, (value, path) => {
    if (value.includes('{{') || value.includes('}}')) {
      diagnostics.push({
        path,
        keyword: 'structured-reference',
        message: 'unsupported template expression; use an input binding with from: vars.<name> or from: steps.<id>.outputs.<name>',
      });
    }
  });

  const vars = new Set(Object.keys(document.spec?.vars ?? {}));
  const steps = Array.isArray(document.spec?.steps) ? document.spec.steps : [];
  const outputs = new Map();
  for (const step of steps) {
    outputs.set(step?.id, new Set((step?.outputs ?? []).map(output => output?.name)));
  }
  steps.forEach((step, stepIndex) => {
    if (!Array.isArray(step?.inputs)) return;
    step.inputs.forEach((input, inputIndex) => {
      if (typeof input?.from !== 'string') return;
      const path = `/spec/steps/${stepIndex}/inputs/${inputIndex}/from`;
      const varMatch = /^vars\.([A-Za-z_][A-Za-z0-9_-]*)$/.exec(input.from);
      if (varMatch) {
        if (!vars.has(varMatch[1])) {
          diagnostics.push({ path, keyword: 'reference-resolution', message: `unknown playbook variable '${varMatch[1]}'` });
        }
        return;
      }
      const stepMatch = /^steps\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)$/.exec(input.from);
      if (stepMatch) {
        if (!outputs.get(stepMatch[1])?.has(stepMatch[2])) {
          diagnostics.push({ path, keyword: 'reference-resolution', message: `unknown step output '${stepMatch[1]}.${stepMatch[2]}'` });
        }
        return;
      }
      diagnostics.push({
        path,
        keyword: 'structured-reference',
        message: "reference must match 'vars.<name>' or 'steps.<id>.outputs.<name>'",
      });
    });
  });
  return diagnostics;
}

export function capabilityReferenceDiagnostics(document, registry) {
  const diagnostics = [];
  const visit = (value, pointer = '') => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      const path = `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
      if (key === 'capability' && typeof child === 'string' && !registry.capabilities.has(child)) {
        diagnostics.push({ path, keyword: 'capability-resolution', message: `undefined OpsCapability '${child}'` });
      }
      visit(child, path);
    }
    // CIPipeline flag steps have a consumer default, not a populated schema default.
    if (value.strategy === 'flag' && Array.isArray(value.steps)) {
      value.steps.forEach((step, index) => {
        if (step && step.capability === undefined && !registry.capabilities.has('progressive-rollout')) {
          diagnostics.push({ path: `${pointer}/steps/${index}/capability`, keyword: 'capability-resolution',
            message: "undefined default OpsCapability 'progressive-rollout'" });
        }
      });
    }
  };
  visit(document);
  return diagnostics;
}

export function buildOpsSchemaRegistry(projectRoot = DEFAULT_ROOT) {
  const root = resolve(projectRoot);
  const ajv = compiler();
  const kinds = new Map();
  const compiledSchemas = new Map();
  const registrationErrors = [];
  const register = (kind, schemaPath, owner) => {
    if (!kind || typeof kind !== 'string') {
      registrationErrors.push(`${owner}: schema does not declare properties.kind.const`);
      return;
    }
    if (kinds.has(kind)) {
      registrationErrors.push(`${owner}: kind '${kind}' duplicates ${kinds.get(kind).owner}`);
      return;
    }
    try {
      const compiled = compiledSchemas.get(schemaPath) ?? (() => {
        const schema = loadJson(schemaPath);
        const validate = ajv.compile(schema);
        const value = { schema, validate };
        compiledSchemas.set(schemaPath, value);
        return value;
      })();
      const { schema, validate } = compiled;
      const declaredKinds = schema.properties?.kind?.const
        ? [schema.properties.kind.const]
        : schema.properties?.kind?.enum ?? [];
      if (!declaredKinds.includes(kind)) {
        registrationErrors.push(`${owner}: schema ${relative(root, schemaPath)} does not accept declared kind '${kind}'`);
        return;
      }
      kinds.set(kind, { kind, schemaPath, owner, validate, apiVersion: schema.properties?.apiVersion?.const });
    } catch (error) {
      registrationErrors.push(`${owner}: cannot compile ${relative(root, schemaPath)}: ${error.message}`);
    }
  };

  const coreSchemaDir = join(root, 'agentic', 'code', 'frameworks', 'ops-complete', 'schemas', 'metalanguage');
  for (const schemaPath of collectFiles(coreSchemaDir, file => file.endsWith('.schema.json'))) {
    try {
      const schema = loadJson(schemaPath);
      register(schema.properties?.kind?.const, schemaPath, 'ops-complete');
    } catch (error) {
      registrationErrors.push(`ops-complete: cannot read ${relative(root, schemaPath)}: ${error.message}`);
    }
  }

  const extensionsDir = join(root, 'agentic', 'code', 'extensions');
  for (const entry of existsSync(extensionsDir) ? readdirSync(extensionsDir, { withFileTypes: true }) : []) {
    if (!entry.isDirectory()) continue;
    const extensionRoot = join(extensionsDir, entry.name);
    const manifestPath = join(extensionRoot, 'ADDON.yaml');
    if (!existsSync(manifestPath)) continue;
    let manifest;
    try {
      manifest = loadYaml(manifestPath);
    } catch (error) {
      registrationErrors.push(`${entry.name}: invalid ADDON.yaml: ${error.message}`);
      continue;
    }
    for (const declaration of manifest.spec?.kinds ?? []) {
      const schemaPath = resolve(extensionRoot, declaration.schema || '');
      const insideExtension = schemaPath === extensionRoot || schemaPath.startsWith(`${extensionRoot}${sep}`);
      if (!insideExtension || !existsSync(schemaPath)) {
        registrationErrors.push(`${entry.name}: kind '${declaration.name}' references missing or out-of-extension schema '${declaration.schema}'`);
        continue;
      }
      register(declaration.name, schemaPath, entry.name);
    }
  }
  const capabilities = new Map();
  // Framework capability libraries plus extension capability dirs (extensions declare `capabilities: auto-discover`).
  const capabilityDirs = [
    ...['ops-complete', 'cicd-complete'].map(framework => join(root, 'agentic/code/frameworks', framework, 'capabilities')),
    ...(existsSync(extensionsDir) ? readdirSync(extensionsDir, { withFileTypes: true }) : [])
      .filter(entry => entry.isDirectory())
      .map(entry => join(extensionsDir, entry.name, 'capabilities')),
  ];
  for (const directory of capabilityDirs) {
    for (const file of collectFiles(directory, path => /\.(ya?ml|json)$/i.test(path))) {
      try {
        const document = file.endsWith('.json') ? loadJson(file) : loadYaml(file);
        const record = kinds.get('OpsCapability');
        if (!record || !record.validate(document)) {
          throw new Error(`invalid OpsCapability: ${JSON.stringify(record?.validate.errors ?? [])}`);
        }
        const name = document.metadata.name;
        if (capabilities.has(name)) throw new Error(`duplicate OpsCapability '${name}'`);
        capabilities.set(name, file);
      } catch (error) {
        registrationErrors.push(`${relative(root, file)}: ${error.message}`);
      }
    }
  }
  return { root, kinds, capabilities, registrationErrors };
}

export function validateOpsArtifact(document, { filePath = '<memory>', registry } = {}) {
  const activeRegistry = registry ?? buildOpsSchemaRegistry();
  const record = activeRegistry.kinds.get(document?.kind);
  const diagnostics = [];
  if (!record) {
    diagnostics.push({ path: '/kind', keyword: 'kind-resolution', message: `no registered ops schema for kind '${document?.kind ?? '<missing>'}'` });
  } else {
    if (record.apiVersion && document.apiVersion !== record.apiVersion) {
      diagnostics.push({ path: '/apiVersion', keyword: 'const', message: `kind '${document.kind}' requires apiVersion '${record.apiVersion}'` });
    }
    if (!record.validate(document)) diagnostics.push(...schemaDiagnostics(record.validate.errors));
  }
  diagnostics.push(...referenceDiagnostics(document));
  diagnostics.push(...capabilityReferenceDiagnostics(document, activeRegistry));
  return { valid: diagnostics.length === 0, filePath, schemaPath: record?.schemaPath ?? null, diagnostics };
}

export function validateOpsTemplateFile(filePath, registry = buildOpsSchemaRegistry()) {
  try {
    const document = filePath.endsWith('.json') ? loadJson(filePath) : loadYaml(filePath);
    if (document.apiVersion === 'cicd.aiwg.io/v1') {
      const diagnostics = capabilityReferenceDiagnostics(document, registry);
      return { valid: diagnostics.length === 0, filePath, schemaPath: null, diagnostics };
    }
    return validateOpsArtifact(document, { filePath, registry });
  } catch (error) {
    return { valid: false, filePath, schemaPath: null, diagnostics: [{ path: '/', keyword: 'yaml-parse', message: error.message }] };
  }
}

export function discoverOpsTemplates(projectRoot = DEFAULT_ROOT) {
  const extensionsDir = join(resolve(projectRoot), 'agentic', 'code', 'extensions');
  if (!existsSync(extensionsDir)) return [];
  return readdirSync(extensionsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .flatMap(entry => collectFiles(join(extensionsDir, entry.name, 'templates'), file => /\.ya?ml$/i.test(file)))
    .sort();
}

export function validateAllOpsTemplates(projectRoot = DEFAULT_ROOT) {
  const registry = buildOpsSchemaRegistry(projectRoot);
  const results = discoverOpsLintFiles(projectRoot).map(file => validateOpsTemplateFile(file, registry));
  return { registry, results, valid: registry.registrationErrors.length === 0 && results.every(result => result.valid) };
}

export function discoverOpsLintFiles(projectRoot = DEFAULT_ROOT) {
  return [
    ...discoverOpsTemplates(projectRoot),
    ...collectFiles(join(resolve(projectRoot), 'test/fixtures/ops/valid'), file => /\.(json|ya?ml)$/i.test(file)),
    ...collectFiles(join(resolve(projectRoot), 'test/fixtures/cicd/valid'), file => file.endsWith('.json')),
  ].sort();
}

function runCli(argv = process.argv.slice(2)) {
  const registry = buildOpsSchemaRegistry(DEFAULT_ROOT);
  const requested = argv.filter(arg => !arg.startsWith('-')).map(file => isAbsolute(file) ? file : resolve(process.cwd(), file));
  const files = requested.length ? requested : discoverOpsLintFiles(DEFAULT_ROOT);
  const results = files.map(file => validateOpsTemplateFile(file, registry));
  for (const error of registry.registrationErrors) console.error(`[ops-schema] ${error}`);
  for (const result of results) {
    const label = relative(DEFAULT_ROOT, result.filePath) || result.filePath;
    if (result.valid) console.log(`PASS ${label}`);
    else for (const diagnostic of result.diagnostics) console.error(`FAIL ${label}${diagnostic.path}: ${diagnostic.message} (${diagnostic.keyword})`);
  }
  const failed = results.filter(result => !result.valid).length;
  console.log(`Validated ${results.length} ops templates and fixtures: ${results.length - failed} passed, ${failed} failed.`);
  if (registry.registrationErrors.length || failed) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) runCli();
