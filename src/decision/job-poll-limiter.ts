import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireDirectoryLock } from '../artifacts/prebuilt-build-lock.js';
import { canonicalJson } from '../security/artifact-trust.js';
import { FileJobStore, JobConflictError, type JobScope } from './job-store.js';

interface Entry { window: number; count: number }
type Ledger = Record<string, Entry>;
/** Host-only bounded polling gate. Shared local filesystem, not a distributed service. */
export class FileJobPollLimiter {
  constructor(private readonly directory: string, private readonly windowMs: number,
    private readonly perPrincipal: number, private readonly perProject: number,
    private readonly maxLanes: number, private readonly now: () => number = Date.now) {
    if (![windowMs, perPrincipal, perProject, maxLanes].every(value => Number.isSafeInteger(value) && value > 0) || maxLanes > 4096)
      throw new JobConflictError('Invalid polling limit');
  }
  async check(actor: JobScope): Promise<void> {
    // Reuse the journal's root privacy gate. Never create a world-readable counter store.
    await new FileJobStore(this.directory).read(actor, '_poll_root_');
    const release = await acquireDirectoryLock(join(this.directory, '.quota-lock'), { timeoutMs: 5000, pollMs: 20 });
    try {
      const path = join(this.directory, '.poll-ledger.json');
      let previous: Ledger = {};
      try {
        if ((await stat(path)).size > this.maxLanes * 128 + 2) throw new JobConflictError('Polling ledger full');
        previous = JSON.parse(await readFile(path, 'utf8')) as Ledger;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const now = this.now();
      if (!Number.isSafeInteger(now) || now < 0 || !previous || typeof previous !== 'object' || Array.isArray(previous))
        throw new JobConflictError('Invalid polling ledger');
      const ledger: Ledger = Object.create(null) as Ledger;
      for (const [key, value] of Object.entries(previous)) {
        if (!/^[a-f0-9]{64}$/.test(key) || !value || !Number.isSafeInteger(value.window) || !Number.isSafeInteger(value.count) ||
            value.count < 0 || value.window > now) throw new JobConflictError('Invalid polling ledger');
        if (now - value.window < this.windowMs) ledger[key] = value;
      }
      const keys = [canonicalJson([actor.tenantId, actor.projectId]),
        canonicalJson([actor.tenantId, actor.projectId, actor.workspaceId, actor.principalId])]
        .map(text => createHash('sha256').update(text).digest('hex'));
      for (const [index, key] of keys.entries()) {
        const count = ledger[key]?.count ?? 0;
        if (count >= [this.perProject, this.perPrincipal][index]!) throw new JobConflictError('Job request throttled');
      }
      if (new Set([...Object.keys(ledger), ...keys]).size > this.maxLanes) throw new JobConflictError('Polling ledger full');
      for (const key of keys) ledger[key] = { window: ledger[key]?.window ?? now, count: (ledger[key]?.count ?? 0) + 1 };
      const temporary = join(this.directory, `.poll-${randomUUID()}.tmp`);
      try {
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(`${canonicalJson(ledger)}\n`); await file.sync(); } finally { await file.close(); }
        await rename(temporary, path);
        const directory = await open(this.directory, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      } finally { await rm(temporary, { force: true }); }
    } finally { await release(); }
  }
}
