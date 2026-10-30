// Refresh recorded context digests through the same rollback-safe writer.
import fs from 'node:fs';
import path from 'node:path';

export function refreshRecordedContextOutput(
  file: string,
  previousHash: string | undefined,
  currentHash: string,
  write: (file: string, content: string) => void,
): void {
  if (!previousHash || previousHash === currentHash || path.basename(file) === '.aiwg-manifest.json') return;
  const sidecar = path.join(path.dirname(file), '.aiwg', '.aiwg-manifest.json');
  let receipt;
  try {
    if (!fs.lstatSync(path.dirname(sidecar)).isDirectory() || fs.lstatSync(path.dirname(sidecar)).isSymbolicLink()
      || !fs.lstatSync(sidecar).isFile() || fs.lstatSync(sidecar).isSymbolicLink()) return;
    receipt = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '') || error instanceof SyntaxError) return;
    throw error;
  }
  const entry = receipt.scope === 'project' && receipt.managed?.[path.basename(file)];
  if (!entry?.owners?.length || entry.hash !== `sha256:${previousHash}`) return;
  entry.hash = `sha256:${currentHash}`;
  write(sidecar, `${JSON.stringify(receipt, null, 2)}\n`);
}
