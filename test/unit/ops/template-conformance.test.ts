import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import {
  buildOpsSchemaRegistry,
  discoverOpsTemplates,
  discoverOpsLintFiles,
  validateAllOpsTemplates,
  validateOpsArtifact,
} from '../../../tools/validation/ops-template-conformance.mjs';

const root = process.cwd();
const temporaryRoots: string[] = [];

function template(name: string): Record<string, unknown> {
  return yaml.load(readFileSync(join(root, 'agentic/code/extensions/it/templates', name), 'utf8')) as Record<string, unknown>;
}

afterEach(() => {
  for (const directory of temporaryRoots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('ops extension template conformance', () => {
  it('discovers and validates every shipped extension YAML template', () => {
    const files = discoverOpsTemplates(root);
    const report = validateAllOpsTemplates(root);

    expect(files).toHaveLength(15);
    expect(report.registry.registrationErrors).toEqual([]);
    expect(report.results.map(result => result.filePath)).toEqual(discoverOpsLintFiles(root));
    expect(report.results.filter(result => !result.valid)).toEqual([]);
    expect(report.valid).toBe(true);
  });

  it('keeps valid core artifacts conformant', () => {
    const capability = yaml.load(readFileSync(
      join(root, 'agentic/code/frameworks/ops-complete/capabilities/dns-register.yaml'),
      'utf8',
    ));

    expect(validateOpsArtifact(capability, { registry: buildOpsSchemaRegistry(root) })).toMatchObject({ valid: true });
  });

  it('reports actionable paths for unknown fields and wrong value shapes', () => {
    const registry = buildOpsSchemaRegistry(root);
    const asset = structuredClone(template('asset-record.yaml')) as any;
    asset.spec.unexpected = true;
    const service = structuredClone(template('service-record.yaml')) as any;
    service.spec.backup.enabled = 'false';

    const unknown = validateOpsArtifact(asset, { filePath: 'asset-record.yaml', registry });
    const wrongShape = validateOpsArtifact(service, { filePath: 'service-record.yaml', registry });

    expect(unknown.valid).toBe(false);
    expect(unknown.diagnostics).toContainEqual(expect.objectContaining({ path: '/spec/unexpected', keyword: 'additionalProperties' }));
    expect(wrongShape.valid).toBe(false);
    expect(wrongShape.diagnostics).toContainEqual(expect.objectContaining({ path: '/spec/backup/enabled', keyword: 'type' }));
  });

  it('requires valid governance and lifecycle metadata on sensitive IT records', () => {
    const registry = buildOpsSchemaRegistry(root);
    const missing = structuredClone(template('asset-record.yaml')) as any;
    delete missing.metadata.governance;
    const invalid = structuredClone(template('network-state.yaml')) as any;
    invalid.metadata.governance.classification = 'PUBLIC';

    const missingResult = validateOpsArtifact(missing, { filePath: 'asset-record.yaml', registry });
    const invalidResult = validateOpsArtifact(invalid, { filePath: 'network-state.yaml', registry });

    expect(missingResult.valid).toBe(false);
    expect(missingResult.diagnostics).toContainEqual(expect.objectContaining({ path: '/metadata', keyword: 'required' }));
    expect(invalidResult.valid).toBe(false);
    expect(invalidResult.diagnostics).toContainEqual(expect.objectContaining({
      path: '/metadata/governance/classification', keyword: 'pattern',
    }));
  });

  it('rejects unsupported and unresolved playbook references', () => {
    const registry = buildOpsSchemaRegistry(root);
    const unsupported = structuredClone(template('provisioning-playbook.yaml')) as any;
    unsupported.spec.steps[0].inputs[0].from = '{{ hostname }}';
    const unresolved = structuredClone(template('provisioning-playbook.yaml')) as any;
    unresolved.spec.steps[0].inputs[0].from = 'vars.missing';

    const unsupportedResult = validateOpsArtifact(unsupported, { registry });
    const unresolvedResult = validateOpsArtifact(unresolved, { registry });

    expect(unsupportedResult.valid).toBe(false);
    expect(unsupportedResult.diagnostics).toContainEqual(expect.objectContaining({ keyword: 'structured-reference' }));
    expect(unresolvedResult.valid).toBe(false);
    expect(unresolvedResult.diagnostics).toContainEqual(expect.objectContaining({
      path: '/spec/steps/0/inputs/0/from',
      keyword: 'reference-resolution',
      message: "unknown playbook variable 'missing'",
    }));
  });

  it('loads a third-party kind from its ADDON manifest without framework changes', () => {
    const project = mkdtempSync(join(tmpdir(), 'aiwg-ops-extension-'));
    temporaryRoots.push(project);
    const extension = join(project, 'agentic/code/extensions/acme');
    mkdirSync(join(extension, 'schemas'), { recursive: true });
    mkdirSync(join(extension, 'templates'), { recursive: true });
    writeFileSync(join(extension, 'ADDON.yaml'), [
      'apiVersion: ops.aiwg.io/v1',
      'kind: OpsExtension',
      'metadata:',
      '  name: acme',
      'spec:',
      '  extends: ops-complete',
      '  description: Acme extension',
      '  version: 1.0.0',
      '  kinds:',
      '    - name: AcmeRecord',
      '      schema: schemas/acme-record.schema.json',
      '',
    ].join('\n'));
    writeFileSync(join(extension, 'schemas/acme-record.schema.json'), JSON.stringify({
      $schema: 'http://json-schema.org/draft-07/schema#',
      $id: 'https://example.test/acme-record.schema.json',
      type: 'object',
      required: ['apiVersion', 'kind', 'metadata', 'spec'],
      additionalProperties: false,
      properties: {
        apiVersion: { const: 'acme.ops.aiwg.io/v1' },
        kind: { const: 'AcmeRecord' },
        metadata: { type: 'object', required: ['name'], properties: { name: { type: 'string' } }, additionalProperties: false },
        spec: { type: 'object', required: ['value'], properties: { value: { type: 'string' } }, additionalProperties: false },
      },
    }, null, 2));
    writeFileSync(join(extension, 'templates/record.yaml'), [
      'apiVersion: acme.ops.aiwg.io/v1',
      'kind: AcmeRecord',
      'metadata:',
      '  name: example',
      'spec:',
      '  value: valid',
      '',
    ].join('\n'));

    const report = validateAllOpsTemplates(project);
    expect(report.registry.registrationErrors).toEqual([]);
    expect(report.results).toHaveLength(1);
    expect(report.valid).toBe(true);
  });
});
