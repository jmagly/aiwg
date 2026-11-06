// Compare hook bytes and deployment receipts without changing either file.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export type ManagedHookScriptState = 'missing' | 'outdated' | 'unreadable' | 'operator-edited';

export async function managedHookScriptState(
  projectRoot: string, file: string, expected: Buffer,
): Promise<ManagedHookScriptState | undefined> {
  const target = path.resolve(projectRoot, file);
  let actual: Buffer;
  try { actual = await fs.readFile(target); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable'; }
  const digest = `sha256:${createHash('sha256').update(actual).digest('hex')}`;
  // Writers may record hooks beside the script, at the provider root, or in
  // the project-scoped receipt. Match the same relative claims as preservation.
  const projectReceipt = path.join(projectRoot, '.aiwg/.aiwg-manifest.json');
  const receipts: string[] = [];
  for (let dir = path.dirname(target); dir !== path.resolve(projectRoot); dir = path.dirname(dir)) {
    if (!dir.startsWith(`${path.resolve(projectRoot)}${path.sep}`)) break;
    receipts.push(path.join(dir, '.aiwg-manifest.json'));
  }
  receipts.push(projectReceipt);
  for (const receipt of receipts) {
    let doc;
    try { doc = JSON.parse(await fs.readFile(receipt, 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return 'unreadable';
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return 'unreadable';
    const base = receipt === projectReceipt && doc.scope === 'project' ? projectRoot : path.dirname(receipt);
    const name = path.relative(base, target).split(path.sep).join('/');
    const record = doc.managed?.[name];
    if (record?.hash && record.hash !== digest) return 'operator-edited';
    // A nearer receipt supersedes an older ancestor claim.
    if (record) break;
  }
  return actual.equals(expected) ? undefined : 'outdated';
}
