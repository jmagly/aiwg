/** Shipped lifecycle templates and the annotated CIPipeline example (#4423). */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Ajv from 'ajv';
import { load, loadAll } from 'js-yaml';

const framework = path.resolve(__dirname, '../../../agentic/code/frameworks/cicd-complete');
const read = (relative: string) => fs.readFileSync(path.join(framework, relative), 'utf8');
const schema = JSON.parse(read('schemas/ci-pipeline.schema.json'));
const validate = new Ajv({ allErrors: true, strict: true }).compile(schema);

describe('CI/CD lifecycle templates', () => {
  it('ships discoverable frontmatter for each registered lifecycle template', () => {
    const manifest = JSON.parse(read('manifest.json'));
    const names = [
      'cicd-intake-template', 'ci-assessment-report-template',
      'ci-pipeline-spec-template', 'ci-environment-plan-template',
      'ci-pipeline-runbook-template', 'ci-pipeline-incident-template',
      'ci-migration-report-template',
    ];
    for (const name of names) {
      expect(manifest.templates).toContain(name);
      const extension = name === 'ci-pipeline-spec-template' ? 'yaml' : 'md';
      const text = read(`templates/${name}.${extension}`);
      const match = text.match(/^---\n([\s\S]*?)\n---\n/);
      expect(match, `frontmatter for ${name}`).not.toBeNull();
      const metadata = load(match![1]) as Record<string, unknown>;
      expect(metadata.name).toBe(name);
      expect(metadata.description).toEqual(expect.any(String));
      expect((metadata.description as string).trim().length).toBeGreaterThan(0);
      expect(metadata.outputKind).toBe(name.replace(/-template$/, ''));
      expect(metadata.aliases).toEqual(expect.arrayContaining([expect.any(String)]));
    }
  });

  it('validates the complete CIPipeline document after YAML template frontmatter', () => {
    const documents = loadAll(read('templates/ci-pipeline-spec-template.yaml'));
    // The first document is discovery metadata, never part of the governed spec.
    expect(documents).toHaveLength(2);
    expect(documents[0]).toMatchObject({ name: 'ci-pipeline-spec-template' });
    expect(validate(documents[1]), JSON.stringify(validate.errors)).toBe(true);
    expect(documents[1]).toMatchObject({
      apiVersion: 'cicd.aiwg.io/v1',
      kind: 'CIPipeline',
      spec: {
        stages: expect.arrayContaining([
          expect.objectContaining({
            rollout: expect.objectContaining({
              strategy: 'canary',
              steps: expect.arrayContaining([
                expect.objectContaining({ weight: 10, gate: expect.any(String) }),
              ]),
              rollback: expect.objectContaining({ on: expect.arrayContaining(['gate-failure']) }),
            }),
          }),
        ]),
      },
    });
  });
});
