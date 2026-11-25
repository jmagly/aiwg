/** Governed CI/CD contracts and distribution projections (#4422, #4427). */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Ajv from 'ajv';
import { frameworkRegistryId } from '../../../src/config/framework-aliases.js';

const ROOT = path.resolve(__dirname, '../../..');
const FRAMEWORK = 'agentic/code/frameworks/cicd-complete';
const FIXTURES = 'test/fixtures/cicd';
const load = (file: string) => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
const schema = (name: string) => load(`${FRAMEWORK}/schemas/${name}.schema.json`);
const ajv = new Ajv({ allErrors: true, strict: true });
const validators = {
  CIPipeline: ajv.compile(schema('ci-pipeline')),
  CIEnvironment: ajv.compile(schema('ci-environment')),
  WorkflowExtension: ajv.compile(load('agentic/code/addons/aiwg-utils/workflow/schemas/workflow-extension.schema.json')),
};

const invalidKeywords: Record<string, string> = {
  'ci-pipeline-unknown-stage.json': 'additionalProperties',
  'ci-pipeline-no-capability.json': 'required',
  'ci-pipeline-render-target.json': 'enum',
  'ci-environment-secret-value.json': 'additionalProperties',
  'cicd-extension-unknown-framework.json': 'enum',
};

describe('CI/CD v1 fixtures', () => {
  for (const directory of ['valid', 'invalid']) {
    const files = fs.readdirSync(path.join(ROOT, FIXTURES, directory)).sort();
    for (const file of files) {
      it(`${directory}/${file}`, () => {
        const doc = load(`${FIXTURES}/${directory}/${file}`);
        const validate = validators[doc.kind as keyof typeof validators];
        expect(validate, `validator for ${doc.kind}`).toBeDefined();
        expect(validate(doc), JSON.stringify(validate.errors)).toBe(directory === 'valid');
        if (directory === 'invalid') {
          expect(invalidKeywords[file], `expected keyword for ${file}`).toBeDefined();
          expect(validate.errors?.map(error => error.keyword)).toContain(invalidKeywords[file]);
        }
      });
    }
  }

  it('does not omit any required negative fixture from the keyword oracle', () => {
    expect(fs.readdirSync(path.join(ROOT, FIXTURES, 'invalid')).sort()).toEqual(Object.keys(invalidKeywords).sort());
  });
});

describe('CI/CD rollout and extension boundaries', () => {
  const pipeline = () => load(`${FIXTURES}/valid/ci-pipeline-flag.json`);

  it.each(['canary', 'blue-green', 'rolling', 'flag'])('accepts the %s rollout strategy', strategy => {
    const doc = pipeline();
    doc.spec.stages[0].rollout.strategy = strategy;
    expect(validators.CIPipeline(doc), JSON.stringify(validators.CIPipeline.errors)).toBe(true);
  });

  it('annotates the flag step default without making validation mutate the pipeline', () => {
    const contract = schema('ci-pipeline');
    expect(contract.definitions.rollout.allOf[0].then.properties.steps.items.properties.capability.default)
      .toBe('progressive-rollout');
    const doc = pipeline();
    expect(validators.CIPipeline(doc)).toBe(true);
    expect(doc.spec.stages[0].rollout.steps[0]).not.toHaveProperty('capability');
    doc.spec.stages[0].rollout.steps[0].capability = 'ci-custom-rollout';
    expect(validators.CIPipeline(doc)).toBe(true);
  });

  it.each([
    ['percentage above 100', { percentage: 101 }, 'maximum'],
    ['negative weight', { weight: -1 }, 'minimum'],
    ['ambiguous allocation', { weight: 10, percentage: 10 }, 'oneOf'],
    ['missing allocation', { pause: '5m' }, 'required'],
    ['flag lifecycle field', { percentage: 10, lifecycle: 'retired' }, 'additionalProperties'],
  ])('rejects %s', (_description, step, keyword) => {
    const doc = pipeline();
    doc.spec.stages[0].rollout.steps = [step];
    expect(validators.CIPipeline(doc)).toBe(false);
    expect(validators.CIPipeline.errors?.map(error => error.keyword)).toContain(keyword);
  });

  it('rejects flag provider configuration in a rollout', () => {
    const doc = pipeline();
    doc.spec.stages[0].rollout.provider = 'ci-provider';
    expect(validators.CIPipeline(doc)).toBe(false);
    expect(validators.CIPipeline.errors?.map(error => error.keyword)).toContain('additionalProperties');
  });

  it.each([0, -1, 1.5])('rejects retry max_attempts %s', max_attempts => {
    const doc = pipeline();
    doc.spec.stages[0].jobs[0].retry = { max_attempts, backoff: '30s' };
    expect(validators.CIPipeline(doc)).toBe(false);
  });

  it('requires a schedule expression for scheduled triggers', () => {
    const doc = pipeline();
    doc.spec.triggers = [{ type: 'schedule' }];
    expect(validators.CIPipeline(doc)).toBe(false);
    expect(validators.CIPipeline.errors?.some(error => error.keyword === 'required' && error.params.missingProperty === 'cron')).toBe(true);
  });

  it('keeps capability inputs and GatePack parameters extensible', () => {
    const doc = load(`${FIXTURES}/valid/ci-pipeline-canary.json`);
    doc.spec.stages[0].jobs[0].inputs = { custom: { nested: ['ci-input'] } };
    doc.spec.gates[0].parameters = { custom: { budget: 5 } };
    expect(validators.CIPipeline(doc), JSON.stringify(validators.CIPipeline.errors)).toBe(true);
  });

  it('requires a secret-store reference even when no literal value is present', () => {
    const doc = load(`${FIXTURES}/valid/ci-environment.json`);
    delete doc.spec.secrets[0].ref;
    expect(validators.CIEnvironment(doc)).toBe(false);
    expect(validators.CIEnvironment.errors?.some(error => error.keyword === 'required' && error.params.missingProperty === 'ref')).toBe(true);
  });
});

describe('CI/CD package registration and projections', () => {
  it('registers both use names and the sole kernel quickref', () => {
    expect(frameworkRegistryId('cicd')).toBe('cicd-complete');
    expect(frameworkRegistryId('cicd-complete')).toBe('cicd-complete');
    const manifest = load(`${FRAMEWORK}/manifest.json`);
    expect(manifest.phases).toEqual(['assess', 'design', 'implement', 'operate']);
    expect(manifest.skills).toEqual(['cicd-quickref']);
    expect(manifest.agents).toEqual([]);
    expect(manifest.templates).toEqual([]);
    const skill = fs.readFileSync(path.join(ROOT, FRAMEWORK, 'skills/cicd-quickref/SKILL.md'), 'utf8');
    expect(skill).toMatch(/^kernel: true$/m);
  });

  it.each(['ci-pipeline', 'ci-environment'])('ships an exact %s schema projection in the plugin', name => {
    const source = fs.readFileSync(path.join(ROOT, FRAMEWORK, `schemas/${name}.schema.json`));
    const projection = fs.readFileSync(path.join(ROOT, 'agentic/code/plugins/cicd-complete', `schemas/${name}.schema.json`));
    expect(projection.equals(source)).toBe(true);
  });
});
