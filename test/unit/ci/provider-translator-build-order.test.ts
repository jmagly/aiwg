// Provider translators require compiled model-wrapper modules (#2649, #3732).
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { globSync } from 'glob';
import { parse, stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import defaultConfig from '../../../config/vitest.config.js';
import requiredCommands from '../../../ci/build-required-commands.json';
import { buildOrderViolations } from './workflow-build-order.js';

const root = resolve(import.meta.dirname, '../../..');
const read = (file: string) => readFileSync(resolve(root, file), 'utf8');
const scripts = JSON.parse(read('package.json')).scripts;
const check = (source: string) => buildOrderViolations(source, 'fixture.yml', scripts);
const build = { run: 'npm run build:cli' };
const lint = { run: 'npm run lint:agent-sizes' };
const workflow = (steps: object[]) => stringify({ jobs: { test: { steps } } });

const workflows = ['.gitea/workflows', '.github/workflows'].flatMap(directory =>
  readdirSync(resolve(root, directory)).filter(file => file.endsWith('.yml')).sort().map(file => `${directory}/${file}`));

describe('provider translator steps run after the CLI build', () => {
  it.each(workflows)('checks every job in %s', file => {
    expect(buildOrderViolations(read(file), file, scripts)).toEqual([]);
  });

  it('rejects both historical pre-#3732 orders with actionable job and step locations', () => {
    expect(check(read('test/fixtures/ci/pre-3732-build-order.yml'))).toEqual([
      'fixture.yml: job test, step 1 (Lint deployed agent definition sizes (#1602)): tools/lint/agent-def-sizes.mjs requires npm run build:cli first',
      'fixture.yml: job omp-conformance, step 1 (Native discovery precedence and conditional rule matching): tools/providers/omp-precedence-conformance.mjs requires npm run build:cli first',
    ]);
  });

  it('keeps the declared npm consumer tied to its real entrypoint', () => {
    for (const entry of requiredCommands) {
      if (entry.npmScript === 'lint:context-firewall') {
        expect(entry.reason).toContain('#3745');
        expect(read(entry.nodeScript)).toContain("await importImpl(import.meta.url, 'memory/firewall-classification.mjs')");
      } else {
        expect(entry.reason).toContain('#3732');
        expect(read(entry.nodeScript)).toMatch(/import .*providers\/(?:codex|omp|packaged-codex-agents)\.mjs/);
      }
      if (entry.npmScript) expect(scripts[entry.npmScript]).toBe(`node ${entry.nodeScript}`);
    }
  });

  it('does not borrow a build from another job, even with needs', () => {
    expect(check(stringify({ jobs: {
      build: { steps: [build] }, consumer: { needs: 'build', steps: [lint] },
    } }))).toHaveLength(1);
  });

  it('ignores build mentions in names, comments and echoed strings', () => {
    expect(check(workflow([
      { name: 'npm run build:cli', run: '# npm run build:cli\necho "npm run build:cli"' }, lint,
    ]))).toHaveLength(1);
  });

  it.each([{ if: 'false' }, { 'continue-on-error': true }])('rejects a non-guaranteed build: %j', options => {
    expect(check(workflow([{ ...build, ...options }, lint]))).toHaveLength(1);
  });

  it.each(requiredCommands)('handles missing builds and direct node invocation of $nodeScript', entry => {
    const consumer = { run: `node ./${entry.nodeScript} --output result.json` };
    expect(check(workflow([consumer]))).toHaveLength(1);
    expect(check(workflow([build, consumer]))).toEqual([]);
  });

  it('checks command order within multiline and chained steps, including quoted scripts and env assignments', () => {
    expect(check(workflow([{ run: 'npm run lint:agent-sizes\nnpm run build:cli' }]))).toHaveLength(1);
    expect(check(workflow([{ run: 'npm run "build:cli" && CHECK=1 npm run lint:agent-sizes' }]))).toEqual([]);
    expect(check(workflow([{ run: 'npm run build:cli\nnode tools/providers/omp-precedence-conformance.mjs --output x' }]))).toEqual([]);
  });

  it('follows npm aliases without looping on cyclic scripts', () => {
    expect(buildOrderViolations(workflow([{ run: 'npm run alias' }]), 'alias.yml', {
      alias: 'npm run cycle && npm run lint:agent-sizes', cycle: 'npm run alias',
    })).toHaveLength(1);
  });

  it('runs in the required default test shards on every main push', () => {
    const ci = parse(read('.gitea/workflows/ci.yml'));
    expect(ci.on.push.branches).toContain('main');
    const job = ci.jobs['test-shards'];
    expect(job.if).toBeUndefined();
    expect(job['continue-on-error']).toBeUndefined();
    const step = job.steps.find((entry: { run?: string }) => entry.run?.includes('-- npm test -- --shard='));
    expect(step).toBeDefined();
    expect(step.if).toBeUndefined();
    expect(step['continue-on-error']).toBeUndefined();
    expect(scripts.test).toBe('node tools/testing/run-default-lane.mjs');
    expect(read('tools/testing/run-default-lane.mjs')).toContain("config: 'config/vitest.config.js'");
    const files = globSync(defaultConfig.test.include, { cwd: root, ignore: defaultConfig.test.exclude });
    expect(files).toContain('test/unit/ci/provider-translator-build-order.test.ts');
  });

  it('lints context bridge sizes after the CLI build (#3740)', () => {
    const workflow = read('.gitea/workflows/ci.yml');
    expect(workflow.indexOf('run: npm run lint:context-sizes')).toBeGreaterThan(workflow.indexOf('run: npm run build:cli'));
  });
});
