import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { DECISION_LIFECYCLE_SURFACES, type DecisionLifecycleHold, type DecisionLifecycleReference,
  type DecisionLifecycleStore, type DecisionLifecycleSurface, type DecisionLifecycleTombstone } from './lifecycle.js';

const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
type Entry =
  | { kind: 'link'; subject: string; reference: DecisionLifecycleReference }
  | { kind: 'tombstone'; value: DecisionLifecycleTombstone }
  | { kind: 'hold'; value: DecisionLifecycleHold }
  | { kind: 'release'; subject: string; hold: DecisionLifecycleHold; actor: string; reason: string; at: number };

/** Single-writer local lifecycle journal. Content erasure is delegated per surface. */
export class FileDecisionLifecycleStore implements DecisionLifecycleStore {
  constructor(private readonly directory: string,
    private readonly erasers: Partial<Record<DecisionLifecycleSurface, (id: string) => Promise<void>>>) {
    if (!directory) throw new Error('Lifecycle storage root required');
  }

  private async path(): Promise<string> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
      throw new Error('Lifecycle storage root must be private');
    }
    return join(this.directory, 'lifecycle.jsonl');
  }

  private valid(subject: string, reference?: DecisionLifecycleReference): void {
    if (!OPAQUE.test(subject) || reference && (!DECISION_LIFECYCLE_SURFACES.includes(reference.surface)
      || !OPAQUE.test(reference.opaqueId))) throw new Error('Lifecycle reference must be opaque');
  }

  private async append(entry: Entry): Promise<void> {
    const fd = await open(await this.path(), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try { await fd.writeFile(`${JSON.stringify(entry)}\n`); await fd.sync(); }
    finally { await fd.close(); }
  }

  private async entries(): Promise<Entry[]> {
    let fd;
    try { fd = await open(await this.path(), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw new Error('Lifecycle journal unavailable'); }
    try {
      const text = await fd.readFile({ encoding: 'utf8' });
      const records = text.trim() ? text.trim().split('\n').map(line => JSON.parse(line) as Entry) : [];
      if (records.some(entry => !entry || !['link', 'tombstone', 'hold', 'release'].includes(entry.kind))) throw new Error();
      return records;
    } catch { throw new Error('Lifecycle journal invalid'); }
    finally { await fd.close(); }
  }

  async register(subject: string, reference: DecisionLifecycleReference): Promise<void> {
    this.valid(subject, reference);
    await this.append({ kind: 'link', subject, reference });
  }

  async links(subject: string): Promise<DecisionLifecycleReference[]> {
    this.valid(subject);
    const records = await this.entries();
    const registered = records.filter((entry): entry is Extract<Entry, { kind: 'link' }> => entry.kind === 'link' && entry.subject === subject);
    return [...new Map(registered.map(entry => [`${entry.reference.surface}:${entry.reference.opaqueId}`, entry.reference])).values()];
  }

  async tombstone(value: DecisionLifecycleTombstone): Promise<void> {
    this.valid(value.subject, value.reference);
    await this.append({ kind: 'tombstone', value });
  }

  async tombstones(subject: string): Promise<DecisionLifecycleTombstone[]> {
    this.valid(subject);
    return (await this.entries()).flatMap(entry => entry.kind === 'tombstone' && entry.value.subject === subject ? [entry.value] : []);
  }

  async erase(reference: DecisionLifecycleReference): Promise<void> {
    this.valid('opaque-subject', reference);
    const erase = this.erasers[reference.surface];
    if (!erase) throw new Error('Lifecycle eraser unavailable');
    try { await erase(reference.opaqueId); }
    catch { throw new Error('Lifecycle erasure failed'); }
  }

  async holds(subject: string): Promise<DecisionLifecycleHold[]> {
    this.valid(subject);
    const active: DecisionLifecycleHold[] = [];
    for (const entry of await this.entries()) {
      if (entry.kind === 'hold' && entry.value.subject === subject) active.push(entry.value);
      if (entry.kind === 'release' && entry.subject === subject) {
        const index = active.findIndex(hold => JSON.stringify(hold) === JSON.stringify(entry.hold));
        if (index >= 0) active.splice(index, 1);
      }
    }
    return active;
  }

  async recordHold(hold: DecisionLifecycleHold): Promise<void> {
    this.valid(hold.subject);
    await this.append({ kind: 'hold', value: hold });
  }

  async releaseHold(hold: DecisionLifecycleHold, actor: string, reason: string, at: number): Promise<void> {
    this.valid(hold.subject);
    if (!actor || !reason || !Number.isSafeInteger(at)) throw new Error('Lifecycle release invalid');
    await this.append({ kind: 'release', subject: hold.subject, hold, actor, reason, at });
  }
}
