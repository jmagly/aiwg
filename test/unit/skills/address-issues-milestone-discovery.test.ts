// Rank milestone delivery against competing shipped issue and iteration surfaces.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildIndex } from '../../../src/artifacts/index-builder.js';
import { syncFortemiCoreIndex } from '../../../src/artifacts/fortemi-core-sync.js';
import { discoverCapability } from '../../../src/artifacts/query-engine.js';

const repo = path.resolve(import.meta.dirname, '../../..');
describe('milestone worker routing (#3916)', () => {
  let tmp: string;
  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-milestone-discovery-'));
    vi.stubEnv('XDG_DATA_HOME', path.join(tmp, 'xdg'));
    vi.stubEnv('AIWG_ROOT', tmp);
    // Include all competing canonical skills and commands, not just known hits.
    for (const kind of ['addons', 'frameworks', 'extensions']) {
      const relative = `agentic/code/${kind}`;
      fs.cpSync(path.join(repo, relative), path.join(tmp, relative), {
        recursive: true,
        filter: source => fs.statSync(source).isDirectory() || source.endsWith('/SKILL.md')
          || (source.includes('/commands/') && source.endsWith('.md')),
      });
    }
    await buildIndex(tmp, { graph: 'framework', force: true });
    syncFortemiCoreIndex(tmp, { graph: 'framework' });
  }, 60_000);
  afterAll(() => {
    vi.unstubAllEnvs();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });
  const cases = (['local', 'fortemi-core'] as const).flatMap(backend =>
    ['work through this milestone with workers', 'work this milestone',
      'get the engineering track going'].map(phrase => ({ backend, phrase })));
  it.each(cases)('$backend: $phrase ranks address-issues first', async ({ backend, phrase }) => {
      const output = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await discoverCapability(tmp, { phrase, backend, graph: 'framework', limit: 3, json: true });
        const result = JSON.parse(output.mock.calls.map(call => call[0]).join(''));
        expect(result.results[0]).toMatchObject({ type: 'skill', name: 'address-issues' });
      } finally { output.mockRestore(); }
  });
});
