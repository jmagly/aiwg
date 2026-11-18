// Build project-local addon skills and rank them against mixed-type packaged competitors.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildIndex } from '../../../src/artifacts/index-builder.js';
import { syncFortemiCoreIndex } from '../../../src/artifacts/fortemi-core-sync.js';
import { discoverCapability } from '../../../src/artifacts/query-engine-discover.js';

const fixture = JSON.parse(fs.readFileSync(new URL('../../fixtures/artifacts/project-local-ranking.json', import.meta.url), 'utf8'));
let root: string;
let project: string;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-name-ranking-'));
  project = path.join(root, 'project');
  for (const key of ['HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) {
    vi.stubEnv(key, path.join(root, key));
  }
  for (const key of ['AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR',
    'AIWG_PROJECT_LOCAL_PATHS', 'AIWG_FRAMEWORK_INDEX_CACHE', 'AIWG_FRAMEWORK_INDEX_CACHE_SOURCE']) vi.stubEnv(key, '');
  const runtime = path.join(root, 'runtime');
  vi.stubEnv('AIWG_ROOT', runtime);
  vi.stubEnv('AIWG_INDEX_WORKERS', '0');
  const put = (file: string, body: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  };
  put(path.join(runtime, 'package.json'), '{"name":"aiwg","version":"1.0.0"}');
  for (const kind of ['frameworks', 'addons', 'extensions', 'agents', 'behaviors']) {
    fs.mkdirSync(path.join(runtime, 'agentic/code', kind), { recursive: true });
  }
  for (const skill of fixture.skills) {
    put(path.join(project, '.aiwg/addons/social-marketing-skills/skills', skill.name, 'SKILL.md'),
      `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n# ${skill.title}\n`);
  }
  for (const item of fixture.competitors) {
    const file = item.type === 'skill' ? `skills/${item.name}/SKILL.md` : `${item.type}s/${item.name}.md`;
    put(path.join(runtime, 'agentic/code/addons/competitors', file),
      `---\nname: ${item.name}\ndescription: ${item.description}\n---\n# ${item.title}\n`);
  }
  await buildIndex(runtime, { graph: 'framework', force: true });
  await buildIndex(project, { graph: 'project', force: true });
  syncFortemiCoreIndex(project, { graph: 'framework' });
  syncFortemiCoreIndex(project, { graph: 'project' });
}, 60_000);

afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('project-local addon name ranking (#4284)', () => {
  for (const backend of ['local', 'fortemi-core'] as const) {
    for (const typeFilter of [undefined, ['skill']]) {
      it.each(fixture.queries)(`${backend} ${typeFilter ?? 'mixed'}: $query`, async ({ query, expected }) => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        try {
          await discoverCapability(project, { phrase: query, backend, typeFilter, json: true, limit: 3 });
          const results = JSON.parse(String(log.mock.calls.at(-1)?.[0])).results;
          expect(results.map((row: { name: string }) => row.name)).toContain(expected);
          expect(results.find((row: { name: string }) => row.name === expected).provenance.graph).toBe('project');
        } finally { log.mockRestore(); }
      });
    }
  }
});
