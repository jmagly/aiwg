import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as runtime from '../../../src/decision/index.js';
import {
  decisionResultForExport,
  evaluateDecisionRuleset,
  FileDecisionReceiptStore,
  JevCredentialError,
  JevDecisionAdapter,
  projectDecisionState,
  type DecisionBinding,
  type DecisionDefinition,
  type DecisionEvaluationRequest,
  type DecisionProjectionPolicy,
  type DecisionRuleset,
} from '../../../src/decision/index.js';
import {
  QUALIFICATION_PRIVACY_SURFACES, scanQualificationPrivacy, type QualificationPrivacyCapture,
} from '../../../src/decision/qualification/privacy.js';
import { runDecisionEvaluate } from '../../../agentic/code/addons/decision-engine/skills/decision-evaluate/scripts/decision-evaluate-core.mjs';

// #2597 AC7: canaries placed in state, credentials, response headers, unmodelled
// response fields and resolver errors are scanned on every surface produced by a
// real evaluation, including bytes actually written to stdout and stderr.

const fixture = <T>(name: string): T => JSON.parse(readFileSync(`examples/decision/${name}`, 'utf8')) as T;

const CANARIES = {
  includedState: 'synthetic-included-state-canary',
  excludedState: 'synthetic-excluded-state-canary',
  credential: 'synthetic-bearer-credential-canary',
  responseHeader: 'synthetic-response-header-canary',
  responseBody: 'synthetic-response-body-canary',
  resolverError: 'synthetic-resolver-error-canary',
  policyLocator: 'synthetic-policy-locator-canary',
};

/** Captures every write to the real process streams and console while `run` executes. */
async function captureProcessOutput<T>(run: () => Promise<T>): Promise<{ value: T; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => { stdout.push(String(chunk));
    return typeof rest.at(-1) === 'function' ? ((rest.at(-1) as () => void)(), true) : true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => { stderr.push(String(chunk));
    return typeof rest.at(-1) === 'function' ? ((rest.at(-1) as () => void)(), true) : true; }) as typeof process.stderr.write;
  const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(method =>
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      (method === 'log' || method === 'info' || method === 'debug' ? stdout : stderr).push(args.map(String).join(' '));
    }));
  try {
    const value = await run();
    return { value, stdout: stdout.join(''), stderr: stderr.join('') };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
    consoleSpies.forEach(spy => spy.mockRestore());
  }
}

function jevPayload(body: Record<string, unknown>): string {
  const answers = Object.fromEntries(Object.entries(body.questions as Record<string, { type: string }>).map(([id, question]) => [id,
    question.type === 'choice'
      ? { type: 'choice', choice: 'documentation', probabilities: { documentation: 1, runtime: 0, other: 0 }, confidence: 1 }
      : question.type === 'score'
        ? { type: 'score', score: 0.25, probabilities: { 0: 0.75, 1: 0.25, 2: 0 },
            legend: { 0: 'Cosmetic or documentation issue; core functions work.', 1: 'A feature fails but has a workaround.',
              2: 'Core functions unavailable.' }, confidence: 0.8 }
        : { type: 'noul', noul: 0.05 }]));
  return JSON.stringify({ answers, model: 'jev-fixture', debug: CANARIES.responseBody, usage: { input_tokens: 9, output_tokens: 3 } });
}

function policy(): DecisionProjectionPolicy {
  return {
    version: '1.0.0', provider: 'jev', model: 'jev-latest', origin: 'https://api.typesafe.ai', region: 'us',
    purpose: 'triage', allowIncompleteContext: false,
    fields: [{ pointer: '/message', output: 'excerpt', source: 'caller', subject: 'ticket:42', trust: 'untrusted',
      sensitivity: 'internal', purpose: 'triage', retentionClass: 'ephemeral', accessScopes: ['decision-runtime'],
      exportPolicy: 'sanitized', deletionPolicy: 'erase', backupPolicy: 'not-persisted', allowedProviders: ['jev'],
      allowedModels: ['jev-latest'], allowedOrigins: ['https://api.typesafe.ai'], allowedRegions: ['us'] }],
  };
}

/** Relaxes the example input schema so an excluded adjacent field can carry a canary. */
function artifacts(): Pick<DecisionEvaluationRequest, 'ruleset' | 'binding' | 'definitions'> {
  const definitions: Record<string, DecisionDefinition> = {
    category: fixture('decision-category.json'), severity: fixture('decision-severity.json'),
    core: fixture('decision-core_unavailable.json'),
  };
  for (const definition of Object.values(definitions)) {
    (definition.spec.inputSchema as Record<string, unknown>).additionalProperties = true;
  }
  const ruleset = fixture<DecisionRuleset>('ruleset.json');
  (ruleset.spec.inputSchema as Record<string, unknown>).additionalProperties = true;
  for (const evaluation of ruleset.spec.evaluations) {
    evaluation.decision = runtime.artifactPin(Object.values(definitions).find(value => value.metadata.id === evaluation.decision.id)!);
  }
  const binding = fixture<DecisionBinding>('binding-jev.json');
  binding.spec.ruleset = runtime.artifactPin(ruleset);
  return { ruleset, binding, definitions };
}

describe('D10 real-evaluation privacy capture harness (#2597 AC7)', () => {
  it('PRV-EGRESS-CAPTURE-01 finds no canary on any surface of an actual evaluation, dispatcher run and failure path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aiwg-egress-capture-'));
    try {
      const providerBodies: string[] = [];
      const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
        providerBodies.push(String(init?.body));
        return new Response(jevPayload(JSON.parse(String(init?.body)) as Record<string, unknown>),
          { status: 200, headers: { 'x-debug-echo': CANARIES.responseHeader } });
      }) as unknown as typeof fetch;
      const activity: unknown[] = [];
      const spans: unknown[] = [];
      const receiptStore = new FileDecisionReceiptStore(join(directory, 'receipts'), { integrityKey: new Uint8Array(32).fill(7) });
      const input = { message: `Broken docs link ${CANARIES.includedState}`, adjacent: { note: CANARIES.excludedState } };

      const captured = await captureProcessOutput(async () => {
        const result = await evaluateDecisionRuleset({
          ...artifacts(), input, runId: 'capture-run', invocationId: 'capture-invocation',
          adapters: { jev: new JevDecisionAdapter({ fetch: fetchImpl, region: 'us' }) }, receiptStore,
          resolveCredential: async () => new TextEncoder().encode(CANARIES.credential),
          projection: { resolve: policy, onEvidence: value => { activity.push(structuredClone(value)); } },
          telemetry: { hook: { emit: span => { spans.push(structuredClone(span)); } } },
        });
        // Failure path: the resolver throws an error carrying a canary.
        const failed = await evaluateDecisionRuleset({
          ...artifacts(), input, runId: 'capture-run', invocationId: 'capture-failure',
          adapters: { jev: new JevDecisionAdapter({ fetch: fetchImpl, region: 'us' }) },
          resolveCredential: async () => { throw Object.assign(new JevCredentialError('denied'),
            { detail: CANARIES.resolverError }); },
          projection: { resolve: policy, onEvidence: value => { activity.push(structuredClone(value)); } },
        });
        const thrown: string[] = [];
        const forbidden = policy(); forbidden.fields[0]!.source = `vault://private/${CANARIES.policyLocator}`;
        try { await projectDecisionState(input, forbidden); } catch (error) {
          thrown.push(String(error), (error as Error).stack ?? '', JSON.stringify(error));
        }
        // Dispatcher path through the source-import seam, writing to the real process streams.
        const requestPath = join(directory, 'request.json');
        await writeFile(requestPath, JSON.stringify({
          rulesetPath: resolve('examples/decision/ruleset.json'), bindingPath: resolve('examples/decision/binding-jev.json'),
          definitionPaths: ['decision-category.json', 'decision-severity.json', 'decision-core_unavailable.json']
            .map(name => resolve('examples/decision', name)),
          inputPath: resolve('examples/decision/input.json'), runId: 'capture-dispatch', invocationId: 'capture-dispatch',
          projectionPolicyPath: resolve('examples/decision/projection-policy-jev.json'),
          credentials: { 'typesafe-api': 'AIWG_TEST_CAPTURE_TOKEN' },
          adapterModules: { jev: resolve('test/fixtures/decision/dispatcher-fake-jev.mjs') },
        }));
        const code = await runDecisionEvaluate({ argv: ['--request', requestPath],
          env: { AIWG_DECISION_ENABLED: '1', AIWG_TEST_CAPTURE_TOKEN: CANARIES.credential },
          runtime, stdout: process.stdout, stderr: process.stderr });
        return { result, failed, thrown, code };
      });

      expect(captured.value.result.spec.status).toBe('completed');
      expect(captured.value.failed.spec.status).not.toBe('completed');
      expect(captured.value.code).toBe(0);
      expect(captured.stdout).toContain('"kind": "RulesetResult"');
      // Authorized egress is visible only on the provider transport, never on scanned surfaces.
      expect(providerBodies.some(body => body.includes(CANARIES.includedState))).toBe(true);
      expect(providerBodies.some(body => body.includes(CANARIES.excludedState))).toBe(false);

      const receiptFiles = await readdir(join(directory, 'receipts'));
      const receipts = await Promise.all(receiptFiles.map(name => readFile(join(directory, 'receipts', name), 'utf8')));
      expect(receipts.length).toBeGreaterThan(0);
      const captures: QualificationPrivacyCapture[] = [
        { surface: 'stdout', content: captured.stdout },
        { surface: 'stderr', content: captured.stderr },
        { surface: 'test-report', content: JSON.stringify({ code: captured.value.code, status: captured.value.result.spec.status }) },
        { surface: 'trace', content: JSON.stringify(spans) },
        { surface: 'receipt', content: receipts.join('\n') },
        { surface: 'snapshot', content: JSON.stringify([captured.value.result, captured.value.failed]) },
        { surface: 'export', content: JSON.stringify([decisionResultForExport(captured.value.result),
          decisionResultForExport(captured.value.failed)]) },
        { surface: 'thrown-error', content: captured.value.thrown.join('\n') },
        { surface: 'activity-record', content: JSON.stringify(activity) },
      ];
      expect(captures.map(item => item.surface).sort()).toEqual([...QUALIFICATION_PRIVACY_SURFACES].sort());
      expect(spans.length).toBeGreaterThan(0);
      expect(activity.length).toBeGreaterThan(0);
      expect(captured.value.thrown.join('')).toContain('forbidden credential');
      expect(scanQualificationPrivacy(captures, Object.values(CANARIES)))
        .toEqual({ clean: true, missing: [], affected: [] });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('PRV-EGRESS-CAPTURE-02 the harness detects a canary that does reach a captured stream', async () => {
    const captured = await captureProcessOutput(async () => { process.stderr.write(`leak ${CANARIES.credential}\n`); });
    const report = scanQualificationPrivacy(QUALIFICATION_PRIVACY_SURFACES.map(surface => ({ surface,
      content: surface === 'stderr' ? captured.stderr : '' })), [CANARIES.credential]);
    expect(report).toEqual({ clean: false, missing: [], affected: ['stderr'] });
  });
});

describe('D10 least-privilege credential resolution offline half (#2597 AC9)', () => {
  it('PRV-EGRESS-CRED-01 a fake scoped resolver sees exactly target.credentialRef and never an adjacent ref', async () => {
    // Scoped fake secret service: one granted logical ref, one adjacent decoy, no listing API.
    const granted = new Map([['typesafe-api', 'synthetic-granted-credential']]);
    const adjacent = new Map([['typesafe-api-admin', 'synthetic-adjacent-credential']]);
    const reads: string[] = [];
    const resolveCredential = vi.fn(async (ref: string) => {
      reads.push(ref);
      if (adjacent.has(ref)) throw new JevCredentialError('denied');
      const value = granted.get(ref);
      if (!value) throw new JevCredentialError('missing');
      return new TextEncoder().encode(value);
    });
    const authorization: string[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      authorization.push(String(new Headers(init?.headers).get('authorization')));
      return new Response(jevPayload(JSON.parse(String(init?.body)) as Record<string, unknown>), { status: 200 });
    }) as unknown as typeof fetch;
    const base = { ...artifacts(), input: { message: 'fixture' }, runId: 'cred-run',
      adapters: { jev: new JevDecisionAdapter({ fetch: fetchImpl, region: 'us' }) }, resolveCredential,
      projection: { resolve: policy } };

    const allowed = await evaluateDecisionRuleset({ ...base, invocationId: 'cred-allowed' });
    expect(allowed.spec.status).toBe('completed');
    expect(new Set(reads)).toEqual(new Set(['typesafe-api']));
    expect(authorization.every(value => value === 'Bearer synthetic-granted-credential')).toBe(true);

    // A binding that names the adjacent ref is denied by the scoped service; nothing is sent.
    reads.length = 0;
    const adjacentBinding = structuredClone(base.binding);
    for (const evaluation of Object.values(adjacentBinding.spec.evaluations)) evaluation.targets[0]!.credentialRef = 'typesafe-api-admin';
    const calls = (fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    const denied = await evaluateDecisionRuleset({ ...base, binding: adjacentBinding, invocationId: 'cred-adjacent' });
    expect(new Set(reads)).toEqual(new Set(['typesafe-api-admin']));
    expect(Object.values(denied.spec.evaluations).every(value => value.spec.reason === 'unauthorized')).toBe(true);
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(calls);
    expect(JSON.stringify(denied)).not.toContain('synthetic-adjacent-credential');

    // A projection denial happens before the resolver: no read at all, so no enumeration signal.
    reads.length = 0;
    const blocked = await evaluateDecisionRuleset({ ...base, invocationId: 'cred-blocked',
      projection: { resolve: () => ({ ...policy(), model: 'unapproved' }) } });
    expect(reads).toEqual([]);
    expect(Object.values(blocked.spec.evaluations).every(value => value.spec.reason === 'data-boundary-denied')).toBe(true);
  });
});
