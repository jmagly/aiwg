import { mkdtemp } from '../../helpers/temp-dir.js';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  decisionCapabilities,
  evaluateMcpProfile,
  evaluateRequestPath,
  livePlan,
  materializeSyntheticClassificationSetup,
  runOfflinePattern,
  syntheticClassificationSetup,
  validateDecisionValue,
  validateDecisionInput,
} from '../../../src/decision/driver.js';

describe('decision driver', () => {
  it('reports offline readiness, primitives and named MCP request profiles without exposing paths', () => {
    const status = decisionCapabilities({
      cwd: '/workspace',
      env: {
        AIWG_DECISION_ENABLED: '1',
        AIWG_DECISION_MCP_REQUESTS: JSON.stringify({ demo: '/trusted/request.json' }),
      },
    });
    expect(status.offlineReady).toBe(true);
    expect(status.enabled).toBe(true);
    expect(status.backend).toMatchObject({ configured: true, probed: false, status: 'not-probed' });
    expect(status.primitives).toContain('choice');
    expect(status.features.evaluate.mcpProfiles).toEqual(['demo']);
    expect(JSON.stringify(status)).not.toContain('/trusted/request.json');
  });

  it('runs offline pattern fixtures with abstained and denied normalized statuses distinct from success', async () => {
    const abstained = await runOfflinePattern('bounded-classification', 'classification-unknown');
    expect(abstained.status).toBe('abstained');
    expect(abstained.reason).toBe('candidate-not-authorized');

    const denied = await runOfflinePattern('tool-risk-preflight', 'tool-deny-conflict');
    expect(denied.status).toBe('denied');
    expect(denied.reason).toBe('deterministic-policy-deny');

    const success = await runOfflinePattern('bounded-classification', 'classification-known');
    expect(success.status).toBe('success');
  });

  it('plans live execution without executing or inferring credentials', () => {
    expect(livePlan('bounded-classification')).toMatchObject({
      status: 'skipped',
      reason: 'explicit-opt-in-required',
      executes: false,
    });
    expect(livePlan('bounded-classification', {
      explicitOptIn: true,
      credentialResolved: false,
      egressApproved: true,
    })).toMatchObject({ status: 'skipped', reason: 'credential-unavailable' });
  });

  it('materializes synthetic classification artifacts from runtime governed artifacts without overwrites', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aiwg-decision-setup-'));
    const setup = syntheticClassificationSetup({}, { frameworkRoot: '/pkg/aiwg' });
    expect(setup.files['dispatcher-request.json']).toMatchObject({
      adapterModules: { jev: '/pkg/aiwg/agentic/code/addons/decision-engine/examples/fixture-jev-adapter.mjs' },
    });
    const written = await materializeSyntheticClassificationSetup(dir, {}, { frameworkRoot: '/pkg/aiwg' });
    expect(Object.keys(written.files).sort()).toEqual([
      'binding.json',
      'definition-category.json',
      'dispatcher-request.json',
      'input.json',
      'ruleset.json',
    ]);
    await expect(materializeSyntheticClassificationSetup(dir, {}, { frameworkRoot: '/pkg/aiwg' })).rejects.toThrow(/Refusing to overwrite/);
    const request = JSON.parse(await readFile(written.files['dispatcher-request.json']!, 'utf8'));
    expect(request.definitionPaths).toEqual(['definition-category.json']);
  });

  it('rejects synthetic setup options that are not pinned by the generated definition', () => {
    expect(() => syntheticClassificationSetup({ allowedOptions: [] })).toThrow(/must not be empty/);
    expect(() => syntheticClassificationSetup({ allowedOptions: ['bug', 'bug'] })).toThrow(/duplicates/);
    expect(() => syntheticClassificationSetup({ allowedOptions: ['bug', 'support'] })).toThrow(/pinned definition options/);
    expect(() => syntheticClassificationSetup({ allowedOptions: ['bug'], text: '   ' })).toThrow(/text must not be blank/);
  });

  it('validates requests statically and gates evaluation behind explicit enablement', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aiwg-decision-request-'));
    const written = await materializeSyntheticClassificationSetup(dir, {}, { frameworkRoot: process.cwd() });
    const requestPath = written.files['dispatcher-request.json']!;
    await expect(validateDecisionInput('request', requestPath)).resolves.toMatchObject({ valid: true });
    const invalidPath = path.join(dir, 'invalid.json');
    await writeFile(invalidPath, '{"rulesetPath":"ruleset.json","body":');
    await expect(validateDecisionInput('request', invalidPath)).resolves.toMatchObject({
      valid: false,
      errors: ['invalid-json'],
    });
    expect(validateDecisionValue('request', {
      rulesetPath: 'ruleset.json',
      bindingPath: 'binding.json',
      inputPath: 'input.json',
      hostPolicies: { batching: 'native-ticket-batch' },
    })).toMatchObject({ valid: true });
    expect(validateDecisionValue('request', {
      rulesetPath: 'ruleset.json',
      bindingPath: 'binding.json',
      inputPath: 'input.json',
      batching: {},
    })).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        "Unsupported inline decision runtime option 'batching'. Use hostPolicies.batching to select a trusted host policy",
      ]),
    });
    expect(validateDecisionValue('request', {
      rulesetPath: 'ruleset.json',
      bindingPath: 'binding.json',
      inputPath: 'input.json',
      hostPolicies: { shell: 'escape' },
    })).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.stringContaining("Unsupported decision host policy 'shell'"),
      ]),
    });
    expect(validateDecisionValue('request', {
      rulesetPath: 'ruleset.json',
      bindingPath: 'binding.json',
      inputPath: 'input.json',
      adapterModules: { '../escape': './adapter.mjs' },
      credentials: { token: 'not-a-valid-env-name' },
      receiptIntegrityKeyRef: 'missing-key',
    })).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        'adapterModules keys must be safe logical references',
        'credentials values must be environment variable names',
        'receiptIntegrityKeyRef must refer to a configured credential logical reference',
      ]),
    });
    await expect(evaluateRequestPath(requestPath, { env: {} })).resolves.toMatchObject({
      status: 'denied',
      reason: 'explicit-enable-required',
      exitCode: 2,
    });
  });

  it('rejects kind mismatches for binding validation and dispatcher output', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aiwg-decision-kind-'));
    const setup = syntheticClassificationSetup({}, { frameworkRoot: process.cwd() });
    expect(validateDecisionValue('binding', setup.files['definition-category.json'])).toMatchObject({
      valid: false,
      errors: ['binding kind must be DecisionBinding'],
    });
    expect(validateDecisionValue('binding', setup.files['binding.json'])).toMatchObject({ valid: true });
    const written = await materializeSyntheticClassificationSetup(dir, {}, { frameworkRoot: process.cwd() });
    await expect(evaluateRequestPath(written.files['dispatcher-request.json']!, {
      env: { AIWG_DECISION_ENABLED: '1' },
      runtime: {},
      dispatcher: {
        async runDecisionEvaluate({ stdout }: any) {
          stdout.write(`${JSON.stringify(setup.files['binding.json'])}\n`);
          return 0;
        },
      },
    })).resolves.toMatchObject({
      status: 'error',
      reason: 'dispatcher-output-unavailable',
      compact: null,
      result: null,
    });
  });

  it('does not collapse defaulted denied or unavailable evaluations into success', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aiwg-decision-compact-'));
    const written = await materializeSyntheticClassificationSetup(dir, {}, { frameworkRoot: process.cwd() });
    const base = (await runOfflinePattern('bounded-classification', 'classification-known')).receipt.result as any;
    const requestPath = written.files['dispatcher-request.json']!;
    const withReason = (reason: string) => {
      const result = structuredClone(base);
      result.spec.status = 'defaulted';
      result.spec.reason = 'no-match';
      for (const evaluation of Object.values(result.spec.evaluations) as any[]) {
        evaluation.spec.status = 'error';
        evaluation.spec.reason = reason;
        delete evaluation.spec.value;
      }
      return result;
    };
    const run = (result: unknown) => evaluateRequestPath(requestPath, {
      env: { AIWG_DECISION_ENABLED: '1' },
      runtime: {},
      dispatcher: {
        async runDecisionEvaluate({ stdout }: any) {
          stdout.write(`${JSON.stringify(result)}\n`);
          return 0;
        },
      },
    });
    await expect(run(withReason('data-boundary-denied'))).resolves.toMatchObject({
      status: 'denied',
      compact: { status: 'denied' },
    });
    await expect(run(withReason('executor-unavailable'))).resolves.toMatchObject({
      status: 'unavailable',
      compact: { status: 'unavailable' },
    });
    await expect(run(withReason('service-error'))).resolves.toMatchObject({
      status: 'error',
      compact: { status: 'error' },
    });
  });

  it('forwards trusted host policy modules for CLI requests and MCP profiles without exposing tool-supplied paths', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aiwg-decision-host-policy-'));
    const written = await materializeSyntheticClassificationSetup(dir, {}, { frameworkRoot: process.cwd() });
    const requestPath = written.files['dispatcher-request.json']!;
    const modulePath = path.join(dir, 'trusted-host-policies.mjs');
    const seen: string[][] = [];
    const dispatcher = {
      async runDecisionEvaluate({ argv, stdout }: any) {
        seen.push(argv);
        stdout.write(`${JSON.stringify((await runOfflinePattern('bounded-classification', 'classification-known')).receipt.result)}\n`);
        return 0;
      },
    };

    await expect(evaluateRequestPath(requestPath, {
      env: { AIWG_DECISION_ENABLED: '1' },
      runtime: {},
      dispatcher,
    }, { hostPolicyModulePath: modulePath })).resolves.toMatchObject({ status: 'success' });
    expect(seen.at(-1)).toEqual(['--request', requestPath, '--host-policy-module', modulePath]);

    await expect(evaluateMcpProfile('demo', true, {
      cwd: dir,
      env: {
        AIWG_DECISION_ENABLED: '1',
        AIWG_DECISION_MCP_REQUESTS: JSON.stringify({ demo: { requestPath: 'dispatcher-request.json', hostPolicyModulePath: 'trusted-host-policies.mjs' } }),
      },
      runtime: {},
      dispatcher,
    })).resolves.toMatchObject({ status: 'success' });
    expect(seen.at(-1)).toEqual(['--request', path.join(dir, 'dispatcher-request.json'), '--host-policy-module', modulePath]);
  });

  it('MCP evaluation only uses configured profile names plus env and per-call opt-in', async () => {
    const denied = await evaluateMcpProfile('demo', false, { env: { AIWG_DECISION_ENABLED: '1' } });
    expect(denied).toMatchObject({ status: 'denied', reason: 'per-call-opt-in-required' });
    const unavailable = await evaluateMcpProfile('missing', true, {
      cwd: '/workspace',
      env: { AIWG_DECISION_ENABLED: '1', AIWG_DECISION_MCP_REQUESTS: 'demo=/trusted/request.json' },
    });
    expect(unavailable).toMatchObject({ status: 'unavailable', reason: 'unknown-request-profile' });
  });
});
