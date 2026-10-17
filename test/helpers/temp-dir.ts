/** File-owned temporary directories, including failed tests and setup hooks. */
import { mkdtempSync as createSync, rmSync } from 'node:fs';
import { mkdtemp as create } from 'node:fs/promises';
import { afterAll } from 'vitest';

const directories = new Set<string>();

// File scope also covers fixtures shared by multiple tests. Register cleanup
// before creating anything so assertion/setup failures cannot bypass it.
afterAll(() => {
  const errors: unknown[] = [];
  for (const directory of directories) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }
  }
  directories.clear();
  if (errors.length) throw new AggregateError(errors, 'Temporary directory cleanup failed');
});

export function mkdtempSync(prefix: string): string {
  const directory = createSync(prefix);
  directories.add(directory);
  return directory;
}

export async function mkdtemp(prefix: string): Promise<string> {
  const directory = await create(prefix);
  directories.add(directory);
  return directory;
}
