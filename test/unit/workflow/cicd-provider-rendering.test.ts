/** Inert, manually projected provider goldens and extension-loader contract (#4428). */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Ajv from 'ajv';
import { load } from 'js-yaml';
import { getAllExtensions, USE_ALL_EXTENSIONS_DISALLOW } from '../../../src/cli/handlers/use-additive-bundles.js';

const root = path.resolve(__dirname, '../../..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const json = (file: string) => JSON.parse(read(file));
const fixtureRoot = 'test/fixtures/cicd';
const environment = json(`${fixtureRoot}/valid/ci-environment.json`);
const providers = ['github', 'gitea'] as const;
const ajv = new Ajv({ allErrors: true, strict: false });
const validateExtension = ajv.compile(json('agentic/code/addons/aiwg-utils/workflow/schemas/workflow-extension.schema.json'));
const validateCapability = ajv.compile(json('agentic/code/frameworks/ops-complete/schemas/metalanguage/ops-capability.schema.json'));

interface Step {
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Job {
  steps: Step[];
  needs?: string[];
  if?: string;
  environment?: { name: string };
  'runs-on': string[];
  strategy?: unknown;
}
interface Workflow {
  name: string;
  on: Record<string, unknown>;
  jobs: Record<string, Job>;
  permissions?: Record<string, string>;
  env?: Record<string, string>;
}
function assertSecretReferences(value: unknown, key = ''): void {
  if (typeof value === 'string') {
    if (/(?:token|password|secret|credential|api_key)$/i.test(key)) {
      expect(value, `literal secret at ${key}`).toMatch(/^\$\{\{ secrets\.[A-Z][A-Z0-9_]* \}\}$/);
    }
    expect(value).not.toMatch(/vault:\/\/|(?:ghp_|github_pat_|AKIA)[A-Za-z0-9_]+/);
    expect(value).not.toMatch(/(?:password|token|secret)\s*=\s*['"]?[A-Za-z0-9+/]{20,}/i);
  } else if (Array.isArray(value)) value.forEach(item => assertSecretReferences(item));
  else if (value && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value)) assertSecretReferences(child, childKey);
  }
}
function assertAcyclic(jobs: Record<string, Job>): void {
  const done = new Set<string>();
  const active = new Set<string>();
  const visit = (id: string) => {
    expect(jobs).toHaveProperty(id);
    expect(active.has(id), `cycle at ${id}`).toBe(false);
    if (done.has(id)) return;
    active.add(id);
    for (const dep of jobs[id].needs ?? []) visit(dep);
    active.delete(id);
    done.add(id);
  };
  Object.keys(jobs).forEach(visit);
}

for (const provider of providers) {
  const id = `cicd-${provider}-actions`;
  const base = `agentic/code/extensions/${id}`;
  describe(`${id} package`, () => {
    it('is discovered at the supported top-level extension path without registration changes', async () => {
      expect(await getAllExtensions(root)).toContain(id);
      expect(USE_ALL_EXTENSIONS_DISALLOW.has(id)).toBe(false);
      const doc = load(read(`${base}/ADDON.yaml`));
      expect(validateExtension(doc), JSON.stringify(validateExtension.errors)).toBe(true);
      expect(doc).toMatchObject({ metadata: { name: id }, spec: { extends: 'cicd-complete', capabilities: 'auto-discover' } });
      const manifest = json(`${base}/manifest.json`);
      expect(manifest).toMatchObject({ id, type: 'addon', requires: ['cicd-complete'] });
      for (const [kind, names] of Object.entries(manifest.provides) as [string, string[]][]) {
        for (const name of names) {
          const file = `${base}/${manifest.entry[kind]}${name}.${kind === 'capabilities' ? 'yaml' : 'md'}`;
          const text = read(file);
          if (kind === 'capabilities') {
            expect(validateCapability(load(text)), JSON.stringify(validateCapability.errors)).toBe(true);
          } else expect(load(text.match(/^---\n([\s\S]*?)\n---/)![1])).toMatchObject({ name });
        }
      }
    });

    it('documents four rollout strategies, required bindings, protection limitations and inert placement', () => {
      const template = read(`${base}/templates/${id}-workflow.md`);
      for (const strategy of ['canary', 'blue-green', 'rolling', 'flag']) expect(template).toContain(strategy);
      for (const contract of ['CI_CAPABILITY', 'CI_ROLLOUT', 'CI_GATE', 'CI_PROTECTION', 'persist-credentials: false']) {
        expect(template).toContain(contract);
      }
      const doc = read(`${base}/README.md`);
      expect(doc).toContain('getAllExtensions');
      expect(doc).toContain('HOLD');
      expect(doc).toContain('Unsupported trigger');
      expect(doc).toContain(provider === 'github' ? 'Native' : 'external approval');
      expect(template).not.toContain('continue-on-error');
    });
  });

  for (const strategy of ['canary', 'flag'] as const) {
    const source = json(`${fixtureRoot}/valid/ci-pipeline-${strategy}.json`);
    const raw = read(`${fixtureRoot}/rendered/${provider}-actions/ci-pipeline-${strategy}.yml`);
    const workflow = load(raw) as Workflow;
    describe(`${provider}-actions ${strategy} golden`, () => {
      it('parses as YAML and preserves the source trigger and job contracts', () => {
        expect(workflow.name).toBe(source.metadata.name);
        expect(Object.keys(workflow.on)).toEqual(strategy === 'canary'
          ? ['push', 'pull_request', 'schedule', 'workflow_dispatch'] : ['workflow_dispatch']);
        if (strategy === 'canary') {
          expect(workflow.on.push).toEqual({ branches: ['main'], paths: ['src/**'] });
          expect(workflow.on.pull_request).toEqual({ branches: ['main'] });
          expect(workflow.on.schedule).toEqual([{ cron: '0 2 * * *' }]);
        }
        for (const stage of source.spec.stages) {
          for (const job of stage.jobs) {
            expect(workflow.jobs).toHaveProperty(job.id);
            const rendered = workflow.jobs[job.id];
            expect(rendered.strategy).toBeUndefined();
            expect(rendered.needs ?? []).toEqual(expect.arrayContaining(job.depends_on ?? []));
            const invocation = rendered.steps.find(step => step.env?.CI_CAPABILITY === job.capability)!;
            expect(invocation.run).toBe('node ci/capability.mjs');
            expect(JSON.parse(invocation.env!.CI_INPUTS)).toEqual(job.inputs ?? {});
            expect(JSON.parse(invocation.env!.CI_RETRY)).toEqual(job.retry ?? { max_attempts: 1 });
          }
        }
        assertAcyclic(workflow.jobs);
        if (strategy === 'canary') {
          expect(workflow.jobs['ci-release'].needs).toEqual(['ci-build', 'ci-test-gate-1']);
          expect(workflow.jobs['ci-test-gate-1'].needs).toEqual(['ci-unit', 'ci-build']);
          expect(workflow.jobs['ci-release-rollout'].needs).toEqual(['ci-release', 'ci-test-gate-1']);
          const step = workflow.jobs['ci-test-gate-1'].steps.find(step => step.env?.CI_GATE)!;
          expect(JSON.parse(step.env!.CI_GATE)).toEqual(source.spec.gates[0]);
        } else expect(workflow.jobs['ci-publish'].needs).toBeUndefined();
      });

      it('pins every action to the reviewed SHA and version manifest', () => {
        const pins = read(`${base}/templates/ci-action-pins.txt`);
        const uses = Object.values(workflow.jobs).flatMap(job => job.steps.filter(step => step.uses));
        expect(uses.length).toBeGreaterThan(0);
        for (const step of uses) {
          expect(step.uses).toMatch(/^[^\s]+@[a-f0-9]{40}$/);
          const [action, sha] = step.uses!.split('@');
          const row = pins.split('\n').find(line => line.startsWith(`action ${action} ${sha} `));
          expect(row, `manifest entry for ${step.uses}`).toBeDefined();
          const version = row!.split(/\s+/)[3];
          expect(raw).toContain(`uses: ${step.uses} # ${version}`);
          if (action.endsWith('checkout')) expect(step.with?.['persist-credentials']).toBe(false);
        }
        const artifact = uses.find(step => step.uses!.includes('/upload-artifact@'))!;
        expect(artifact.uses).toContain(provider === 'github' ? 'ea165f8d65b6e75b540449e92b4886f43607fa02' : 'c24449f33cd45d4826c6702db7e49f7cdb9b551d');
      });

      it('contains only name-based secrets and protects privileged jobs from PR execution', () => {
        assertSecretReferences(workflow);
        expect(workflow.env).toBeUndefined();
        expect(workflow.on).not.toHaveProperty('pull_request_target');
        expect(workflow.permissions).toEqual(provider === 'github' ? { contents: 'read' } : undefined);
        for (const job of Object.values(workflow.jobs)) {
          const privileged = job.steps.some(step => step.env?.CI_TOKEN);
          if (!privileged) {
            expect(job['runs-on']).toContain('ci-untrusted');
            continue;
          }
          expect(job.if).toBe("${{ github.event_name != 'pull_request' && (github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/heads/release/')) }}");
          expect(job.environment).toEqual(provider === 'github' ? { name: environment.metadata.name } : undefined);
          expect(job['runs-on']).toEqual(provider === 'github' ? ['self-hosted', ...environment.spec.runner.labels] : environment.spec.runner.labels);
          const approvalIndex = job.steps.findIndex(step => step.run === 'node ci/approval.mjs');
          expect(approvalIndex).toBeGreaterThan(0);
          expect(JSON.parse(job.steps[approvalIndex].env!.CI_PROTECTION)).toEqual(environment.spec.protection);
          for (const [index, step] of job.steps.entries()) {
            if (step.env?.CI_TOKEN) {
              expect(index).toBeGreaterThan(approvalIndex);
              expect(step.env.CI_TOKEN).toBe('${{ secrets.CI_TOKEN }}');
              expect(step.env.CI_ENVIRONMENT).toBe(environment.metadata.name);
            }
          }
        }
      });

      it('retains rollout steps, pauses, entry gates and rollback in a dependent protected job', () => {
        const sourceRollout = source.spec.stages.find((stage: { rollout?: unknown }) => stage.rollout).rollout;
        const job = workflow.jobs['ci-release-rollout'];
        const step = job.steps.find(step => step.run === 'node ci/rollout.mjs')!;
        expect(JSON.parse(step.env!.CI_ROLLOUT)).toEqual(sourceRollout);
        expect(step.env!.CI_CAPABILITY).toBe(strategy === 'flag' ? 'progressive-rollout' : 'ci-deploy-handoff');
        expect(job.needs?.length).toBeGreaterThan(0);
        if (strategy === 'flag') expect(step.env!.CI_HEALTH_GATE).toBe('aiwg:cicd-complete/progressive-rollout-health');
        else expect(JSON.parse(job.steps.find(step => step.env?.CI_GATE)!.env!.CI_GATE)).toEqual(sourceRollout.gates[0]);
        expect(raw).not.toContain('continue-on-error');
        expect(raw).not.toContain('set -x');
      });
    });
  }
}

it('rejects injected literal secrets, including nested environment and command values', () => {
  for (const value of [{ env: { CI_TOKEN: 'literal-credential' } }, { run: 'token=abcdefghijklmnopqrstuvwxyz' }, { env: { OTHER: 'vault://ci/production#token' } }]) {
    expect(() => assertSecretReferences(value)).toThrow();
  }
});
