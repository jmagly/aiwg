// Verify bundled model defaults across corpus and slim runtime package layouts.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigLoader } from '../../../src/models/config-loader.js';

let root: string;
let corpus: string;
let runtime: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aiwg-default-paths-'));
  corpus = join(root, 'package/agentic/code/frameworks/sdlc-complete/config/models-v2.json');
  runtime = join(root, 'package/dist/src/models/models-v2.json');
  vi.stubEnv('AIWG_CONFIG', join(root, 'user'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function defaults(file: string, provider: string) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({
    version: '2.0', defaults: { provider, tier: 'standard' }, tiers: {}, providers: {},
  }));
}

describe('T-OG-01 #2644 bundled model default paths', () => {
  it.each([
    { corpusPresent: false, runtimePresent: true, provider: 'codex' },
    { corpusPresent: true, runtimePresent: false, provider: 'claude' },
    { corpusPresent: true, runtimePresent: true, provider: 'claude' },
  ])('loads the selected defaults with corpus=$corpusPresent runtime=$runtimePresent', async row => {
    if (row.corpusPresent) await defaults(corpus, 'claude');
    if (row.runtimePresent) await defaults(runtime, 'codex');
    const loader = new ConfigLoader(join(root, 'project'), { aiwgHome: join(root, 'package') });

    expect(loader.getLocations().aiwgDefault).toBe(row.corpusPresent ? corpus : runtime);
    expect((await loader.load()).defaults).toMatchObject({ provider: row.provider, tier: 'standard' });
  });

  it('reports the canonical missing file when neither layout supplies defaults', async () => {
    const loader = new ConfigLoader(join(root, 'project'), { aiwgHome: join(root, 'package') });

    expect(loader.getLocations().aiwgDefault).toBe(corpus);
    await expect(loader.load()).rejects.toThrow('Failed to load AIWG default config:');
    await expect(loader.load()).rejects.toThrow(corpus);
  });
});
