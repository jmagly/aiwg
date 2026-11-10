// Verify installation binding separately from settings parsing and config validation.
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { readAiwgConfig } from '../../../src/config/aiwg-config.js';
import { discoverProjectFactoryModels } from '../../../src/models/factory-models.js';

vi.mock('../../../src/config/aiwg-config.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/config/aiwg-config.js')>(),
  readAiwgConfig: vi.fn(),
}));
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it.each(['single', 'disabled', 'multiple', 'implicit', 'empty', 'missing'] as const)(
  'binds only a single enabled Factory installation (%s)', async mode => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-factory-project-')); roots.push(root);
    await mkdir(join(root, '.factory'));
    await writeFile(join(root, '.factory/settings.json'), JSON.stringify({ customModels: [
      { model: 'synthetic/model', displayName: 'Synthetic', provider: 'openai' },
    ] }));
    const factory = { adapter: 'providers:factory', executable: '/synthetic/droid', accountScope: 'synthetic-account' };
    const clis = mode === 'single' ? { byok: factory, ignored: { adapter: 'providers:codex' } }
      : mode === 'disabled' ? { byok: { ...factory, enabled: false } }
      : mode === 'multiple' ? { byok: factory, second: factory }
      : mode === 'implicit' ? { factory: { executable: '/synthetic/droid' } } : {};
    vi.mocked(readAiwgConfig).mockResolvedValue(mode === 'missing' ? null : mode === 'empty' ? {} : { parallelism: { clis } });
    const runner = vi.fn(async () => ({ stdout: '1.0.0', stderr: '', exitCode: 0 }));
    const observed = await discoverProjectFactoryModels(root, { homeDir: root, runner });
    const bound = mode === 'single' || mode === 'implicit';
    expect(readAiwgConfig).toHaveBeenCalledWith(root);
    expect(runner).toHaveBeenCalledWith(bound ? '/synthetic/droid' : 'droid', ['--version'], expect.any(Object));
    expect(observed.errorKind).toBeUndefined();
    expect(observed.models).toMatchObject([{ id: 'custom:Synthetic-0', worker: {
      cliId: mode === 'single' ? 'byok' : 'factory',
      accountScope: mode === 'single' ? 'synthetic-account' : 'local-account',
    } }]);
    expect(observed.accountBinding).toBe(mode === 'single' ? 'synthetic-account' : undefined);
  });
