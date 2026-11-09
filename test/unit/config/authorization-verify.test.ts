// Exercises the existing authorization command surface with an empty local ledger.
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorizationCli } from '../../../src/config/authorization-cli.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
it('verifies an empty authorization ledger through config authorization', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aiwg-grant-verify-')); dirs.push(dir);
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  await expect(authorizationCli(['verify', '--target', dir], dir)).resolves.toBeUndefined();
  expect(JSON.parse(String(output.mock.calls.at(-1)![0]))).toMatchObject({ ok: true, grants: 0 });
});
