import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dump as dumpYaml, load as loadYaml } from 'js-yaml';
import { describe, expect, it, vi } from 'vitest';
import {
  admitEntry, artifactPin, assertDecisionWriterVersion, convertDecisionDefinitionV1Alpha1, DECISION_CHANGED_SEMANTICS, DEFAULT_ENTRY_LIMITS,
  EntryAdmissionError, evaluateDecisionRuleset, JevDecisionAdapter, LlmSubagentDecisionAdapter, MemoryDecisionReceiptStore, parseCompressedDecisionJson, parseDecisionJson, parseDecisionYaml, readDecisionDocumentForRollback, validateDefinition, validateDecisionDocument,
  type DecisionAdapter, type DecisionBinding, type DecisionRuleset, type DecisionResult,
  type DecisionDefinition, type DecisionAdapterRequest,
} from '../../../src/decision/index.js';
import { parseDecisionDoc } from '../../../src/artifacts/index-builder.js';

const old = (): DecisionDefinition => JSON.parse(readFileSync('agentic/code/addons/decision-engine/examples/decision-category.json', 'utf8')) as DecisionDefinition;
const structured = (): DecisionDefinition => {
  const value = convertDecisionDefinitionV1Alpha1(old()).definition;
  value.spec.question = { task: 'classify', context: ['plain', null, { weight: 1, active: true }] };
  if (value.spec.answer.kind === 'choice') value.spec.answer.options[0]!.description = { reason: 'documentation', hints: [null, 'guide'] };
  return value;
};
const request = (definition: DecisionDefinition): DecisionAdapterRequest => ({
  alias: 'category', definition, input: { message: 'example' },
  target: { adapter: 'jev', adapterVersion: '1.0.0', model: 'fixture', credentialRef: 'fixture', requiredCapabilities: [], acceptance: { mode: 'typed-value' }, timeoutMs: 1000, retry: { maxRetries: 0, initialDelayMs: 0, maxDelayMs: 0 } },
  invocationId: 'structured-test', deadlineEpochMs: Date.now() + 1000,
  signal: new AbortController().signal, resolveCredential: async () => new TextEncoder().encode('token'),
});

describe('decision structured entry contract', () => {
  it('keeps v1alpha1 digests and converts explicitly to a new v1alpha2 digest', () => {
    const source = old();
    const before = artifactPin(source).digest;
    validateDefinition(source);
    const converted = convertDecisionDefinitionV1Alpha1(source);
    expect(converted.previousDigest).toBe(before);
    expect(converted.digest).not.toBe(before);
    expect(source.apiVersion).toBe('decision.aiwg.io/v1alpha1');
    expect(converted.definition.apiVersion).toBe('decision.aiwg.io/v1alpha2');
    validateDefinition(converted.definition);
  });

  it('round trips nested values through schema, canonical digest, JSON parser, and discovery', () => {
    const value = structured();
    validateDefinition(value);
    const source = JSON.stringify(value);
    expect(parseDecisionJson(source)).toEqual(value);
    expect(artifactPin(parseDecisionJson(source) as DecisionDefinition)).toEqual(artifactPin(value));
    expect(parseDecisionDoc(source, 'decision.json')).toMatchObject({ kind: 'DecisionDefinition' });
    const yaml = dumpYaml(value);
    expect(parseDecisionDoc(yaml, 'decision.yaml')).toMatchObject({ kind: 'DecisionDefinition' });
    expect(artifactPin(loadYaml(yaml) as DecisionDefinition).digest).toBe(artifactPin(value).digest);
    const reordered = structured();
    reordered.spec.question = { context: ['plain', null, { active: true, weight: 1 }], task: 'classify' };
    expect(artifactPin(reordered).digest).toBe(artifactPin(value).digest);
    const unicode = structured();
    unicode.spec.question = { 'é': { '漢': [0.000001, -0, true, null] }, '😀': 'café' };
    const unicodeReordered = structured();
    unicodeReordered.spec.question = { '😀': 'café', 'é': { '漢': [0.000001, 0, true, null] } };
    expect(artifactPin(unicode).digest).toBe(artifactPin(unicodeReordered).digest);
  });

  it.each([
    ['cycle', () => { const x: Record<string, unknown> = {}; x.self = x; return x; }],
    ['function', () => ({ value: () => 1 })],
    ['symbol', () => ({ [Symbol('key')]: 1 })],
    ['nonfinite', () => ({ value: Number.POSITIVE_INFINITY })],
    ['prototype', () => Object.create({ inherited: 'bad' })],
    ['unsafe-key', () => JSON.parse('{"__proto__":true}')],
    ['depth', () => { let x: unknown = 'leaf'; for (let i = 0; i < 34; i++) x = [x]; return x; }],
    ['property-count', () => Object.fromEntries(Array.from({ length: 4097 }, (_, i) => [`k${i}`, i]))],
    ['array-length', () => Array.from({ length: 4097 }, () => 1)],
    ['proxy', () => new Proxy({}, { get: () => { throw new Error('must not execute'); } })],
    ['array-getter', () => { const x = [1]; Object.defineProperty(x, 0, { get: () => { throw new Error('must not execute'); } }); return x; }],
    ['array-symbol', () => Object.assign([1], { [Symbol('key')]: true })],
    ['string-length', () => 'a'.repeat(65_537)],
  ] as const)('rejects %s before canonicalization', (_name, make) => {
    expect(() => admitEntry(make())).toThrow();
  });

  it('rejects duplicate JSON keys, unsupported fields, and primitive domain violations', () => {
    expect(() => parseDecisionJson('{"a":1,"a":2}')).toThrow(/duplicate/);
    const value = structured();
    (value.spec as Record<string, unknown>).state = { admin: true };
    expect(() => validateDefinition(value)).toThrow();
    delete (value.spec as Record<string, unknown>).state;
    if (value.spec.answer.kind === 'choice') value.spec.answer.options = value.spec.answer.options.slice(0, 1);
    expect(() => validateDefinition(value)).toThrow();
  });

  it('rejects YAML non-string keys, duplicates, and aliases before discovery', () => {
    expect(() => parseDecisionYaml('1: value\n')).toThrow(/non-string-key/);
    expect(() => parseDecisionYaml('entry: first\nentry: second\n')).toThrow(/duplicate/);
    expect(() => parseDecisionYaml('entry: &a value\nother: *a\n')).toThrow(/yaml-alias/);
    expect(parseDecisionDoc('1: value\n', 'decision.yaml')).toBeNull();
  });

  it('requires a nonempty explicit instruction at v1alpha2', () => {
    for (const question of [{}, [], null, true, 1]) {
      const value = structured();
      value.spec.question = question as DecisionDefinition['spec']['question'];
      expect(() => validateDefinition(value)).toThrow();
    }
  });

  it('rejects unsupported embedded schema keywords before execution', () => {
    const value = structured();
    value.spec.inputSchema = { type: 'object', executeExpression: 'state.admin = true' };
    expect(() => validateDefinition(value)).toThrow(/unsupported schema construct/);
  });

  it('keeps the structured Jev instruction and criteria as JSON values', async () => {
    const definition = structured();
    let body: Record<string, unknown> | undefined;
    const adapter = new JevDecisionAdapter({ fetch: vi.fn(async (_url, options) => {
      body = JSON.parse(String(options?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ answers: { category: { type: 'choice', choice: 'documentation', probabilities: { documentation: 1, runtime: 0, other: 0 }, confidence: 1 } }, model: 'fixture' }), { status: 200 });
    }) as typeof fetch });
    const observation = await adapter.evaluate(request(definition));
    const result = JSON.parse(readFileSync('agentic/code/addons/decision-engine/examples/result-category.json', 'utf8')) as DecisionResult;
    result.spec.uncertainty = observation.uncertainty;
    expect(() => validateDecisionDocument(result)).not.toThrow();
    const question = (body?.questions as Record<string, Record<string, unknown>>).category;
    expect(question.instructions).toEqual(definition.spec.question);
    expect((question.criteria as Record<string, unknown>).documentation).toEqual(definition.spec.answer.kind === 'choice' ? definition.spec.answer.options[0]?.description : null);
    expect(body?.state).toEqual({ message: 'example' });
    expect(body?.model).toBe('fixture');
  });

  it('passes structured values through the subagent prompt as JSON', async () => {
    const definition = structured();
    const worker = { metadata: { id: 'worker', version: '1.0.0' } };
    const workerPin = artifactPin(worker);
    let prompt = '';
    const adapter = new LlmSubagentDecisionAdapter({
      resolveWorker: async () => worker,
      runWorker: async task => { prompt = task.prompt; return { started: true, terminal: true, output: { status: 'abstained', reason: 'insufficient-information' } }; },
    });
    const req = request(definition);
    req.target = { ...req.target, adapter: 'llm-subagent', subagent: workerPin };
    await adapter.evaluate(req);
    const parsed = JSON.parse(prompt) as Record<string, unknown>;
    expect(parsed.question).toEqual(definition.spec.question);
    expect(parsed.answer).toEqual(definition.spec.answer);
  });

  it('enforces explicit byte limits before parsing', () => {
    expect(() => parseDecisionJson('"' + 'x'.repeat(DEFAULT_ENTRY_LIMITS.serializedBytes) + '"')).toThrow(/serialized-bytes/);
    expect(() => parseCompressedDecisionJson(gzipSync('"' + 'x'.repeat(DEFAULT_ENTRY_LIMITS.serializedBytes) + '"'))).toThrow(/decompressed-bytes/);
  });

  it('returns a typed nonretryable reason and counts for entry/time budgets', () => {
    const many = [Array.from({ length: 4096 }, () => 1), Array.from({ length: 4096 }, () => 1)];
    expect(() => admitEntry(many)).toThrowError(EntryAdmissionError);
    try { admitEntry(many); } catch (error) {
      expect(error).toMatchObject({ reasonCode: 'entry-count', counts: { entries: 8193 } });
      expect(String(error)).not.toContain('4096');
    }
    expect(() => admitEntry({ entry: 'safe' }, { ...DEFAULT_ENTRY_LIMITS, timeMs: -1 })).toThrow(/time-budget/);
    expect(() => admitEntry({ entry: 'safe' }, { ...DEFAULT_ENTRY_LIMITS, memoryBytes: 1 })).toThrow(/memory-budget/);
  });

  it('bounds canonicalization of many small properties and ignores author insertion order', () => {
    const properties = Object.fromEntries(Array.from({ length: 4090 }, (_, i) => [`k${i}`, i]));
    const reversed = Object.fromEntries(Object.entries(properties).reverse());
    expect(artifactPin({ metadata: { id: 'many', version: '1.0.0' }, properties }).digest)
      .toBe(artifactPin({ metadata: { id: 'many', version: '1.0.0' }, properties: reversed }).digest);
  });

  it('gates all changed-semantic writers and permits frozen rollback inspection', () => {
    const oldDefinition = old();
    const newDefinition = structured();
    for (const semantic of DECISION_CHANGED_SEMANTICS) {
      expect(() => assertDecisionWriterVersion(oldDefinition, semantic)).toThrow(/v1alpha2/);
      expect(() => assertDecisionWriterVersion(newDefinition, semantic)).not.toThrow();
    }
    const oldDigest = artifactPin(oldDefinition).digest;
    const newDigest = artifactPin(newDefinition).digest;
    expect(readDecisionDocumentForRollback(oldDefinition, 'execute').writable).toBe(true);
    expect(() => readDecisionDocumentForRollback(newDefinition, 'execute')).toThrow(/cannot execute/);
    const inspection = readDecisionDocumentForRollback(newDefinition, 'read-only');
    expect(inspection.writable).toBe(false);
    expect(Object.isFrozen(inspection.document)).toBe(true);
    expect(Object.isFrozen(inspection.document.spec)).toBe(true);
    expect(artifactPin(oldDefinition).digest).toBe(oldDigest);
    expect(artifactPin(newDefinition).digest).toBe(newDigest);
  });

  it('keeps v1alpha1 strict while dual readers accept v1alpha2 artifacts', () => {
    const definition = structured();
    validateDecisionDocument(definition);
    const oldVersion = structured(); oldVersion.apiVersion = 'decision.aiwg.io/v1alpha1';
    expect(() => validateDecisionDocument(oldVersion)).toThrow();
    for (const [file, kind] of [['ruleset.json', 'DecisionRuleset'], ['binding-jev.json', 'DecisionBinding']] as const) {
      const oldDoc = JSON.parse(readFileSync(`agentic/code/addons/decision-engine/examples/${file}`, 'utf8')) as { apiVersion: string; kind: string; spec: Record<string, unknown> };
      validateDecisionDocument(oldDoc);
      oldDoc.apiVersion = 'decision.aiwg.io/v1alpha2';
      validateDecisionDocument(oldDoc);
      expect(oldDoc.kind).toBe(kind);
      oldDoc.spec.structuredAcceptance = { override: true };
      expect(() => validateDecisionDocument(oldDoc)).toThrow();
    }
  });

  it('pre-admits malformed rulesets before digesting or dispatching', async () => {
    const ruleset = JSON.parse(readFileSync('agentic/code/addons/decision-engine/examples/ruleset.json', 'utf8')) as DecisionRuleset;
    (ruleset.spec as Record<string, unknown>).poison = ruleset;
    const adapter = { id: 'jev', version: '1.0.0', capabilities: vi.fn(), evaluate: vi.fn() } as unknown as DecisionAdapter;
    const result = await evaluateDecisionRuleset({
      ruleset, binding: JSON.parse(readFileSync('agentic/code/addons/decision-engine/examples/binding-jev.json', 'utf8')) as DecisionBinding,
      definitions: {}, input: { message: 'hello' }, runId: 'run', invocationId: 'bad-ruleset', adapters: { jev: adapter },
    });
    expect(result.spec.reason).toBe('invalid-definition');
    expect(adapter.evaluate).not.toHaveBeenCalled();
  });

  it('classifies cyclic input as invalid-input before dispatch', async () => {
    const input: Record<string, unknown> = { message: 'hello' }; input.self = input;
    const adapter = { id: 'jev', version: '1.0.0', capabilities: vi.fn(), evaluate: vi.fn() } as unknown as DecisionAdapter;
    const result = await evaluateDecisionRuleset({
      ruleset: JSON.parse(readFileSync('agentic/code/addons/decision-engine/examples/ruleset.json', 'utf8')) as DecisionRuleset,
      binding: JSON.parse(readFileSync('agentic/code/addons/decision-engine/examples/binding-jev.json', 'utf8')) as DecisionBinding,
      definitions: {}, input, runId: 'run', invocationId: 'bad-input', adapters: { jev: adapter },
    });
    expect(result.spec.reason).toBe('invalid-input');
    expect(adapter.evaluate).not.toHaveBeenCalled();
  });

  it('requires structured-entry capability and emits v1alpha2 provenance', async () => {
    const definition = structured();
    const ruleset = JSON.parse(readFileSync('agentic/code/addons/decision-engine/examples/ruleset.json', 'utf8')) as DecisionRuleset;
    ruleset.spec.evaluations[0]!.decision = artifactPin(definition);
    const binding = JSON.parse(readFileSync('agentic/code/addons/decision-engine/examples/binding-jev.json', 'utf8')) as DecisionBinding;
    binding.spec.ruleset = artifactPin(ruleset);
    const plain = JSON.parse(readFileSync('agentic/code/addons/decision-engine/examples/decision-severity.json', 'utf8')) as DecisionDefinition;
    const core = JSON.parse(readFileSync('agentic/code/addons/decision-engine/examples/decision-core_unavailable.json', 'utf8')) as DecisionDefinition;
    const adapter: DecisionAdapter = {
      id: 'jev', version: '1.0.0',
      capabilities: async () => ({ answerKinds: ['choice', 'ordinal-score', 'truth-probability'], features: ['typed-output'], maxOptions: 255, maxLevels: 10, confidenceProfiles: ['typesafe-distribution-v1'], executable: true }),
      evaluate: vi.fn(async () => ({ status: 'success', reason: 'none', value: 'documentation', uncertainty: null, actualModel: 'fixture', usage: { inputTokens: null, outputTokens: null, costUsd: null }, requestId: null })),
    };
    const store = new MemoryDecisionReceiptStore();
    const result = await evaluateDecisionRuleset({
      ruleset, binding, definitions: { category: definition, severity: plain, core },
      input: JSON.parse(readFileSync('agentic/code/addons/decision-engine/examples/input.json', 'utf8')),
      runId: 'run', invocationId: 'structured-run', adapters: { jev: adapter }, receiptStore: store,
    });
    expect(result.apiVersion).toBe('decision.aiwg.io/v1alpha2');
    expect(result.spec.evaluations.category?.apiVersion).toBe('decision.aiwg.io/v1alpha2');
    expect(result.spec.evaluations.category?.spec.reason).toBe('unsupported-capability');
    expect(vi.mocked(adapter.evaluate).mock.calls.some(([req]) => req.alias === 'category')).toBe(false);
    const receipt = await store.read('structured-run');
    expect(receipt?.result?.apiVersion).toBe('decision.aiwg.io/v1alpha2');
    expect(receipt?.result?.spec.evaluations.category?.spec.decision.digest).toBe(artifactPin(definition).digest);
    validateDecisionDocument(result);
  });

  it('keeps planned state, instructions, and target controls isolated from adapter mutation', async () => {
    const definition = structured();
    const originalQuestion = structuredClone(definition.spec.question);
    const ruleset = JSON.parse(readFileSync('agentic/code/addons/decision-engine/examples/ruleset.json', 'utf8')) as DecisionRuleset;
    ruleset.spec.evaluations[0]!.decision = artifactPin(definition);
    const binding = JSON.parse(readFileSync('agentic/code/addons/decision-engine/examples/binding-jev.json', 'utf8')) as DecisionBinding;
    binding.spec.ruleset = artifactPin(ruleset);
    const input = JSON.parse(readFileSync('agentic/code/addons/decision-engine/examples/input.json', 'utf8')) as { message: string };
    const originalInput = structuredClone(input);
    const adapter: DecisionAdapter = {
      id: 'jev', version: '1.0.0',
      capabilities: async () => ({ answerKinds: ['choice', 'ordinal-score', 'truth-probability'], features: ['structured-entries'], maxOptions: 255, maxLevels: 10, confidenceProfiles: ['typesafe-distribution-v1'], executable: true }),
      evaluate: async req => {
        req.definition.spec.question = { state: 'override', model: 'override', questions: 'override' };
        (req.input as { message: string }).message = 'changed';
        req.target.model = 'override';
        return { status: 'success', reason: 'none', value: req.alias === 'category' ? 'documentation' : 0.1,
          uncertainty: null, actualModel: 'fixture', usage: { inputTokens: null, outputTokens: null, costUsd: null }, requestId: null };
      },
    };
    const result = await evaluateDecisionRuleset({
      ruleset, binding, definitions: { category: definition,
        severity: JSON.parse(readFileSync('agentic/code/addons/decision-engine/examples/decision-severity.json', 'utf8')) as DecisionDefinition,
        core: JSON.parse(readFileSync('agentic/code/addons/decision-engine/examples/decision-core_unavailable.json', 'utf8')) as DecisionDefinition },
      input, runId: 'run', invocationId: 'mutation-test', adapters: { jev: adapter },
    });
    expect(definition.spec.question).toEqual(originalQuestion);
    expect(input).toEqual(originalInput);
    expect(binding.spec.evaluations.category?.targets[0]?.model).toBe('jev-latest');
    expect(result.spec.evaluations.category?.spec.attempts[0]?.requestedModel).toBe('jev-latest');
  });


  it.each(['jev', 'llm-subagent'] as const)('executes nested v1alpha2 definitions through %s with pinned receipts', async backend => {
    const category = structured();
    const severity = convertDecisionDefinitionV1Alpha1(JSON.parse(readFileSync('agentic/code/addons/decision-engine/examples/decision-severity.json', 'utf8')) as DecisionDefinition).definition;
    if (severity.spec.answer.kind === 'ordinal-score') severity.spec.answer.levels = [{ label: 'cosmetic' }, ['workaround', null], 'unavailable'];
    const core = convertDecisionDefinitionV1Alpha1(JSON.parse(readFileSync('agentic/code/addons/decision-engine/examples/decision-core_unavailable.json', 'utf8')) as DecisionDefinition).definition;
    if (core.spec.answer.kind === 'truth-probability') { core.spec.answer.trueDescription = { meaning: 'down' }; core.spec.answer.falseDescription = null; }
    const ruleset = JSON.parse(readFileSync('agentic/code/addons/decision-engine/examples/ruleset.json', 'utf8')) as DecisionRuleset;
    for (const [alias, definition] of [['category', category], ['severity', severity], ['core_unavailable', core]] as const) {
      ruleset.spec.evaluations.find(item => item.alias === alias)!.decision = artifactPin(definition);
    }
    const binding = JSON.parse(readFileSync(`agentic/code/addons/decision-engine/examples/binding-${backend === 'jev' ? 'jev' : 'llm-subagent'}.json`, 'utf8')) as DecisionBinding;
    binding.spec.ruleset = artifactPin(ruleset);
    const seen: Record<string, unknown>[] = [];
    const worker = JSON.parse(readFileSync('agentic/code/addons/decision-engine/examples/worker-fixture.json', 'utf8')) as { metadata: { id: string; version: string } };
    if (backend === 'llm-subagent') {
      for (const evaluation of Object.values(binding.spec.evaluations)) evaluation.targets[0]!.subagent = artifactPin(worker);
    }
    const adapters: Record<string, DecisionAdapter> = backend === 'jev'
      ? { jev: new JevDecisionAdapter({ fetch: vi.fn(async (_url, options) => {
        const body = JSON.parse(String(options?.body)) as Record<string, unknown>;
        seen.push(body);
        const alias = Object.keys(body.questions as object)[0]!;
        const answer = alias === 'category'
          ? { type: 'choice', choice: 'documentation', probabilities: { documentation: 1, runtime: 0, other: 0 }, confidence: 1 }
          : alias === 'severity'
            ? { type: 'score', score: 0, probabilities: { 0: 1, 1: 0, 2: 0 }, legend: Object.fromEntries((severity.spec.answer.kind === 'ordinal-score' ? severity.spec.answer.levels : []).map((level, index) => [index, level])), confidence: 1 }
            : { type: 'noul', noul: 0.1 };
        return new Response(JSON.stringify({ answers: { [alias]: answer }, model: 'fixture', usage: {} }), { status: 200 });
      }) as typeof fetch }) }
      : { 'llm-subagent': new LlmSubagentDecisionAdapter({
        resolveWorker: async () => worker,
        runWorker: async task => {
          const prompt = JSON.parse(task.prompt) as Record<string, unknown>;
          seen.push(prompt);
          const answer = prompt.answer as { kind: string };
          const output = answer.kind === 'choice'
            ? { status: 'success', value: 'documentation' }
            : answer.kind === 'ordinal-score'
              ? { status: 'success', distribution: { 0: 1, 1: 0, 2: 0 } }
              : { status: 'success', value: 0.1 };
          return { started: true, terminal: true, output, actualModel: 'fixture' };
        },
      }) };
    const store = new MemoryDecisionReceiptStore();
    const result = await evaluateDecisionRuleset({
      ruleset, binding, definitions: { category, severity, core },
      input: JSON.parse(readFileSync('agentic/code/addons/decision-engine/examples/input.json', 'utf8')),
      runId: 'structured-run', invocationId: `structured-${backend}`, adapters, receiptStore: store,
      resolveCredential: async () => new TextEncoder().encode('fixture-token'),
    });
    expect(result.apiVersion).toBe('decision.aiwg.io/v1alpha2');
    expect(result.spec.evaluations.category?.spec.status).toBe('success');
    expect(result.spec.evaluations.severity?.spec.status).toBe('success');
    expect(result.spec.evaluations.core_unavailable?.spec.status).toBe('success');
    expect(result.spec.evaluations.category?.spec.decision.digest).toBe(artifactPin(category).digest);
    expect((await store.read(`structured-${backend}`))?.result).toEqual(result);
    expect(seen).toHaveLength(3);
    if (backend === 'jev') {
      const question = (seen[0]!.questions as Record<string, Record<string, unknown>>).category;
      expect(question.instructions).toEqual(category.spec.question);
      expect((seen[1]!.questions as Record<string, Record<string, unknown>>).severity.criteria).toEqual(severity.spec.answer.kind === 'ordinal-score' ? severity.spec.answer.levels : null);
    } else {
      expect(seen[0]!.question).toEqual(category.spec.question);
      expect(seen[1]!.answer).toEqual(severity.spec.answer);
    }
    validateDecisionDocument(result);
  });

});
