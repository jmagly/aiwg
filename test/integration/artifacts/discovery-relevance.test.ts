import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildIndex } from '../../../src/artifacts/index-builder.js';
import { parseDiscoveryRelevanceJsonl } from '../../../src/artifacts/discovery-eval.js';
import { syncFortemiCoreIndex } from '../../../src/artifacts/fortemi-core-sync.js';
import { discoverCapability } from '../../../src/artifacts/query-engine.js';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const queries = parseDiscoveryRelevanceJsonl(fs.readFileSync(
  path.join(repoRoot, 'test/fixtures/artifacts/discovery-relevance.jsonl'), 'utf8',
)).filter(query => query.id.startsWith('3067-'));

describe('plain-language discovery relevance against shipped skills and competing hits (#3067)', () => {
  let tmp: string;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-discovery-relevance-'));
    vi.stubEnv('XDG_DATA_HOME', path.join(tmp, 'xdg'));
    vi.stubEnv('AIWG_ROOT', tmp);
    // Keep real metadata for the owning skills and the competing hits from
    // #3067. Do not copy the entire documentation/schema corpus into this test.
    const sources = [
      ...['address-issues', 'issue-planner', 'artifact-orchestration',
        'flow-architecture-evolution', 'flow-inception-to-elaboration'].map(
        name => `agentic/code/frameworks/sdlc-complete/skills/${name}/SKILL.md`,
      ),
      ...['new-project', 'add-template', 'steward', 'aiwg-issue',
        'config-validator', 'feedback', ...fs.readdirSync(path.join(
          repoRoot, 'agentic/code/addons/aiwg-utils/skills',
        )).filter(name => name.startsWith('aiwg-regenerate'))].map(
        name => `agentic/code/addons/aiwg-utils/skills/${name}/SKILL.md`,
      ),
      'agentic/code/addons/schema-governance/skills/schema-author/SKILL.md',
      'agentic/code/addons/aiwg-utils/rules/skill-discovery.md',
    ];
    for (const source of sources) {
      const target = path.join(tmp, source);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(repoRoot, source), target);
    }
    expect(queries).toHaveLength(3);
    await buildIndex(tmp, { graph: 'framework', force: true });
    syncFortemiCoreIndex(tmp, { graph: 'framework' });
  }, 60_000);

  afterAll(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  for (const backend of ['local', 'fortemi-core'] as const) {
    it.each(queries)(`${backend}: $query returns its owning skill in the top three`, async query => {
      const output = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await discoverCapability(tmp, {
          phrase: query.query, backend, graph: 'framework', limit: 3, json: true,
        });
        const result = JSON.parse(output.mock.calls.map(call => call[0]).join(''));
        const ids = result.results.map((item: { type: string; name: string }) => `${item.type}:${item.name}`);
        expect(ids, query.notes).toEqual(expect.arrayContaining(query.relevant_ids));
      } finally {
        output.mockRestore();
      }
    });
  }
});
