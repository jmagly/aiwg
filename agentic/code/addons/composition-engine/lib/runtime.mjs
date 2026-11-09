import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { validateFlowGraph } from './validator.mjs';
import { createFlowAuthority } from './authority.mjs';

const RESOURCE_KEYS = ['activations', 'tokens', 'costUsd', 'timeMs'];

// Legacy adapters cannot consume worker values without the managed handshake.
const MISSION_WORKER_SCHEMA_ID = 'https://aiwg.io/schemas/mission.aiwg.io/v1';
const MISSION_WORKER_DEFINITIONS = new Set([
  'workerArtifact',
  'workerEffort',
  'workerTuple',
  'workerLimits',
  'workerSelectionIntent',
  'workerBrief',
  'workerClaims',
  'workerUsage',
  'workerExecution',
  'workerVerification',
  'workerResult',
  'workerDispatch',
  'workerDirectIntent',
  'workerDirectBrief',
  'workerResolvedInvocation',
  'workerDirectVerification',
  'workerDirectResult',
  'workerHealthSummary',
  'workerEffectiveHealth',
]);

// Resolve against the owning schema, never infer ownership from a $defs name.
function workerContractReference(reference, base = 'https://aiwg.invalid/local-schema') {
  if (typeof reference !== 'string') return false;
  try {
    const resolved = new URL(reference, base);
    const fragment = decodeURIComponent(resolved.hash).split('/');
    resolved.hash = '';
    return resolved.href === MISSION_WORKER_SCHEMA_ID
      && fragment[0] === '#' && fragment[1] === '$defs'
      && MISSION_WORKER_DEFINITIONS.has(fragment[2]);
  } catch {
    return false;
  }
}

function assertNoWorkerBinding(value) {
  const seenExtensions = new Set();
  const seenRecords = new Set();
  const seenSchemas = new Map();
  function unsupported() {
    throw new FlowGraphRuntimeError('OG_CONTRACT_UNSUPPORTED', 'Flow runtime does not advertise worker-flow-values.v1 validation/accounting support.');
  }
  function extensions(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || seenExtensions.has(item)) return;
    seenExtensions.add(item);
    if (Object.hasOwn(item, 'aiwg.worker-dispatch')) unsupported();
    for (const [key, child] of Object.entries(item)) if (key.startsWith('aiwg.source.')) {
      extensions(child);
      record(child);
    }
  }
  function schema(item, inheritedBase = 'https://aiwg.invalid/local-schema') {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return;
    let base = inheritedBase;
    if (typeof item.$id === 'string') {
      try { base = new URL(item.$id, inheritedBase).href; } catch { /* invalid schemas belong to validation */ }
    }
    const bases = seenSchemas.get(item) ?? new Set();
    if (bases.has(base)) return;
    bases.add(base);
    seenSchemas.set(item, bases);
    if (workerContractReference(item.$ref, base) || workerContractReference(item.schemaRef, base)) unsupported();
    // Only JSON Schema subschemas inherit an owner. const/default/examples
    // and properties' names are data, not active references or extensions.
    for (const key of ['$defs', 'definitions', 'properties', 'patternProperties', 'dependentSchemas', 'dependencies']) {
      for (const child of Object.values(item[key] ?? {})) schema(child, base);
    }
    for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
      if (Array.isArray(item[key])) for (const child of item[key]) schema(child, base);
    }
    for (const key of ['items', 'additionalItems', 'additionalProperties', 'unevaluatedItems', 'unevaluatedProperties', 'contains', 'propertyNames', 'not', 'if', 'then', 'else']) {
      if (Array.isArray(item[key])) for (const child of item[key]) schema(child, base);
      else schema(item[key], base);
    }
  }
  function record(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || seenRecords.has(item)) return;
    seenRecords.add(item);
    // All mission-v1 carriers: /extensions and /status/artifacts/*/extensions.
    extensions(item.extensions);
    if (Array.isArray(item.status?.artifacts)) item.status.artifacts.forEach(record);
    // Native protocols also use metadata and top-level artifacts.
    extensions(item.metadata);
    if (Array.isArray(item.artifacts)) item.artifacts.forEach(record);
    if (typeof item.$ref === 'string' || typeof item.schemaRef === 'string'
      || typeof item.$id === 'string' || typeof item.$schema === 'string') schema(item);
    schema(item.schema);
    if (workerContractReference(item.output?.schemaRef)) unsupported();
  }
  record(value);
}

// Named input/output maps and their values are user data, not contract
// records. Only a value that declares itself a Mission record can carry a
// worker binding, so an input named `extensions` or `metadata` stays data.
function assertNoWorkerValues(values) {
  for (const value of Object.values(values ?? {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)
      && value.apiVersion === 'mission.aiwg.io/v1' && value.kind === 'Mission') assertNoWorkerBinding(value);
  }
}

function assertNoWorkerResult(result) {
  assertNoWorkerBinding(result);
  assertNoWorkerValues(result?.outputs);
}

function assertNoWorkerFlow(manifest, resume) {
  assertNoWorkerBinding(manifest);
  // Visit declared schemas and typed values, never arbitrary manifest data.
  for (const candidate of manifest?.spec?.candidates ?? []) assertNoWorkerBinding(candidate);
  for (const field of manifest?.spec?.state?.fields ?? []) {
    assertNoWorkerBinding(field);
    assertNoWorkerBinding(field.initial);
  }
  for (const node of manifest?.spec?.nodes ?? []) {
    assertNoWorkerBinding(node);
    for (const binding of [...(node.inputs ?? []), ...(node.outputs ?? [])]) {
      assertNoWorkerBinding(binding);
      assertNoWorkerBinding(binding.value);
    }
  }
  assertNoWorkerBinding(manifest?.spec?.output);
  assertNoWorkerBinding(resume);
  assertNoWorkerValues(resume?.state);
  assertNoWorkerBinding(resume?.results);
  for (const result of Object.values(resume?.results ?? {})) assertNoWorkerResult(result);
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
}

function getPointer(root, pointer) {
  if (pointer === '' || pointer === '/') return root;
  return pointer.split('/').slice(1).reduce((value, token) => (
    value?.[token.replaceAll('~1', '/').replaceAll('~0', '~')]
  ), root);
}

function setPointer(root, pointer, replacement) {
  const tokens = pointer.split('/').slice(1).map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~'));
  if (tokens.length === 0) return replacement;
  const output = clone(root);
  let cursor = output;
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const token = tokens[index];
    if (!cursor[token] || typeof cursor[token] !== 'object') return output;
    cursor = cursor[token];
  }
  if (Object.prototype.hasOwnProperty.call(cursor, tokens.at(-1))) cursor[tokens.at(-1)] = replacement;
  return output;
}

function redact(value, pointers) {
  let result = clone(value);
  for (const pointer of pointers) result = setPointer(result, pointer, '[REDACTED]');
  return result;
}

function reduceValue(current, next, reducer) {
  switch (reducer) {
    case 'replace': return clone(next);
    case 'append': return [...(current ?? []), ...(Array.isArray(next) ? next : [next])];
    case 'merge': return { ...(current ?? {}), ...(next ?? {}) };
    case 'sum': return (current ?? 0) + next;
    case 'min': return current === undefined ? next : Math.min(current, next);
    case 'max': return current === undefined ? next : Math.max(current, next);
    case 'set-union': return [...new Set([...(current ?? []), ...(next ?? [])])];
    default: throw new Error(`Unsupported state reducer '${reducer}'.`);
  }
}

function defaultPredicate(predicate, context) {
  if (!predicate) return true;
  const expression = predicate.expression.trim();
  if (expression === 'true') return true;
  if (expression === 'false') return false;
  const match = expression.match(/^(state|metrics)\.([a-z][a-z0-9-]*)\s*(==|!=|>=|<=|>|<)\s*(-?\d+(?:\.\d+)?|true|false)$/);
  if (!match) throw new Error(`Predicate '${expression}' requires an adapter evaluator.`);
  const [, scope, key, operator, raw] = match;
  const right = raw === 'true' ? true : raw === 'false' ? false : Number(raw);
  const left = context[scope]?.[key];
  switch (operator) {
    case '==': return left === right;
    case '!=': return left !== right;
    case '>=': return left >= right;
    case '<=': return left <= right;
    case '>': return left > right;
    case '<': return left < right;
    default: return false;
  }
}

const FLOW_WORKER_FEATURES = [
  'worker-dispatch.v1', 'worker-policy-origins.v1', 'worker-admission-fencing.v1',
  'worker-claims.v1', 'worker-activation.v1', 'worker-health.v1', 'worker-flow-values.v1',
];
let bundledSchemas;
const managedInvokers = new WeakSet();

function loadBundledSchemas() {
  if (bundledSchemas) return bundledSchemas;
  let root = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      const name = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name;
      if (name === 'aiwg' || name === '@aiwg/cli') break;
    } catch { /* source and installed packages have different depths */ }
    const parent = path.dirname(root);
    if (parent === root) throw new FlowGraphRuntimeError('OG_CONTRACT_UNSUPPORTED', 'Cannot locate bundled Flow schema owners.');
    root = parent;
  }
  const files = [
    'schemas/mission-v1.schema.json',
    'schemas/models/model-catalog.v1.schema.json',
    'schemas/models/model-policy.v1.schema.json',
    'schemas/models/model-config-compatibility.v1.schema.json',
    'schemas/models/provider-model-capabilities.v1.schema.json',
    'vscode-extension/schemas/aiwg.config.v1.json',
    'agentic/code/addons/composition-engine/schemas/flow-graph.schema.json',
  ];
  bundledSchemas = files.map((file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')));
  return bundledSchemas;
}

/** Trusted adapter registration metadata, using the existing Mission handshake. */
export function flowWorkerConsumerSupport() {
  const mission = loadBundledSchemas().find((schema) => schema.$id === MISSION_WORKER_SCHEMA_ID);
  const definitions = Object.fromEntries([...MISSION_WORKER_DEFINITIONS].map((name) => [name, mission.$defs[name]]));
  return { revision: 1, bundleDigest: digest(definitions), features: [...FLOW_WORKER_FEATURES], lossless: true };
}

/** Bind the graph evaluator to the existing project's managed execution owner. */
export function createManagedCompositionAdapter({ scheduler, prepareNode, invokeNode, allowanceFromOwner, ...adapter }) {
  if (!scheduler || typeof prepareNode !== 'function' || typeof invokeNode !== 'function' || typeof allowanceFromOwner !== 'function') {
    throw new FlowGraphRuntimeError('OG_CONTRACT_UNSUPPORTED', 'Managed Flow requires the shared admission and qualified execution owner.');
  }
  async function invokeManagedNode(request) {
    const prepared = await prepareNode(clone(request));
    const proposed = prepared?.admission;
    if (!proposed?.managed || !request.runResources) throw new FlowGraphRuntimeError('OG_CONTRACT_UNSUPPORTED', 'Managed Flow requires a qualified admission request and parent ceilings.');
    const allowance = {
      ...proposed.allowance,
      ...allowanceFromOwner(request.runId, proposed.allowance?.taskId ?? request.node.id, { kind: 'flow', ceilings: request.runResources }),
    };
    if (!allowance.previousRequestId) {
      const previous = Object.values(scheduler.snapshot().records)
        .filter((record) => record.requestId !== proposed.requestId && record.allowance?.runId === allowance.runId && record.allowance?.taskId === allowance.taskId)
        .sort((left, right) => (right.accounting?.attemptNumber ?? 0) - (left.accounting?.attemptNumber ?? 0))[0];
      if (previous) allowance.previousRequestId = previous.requestId;
    }
    const admission = scheduler.submit({ ...proposed, allowance });
    if (admission.state !== 'admitted') throw Object.assign(new FlowGraphRuntimeError('MANAGED_ADMISSION_BLOCKED', `Flow node '${request.node.id}' is ${admission.state}: ${admission.reason}`), { usage: { tokens: 0, costUsd: 0, timeMs: 0 } });
    const generation = admission.leaseGeneration;
    let claimed = false;
    let execution;
    let observedUsage;
    let finalized = false;
    function settle(source) {
      const evidence = source?.managedEvidence;
      if (!evidence?.health || !evidence?.usage) return false;
      scheduler.acceptFinal(admission.requestId, generation, evidence.health, evidence.usage);
      const record = scheduler.settle(admission.requestId, generation, evidence.health, evidence.usage, evidence.failure, execution);
      finalized = record.state === 'settled';
      return finalized;
    }
    try {
      if (prepared.brief && (prepared.brief.lease?.reservationId !== admission.requestId
        || prepared.brief.lease?.generation !== generation || prepared.brief.lease?.authorityRef !== 'project')) {
        scheduler.disconnect(admission.requestId, generation);
        throw new FlowGraphRuntimeError('MANAGED_ADMISSION_MISMATCH', 'Prepared Flow brief does not match its current shared admission lease.');
      }
      scheduler.claimLaunch(admission.requestId, generation);
      claimed = true;
      const raw = await invokeNode(clone(request), {
        admission: clone(admission), prepared,
        bindExecution(identity) {
          scheduler.bindExecution(admission.requestId, generation, identity);
          execution = clone(identity);
        },
        renew: () => scheduler.renew(admission.requestId, generation),
        observeHealth: (health) => scheduler.observeHealth(admission.requestId, generation, health),
        cancel: () => scheduler.cancel(admission.requestId, generation),
      });
      observedUsage = raw?.usage;
      if (!settle(raw)) throw Object.assign(new FlowGraphRuntimeError('MANAGED_EXECUTION_UNCERTAIN', 'Managed Flow cannot deliver outputs without current-generation termination proof.'), { usage: raw?.usage });
      if (raw.managedEvidence.health.state !== 'completed') throw Object.assign(new FlowGraphRuntimeError('MANAGED_EXECUTION_FAILED', 'Managed worker did not complete.'), { usage: raw?.usage });
      const { managedEvidence, ...result } = raw;
      return { ...result, managedAdmission: { requestId: admission.requestId, generation, state: 'settled', worker: clone(admission.managed) } };
    } catch (error) {
      if (observedUsage !== undefined && error && typeof error === 'object' && error.usage === undefined) error.usage = clone(observedUsage);
      if (!finalized && claimed) {
        try { settle(error); } catch {
          // Invalid final evidence cannot replace the execution failure or its usage.
        }
        if (!finalized) {
          try { scheduler.disconnect(admission.requestId, generation); } catch {
            // A stale owner cannot mutate the current lease or deliver outputs.
          }
        }
      }
      throw error;
    }
  }
  managedInvokers.add(invokeManagedNode);
  return { ...adapter, workerMode: 'managed', workerConsumer: flowWorkerConsumerSupport(), invokeNode: invokeManagedNode };
}

function managedValueValidator(consumer) {
  const support = flowWorkerConsumerSupport();
  if (consumer?.revision !== support.revision || consumer?.bundleDigest !== support.bundleDigest
    || consumer?.lossless !== true || !Array.isArray(consumer?.features)
    || support.features.some((feature) => !consumer.features.includes(feature))) {
    throw new FlowGraphRuntimeError('OG_CONTRACT_UNSUPPORTED', 'Managed Flow requires the current lossless worker schema bundle and worker-flow-values.v1 adapter.');
  }
  const engines = {
    draft7: addFormats(new Ajv({ strict: false, allErrors: true })),
    draft2020: addFormats(new Ajv2020({ strict: false, allErrors: true })),
  };
  const dialect = (schema) => schema.$schema?.includes('2020-12') ? 'draft2020' : 'draft7';
  const owners = new Map(loadBundledSchemas().map((schema) => [schema.$id, schema]));
  for (const schema of owners.values()) engines[dialect(schema)].addSchema(schema);
  // A reference to another dialect delegates to that owner's validator.
  // The surrounding schema keeps its own dialect and sibling semantics.
  const bridgeKeyword = 'aiwgBundledSchemaReference';
  for (const engine of Object.values(engines)) engine.addKeyword({
    keyword: bridgeKeyword,
    schemaType: 'string',
    errors: true,
    compile(reference) {
      const owner = owners.get(reference.split('#')[0]);
      if (!owner) throw new Error('Only bundled schema references are supported.');
      return engines[dialect(owner)].getSchema(reference);
    },
  });
  function bridge(schema, selected, base = 'https://aiwg.invalid/flow-value') {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
    const result = { ...schema };
    if (Object.hasOwn(schema, bridgeKeyword)) throw new Error('Reserved schema keyword.');
    if (schema.$id) base = new URL(schema.$id, base).href;
    if (schema.$ref) {
      const reference = new URL(schema.$ref, base).href;
      const owner = owners.get(reference.split('#')[0]);
      if (owner && dialect(owner) !== selected) {
        delete result.$ref;
        result[bridgeKeyword] = reference;
      }
    }
    for (const key of ['$defs', 'definitions', 'properties', 'patternProperties', 'dependentSchemas', 'dependencies']) {
      if (schema[key]) result[key] = Object.fromEntries(Object.entries(schema[key]).map(([name, child]) => [name, bridge(child, selected, base)]));
    }
    for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) if (Array.isArray(schema[key])) result[key] = schema[key].map((child) => bridge(child, selected, base));
    for (const key of ['items', 'additionalItems', 'additionalProperties', 'unevaluatedItems', 'unevaluatedProperties', 'contains', 'propertyNames', 'not', 'if', 'then', 'else']) {
      if (Object.hasOwn(schema, key)) result[key] = Array.isArray(schema[key]) ? schema[key].map((child) => bridge(child, selected, base)) : bridge(schema[key], selected, base);
    }
    return result;
  }
  const validators = new Map();
  function compile(schema) {
    if (validators.has(schema)) return validators.get(schema);
    let selected = dialect(schema);
    if (!schema.$schema && schema.$ref) {
      const owner = owners.get(schema.$ref.split('#')[0]);
      if (owner) selected = dialect(owner);
    }
    try {
      const validate = engines[selected].compile(bridge(schema, selected));
      validators.set(schema, validate);
      return validate;
    } catch (error) {
      throw new FlowGraphRuntimeError('FLOW_SCHEMA_UNRESOLVED', 'Typed Flow schemas must resolve offline from bundled owners in their declared dialect.', { reason: error.message });
    }
  }
  return {
    compile,
    check(schema, value, code, binding) {
      const validate = compile(schema);
      if (!validate(value)) throw new FlowGraphRuntimeError(code, `Invalid typed Flow value '${binding}'.`, { errors: clone(validate.errors) });
    },
  };
}

function usageOf(result, managed = false) {
  const usage = result?.usage ?? {};
  return Object.fromEntries(['tokens', 'costUsd', 'timeMs'].map((key) => [
    key, managed && (usage[key] === undefined || usage[key] === null) ? null : Number(usage[key] ?? 0),
  ]));
}

function assertUsage(usage) {
  for (const [key, value] of Object.entries(usage)) {
    if (value !== null && (!Number.isFinite(value) || value < 0)) throw new Error(`Adapter usage.${key} must be a non-negative number.`);
  }
}

function resultOutput(results, reference) {
  const [nodeId, outputName] = String(reference).split('.');
  return results[nodeId]?.outputs?.[outputName];
}

function initialState(manifest) {
  return Object.fromEntries(manifest.spec.state.fields.map((field) => [field.name, clone(field.initial)]));
}

function resourcesExceeded(realized, ceilings) {
  return RESOURCE_KEYS.find((key) => realized[key] >= ceilings[key]);
}

function publicTouches(value) {
  const normalize = (items) => [...new Set((Array.isArray(items) ? items : [])
    .filter((item) => typeof item === 'string' && item.length > 0))].sort();
  return { files: normalize(value?.files), resources: normalize(value?.resources) };
}

function scopeEvidence(declaredValue, observedValue, complete = true) {
  const declared = publicTouches(declaredValue);
  const observed = publicTouches(observedValue);
  const compare = (kind) => ({
    declared: declared[kind],
    observed: observed[kind],
    undeclared: observed[kind].filter((item) => !declared[kind].includes(item)),
    unobserved: declared[kind].filter((item) => !observed[kind].includes(item)),
  });
  const files = compare('files');
  const resources = compare('resources');
  const observedCount = observed.files.length + observed.resources.length;
  const declaredCount = declared.files.length + declared.resources.length;
  const undeclaredCount = files.undeclared.length + resources.undeclared.length;
  return {
    files,
    resources,
    coverage: observedCount === 0 ? 'empty'
      : undeclaredCount > 0 ? 'divergent'
      : observedCount < declaredCount ? 'reduced'
        : 'complete',
    observationComplete: Boolean(complete),
  };
}

function mergedScopeEvidence(previous, declared, observed, complete) {
  const aggregate = {
    files: [...(previous?.files?.observed ?? []), ...(observed?.files ?? [])],
    resources: [...(previous?.resources?.observed ?? []), ...(observed?.resources ?? [])],
  };
  return scopeEvidence(declared, aggregate, previous ? previous.observationComplete && complete : complete);
}

function emptyUsage() {
  return { runs: 0, tokens: 0, costUsd: 0, timeMs: 0 };
}

function addUsage(target, usage) {
  target.runs += 1;
  for (const key of ['tokens', 'costUsd', 'timeMs']) target[key] = target[key] === null || usage[key] === null ? null : target[key] + usage[key];
}

export class FlowGraphRuntimeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'FlowGraphRuntimeError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Execute the deterministic FlowGraph planner. The returned event stream is a
 * projection for MissionConductor (or another durable owner) to persist; this
 * module deliberately does not create a competing mission ledger.
 */
export async function executeFlowGraph(manifest, options = {}) {
  const managed = options.workerMode === 'managed';
  const values = managed ? managedValueValidator(options.workerConsumer) : undefined;
  if (managed && !managedInvokers.has(options.invokeNode)) throw new FlowGraphRuntimeError('OG_CONTRACT_UNSUPPORTED', 'Managed Flow requires an adapter bound to the shared execution owner.');
  if (!managed) assertNoWorkerFlow(manifest, options.resumeFrom);
  const validation = validateFlowGraph(manifest, options.validation);
  if (!validation.valid) {
    throw new FlowGraphRuntimeError('FLOW_GRAPH_INVALID', 'FlowGraph validation failed.', {
      diagnostics: validation.diagnostics,
    });
  }
  if (typeof options.invokeNode !== 'function') {
    throw new FlowGraphRuntimeError('ADAPTER_REQUIRED', 'FlowGraph execution requires invokeNode adapter function.');
  }

  const graphId = validation.normalized.identity.graphId;
  const runId = options.runId ?? `${graphId}:run`;
  const evaluatePredicate = options.evaluatePredicate ?? defaultPredicate;
  const nodeOrder = new Map(manifest.spec.nodes.map((node, index) => [node.id, index]));
  const nodes = new Map(manifest.spec.nodes.map((node) => [node.id, node]));
  const stateFields = new Map(manifest.spec.state.fields.map((field) => [field.name, field]));
  const resume = options.resumeFrom ?? {};
  const state = { ...initialState(manifest), ...(clone(resume.state) ?? {}) };
  const results = clone(resume.results) ?? {};
  const receipts = clone(resume.receipts) ?? {};
  const completed = new Set(resume.completed ?? []);
  const failed = new Set(resume.failed ?? []);
  const skipped = new Set(resume.skipped ?? []);
  const activatedRoutes = new Set(resume.activatedRoutes ?? []);
  const routeActivations = clone(resume.routeActivations) ?? {};
  const routeProgress = clone(resume.routeProgress) ?? {};
  const reactivatedNodes = new Set(resume.reactivatedNodes ?? []);
  const events = clone(resume.events) ?? [];
  const realized = {
    activations: Number(resume.realized?.activations ?? 0),
    nodeRuns: Number(resume.realized?.nodeRuns ?? 0),
    tokens: managed && resume.realized?.tokens === null ? null : Number(resume.realized?.tokens ?? 0),
    costUsd: managed && resume.realized?.costUsd === null ? null : Number(resume.realized?.costUsd ?? 0),
    timeMs: managed && resume.realized?.timeMs === null ? null : Number(resume.realized?.timeMs ?? 0),
    maxConcurrency: Number(resume.realized?.maxConcurrency ?? 0),
    retries: Number(resume.realized?.retries ?? 0),
  };
  const joinState = clone(resume.joins) ?? {};
  const evidence = clone(resume.evidence) ?? { nodes: {}, branches: {}, sideEffects: {}, joins: {} };
  const accounting = managed ? clone(resume.accounting) ?? {
    attempts: {},
    pending: {},
    known: Object.fromEntries(['tokens', 'costUsd', 'timeMs'].map((key) => [key, realized[key] ?? 0])),
    reserved: Object.fromEntries(['tokens', 'costUsd', 'timeMs'].map((key) => [key, realized[key] === null ? manifest.spec.ceilings[key] : 0])),
  } : undefined;
  if (managed) {
    for (const field of stateFields.values()) values.check(field.schema, state[field.name], 'INVALID_TYPED_STATE', field.name);
    for (const node of nodes.values()) {
      for (const binding of [...node.inputs, ...node.outputs]) values.compile(binding.schema);
      for (const binding of node.inputs) if (Object.hasOwn(binding, 'value')) values.check(binding.schema, binding.value, 'INVALID_TYPED_INPUT', `${node.id}.${binding.name}`);
      if (results[node.id]) for (const binding of node.outputs) values.check(binding.schema, results[node.id].outputs?.[binding.name], 'INVALID_TYPED_OUTPUT', `${node.id}.${binding.name}`);
    }
    values.compile(manifest.spec.output.schema);
  }
  if (managed) accounting.pending ??= {};
  let sequence = events.length;
  let terminal = managed && Object.keys(accounting.pending).length
    ? { code: 'MANAGED_RECONCILIATION_REQUIRED', reason: 'Managed Flow checkpoint has an invocation awaiting owner reconciliation.' }
    : undefined;

  async function emit(type, payload = {}) {
    const event = { sequence: ++sequence, type, graphId, runId, ...clone(payload) };
    events.push(event);
    await options.onEvent?.(clone(event));
  }

  function checkpoint() {
    return {
      schemaVersion: 'flow.aiwg.io/v1alpha1',
      kind: 'FlowGraphCheckpoint',
      graphId,
      runId,
      state: clone(state),
      results: clone(results),
      receipts: clone(receipts),
      completed: [...completed].sort((a, b) => nodeOrder.get(a) - nodeOrder.get(b)),
      failed: [...failed].sort((a, b) => nodeOrder.get(a) - nodeOrder.get(b)),
      skipped: [...skipped].sort((a, b) => nodeOrder.get(a) - nodeOrder.get(b)),
      activatedRoutes: [...activatedRoutes].sort(),
      routeActivations: clone(routeActivations),
      routeProgress: clone(routeProgress),
      reactivatedNodes: [...reactivatedNodes].sort(),
      joins: clone(joinState),
      realized: clone(realized),
      ...(managed ? { accounting: clone(accounting) } : {}),
      evidence: clone(evidence),
      events: clone(events),
    };
  }

  async function persist() {
    await options.saveCheckpoint?.(checkpoint());
  }

  function tracePayload(node, inputs, outputs) {
    const base = {
      inputDigest: digest(inputs),
      outputDigest: digest(outputs),
    };
    if (manifest.spec.trace.level === 'bindings') {
      return { ...base, inputNames: Object.keys(inputs).sort(), outputNames: Object.keys(outputs).sort() };
    }
    if (manifest.spec.trace.level === 'full-io') {
      return {
        ...base,
        inputs: redact(inputs, manifest.spec.trace.redact),
        outputs: redact(outputs, manifest.spec.trace.redact),
      };
    }
    return base;
  }

  function inputsFor(node) {
    return Object.fromEntries(node.inputs.map((binding) => {
      if (binding.from) return [binding.name, clone(resultOutput(results, binding.from))];
      if (binding.state) return [binding.name, clone(state[binding.state])];
      return [binding.name, clone(binding.value)];
    }));
  }

  const enforceAuthority = createFlowAuthority(manifest, options, evidence, FlowGraphRuntimeError);

  function validateInputs(node, inputs) {
    if (!managed) return assertNoWorkerValues(inputs);
    for (const binding of node.inputs) values.check(binding.schema, inputs[binding.name], 'INVALID_TYPED_INPUT', `${node.id}.${binding.name}`);
  }

  function requestedResources(node) {
    const requested = clone(node.ceilings ?? manifest.spec.ceilings);
    if (managed) for (const key of ['tokens', 'costUsd', 'timeMs']) {
      const remaining = manifest.spec.ceilings[key] - accounting.known[key] - accounting.reserved[key];
      if (remaining <= 0) throw new FlowGraphRuntimeError('RESOURCE_CEILING_EXHAUSTED', `Managed Flow has no remaining ${key} allowance.`);
      requested[key] = Math.min(requested[key], remaining);
    }
    return requested;
  }

  async function chargeAttempt(node, invocationId, source, requested) {
    if (accounting.attempts[invocationId]) return accounting.attempts[invocationId].usage;
    let usage = usageOf(source, true);
    try { assertUsage(usage); } catch { usage = { tokens: null, costUsd: null, timeMs: null }; }
    const reserved = {};
    for (const key of ['tokens', 'costUsd', 'timeMs']) {
      reserved[key] = usage[key] === null ? requested[key] : 0;
      accounting.known[key] += usage[key] ?? 0;
      accounting.reserved[key] += reserved[key];
      realized[key] = realized[key] === null || usage[key] === null ? null : realized[key] + usage[key];
    }
    accounting.attempts[invocationId] = { nodeId: node.id, usage, reserved };
    realized.nodeRuns += 1;
    const nodeUsage = evidence.nodes[node.id]?.resources ?? emptyUsage();
    addUsage(nodeUsage, usage);
    evidence.nodes[node.id] = { ...(evidence.nodes[node.id] ?? {}), resources: nodeUsage };
    const branchId = node.track ?? 'default';
    const branchUsage = evidence.branches[branchId] ?? emptyUsage();
    addUsage(branchUsage, usage);
    evidence.branches[branchId] = branchUsage;
    await persist();
    return usage;
  }

  function checkChargedCeilings(node, usage, requested) {
    for (const key of ['tokens', 'costUsd', 'timeMs']) if (usage[key] !== null && usage[key] > requested[key]) {
      throw new FlowGraphRuntimeError('RESOURCE_CEILING_WOULD_EXCEED', `Node '${node.id}' exceeded its ${key} allowance.`);
    }
  }

  function applyOutputs(node, outputs) {
    if (managed) for (const binding of node.outputs) values.check(binding.schema, outputs[binding.name], 'INVALID_TYPED_OUTPUT', `${node.id}.${binding.name}`);
    for (const binding of node.outputs) {
      if (!Object.prototype.hasOwnProperty.call(outputs, binding.name)) {
        throw new FlowGraphRuntimeError('MISSING_TYPED_OUTPUT', `Node '${node.id}' did not return output '${binding.name}'.`);
      }
      if (binding.state) {
        const field = stateFields.get(binding.state);
        const reduced = reduceValue(state[binding.state], outputs[binding.name], field.reducer);
        if (managed) values.check(field.schema, reduced, 'INVALID_TYPED_STATE', binding.state);
        state[binding.state] = reduced;
      }
    }
  }

  async function invoke(node, activationTick, iteration = 1) {
    await enforceAuthority(node);
    const inputs = inputsFor(node);
    validateInputs(node, inputs);
    const inputSnapshot = clone(inputs);
    const nodeRunId = `${runId}:${node.id}:${activationTick}:${iteration}`;
    const invocationKey = node.idempotencyKey
      ? `${graphId}:${node.id}:${digest(node.idempotencyKey).slice(7, 23)}:${digest(inputSnapshot).slice(7, 23)}`
      : nodeRunId;
    const existing = receipts[invocationKey];
    const sideEffect = evidence.sideEffects[node.id] ?? {
      mode: node.sideEffectMode,
      attempts: 0,
      duplicateDetections: 0,
      suppressions: 0,
      successes: 0,
    };
    evidence.sideEffects[node.id] = sideEffect;
    if (existing && ['idempotent', 'exactly-once'].includes(node.sideEffectMode)) {
      sideEffect.attempts += 1;
      sideEffect.duplicateDetections += 1;
      sideEffect.suppressions += 1;
      await emit('node-replayed', { nodeId: node.id, nodeRunId, activation: activationTick, invocationKey, duplicateDetected: true, suppressed: true });
      results[node.id] = clone(existing.result);
      completed.add(node.id);
      return existing.result;
    }

    const attempts = (node.retry?.limit ?? 0) + 1;
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      sideEffect.attempts += 1;
      await emit('node-started', {
        nodeId: node.id,
        nodeRunId,
        activation: activationTick,
        iteration,
        attempt,
        invocationKey,
        inputDigest: digest(inputSnapshot),
      });
      let requested;
      try {
        requested = requestedResources(node);
        if (managed) {
          accounting.pending[`${nodeRunId}:${attempt}`] = { nodeId: node.id, requestedResources: clone(requested) };
          await persist();
        }
        const raw = await options.invokeNode({
          graphId,
          runId,
          node: clone(node),
          nodeRunId,
          activationId: `${runId}:activation:${activationTick}`,
          activation: activationTick,
          iteration,
          attempt,
          invocationKey,
          inputs: inputSnapshot,
          state: clone(state),
          requestedResources: requested,
          ...(managed ? { runResources: clone(manifest.spec.ceilings), invocationId: `${nodeRunId}:${attempt}` } : {}),
        });
        if (!managed) assertNoWorkerResult(raw);
        const outputs = clone(raw?.outputs ?? {});
        const usage = managed ? await chargeAttempt(node, `${nodeRunId}:${attempt}`, raw, requested) : usageOf(raw);
        assertUsage(usage);
        if (managed) checkChargedCeilings(node, usage, requested);
        if (!managed) for (const key of ['tokens', 'costUsd', 'timeMs']) {
          const graphCeiling = manifest.spec.ceilings[key];
          const nodeCeiling = node.ceilings?.[key] ?? graphCeiling;
          if (usage[key] > nodeCeiling || realized[key] + usage[key] > graphCeiling) {
            throw new FlowGraphRuntimeError(
              'RESOURCE_CEILING_WOULD_EXCEED',
              `Node '${node.id}' would exceed its ${key} ceiling.`,
              { graphCeiling, nodeCeiling, realized: realized[key], attempted: usage[key] },
            );
          }
        }
        applyOutputs(node, outputs);
        if (!managed) {
          realized.nodeRuns += 1;
          realized.tokens += usage.tokens;
          realized.costUsd += usage.costUsd;
          realized.timeMs += usage.timeMs;
          const nodeUsage = evidence.nodes[node.id]?.resources ?? emptyUsage();
          addUsage(nodeUsage, usage);
          const branchId = node.track ?? 'default';
          const branchUsage = evidence.branches[branchId] ?? emptyUsage();
          addUsage(branchUsage, usage);
          evidence.branches[branchId] = branchUsage;
          evidence.nodes[node.id] = { ...(evidence.nodes[node.id] ?? {}), resources: nodeUsage };
        }
        evidence.nodes[node.id] = {
          ...(evidence.nodes[node.id] ?? {}),
          scope: mergedScopeEvidence(
            evidence.nodes[node.id]?.scope,
            node.scope,
            publicTouches(raw?.observedTouches),
            raw?.observationComplete === true,
          ),
        };
        sideEffect.successes += 1;
        const result = {
          outputs,
          usage,
          ...(raw?.score === undefined ? {} : { score: raw.score }),
          ...(raw?.citations === undefined ? {} : { citations: clone(raw.citations) }),
          adapter: options.adapterId ?? 'unspecified',
          ...(managed ? { admission: clone(raw?.managedAdmission) } : {}),
          nodeRunId,
          invocationKey,
        };
        results[node.id] = result;
        completed.add(node.id);
        failed.delete(node.id);
        if (['idempotent', 'exactly-once'].includes(node.sideEffectMode)) receipts[invocationKey] = { result: clone(result) };
        await emit('node-completed', {
          nodeId: node.id,
          nodeRunId,
          activation: activationTick,
          iteration,
          attempt,
          invocationKey,
          usage,
          score: raw?.score,
          citations: clone(raw?.citations),
          ...tracePayload(node, inputSnapshot, outputs),
        });
        if (managed) delete accounting.pending[`${nodeRunId}:${attempt}`];
        await persist();
        return result;
      } catch (error) {
        if (managed && requested) {
          await chargeAttempt(node, `${nodeRunId}:${attempt}`, error, requested);
          delete accounting.pending[`${nodeRunId}:${attempt}`];
        }
        lastError = error;
        await emit('node-attempt-failed', {
          nodeId: node.id,
          nodeRunId,
          activation: activationTick,
          iteration,
          attempt,
          invocationKey,
          code: error?.code ?? 'ADAPTER_FAILURE',
          message: error instanceof Error ? error.message : String(error),
        });
        const retryClass = error?.code === 'TIMEOUT' ? 'timeout'
          : error?.code === 'RATE_LIMIT' ? 'rate-limit'
            : 'failure';
        if (attempt < attempts && node.retry?.on.includes(retryClass)) realized.retries += 1;
        else break;
      }
    }
    failed.add(node.id);
    completed.delete(node.id);
    throw lastError;
  }

  function predicateContext(extra = {}) {
    return {
      state: clone(state),
      results: clone(results),
      metrics: { ...clone(realized), ...extra },
    };
  }

  async function routeFrom(nodeId) {
    for (const [index, route] of manifest.spec.routes.entries()) {
      if (route.from !== nodeId) continue;
      const routeId = route.id ?? `route-${index}-${route.from}-${route.to}`;
      const predicateMatched = await evaluatePredicate(route.when, predicateContext());
      const guardMatched = predicateMatched && await evaluatePredicate(route.guard, predicateContext({
        routeIterations: Number(routeActivations[routeId] ?? 0),
      }));
      const exhausted = Boolean(
        guardMatched
        && route.maxIterations
        && Number(routeActivations[routeId] ?? 0) >= route.maxIterations,
      );
      const active = guardMatched && !exhausted;
      let progress;
      if (active && route.progress) {
        const current = state[route.progress.state];
        const previous = routeProgress[routeId];
        const progressed = previous === undefined || current < previous;
        progress = { state: route.progress.state, direction: 'decrease', previous, current, progressed };
        routeProgress[routeId] = current;
        if (!progressed) {
          terminal = {
            code: 'CYCLE_PROGRESS_STALLED',
            reason: `route '${routeId}' progress state '${route.progress.state}' did not strictly decrease (${previous} -> ${current})`,
          };
        }
      }
      if (active && !terminal) {
        activatedRoutes.add(routeId);
        routeActivations[routeId] = Number(routeActivations[routeId] ?? 0) + 1;
        // Guarded finite routes are explicit feedback edges. A completed target
        // must become runnable again; ordinary DAG routes stay single-shot.
        if (route.guard || route.maxIterations || reactivatedNodes.has(nodeId)) {
          completed.delete(route.to);
          failed.delete(route.to);
          skipped.delete(route.to);
          reactivatedNodes.add(route.to);
        }
      }
      await emit('route-evaluated', {
        routeId,
        edgeId: `${graphId}:route:${routeId}:${route.from}->${route.to}`,
        from: route.from,
        to: route.to,
        active: Boolean(active),
        predicateMatched: Boolean(predicateMatched),
        guardMatched: Boolean(guardMatched),
        exhausted,
        iteration: Number(routeActivations[routeId] ?? 0),
        maxIterations: route.maxIterations,
        progress,
      });
      if (terminal?.code === 'CYCLE_PROGRESS_STALLED') return;
      if (exhausted) {
        terminal = {
          code: 'CYCLE_GUARD_EXHAUSTED',
          reason: `route '${routeId}' exhausted maxIterations ${route.maxIterations}`,
        };
        return;
      }
    }
  }

  function phaseIndex(node) {
    if (!node.phase) return 0;
    const phases = [...new Set(manifest.spec.nodes.map((item) => item.phase).filter(Boolean))];
    return phases.indexOf(node.phase) + 1;
  }

  function incomingRoutes(nodeId) {
    return manifest.spec.routes.map((route, index) => ({ route, index })).filter(({ route }) => route.to === nodeId);
  }

  function joinFor(nodeId) {
    return manifest.spec.joins.find((join) => join.target === nodeId);
  }

  function recordJoinEvidence(join) {
    if (!join) return;
    const resources = join.sources.reduce((total, source) => {
      const usage = evidence.nodes[source]?.resources ?? emptyUsage();
      total.runs += usage.runs;
      for (const key of ['tokens', 'costUsd', 'timeMs']) total[key] = total[key] === null || usage[key] === null ? null : total[key] + usage[key];
      return total;
    }, emptyUsage());
    evidence.joins[join.id] = { sources: [...join.sources], resources };
  }

  function ordinaryJoinReady(join) {
    const succeeded = join.sources.filter((id) => completed.has(id)).length;
    if (join.policy.mode === 'all') return succeeded === join.sources.length;
    if (join.policy.mode === 'quorum') return succeeded >= join.policy.quorum;
    if (join.policy.mode === 'fixed') return succeeded >= join.policy.count;
    return false;
  }

  function nodeReady(node) {
    if (completed.has(node.id) || failed.has(node.id) || skipped.has(node.id)) return false;
    const join = joinFor(node.id);
    if (join && !['lcm', 'converged', 'budget'].includes(join.policy.mode)) return ordinaryJoinReady(join);
    if (join) return false;
    if ((node.dependsOn ?? []).some((id) => !completed.has(id) && !skipped.has(id))) return false;
    const incoming = incomingRoutes(node.id);
    // Entry nodes run once before any feedback edge into them is activated.
    if (manifest.spec.entry.includes(node.id) && !results[node.id]) return true;
    if (incoming.length === 0) return manifest.spec.entry.includes(node.id) || (node.dependsOn?.length ?? 0) > 0;
    return incoming.some(({ route, index }) => activatedRoutes.has(route.id ?? `route-${index}-${route.from}-${route.to}`));
  }

  async function activation(nodesToRun, tick, iteration = 1) {
    realized.activations = Math.max(realized.activations, tick);
    const parallelEligible = nodesToRun.length > 1
      && typeof options.parallelDispatch === 'function'
      && nodesToRun.every((node) => node.sideEffectMode === 'none' && (node.retry?.limit ?? 0) === 0);
    realized.maxConcurrency = Math.max(realized.maxConcurrency, parallelEligible ? nodesToRun.length : Math.min(1, nodesToRun.length));
    await emit('activation-started', {
      activation: tick,
      nodeIds: nodesToRun.map((node) => node.id),
      inputSnapshotDigests: Object.fromEntries(nodesToRun.map((node) => [node.id, digest(inputsFor(node))])),
    });
    for (const node of nodesToRun) recordJoinEvidence(joinFor(node.id));
    let settled;
    if (parallelEligible && managed) {
      for (const node of nodesToRun) await enforceAuthority(node);
      const requests = nodesToRun.map((node) => {
        const inputs = inputsFor(node);
        validateInputs(node, inputs);
        const requested = requestedResources(node);
        for (const key of ['tokens', 'costUsd', 'timeMs']) {
          const share = (manifest.spec.ceilings[key] - accounting.known[key] - accounting.reserved[key]) / nodesToRun.length;
          requested[key] = Math.min(requested[key], key === 'costUsd' ? share : Math.floor(share));
          if (requested[key] <= 0) throw new FlowGraphRuntimeError('RESOURCE_CEILING_EXHAUSTED', `Managed parallel Flow has no remaining ${key} allowance.`);
        }
        const nodeRunId = `${runId}:${node.id}:${tick}:${iteration}`;
        return { graphId, runId, node: clone(node), nodeRunId, activationId: `${runId}:activation:${tick}`,
          activation: tick, iteration, attempt: 1, invocationKey: nodeRunId,
          inputs: clone(inputs), state: clone(state), requestedResources: requested, runResources: clone(manifest.spec.ceilings), invocationId: `${nodeRunId}:1` };
      });
      for (const request of requests) accounting.pending[`${request.nodeRunId}:1`] = { nodeId: request.node.id, requestedResources: clone(request.requestedResources) };
      await persist();
      const observations = new Map();
      const pending = new Map();
      let rawResults;
      let dispatchError;
      for (const request of requests) await emit('node-started', {
        nodeId: request.node.id, nodeRunId: request.nodeRunId, activation: tick, iteration,
        attempt: 1, invocationKey: request.invocationKey, inputDigest: digest(request.inputs), delegated: 'parallel-dispatch',
      });
      try {
        rawResults = await options.parallelDispatch(clone(requests), (request) => {
          const original = requests.find((item) => item.nodeRunId === request.nodeRunId);
          if (!original || pending.has(original.nodeRunId)) throw new FlowGraphRuntimeError('PARALLEL_RESULT_MISMATCH', 'Managed parallel dispatch must invoke each planned request once.');
          const call = Promise.resolve().then(() => options.invokeNode(clone(original))).then(
            (raw) => { observations.set(original.nodeRunId, { raw }); return raw; },
            (error) => { observations.set(original.nodeRunId, { error }); throw error; },
          );
          pending.set(original.nodeRunId, call);
          return call;
        });
        if (!Array.isArray(rawResults) || rawResults.length !== requests.length || pending.size !== requests.length) {
          throw new FlowGraphRuntimeError('PARALLEL_RESULT_MISMATCH', 'Managed parallelDispatch must invoke every planned request through the supplied execution owner.');
        }
      } catch (error) { dispatchError = error; }
      // Promise.all may reject before other dispatched attempts settle. Retain
      // every observed spend before returning control to the graph owner.
      await Promise.allSettled([...pending.values()]);
      settled = [];
      for (const [index, request] of requests.entries()) {
        const node = nodesToRun[index];
        const observation = observations.get(request.nodeRunId);
        const raw = observation?.raw;
        const error = observation?.error ?? (!raw ? dispatchError : undefined);
        const usage = await chargeAttempt(node, `${request.nodeRunId}:1`, raw ?? error, request.requestedResources);
        delete accounting.pending[`${request.nodeRunId}:1`];
        try {
          if (error) throw error;
          checkChargedCeilings(node, usage, request.requestedResources);
          const outputs = clone(raw?.outputs ?? {});
          applyOutputs(node, outputs);
          const result = { outputs, usage, adapter: options.adapterId ?? 'unspecified', admission: clone(raw?.managedAdmission), nodeRunId: request.nodeRunId, invocationKey: request.invocationKey,
            ...(raw?.score === undefined ? {} : { score: raw.score }), ...(raw?.citations === undefined ? {} : { citations: clone(raw.citations) }) };
          evidence.nodes[node.id].scope = mergedScopeEvidence(evidence.nodes[node.id]?.scope, node.scope, publicTouches(raw?.observedTouches), raw?.observationComplete === true);
          results[node.id] = result;
          completed.add(node.id);
          failed.delete(node.id);
          await emit('node-completed', { nodeId: node.id, nodeRunId: request.nodeRunId, activation: tick, iteration,
            attempt: 1, invocationKey: request.invocationKey, delegated: 'parallel-dispatch', usage, ...tracePayload(node, request.inputs, outputs) });
          settled.push({ node, result });
        } catch (error) {
          failed.add(node.id);
          completed.delete(node.id);
          settled.push({ node, error });
        }
      }
      await persist();
    } else if (parallelEligible) {
      for (const node of nodesToRun) await enforceAuthority(node);
      const requests = nodesToRun.map((node) => {
        const inputs = inputsFor(node);
        validateInputs(node, inputs);
        const nodeRunId = `${runId}:${node.id}:${tick}:${iteration}`;
        return {
          graphId,
          runId,
          node: clone(node),
          nodeRunId,
          activationId: `${runId}:activation:${tick}`,
          activation: tick,
          iteration,
          attempt: 1,
          invocationKey: nodeRunId,
          inputs: clone(inputs),
          state: clone(state),
          requestedResources: clone(node.ceilings ?? manifest.spec.ceilings),
        };
      });
      for (const request of requests) {
        await emit('node-started', {
          nodeId: request.node.id,
          nodeRunId: request.nodeRunId,
          activation: tick,
          iteration,
          attempt: 1,
          invocationKey: request.invocationKey,
          inputDigest: digest(request.inputs),
          delegated: 'parallel-dispatch',
        });
      }
      try {
        const rawResults = await options.parallelDispatch(clone(requests), options.invokeNode);
        if (Array.isArray(rawResults)) rawResults.forEach(assertNoWorkerResult);
        if (!Array.isArray(rawResults) || rawResults.length !== requests.length) {
          throw new FlowGraphRuntimeError('PARALLEL_RESULT_MISMATCH', 'parallelDispatch must return one ordered result per request.');
        }
        settled = [];
        for (let index = 0; index < requests.length; index += 1) {
          const request = requests[index];
          const node = nodesToRun[index];
          const raw = rawResults[index];
          const outputs = clone(raw?.outputs ?? {});
          const usage = usageOf(raw);
          assertUsage(usage);
          for (const key of ['tokens', 'costUsd', 'timeMs']) {
            const graphCeiling = manifest.spec.ceilings[key];
            const nodeCeiling = node.ceilings?.[key] ?? graphCeiling;
            if (usage[key] > nodeCeiling || realized[key] + usage[key] > graphCeiling) {
              throw new FlowGraphRuntimeError('RESOURCE_CEILING_WOULD_EXCEED', `Node '${node.id}' would exceed its ${key} ceiling.`);
            }
          }
          applyOutputs(node, outputs);
          realized.nodeRuns += 1;
          realized.tokens += usage.tokens;
          realized.costUsd += usage.costUsd;
          realized.timeMs += usage.timeMs;
          const nodeUsage = evidence.nodes[node.id]?.resources ?? emptyUsage();
          addUsage(nodeUsage, usage);
          const branchId = node.track ?? 'default';
          const branchUsage = evidence.branches[branchId] ?? emptyUsage();
          addUsage(branchUsage, usage);
          evidence.branches[branchId] = branchUsage;
          evidence.nodes[node.id] = {
            ...(evidence.nodes[node.id] ?? {}),
            resources: nodeUsage,
            scope: mergedScopeEvidence(
              evidence.nodes[node.id]?.scope,
              node.scope,
              publicTouches(raw?.observedTouches),
              raw?.observationComplete === true,
            ),
          };
          const result = {
            outputs,
            usage,
            ...(raw?.score === undefined ? {} : { score: raw.score }),
            ...(raw?.citations === undefined ? {} : { citations: clone(raw.citations) }),
            adapter: options.adapterId ?? 'unspecified',
            nodeRunId: request.nodeRunId,
            invocationKey: request.invocationKey,
          };
          results[node.id] = result;
          completed.add(node.id);
          await emit('node-completed', {
            nodeId: node.id,
            nodeRunId: request.nodeRunId,
            activation: tick,
            iteration,
            attempt: 1,
            invocationKey: request.invocationKey,
            delegated: 'parallel-dispatch',
            usage,
            score: raw?.score,
            citations: clone(raw?.citations),
            ...tracePayload(node, request.inputs, outputs),
          });
          settled.push({ node, result });
        }
        await persist();
      } catch (error) {
        settled = nodesToRun.map((node) => ({ node, error }));
      }
    } else {
      settled = [];
      for (const node of nodesToRun) {
        try {
          settled.push({ node, result: await invoke(node, tick, iteration) });
        } catch (error) {
          settled.push({ node, error });
        }
      }
    }
    for (const item of settled) {
      if (item.result) await routeFrom(item.node.id);
      else await handleFailure(item.node, item.error, tick);
    }
    await emit('activation-completed', { activation: tick, nodeIds: nodesToRun.map((node) => node.id) });
  }

  async function handleFailure(node, error, tick) {
    if (error?.code === 'APPROVAL_REQUIRED') {
      failed.delete(node.id);
      await emit('run-paused', { nodeId: node.id, activation: tick, code: error.code, reason: error.message });
      terminal = { code: error.code, reason: error.message, status: 'paused' };
      await persist();
      return;
    }
    if (error?.code === 'APPROVAL_CANCELLED') {
      failed.delete(node.id);
      await emit('run-cancelled', { nodeId: node.id, activation: tick, code: error.code, reason: error.message });
      terminal = { code: error.code, reason: error.message, status: 'cancelled' };
      await persist();
      return;
    }
    if (manifest.spec.failure.onNodeFailure === 'skip-optional' && node.optional === true) {
      failed.delete(node.id);
      skipped.add(node.id);
      await emit('node-skipped', { nodeId: node.id, activation: tick, reason: 'optional node failed' });
      return;
    }
    if (manifest.spec.failure.onNodeFailure === 'continue') {
      failed.delete(node.id);
      skipped.add(node.id);
      await emit('node-skipped', { nodeId: node.id, activation: tick, reason: 'failure policy continued' });
      return;
    }
    const fallbackId = node.fallback?.node;
    if (fallbackId && manifest.spec.failure.onNodeFailure === 'fallback') {
      const fallback = nodes.get(fallbackId);
      await emit('fallback-started', { nodeId: node.id, fallbackNodeId: fallbackId, activation: tick });
      await invoke(fallback, tick, 1);
      completed.add(node.id);
      return;
    }
    await emit('node-failed', {
      nodeId: node.id,
      activation: tick,
      code: error?.code ?? 'NODE_FAILED',
      message: error instanceof Error ? error.message : String(error),
    });
    if (manifest.spec.failure.onNodeFailure === 'fail' || failed.size > manifest.spec.failure.maxFailures) {
      terminal = { code: error?.code ?? 'NODE_FAILED', reason: `node '${node.id}' failed` };
    }
  }

  async function temporalJoin(join) {
    const sourceNodes = join.sources.map((id) => nodes.get(id));
    const policy = join.policy;
    const maximum = policy.mode === 'lcm'
      ? policy.periods.reduce((value, next) => {
          const gcd = (a, b) => (b ? gcd(b, a % b) : a);
          return (value * next) / gcd(value, next);
        }, 1)
      : policy.maxIterations ?? manifest.spec.ceilings.activations;
    let satisfied = false;
    let reason = 'ceiling';
    for (let iteration = 1; iteration <= maximum && !terminal; iteration += 1) {
      const tick = realized.activations + 1;
      if (tick > manifest.spec.ceilings.activations) break;
      let activeSources = sourceNodes;
      if (policy.mode === 'lcm') activeSources = sourceNodes.filter((_, index) => iteration % policy.periods[index] === 0);
      if (activeSources.length > 0) {
        for (const source of activeSources) {
          completed.delete(source.id);
          failed.delete(source.id);
        }
        await activation(activeSources, tick, iteration);
      } else {
        realized.activations = tick;
        await emit('activation-completed', { activation: tick, nodeIds: [] });
      }
      if (policy.mode === 'lcm') {
        satisfied = activeSources.length === sourceNodes.length;
        reason = satisfied ? `lcm:${maximum}` : 'period-pending';
      } else if (policy.mode === 'converged') {
        satisfied = Boolean(await evaluatePredicate(policy.predicate, predicateContext({ iteration })));
        reason = satisfied ? 'converged' : 'threshold-not-met';
      } else {
        satisfied = realized.costUsd >= policy.maxCostUsd;
        reason = satisfied ? 'budget-reached' : 'budget-available';
      }
      await emit('join-evaluated', {
        joinId: join.id,
        edgeIds: join.sources.map((source) => `${graphId}:join:${join.id}:${source}->${join.target}`),
        activation: realized.activations,
        iteration,
        policy: policy.mode,
        satisfied,
        reason,
        resources: join.sources.reduce((total, source) => {
          const usage = evidence.nodes[source]?.resources ?? emptyUsage();
          total.runs += usage.runs;
          for (const key of ['tokens', 'costUsd', 'timeMs']) total[key] = total[key] === null || usage[key] === null ? null : total[key] + usage[key];
          return total;
        }, emptyUsage()),
      });
      if (satisfied) break;
      const exceeded = resourcesExceeded(realized, manifest.spec.ceilings);
      if (exceeded) break;
    }
    const joinResources = join.sources.reduce((total, source) => {
      const usage = evidence.nodes[source]?.resources ?? emptyUsage();
      total.runs += usage.runs;
      for (const key of ['tokens', 'costUsd', 'timeMs']) total[key] = total[key] === null || usage[key] === null ? null : total[key] + usage[key];
      return total;
    }, emptyUsage());
    evidence.joins[join.id] = { sources: [...join.sources], resources: joinResources };
    joinState[join.id] = { satisfied, reason, activation: realized.activations, resources: joinResources };
    if (satisfied) {
      const target = nodes.get(join.target);
      completed.delete(target.id);
      try {
        await invoke(target, realized.activations, 1);
        await routeFrom(target.id);
      } catch (error) {
        await handleFailure(target, error, realized.activations);
      }
    } else if (!terminal) {
      terminal = { code: 'JOIN_CEILING_EXHAUSTED', reason: `join '${join.id}' stopped: ${reason}` };
    }
  }

  await emit('run-started', {
    requestedResources: clone(manifest.spec.ceilings),
    adapter: options.adapterId ?? 'unspecified',
    resumed: Boolean(options.resumeFrom),
  });
  if (options.operatorAction === 'stop') {
    await emit('run-cancelled', { code: 'OPERATOR_STOPPED', reason: 'operator requested stop' });
    terminal = { code: 'OPERATOR_STOPPED', reason: 'operator requested stop', status: 'cancelled' };
  }

  const temporal = manifest.spec.joins.filter((join) => ['lcm', 'converged', 'budget'].includes(join.policy.mode));
  const temporalSources = new Set(temporal.flatMap((join) => join.sources));
  for (const join of temporal) {
    if (join.sources.some((id) => completed.has(id)) && joinState[join.id]?.satisfied) continue;
    await temporalJoin(join);
  }

  while (!terminal) {
    const candidates = manifest.spec.nodes
      .filter((node) => !temporalSources.has(node.id) && nodeReady(node))
      .sort((left, right) => phaseIndex(left) - phaseIndex(right)
        || String(left.track ?? '').localeCompare(String(right.track ?? ''))
        || nodeOrder.get(left.id) - nodeOrder.get(right.id));
    if (candidates.length === 0) break;
    const minimumPhase = phaseIndex(candidates[0]);
    const wave = candidates.filter((node) => phaseIndex(node) === minimumPhase).slice(0, manifest.spec.ceilings.concurrency);
    const nextTick = realized.activations + 1;
    if (nextTick > manifest.spec.ceilings.activations) {
      terminal = { code: 'ACTIVATION_CEILING_EXHAUSTED', reason: 'activation ceiling exhausted' };
      break;
    }
    await activation(wave, nextTick);
    const exceeded = resourcesExceeded(realized, manifest.spec.ceilings);
    const workRemains = manifest.spec.nodes.some((node) => !completed.has(node.id) && !failed.has(node.id) && !skipped.has(node.id));
    if (exceeded && workRemains) terminal = { code: 'RESOURCE_CEILING_EXHAUSTED', reason: `${exceeded} ceiling exhausted` };
  }

  const unresolved = manifest.spec.nodes.filter((node) => !completed.has(node.id) && !failed.has(node.id) && !skipped.has(node.id));
  if (!terminal && unresolved.length > 0) {
    terminal = { code: 'NO_RUNNABLE_NODES', reason: `no runnable nodes remain: ${unresolved.map((node) => node.id).join(', ')}` };
  }

  const output = resultOutput(results, manifest.spec.output.from);
  if (managed && !terminal) {
    try { values.check(manifest.spec.output.schema, output, 'INVALID_TYPED_OUTPUT', manifest.spec.output.from); }
    catch (error) { terminal = { code: error.code, reason: error.message }; }
  }
  let status = terminal?.status ?? (terminal ? 'failed' : 'completed');
  if (terminal && !terminal.status && manifest.spec.failure.onNodeFailure === 'partial-synthesis') status = 'partial';
  const publicOutput = status === 'completed' && output !== undefined
    ? clone(output)
    : manifest.spec.output.mode === 'typed-terminal-failure'
      ? { code: terminal?.code ?? 'OUTPUT_UNAVAILABLE', stopReason: terminal?.reason ?? 'terminal output unavailable' }
      : status === 'partial'
        ? { partial: true, state: clone(state), stopReason: terminal.reason }
        : undefined;

  await emit('run-completed', {
    status,
    stopReason: terminal?.reason ?? 'completed',
    requestedResources: clone(manifest.spec.ceilings),
    realizedResources: clone(realized),
    evidence: clone(evidence),
    outputDigest: publicOutput === undefined ? undefined : digest(publicOutput),
  });
  await persist();

  return {
    schemaVersion: 'flow.aiwg.io/v1alpha1',
    kind: 'FlowGraphRunReport',
    graphId,
    runId,
    status,
    stopReason: terminal?.reason ?? 'completed',
    output: publicOutput,
    state: clone(state),
    results: clone(results),
    requestedResources: clone(manifest.spec.ceilings),
    realizedResources: clone(realized),
    ...(managed ? { accounting: clone(accounting) } : {}),
    evidence: clone(evidence),
    trace: events,
    checkpoint: checkpoint(),
  };
}
