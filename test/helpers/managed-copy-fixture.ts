// Give synthetic managed copies the same integrity evidence as real deployments.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
export function recordManagedCopy(file: string): void {
  const receiptFile = path.join(path.dirname(file), '.aiwg-manifest.json');
  const receipt = fs.existsSync(receiptFile) ? JSON.parse(fs.readFileSync(receiptFile, 'utf8')) : { managed: {} };
  receipt.managed ??= {};
  receipt.managed[path.basename(file)] = { hash: `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`, source: 'bundled' };
  fs.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2));
}
export const writeManagedFixture: typeof fs.writeFileSync = (file, bytes, options) => {
  fs.writeFileSync(file, bytes, options);
  if (typeof file === 'string' && /aiwg:managed/.test(bytes.toString())) recordManagedCopy(file);
};
