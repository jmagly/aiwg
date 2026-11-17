// Offline provider fixtures expose native pins separately from inherited or global selection.
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { load } from 'js-yaml';
import fixture from '../../fixtures/model-wrappers/enforcement.json';
import { MODEL_WRAPPER_DEFINITIONS } from '../../../src/models/wrapper-definitions.js';
import { loadProviderModelCatalog } from '../../../src/models/catalog-policy.js';

const catalog = loadProviderModelCatalog();
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));
const native = Object.entries(fixture).filter(([, row]) => 'model' in row);
const source = (name: string) => readFileSync(`agentic/code/addons/aiwg-utils/agents/${name}.md`, 'utf8');
const fields = (provider: string, text: string): Record<string, unknown> => provider === 'codex'
  ? Object.fromEntries(text.split('\n').flatMap(line => {
    const match = line.match(/^(model|model_reasoning_effort) = (.*)$/);
    return match ? [[match[1], JSON.parse(match[2])]] : [];
  })) : load(text.match(/^---\n([\s\S]*?)\n---/)![1]) as Record<string, unknown>;
const translator = async (provider: string) => (await import(`../../../tools/agents/providers/${provider}.mjs`)).transformAgent;

describe('wrapper tier and effort enforcement', () => {
  it('reproduces preservation of an ordinary Codex unknown explicit model', async () => {
    const { mapModel } = await import('../../../tools/agents/providers/codex.mjs');
    expect(mapModel('operator-private-model', {}, {})).toBe('operator-private-model');
  });

  it.each(native)('%s pins all wrappers with native effort where available', async (provider, row) => {
    const translate = await translator(provider);
    for (const wrapper of MODEL_WRAPPER_DEFINITIONS) {
      const opts = { quiet: true, modelCatalog: catalog,
        ...(provider === 'omp' ? { [`${wrapper.role}Model`]: `fixture/${wrapper.role}` } : {}) };
      const output = fields(provider, translate('fixture.md', source(wrapper.name), opts));
      const entry = catalog.providers[provider as keyof typeof catalog.providers]!;
      // Cursor falls back to the standard/coding pin only while its economy role is `auto` (never dispatched).
      const fallback = provider === 'cursor' && wrapper.tier === 'economy' && entry.roles.efficiency.id === 'auto';
      const expected = provider === 'omp' ? `fixture/${wrapper.role}`
        : entry.tiers?.[fallback ? 'standard' : wrapper.tier].id ?? entry.roles[fallback ? 'coding' : wrapper.role].id;
      expect(output.model).toBe(expected);
      if ('effort' in row) expect(output[row.effort]).toBe(wrapper.effort);
      else for (const key of ['effort', 'model_reasoning_effort', 'reasoningEffort', 'thinkingLevel']) expect(output[key]).toBeUndefined();
    }
  });

  it.each(native)('%s preserves explicit operator pins on every wrapper', async (provider, row) => {
    const translate = await translator(provider);
    for (const wrapper of MODEL_WRAPPER_DEFINITIONS) {
      for (const pin of ['operator-private-model', 'gpt-6.1-sol']) {
        const content = source(wrapper.name).replace(/^model: .*$/m, `model: ${pin}`);
        expect(fields(provider, translate('fixture.md', content, { quiet: true, modelCatalog: catalog })).model).toBe(pin);
      }
      for (const opts of [{ [`${wrapper.role}Model`]: 'operator-model' },
        { modelsConfig: { [provider]: { [wrapper.role]: { model: 'operator-model' } } } }]) {
        expect(fields(provider, translate('fixture.md', source(wrapper.name), { quiet: true, modelCatalog: catalog, ...opts })).model).toBe('operator-model');
      }
      const content = source(wrapper.name).replace('\n---', '\nmodel-override: operator-exact\nmodel-effort: high\n---');
      const output = fields(provider, translate('fixture.md', content, { quiet: true, modelCatalog: catalog }));
      expect(output.model).toBe('operator-exact');
      if ('effort' in row) expect(output[row.effort]).toBe('high');
    }
  });

  it.each(native)('%s deploys operator model and effort pins without parent defaults', async (provider, row) => {
    const adapter = await import(`../../../tools/agents/providers/${provider}.mjs`);
    const root = await mkdtemp(join(tmpdir(), 'aiwg-pinned-wrappers-')); roots.push(root);
    adapter.deployAgents(MODEL_WRAPPER_DEFINITIONS.map(wrapper =>
      join(process.cwd(), 'agentic/code/addons/aiwg-utils/agents', `${wrapper.name}.md`)), root, {
      quiet: true, force: true, dryRun: false, provider, modelCatalog: catalog,
      reasoningModel: 'fixture/reasoning', codingModel: 'fixture/coding', efficiencyModel: 'fixture/efficiency',
    });
    for (const wrapper of MODEL_WRAPPER_DEFINITIONS) {
      const extension = provider === 'codex' ? '.toml' : provider === 'copilot' ? '.agent.md' : '.md';
      const output = fields(provider, await readFile(join(root, adapter.paths.agents, wrapper.name + extension), 'utf8'));
      expect(output.model).toBe(`fixture/${wrapper.role}`);
      if ('effort' in row) expect(output[row.effort]).toBe(wrapper.effort);
    }
  });
});
