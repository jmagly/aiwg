/** Full-corpus golden against the Phase A show and deploy resolvers. No CLI children. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { buildIndex } from '../../../src/artifacts/index-builder.js';
import { resolveRuleBindingTarget, rulesBoundTo, showArtifact } from '../../../src/artifacts/query-engine.js';
import * as relations from '../../../src/artifacts/relations.js';
import { buildPrebuiltRelations } from '../../../src/artifacts/prebuilt-relations.js';
import { relationId } from '../../../src/artifacts/relations-builder.js';
import { loadRelations, type RelationsReader } from '../../../src/artifacts/relations.js';
import { getGraphIndexDir, type ArtifactIndex, type MetadataEntry } from '../../../src/artifacts/types.js';

const corpus = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
let isolated: string;
let entries: MetadataEntry[];
let reader: RelationsReader;
beforeAll(async () => {
  isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-relations-corpus-'));
  for (const key of ['HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) vi.stubEnv(key, path.join(isolated, key));
  for (const key of ['AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR']) vi.stubEnv(key, '');
  vi.stubEnv('AIWG_ROOT', corpus);
  await buildIndex(corpus, { graph: 'framework', force: true, quiet: true });
  entries = Object.values((JSON.parse(fs.readFileSync(path.join(getGraphIndexDir(corpus, 'framework'), 'metadata.json'), 'utf8')) as ArtifactIndex).entries);
  reader = loadRelations(corpus)!;
}, 60_000);
afterAll(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(isolated, { recursive: true, force: true }); });

describe('full corpus relationship golden', () => {
  it('ships issue-update templates and their reverse ownership without a local index', async () => {
    const selected = relations.selectPrebuiltRelations(corpus).reader!;
    const skill = entries.find(entry => entry.type === 'skill' && entry.name === 'issue-update')!;
    const templates = selected.templatesForTarget('skill', relationId(skill)).map(id => selected.index.templates![id]);
    expect(templates.filter(template => template.path.includes('/issue-comments/')).map(template => template.name).sort())
      .toEqual(['blocker-found', 'feedback-needed', 'progress-update', 'task-completed']);
    for (const template of templates) expect(selected.targetsForTemplate(template.path)).toContainEqual({ type: 'skill', id: relationId(skill) });
  });

  it('validates the full corpus sidecar against its registered schema', () => {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(JSON.parse(fs.readFileSync(path.join(corpus, 'schemas/artifacts/relations.v1.schema.json'), 'utf8')));
    expect(validate(reader.index), JSON.stringify(validate.errors)).toBe(true);
  });
  it('matches every forward binding resolved by deploy, plus its flow skill projection', () => {
    const rules = entries.filter(entry => ['rule', 'behavior'].includes(entry.type));
    expect(rules.length).toBeGreaterThan(100);
    for (const rule of rules) {
      const expected = new Map<string, { type: string; id: string }>();
      for (const [key, type] of Object.entries({ skills: 'skill', agents: 'agent', flows: 'flow' } as const)) {
        for (const alias of rule.bound_to?.[key as 'skills' | 'agents' | 'flows'] ?? []) {
          const target = resolveRuleBindingTarget(entries, type, alias);
          const id = relationId(target);
          expected.set(`${type}:${id}`, { type, id });
          if (type === 'flow') expected.set(`skill:projected:${id}`, { type: 'skill', id: `projected:${id}` });
          expect(reader.rulesForTarget(type, alias), `${rule.path} -> ${alias}`).toContain(relationId(rule));
        }
      }
      expect(reader.targetsForRule(relationId(rule)), rule.path).toEqual([...expected.values()].sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`)));
    }
  });

  it('matches show reverse bindings for every indexed action artifact and all flow projections', () => {
    const targets = entries.filter(entry => ['skill', 'agent', 'flow', 'command'].includes(entry.type));
    expect(targets.length).toBeGreaterThan(500);
    for (const target of targets) {
      expect(reader.rulesForTarget(target.type as 'skill', relationId(target)), target.path).toEqual(rulesBoundTo(entries, target).map(relationId));
    }
    for (const [key, projection] of Object.entries(reader.index.targets)) {
      if (!projection.projected_from) continue;
      expect(projection.rules, key).toEqual(reader.rulesForTarget('flow', projection.projected_from.id));
      expect(projection.rule_stats).toEqual(reader.ruleStats('flow', projection.projected_from.id));
    }
  }, 120_000);

  it('matches actual show --json bound_rules for every bound artifact in the corpus', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    // Selection is tested separately; reuse the validated reader for this batch.
    const ensure = vi.spyOn(relations, 'ensureRelations').mockResolvedValue(reader);
    try {
      for (const type of ['skill', 'agent', 'flow'] as const) {
        const samples = entries.filter(entry => entry.type === type && reader.rulesForTarget(type, relationId(entry)).length);
        expect(samples.length).toBeGreaterThan(3);
        for (const target of samples) {
          log.mockClear();
          await showArtifact(corpus, { name: relationId(target), typeFilter: [type], graph: 'framework', backend: 'local', json: true });
          const shown = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
          const expected = rulesBoundTo(entries, target).map(rule => {
            const name = rule.name ?? path.basename(rule.path, '.md');
            return { name, activation: rule.activation ?? null, enforcement: rule.ruleEnforcement ?? null, precedence: rule.rulePrecedence ?? 'medium', overridable: rule.ruleOverridable ?? true, precedence_source: 'rule', project_context: false, summary: rule.ruleSummary ?? '', show_command: `aiwg show ${rule.type} ${name} --body` };
          });
          expect(shown.bound_rules, target.path).toEqual(expected);
        }
      }
    } finally { log.mockRestore(); ensure.mockRestore(); }
  }, 120_000);

  it('matches all shipped prebuilt tables byte for byte from a fresh corpus build', () => {
    const tables = buildPrebuiltRelations(corpus, entries);
    expect(tables['relations.json']).toBe(fs.readFileSync(path.join(getGraphIndexDir(corpus, 'framework'), 'relations.json'), 'utf8'));
    for (const [file, text] of Object.entries(tables)) {
      expect(text, file).toBe(fs.readFileSync(path.join(corpus, 'prebuilt/framework-relations', file), 'utf8'));
    }
  });
});
