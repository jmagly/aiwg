// Persisted model defaults may still use the deprecated Desktop selector.
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigLoader } from '../../../src/models/config-loader.js';
import { validateUserProjectModelConfig } from '../../../src/models/provider-policy.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aiwg-devin-models-'));
  await mkdir(join(root, 'user')); await mkdir(join(root, 'project'));
  vi.stubEnv('AIWG_CONFIG', join(root, 'user'));
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

describe('Desktop model default compatibility', () => {
  it.each(['devin', 'windsurf'])('accepts %s without mutating caller configuration', provider => {
    const value = { defaults: { provider } };
    expect(validateUserProjectModelConfig(value).valid).toBe(true);
    expect(value.defaults.provider).toBe(provider);
  });
  it.each(['user', 'project'])('loads a legacy %s model default as Devin without rewriting its file', async layer => {
    const file = join(root, layer, 'models.json');
    const bytes = JSON.stringify({ defaults: { provider: 'windsurf' } });
    await writeFile(file, bytes);
    const result = await new ConfigLoader(join(root, 'project'), { aiwgHome: resolve('.') }).load();
    expect(result.defaults.provider).toBe('devin');
    expect(await readFile(file, 'utf8')).toBe(bytes);
  });
  it('continues rejecting unknown providers', () => {
    expect(validateUserProjectModelConfig({ defaults: { provider: 'unknown-desktop' } }).valid).toBe(false);
  });
});
