import { lstat } from 'node:fs/promises';
import { basename } from 'node:path';

/** Never read or update a provider instruction file through a filesystem link. */
export async function assertSafeContextFile(filePath: string): Promise<void> {
  let stat;
  try { stat = await lstat(filePath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Refusing unsafe ${basename(filePath)} target: ${filePath}`);
  }
}
