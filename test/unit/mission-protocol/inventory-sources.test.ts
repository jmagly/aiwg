// Deleted index candidates are absent sources; other read failures stay observable.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { readInventorySource } from '../../../tools/mission-protocol/inventory.mjs';
let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'inventory-source-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
it('reads replacements and ignores paths removed after indexing', async () => {
  await fs.writeFile(path.join(root, 'old.ts'), 'original');
  await fs.rename(path.join(root, 'old.ts'), path.join(root, 'new.ts'));
  expect(await readInventorySource(root, 'old.ts')).toBeNull();
  expect(await readInventorySource(root, 'new.ts')).toBe('original');
});
it('retains empty sources and propagates errors other than missing paths', async () => {
  await fs.writeFile(path.join(root, 'empty.ts'), '');
  expect(await readInventorySource(root, 'empty.ts')).toBe('');
  await fs.mkdir(path.join(root, 'directory'));
  await expect(readInventorySource(root, 'directory')).rejects.toMatchObject({ code: 'EISDIR' });
});
