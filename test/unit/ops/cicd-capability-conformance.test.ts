import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import {
  buildOpsSchemaRegistry,
  capabilityReferenceDiagnostics,
  discoverOpsLintFiles,
  validateOpsArtifact,
  validateOpsTemplateFile,
} from '../../../tools/validation/ops-template-conformance.mjs';

const root = process.cwd();
const registry = buildOpsSchemaRegistry(root);
const temporaryRoots: string[] = [];
const json = (file: string) => JSON.parse(readFileSync(join(root, file), 'utf8'));
const fixture = (name: string) => `test/fixtures/ops/${name}.json`;
const invalidKeywords: Record<string, string> = {
  'missing-steps': 'required',
  'missing-step-id': 'required',
  'missing-capability': 'required',
  'depends-on-shape': 'type',
  'input-map': 'type',
  'ambiguous-input': 'oneOf',
  'negative-retry': 'minimum',
  'unknown-step-field': 'additionalProperties',
  'undefined-capability': 'capability-resolution',
};

afterEach(() => {
  for (const directory of temporaryRoots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('DevBuildPlaybook and missing build capabilities (#4419)', () => {
  it('validates the structured build fixture and the migrated template', () => {
    expect(validateOpsArtifact(json(fixture('valid/dev-build-playbook')), { registry }).diagnostics).toEqual([]);
    expect(validateOpsTemplateFile(join(root, 'agentic/code/extensions/dev/templates/build-playbook.yaml'), registry).valid).toBe(true);
  });

  it.each(Object.entries(invalidKeywords))('rejects %s with an actionable diagnostic', (name, keyword) => {
    const report = validateOpsArtifact(json(fixture(`invalid/dev-build-${name}`)), { registry });
    expect(report.valid).toBe(false);
    expect(report.diagnostics.map(diagnostic => diagnostic.keyword)).toContain(keyword);
  });

  it('fails the lint CLI for an undefined capability in either YAML or JSON', () => {
    const doc = json(fixture('invalid/dev-build-undefined-capability'));
    const directory = mkdtempSync(join(tmpdir(), 'cicd-capability-lint-'));
    temporaryRoots.push(directory);
    for (const extension of ['yaml', 'json']) {
      const file = join(directory, `playbook.${extension}`);
      writeFileSync(file, extension === 'yaml' ? yaml.dump(doc) : JSON.stringify(doc));
      const result = spawnSync(process.execPath, ['tools/validation/ops-template-conformance.mjs', file], {
        cwd: root, encoding: 'utf8', timeout: 60_000,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("undefined OpsCapability 'ci-undefined'");
      expect(result.stderr).toContain('/spec/steps/0/capability');
    }
  });

  it('rejects missing DevBuildPlaybook variables and step outputs', () => {
    const doc = json(fixture('valid/dev-build-playbook'));
    doc.spec.steps[0].inputs = [{ name: 'path', from: 'vars.missing' }];
    doc.spec.steps[3].inputs = [{ name: 'scan_evidence', from: 'steps.scan-image.outputs.missing' }];
    const result = validateOpsArtifact(doc, { registry });
    expect(result.diagnostics.map(diagnostic => diagnostic.message)).toEqual([
      "unknown playbook variable 'missing'", "unknown step output 'scan-image.missing'",
    ]);
  });
});

describe('CI/CD capability library (#4424)', () => {
  const manifest = json('agentic/code/frameworks/cicd-complete/manifest.json');
  it('validates every registered capability with no duplicate build definitions', () => {
    expect(registry.registrationErrors).toEqual([]);
    expect(manifest.capabilities).toHaveLength(15);
    for (const name of manifest.capabilities) {
      const file = registry.capabilities.get(name);
      expect(file, name).toBe(join(root, `agentic/code/frameworks/cicd-complete/capabilities/${name}.yaml`));
      expect(validateOpsTemplateFile(file, registry).valid, name).toBe(true);
    }
    for (const name of ['dev-pipeline-validate', 'docker-build', 'image-scan', 'docker-push']) {
      expect(registry.capabilities.get(name)).toBe(join(root, `agentic/code/frameworks/ops-complete/capabilities/${name}.yaml`));
      expect(manifest.capabilities).not.toContain(name);
    }
  });

  it('includes every cicd valid fixture in default lint discovery and resolves all references', () => {
    const directory = join(root, 'test/fixtures/cicd/valid');
    const files = readdirSync(directory).filter(file => file.endsWith('.json')).map(file => join(directory, file));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(discoverOpsLintFiles(root)).toContain(file);
      expect(validateOpsTemplateFile(file, registry).diagnostics, file).toEqual([]);
    }
  });

  it('finds missing job, rollout step and rollback capabilities in pipeline fixtures', () => {
    const doc = json('test/fixtures/cicd/valid/ci-pipeline-flag.json');
    doc.spec.stages[0].jobs[0].capability = 'ci-missing-job';
    doc.spec.stages[0].rollout.steps[0].capability = 'ci-missing-step';
    doc.spec.stages[0].rollout.rollback.capability = 'ci-missing-rollback';
    const diagnostics = capabilityReferenceDiagnostics(doc, registry);
    expect(diagnostics.map(diagnostic => diagnostic.path)).toEqual([
      '/spec/stages/0/jobs/0/capability',
      '/spec/stages/0/rollout/steps/0/capability',
      '/spec/stages/0/rollout/rollback/capability',
    ]);
  });

  it('resolves the implicit flag rollout capability without mutating the fixture', () => {
    const doc = json('test/fixtures/cicd/valid/ci-pipeline-flag.json');
    const capabilities = new Map(registry.capabilities);
    capabilities.delete('progressive-rollout');
    const diagnostics = capabilityReferenceDiagnostics(doc, { ...registry, capabilities });
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0].message).toContain("default OpsCapability 'progressive-rollout'");
    expect(doc.spec.stages[0].rollout.steps[0]).not.toHaveProperty('capability');
  });

  it('fails closed when a capability file is malformed or duplicated', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cicd-capability-registry-'));
    temporaryRoots.push(directory);
    const schemas = join(directory, 'agentic/code/frameworks/ops-complete/schemas/metalanguage');
    const capabilities = join(directory, 'agentic/code/frameworks/ops-complete/capabilities');
    mkdirSync(schemas, { recursive: true });
    mkdirSync(capabilities, { recursive: true });
    const schema = readFileSync(join(root, 'agentic/code/frameworks/ops-complete/schemas/metalanguage/ops-capability.schema.json'));
    writeFileSync(join(schemas, 'ops-capability.schema.json'), schema);
    const capability = readFileSync(join(root, 'agentic/code/frameworks/ops-complete/capabilities/docker-build.yaml'));
    writeFileSync(join(capabilities, 'a.yaml'), capability);
    writeFileSync(join(capabilities, 'b.yaml'), capability);
    writeFileSync(join(capabilities, 'c.yaml'), 'kind: OpsCapability\n');
    const report = buildOpsSchemaRegistry(directory);
    expect(report.registrationErrors).toHaveLength(2);
    expect(report.registrationErrors.join('\n')).toContain("duplicate OpsCapability 'docker-build'");
    expect(report.registrationErrors.join('\n')).toContain('invalid OpsCapability');
  });
});
