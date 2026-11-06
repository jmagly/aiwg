// Verify natural issue/PR requests rank first against the shipped template corpus.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildIndex } from '../../../src/artifacts/index-builder.js';
import { syncFortemiCoreIndex } from '../../../src/artifacts/fortemi-core-sync.js';
import { discoverCapability } from '../../../src/artifacts/query-engine.js';

const repo = path.resolve(import.meta.dirname, '../../..');
const cases = [
  ['write a bug report issue', 'agentic/code/addons/aiwg-utils/templates/issues/bug-report.md'],
  ['feature request issue template', 'agentic/code/addons/aiwg-utils/templates/issues/feature-request.md'],
  ['pull request description', 'agentic/code/addons/aiwg-utils/templates/pull-requests/description.md'],
  ['post a status update on an issue', 'agentic/code/frameworks/sdlc-complete/templates/issue-comments/progress-update.md'],
];

describe('issue and PR template discovery relevance (#3931)', () => {
  let tmp: string;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-template-discovery-'));
    vi.stubEnv('XDG_DATA_HOME', path.join(tmp, 'xdg'));
    vi.stubEnv('AIWG_ROOT', tmp);
    // Include all competing bundled templates, not just the four expected hits.
    for (const kind of ['addons', 'frameworks', 'extensions']) {
      const relative = `agentic/code/${kind}`;
      fs.cpSync(path.join(repo, relative), path.join(tmp, relative), {
        recursive: true,
        filter: source => fs.statSync(source).isDirectory() || source.includes(`${path.sep}templates${path.sep}`),
      });
    }
    await buildIndex(tmp, { graph: 'framework', force: true });
    syncFortemiCoreIndex(tmp, { graph: 'framework' });
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  for (const backend of ['local', 'fortemi-core'] as const) {
    it.each(cases)(`${backend}: %s ranks its required template first`, async (phrase, expectedPath) => {
      const output = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await discoverCapability(tmp, {
          phrase, backend, graph: 'framework', typeFilter: ['template'], limit: 3, json: true,
        });
        const result = JSON.parse(output.mock.calls.map(call => call[0]).join(''));
        expect(result.results[0]).toMatchObject({ type: 'template', path: path.join(tmp, expectedPath) });
      } finally {
        output.mockRestore();
      }
    });
  }
});
