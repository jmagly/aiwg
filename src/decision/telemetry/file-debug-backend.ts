import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DebugSidecarBackend, EncryptedDebugSidecar } from './debug-sidecar.js';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** Local encrypted-content backend. The caller supplies key resolution and authorization separately. */
export class FileDebugSidecarBackend implements DebugSidecarBackend {
  constructor(private readonly root: string) {
    if (!root) throw new Error('Debug storage root required');
  }

  private path(id: string): string {
    if (!ID.test(id)) throw new Error('Debug reference invalid');
    return join(this.root, `${id}.json`);
  }

  private async prepare(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
      throw new Error('Debug storage root must be a private directory');
    }
  }

  async put(record: EncryptedDebugSidecar): Promise<void> {
    const target = this.path(record.id);
    if (!SCOPE.test(record.scope)) throw new Error('Debug scope invalid');
    await this.prepare();
    const temp = join(this.root, `${randomUUID()}.tmp`);
    const serialized = JSON.stringify({ id: record.id, scope: record.scope, expiresAt: record.expiresAt,
      nonce: record.nonce.toString('base64'), tag: record.tag.toString('base64'), ciphertext: record.ciphertext.toString('base64') });
    try {
      const fd = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await fd.writeFile(serialized); await fd.sync(); } finally { await fd.close(); }
      // Atomic create without replacing a previous reference or following a symlink.
      await link(temp, target);
    } finally { await rm(temp, { force: true }); }
  }

  async get(id: string): Promise<EncryptedDebugSidecar | null> {
    const target = this.path(id);
    let fd;
    try { fd = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('Debug content unavailable'); }
    try {
      const value = JSON.parse(await fd.readFile({ encoding: 'utf8' })) as Record<string, unknown>;
      if (value.id !== id || typeof value.scope !== 'string' || !SCOPE.test(value.scope)
        || !Number.isSafeInteger(value.expiresAt) || typeof value.nonce !== 'string'
        || typeof value.tag !== 'string' || typeof value.ciphertext !== 'string') throw new Error();
      return { id, scope: value.scope, expiresAt: value.expiresAt as number,
        nonce: Buffer.from(value.nonce, 'base64'), tag: Buffer.from(value.tag, 'base64'),
        ciphertext: Buffer.from(value.ciphertext, 'base64') };
    } catch { throw new Error('Debug content invalid'); }
    finally { await fd.close(); }
  }

  async delete(id: string): Promise<void> {
    await rm(this.path(id), { force: true });
  }

  async listExpired(scope: string, before: number): Promise<EncryptedDebugSidecar[]> {
    if (!SCOPE.test(scope) || !Number.isSafeInteger(before)) throw new Error('Debug expiry query invalid');
    await this.prepare();
    const records: EncryptedDebugSidecar[] = [];
    for (const name of await readdir(this.root)) {
      if (!name.endsWith('.json') || !ID.test(name.slice(0, -5))) continue;
      const record = await this.get(name.slice(0, -5));
      if (record?.scope === scope && record.expiresAt <= before) records.push(record);
    }
    return records;
  }

  async audit(event: { operation: 'capture' | 'read' | 'delete' | 'expire'; id: string; scope: string }): Promise<void> {
    this.path(event.id);
    if (!SCOPE.test(event.scope) || !['capture', 'read', 'delete', 'expire'].includes(event.operation)) {
      throw new Error('Debug audit event invalid');
    }
    await this.prepare();
    const fd = await open(join(this.root, 'audit.jsonl'),
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try { await fd.writeFile(`${JSON.stringify(event)}\n`); await fd.sync(); } finally { await fd.close(); }
  }
}
