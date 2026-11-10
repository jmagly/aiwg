// Exercise the post-stat size guard with a synthetic growing settings file.
import { mkdtemp, open, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { discoverFactoryModels } from '../../../src/models/factory-models.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});
vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});

it('fails closed with default options when Droid is absent from an isolated PATH', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiwg-factory-no-runtime-'));
  vi.mocked(homedir).mockReturnValue(root);
  vi.stubEnv('PATH', root);
  try {
    const observed = await discoverFactoryModels();
    expect(observed).toMatchObject({ models: [], errorKind: 'command',
      error: 'Factory version probe failed; no current custom model observations.' });
    expect(homedir).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});

it('rejects settings that grow past the byte bound after stat and closes the handle', async () => {
  const handle = {
    stat: vi.fn(async () => ({ isFile: () => true, size: 10 })),
    read: vi.fn(async () => ({ bytesRead: 1024 * 1024 + 1 })),
    close: vi.fn(async () => {}),
  };
  vi.mocked(open).mockResolvedValueOnce(handle as unknown as Awaited<ReturnType<typeof open>>);
  const observed = await discoverFactoryModels({ homeDir: tmpdir(), runtimeVersion: '1.0.0' });
  expect(observed).toMatchObject({ models: [], errorKind: 'invalid-output',
    error: 'Factory settings.json could not be read or parsed within bounds; built-in plan models have no non-interactive model-list command.' });
  expect(handle.read).toHaveBeenCalledWith(expect.any(Buffer), 0, 1024 * 1024 + 1, 0);
  expect(handle.close).toHaveBeenCalledOnce();
});
