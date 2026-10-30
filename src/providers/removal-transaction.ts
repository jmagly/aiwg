// Back up a removal's complete write set before applying it; roll back failures.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface RemovalWrite { path: string; before: Buffer | null; after: Buffer | null; commit?: boolean }

function verifyPreimage(write: RemovalWrite): void {
  let ancestor = write.path;
  while (ancestor !== path.dirname(ancestor)) {
    if (fs.existsSync(ancestor) && fs.lstatSync(ancestor).isSymbolicLink()) throw new Error(`Symlink changed during removal planning: ${write.path}`);
    ancestor = path.dirname(ancestor);
  }
  const current = fs.existsSync(write.path) ? fs.readFileSync(write.path) : null;
  if (write.before === null ? current !== null : !current?.equals(write.before)) throw new Error(`Changed during removal planning: ${write.path}`);
}

export async function applyRemovalTransaction(writes: RemovalWrite[], commit?: () => Promise<void>): Promise<void> {
  if (!writes.length) return;
  const backup = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-remove-'));
  fs.chmodSync(backup, 0o700);
  const entries = writes.map((write, index) => ({ path: write.path, backup: write.before ? `${index}` : null,
    mode: undefined as number | undefined, operation: write.after ? 'write' : 'delete' }));
  const journal = path.join(backup, 'removal.json');
  // No output is mutated until every preimage and the durable intent are saved.
  try {
    for (const [index, write] of writes.entries()) {
      verifyPreimage(write);
      if (write.before) entries[index].mode = fs.statSync(write.path).mode;
      if (write.before) fs.writeFileSync(path.join(backup, `${index}`), write.before, { mode: 0o600 });
    }
    fs.writeFileSync(journal, JSON.stringify({ status: 'prepared', entries }, null, 2), { mode: 0o600 });
  } catch (error) {
    fs.rmSync(backup, { recursive: true, force: true });
    throw error;
  }
  const applied: number[] = [];
  try {
    for (const [index, write] of writes.entries()) {
      if (write.commit) continue;
      verifyPreimage(write);
      applied.push(index); // Also restore a write that throws after truncation.
      if (write.after === null) fs.unlinkSync(write.path);
      else fs.writeFileSync(write.path, write.after);
    }
    for (const [index, write] of writes.entries()) {
      if (!write.commit) continue;
      verifyPreimage(write);
      applied.push(index);
    }
    await commit?.();
  } catch (error) {
    const failures: string[] = [];
    for (const index of applied.reverse()) {
      const write = writes[index];
      try {
        if (write.before === null) { if (fs.existsSync(write.path)) fs.unlinkSync(write.path); }
        else {
          fs.writeFileSync(write.path, write.before);
          fs.chmodSync(write.path, entries[index].mode!);
        }
      } catch { failures.push(write.path); }
    }
    try { fs.writeFileSync(journal, JSON.stringify({ status: failures.length ? 'rollback-incomplete' : 'rolled-back', entries, failures }, null, 2)); } catch { /* The prepared intent and preimages remain available. */ }
    throw new Error(`Removal failed: ${error instanceof Error ? error.message : String(error)}. ${failures.length
      ? `Rollback incomplete for ${failures.join(', ')}.` : 'All changes rolled back.'} Recovery preimages and record: ${journal}`);
  }
  fs.rmSync(backup, { recursive: true, force: true });
}
