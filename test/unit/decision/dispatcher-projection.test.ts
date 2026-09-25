import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as runtime from '../../../src/decision/index.js';
// Source-import seam: the packaged CLI injects the dist runtime; tests inject src.
import { runDecisionEvaluate } from '../../../agentic/code/addons/decision-engine/skills/decision-evaluate/scripts/decision-evaluate-core.mjs';
import { observed } from '../../fixtures/decision/dispatcher-fake-jev.mjs';

const examples = resolve('agentic/code/addons/decision-engine/examples');
const fakeJev = resolve('test/fixtures/decision/dispatcher-fake-jev.mjs');

function sink() {
  const chunks: string[] = [];
  return { chunks, write: (chunk: string | Uint8Array) => { chunks.push(String(chunk)); return true; } };
}

describe('decision-evaluate dispatcher projection boundary (#2678)', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'aiwg-dispatch-'));
    observed.calls = 0; observed.bodies.length = 0; observed.authorization.length = 0;
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  async function request(extra: Record<string, unknown>): Promise<string> {
    const path = join(directory, 'request.json');
    await writeFile(path, JSON.stringify({
      rulesetPath: join(examples, 'ruleset.json'), bindingPath: join(examples, 'binding-jev.json'),
      definitionPaths: ['decision-category.json', 'decision-severity.json', 'decision-core_unavailable.json']
        .map(name => join(examples, name)),
      inputPath: join(examples, 'input.json'), runId: 'dispatch-run', invocationId: 'dispatch-invocation',
      credentials: { 'typesafe-api': 'AIWG_TEST_DISPATCH_TOKEN' }, adapterModules: { jev: fakeJev },
      ...extra,
    }));
    return path;
  }

  const env = { AIWG_DECISION_ENABLED: '1', AIWG_TEST_DISPATCH_TOKEN: 'synthetic-dispatch-credential-canary' };

  it('DISPATCH-PROJ-01 refuses a network-capable adapter without projectionPolicyPath before any transport', async () => {
    const stdout = sink(); const stderr = sink();
    const code = await runDecisionEvaluate({ argv: ['--request', await request({})], env, runtime, stdout, stderr });
    expect(code).toBe(2);
    expect(stderr.chunks.join('')).toContain("adapter 'jev' can send state over the network");
    expect(stdout.chunks).toEqual([]);
    expect(observed.calls).toBe(0);
  });

  it('DISPATCH-PROJ-02 evaluates through the example projection policy and sends only projected state', async () => {
    const stdout = sink(); const stderr = sink();
    const code = await runDecisionEvaluate({ argv: ['--request', await request({
      projectionPolicyPath: join(examples, 'projection-policy-jev.json') })], env, runtime, stdout, stderr });
    expect(stderr.chunks).toEqual([]);
    expect(code).toBe(0);
    const result = JSON.parse(stdout.chunks.join('')) as runtime.RulesetResult;
    expect(result.spec).toMatchObject({ status: 'completed', outcome: 'docs-review' });
    expect(result.spec.projection).toBeUndefined();
    expect(observed.calls).toBe(3);
    const input = runtime.parseDecisionJson(await import('node:fs/promises')
      .then(fs => fs.readFile(join(examples, 'input.json'), 'utf8'))) as { message: string };
    expect(observed.bodies.every(body => JSON.stringify(body.state)
      === JSON.stringify({ verified: {}, untrusted: { message: input.message } }))).toBe(true);
    // The credential crosses only in the transport header, never to stdout.
    expect(stdout.chunks.join('')).not.toContain('synthetic-dispatch-credential-canary');
  });

  it('DISPATCH-PROJ-03 denies the example policy when the adapter region is not declared', async () => {
    const stdout = sink(); const stderr = sink();
    // The packaged Jev adapter built from adapterOptions without a region is an unknown destination.
    const path = await request({ projectionPolicyPath: join(examples, 'projection-policy-jev.json'), adapterModules: {} });
    const code = await runDecisionEvaluate({ argv: ['--request', path], env, runtime, stdout, stderr });
    expect(code).toBe(0);
    const result = JSON.parse(stdout.chunks.join('')) as runtime.RulesetResult;
    expect(Object.values(result.spec.evaluations).map(value => value.spec.reason))
      .toEqual(['data-boundary-denied', 'data-boundary-denied', 'data-boundary-denied']);
  });

  it('DISPATCH-PROJ-04 rejects a projection policy file carrying credential material before dispatch', async () => {
    const policy = JSON.parse(await import('node:fs/promises')
      .then(fs => fs.readFile(join(examples, 'projection-policy-jev.json'), 'utf8'))) as runtime.DecisionProjectionPolicy;
    policy.fields[0]!.source = 'vault://private/synthetic-policy-canary';
    const policyPath = join(directory, 'policy.json');
    await writeFile(policyPath, JSON.stringify(policy));
    await expect(runDecisionEvaluate({ argv: ['--request', await request({ projectionPolicyPath: policyPath })], env,
      runtime, stdout: sink(), stderr: sink() })).rejects.toThrow(/forbidden credential/);
    expect(observed.calls).toBe(0);
  });

  it('DISPATCH-PROJ-05 validates the shipped example policy against its JSON schema and the runtime validator', async () => {
    const policy = JSON.parse(await import('node:fs/promises')
      .then(fs => fs.readFile(join(examples, 'projection-policy-jev.json'), 'utf8'))) as runtime.DecisionProjectionPolicy;
    expect(() => runtime.validateProjectionPolicy(policy)).not.toThrow();
    const { default: Ajv2020 } = await import('ajv/dist/2020.js');
    const { default: addFormats } = await import('ajv-formats');
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    const schema = JSON.parse(await import('node:fs/promises')
      .then(fs => fs.readFile('schemas/decision/DecisionProjectionPolicy.v1.schema.json', 'utf8')));
    expect(ajv.validate(schema, policy)).toBe(true);
  });
});
