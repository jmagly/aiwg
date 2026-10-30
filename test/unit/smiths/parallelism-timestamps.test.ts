// Cached timestamps never become fresh evidence merely because context is rendered.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { buildParallelismSection } from '../../../src/smiths/context-pipeline/parallelism-section.js';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';

let project: string;
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'aiwg-parallelism-timestamps-'));
  vi.stubEnv('HOME', project);
  vi.stubEnv('AIWG_CONFIG', join(project, 'config'));
  vi.stubEnv('AIWG_HOME', process.cwd());
  vi.stubEnv('AIWG_HIDE_PARALLELISM_IN_CONTEXT', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(project, { recursive: true, force: true });
});

it.each(['catalog', 'observedAt', 'verifiedAt'] as const)(
  'renders unknown ages and freshness limits when the cached %s timestamp is missing', async field => {
    const f = workerResolutionFixture();
    if (field === 'catalog') delete (f.snapshot.catalog.discovery as { fetchedAt?: string }).fetchedAt;
    else delete (f.snapshot.catalog.discovery!.instances!.codex.models[0].worker as Partial<typeof f.observation>)[field];
    const before = structuredClone(f.snapshot.catalog);
    const section = await buildParallelismSection(project, {
      readConfig: async () => f.snapshot.config,
      validateWorkerConfig: async () => {},
      readCatalog: async () => f.snapshot.catalog,
      now: () => new Date(f.request.now),
    });
    expect(section).toContain('catalog fetchedAt: unknown');
    expect(section).toContain('workers cached observations: 0/2 members; observedAt: unknown; verifiedAt: unknown');
    expect(section).toContain('observation warning after 24 hours; observation blocked after 168 hours; verification blocked after 30 days');
    expect(f.snapshot.catalog).toEqual(before);
  },
);
