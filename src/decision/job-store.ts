import { createHash, randomUUID } from 'node:crypto';
import { access, link, lstat, mkdir, open, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson } from '../security/artifact-trust.js';
import { assertJobTransition, validateDecisionJob, type DecisionJob } from './job-contract.js';

export type JobScope = DecisionJob['scope'];
export interface JobSnapshot { revision: number; job: DecisionJob; deleted: boolean; legalHold?: boolean }
export class JobConflictError extends Error {}
export interface JobStore {
  acquire(job: DecisionJob): Promise<{ owner: boolean; snapshot: JobSnapshot }>;
  read(scope: JobScope, id: string): Promise<JobSnapshot | null>;
  compareAndSwap(previous: JobSnapshot, next: JobSnapshot): Promise<boolean>;
}

function key(scope: JobScope, id: string): string { return canonicalJson({ scope, id }); }
function validateFirst(job: DecisionJob): void {
  validateDecisionJob(job);
  if (job.state !== 'validating' || job.items.some(item => item.state !== 'queued' || item.attempts.length))
    throw new JobConflictError('Initial job must be undispatched');
}
function assertIdentity(initial: DecisionJob, existing: DecisionJob): void {
  if (initial.fingerprint !== existing.fingerprint ||
      canonicalJson(initial.items.map(({ id, fingerprint, subjectDigest, definitionDigest, bindingDigest, rulesetDigest }) =>
        ({ id, fingerprint, subjectDigest, definitionDigest, bindingDigest,
          ...(rulesetDigest ? { rulesetDigest } : {}) }))) !==
      canonicalJson(existing.items.map(({ id, fingerprint, subjectDigest, definitionDigest, bindingDigest, rulesetDigest }) =>
        ({ id, fingerprint, subjectDigest, definitionDigest, bindingDigest,
          ...(rulesetDigest ? { rulesetDigest } : {}) }))) ||
      canonicalJson(initial.budget) !== canonicalJson(existing.budget) ||
      initial.createdAtEpochMs !== existing.createdAtEpochMs || initial.expiresAtEpochMs !== existing.expiresAtEpochMs)
    throw new JobConflictError('Job ID belongs to a different immutable request');
}
function validateNext(previous: JobSnapshot, next: JobSnapshot): void {
  if (previous.deleted || next.revision !== previous.revision + 1 || (next.legalHold !== undefined && typeof next.legalHold !== 'boolean') ||
      (next.deleted && (previous.legalHold || next.legalHold || next.job.state !== previous.job.state)))
    throw new JobConflictError('Invalid job revision or tombstone');
  if (Boolean(previous.legalHold) !== Boolean(next.legalHold)) {
    if (next.deleted || canonicalJson(previous.job) !== canonicalJson(next.job))
      throw new JobConflictError('Legal hold cannot change during job transition');
  } else if (next.deleted) {
    if (canonicalJson(previous.job) !== canonicalJson(next.job)) throw new JobConflictError('Tombstone changed job');
  } else assertJobTransition(previous.job, next.job);
}
const copy = (value: JobSnapshot): JobSnapshot => structuredClone(value);

export class MemoryJobStore implements JobStore {
  private readonly records = new Map<string, JobSnapshot>();
  async acquire(job: DecisionJob): Promise<{ owner: boolean; snapshot: JobSnapshot }> {
    validateFirst(job);
    const id = key(job.scope, job.id);
    const existing = this.records.get(id);
    if (existing) { assertIdentity(job, existing.job); return { owner: false, snapshot: copy(existing) }; }
    const snapshot = { revision: 1, job: structuredClone(job), deleted: false, legalHold: false };
    this.records.set(id, snapshot); return { owner: true, snapshot: copy(snapshot) };
  }
  async read(scope: JobScope, id: string): Promise<JobSnapshot | null> {
    const record = this.records.get(key(scope, id)); return record ? copy(record) : null;
  }
  async compareAndSwap(previous: JobSnapshot, next: JobSnapshot): Promise<boolean> {
    validateNext(previous, next);
    const id = key(previous.job.scope, previous.job.id);
    const current = this.records.get(id);
    if (!current || canonicalJson(current) !== canonicalJson(previous)) return false;
    this.records.set(id, copy(next)); return true;
  }
}

/** Append-only, immutable revision journal. Link publication is atomic across processes on one local filesystem. */
export class FileJobStore implements JobStore {
  constructor(private readonly directory: string,
    private readonly externallyDeleted?: (scope: JobScope, id: string) => Promise<boolean>) {}
  async acquire(job: DecisionJob): Promise<{ owner: boolean; snapshot: JobSnapshot }> {
    validateFirst(job);
    await this.ensureDirectory();
    if (await this.isDeleted(job.scope, job.id)) throw new JobConflictError('Job tombstoned');
    const snapshot = { revision: 1, job: structuredClone(job), deleted: false, legalHold: false };
    if (await this.publish(snapshot)) return { owner: true, snapshot: copy(snapshot) };
    const existing = await this.read(job.scope, job.id);
    if (!existing) throw new JobConflictError('Job revision unavailable');
    assertIdentity(job, existing.job);
    return { owner: false, snapshot: existing };
  }
  async read(scope: JobScope, id: string): Promise<JobSnapshot | null> {
    await this.ensureDirectory();
    if (await this.isDeleted(scope, id)) return null;
    const prefix = this.prefix(scope, id);
    const revisions = (await readdir(this.directory)).flatMap(name => {
      const match = name.match(new RegExp(`^${prefix}\\.r([0-9]+)\\.json$`));
      return match ? [Number(match[1])] : [];
    }).sort((a, b) => a - b);
    let previous: JobSnapshot | null = null;
    for (const [index, revision] of revisions.entries()) {
      if (revision !== index + 1) throw new JobConflictError('Job revision gap');
      const snapshot = JSON.parse(await readFile(join(this.directory, `${prefix}.r${revision}.json`), 'utf8')) as JobSnapshot;
      if (snapshot.revision !== revision || key(snapshot.job.scope, snapshot.job.id) !== key(scope, id))
        throw new JobConflictError('Job scope substitution');
      if (previous) validateNext(previous, snapshot);
      else { validateFirst(snapshot.job); if (snapshot.deleted || snapshot.legalHold) throw new JobConflictError('Invalid initial snapshot'); }
      previous = snapshot;
    }
    return previous ? copy(previous) : null;
  }
  async compareAndSwap(previous: JobSnapshot, next: JobSnapshot): Promise<boolean> {
    validateNext(previous, next);
    const current = await this.read(previous.job.scope, previous.job.id);
    if (!current || canonicalJson(current) !== canonicalJson(previous)) return false;
    return this.publish(next);
  }
  /** Host-only quota scan. Validate every live journal; corrupted records fail admission closed. */
  async listSnapshots(): Promise<JobSnapshot[]> {
    await this.ensureDirectory();
    const snapshots: JobSnapshot[] = [];
    for (const name of await readdir(this.directory)) {
      if (!/^[a-f0-9]{64}\.r1\.json$/.test(name)) continue;
      const first = JSON.parse(await readFile(join(this.directory, name), 'utf8')) as JobSnapshot;
      if (name !== `${this.prefix(first.job.scope, first.job.id)}.r1.json`)
        throw new JobConflictError('Job scope substitution');
      const current = await this.read(first.job.scope, first.job.id);
      if (current) snapshots.push(current);
    }
    return snapshots;
  }
  /** Host-only D10 eraser: call after lifecycle tombstone and authorized job deletion. */
  async purgeDeleted(scope: JobScope, id: string): Promise<void> {
    const record = await this.read(scope, id);
    if (record && (!record.deleted || record.legalHold)) throw new JobConflictError('Job not eligible for erasure');
    if (!record && !await this.hasMarker(scope, id) && !await this.externallyDeleted?.(scope, id))
      throw new JobConflictError('Job tombstone required before erasure');
    await this.ensureDirectory();
    if (!await this.hasMarker(scope, id)) {
      try {
        const handle = await open(this.marker(scope, id), 'wx', 0o600);
        try { await handle.sync(); } finally { await handle.close(); }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    const prefix = `${this.prefix(scope, id)}.r`;
    for (const name of await readdir(this.directory)) {
      if (name.startsWith(prefix) && /^r[1-9][0-9]*\.json$/.test(name.slice(prefix.length - 1)))
        await rm(join(this.directory, name));
    }
    const directory = await open(this.directory, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
      throw new JobConflictError('Job storage root must be private');
  }
  private marker(scope: JobScope, id: string): string { return join(this.directory, `${this.prefix(scope, id)}.deleted`); }
  private async isDeleted(scope: JobScope, id: string): Promise<boolean> {
    return await this.hasMarker(scope, id) || Boolean(await this.externallyDeleted?.(scope, id));
  }
  private async hasMarker(scope: JobScope, id: string): Promise<boolean> {
    try { await access(this.marker(scope, id)); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }
  private prefix(scope: JobScope, id: string): string {
    return createHash('sha256').update(key(scope, id)).digest('hex');
  }
  private async publish(snapshot: JobSnapshot): Promise<boolean> {
    await this.ensureDirectory();
    const destination = join(this.directory, `${this.prefix(snapshot.job.scope, snapshot.job.id)}.r${snapshot.revision}.json`);
    const temporary = join(this.directory, `.job-${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(`${canonicalJson(snapshot)}\n`, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    try {
      await link(temporary, destination);
      const directory = await open(this.directory, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
      return true;
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
    finally { await rm(temporary, { force: true }); }
  }
}
