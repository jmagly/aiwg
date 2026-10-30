// Restore verified settings contributions while retaining unresolved ownership for retries.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import type { ArtifactOwnershipRecord, SettingsOwnershipRecord, SettingsContribution } from './skill-ownership.mjs';
import { parseSettings, renderSettings, stableSettings } from './settings-document.mjs';
import type { RemovalDecision } from './deployment-removal.js';
import type { RemovalWrite } from './removal-transaction.js';

const digest = (value: unknown) => `sha256:${createHash('sha256').update(stableSettings(value) ?? '').digest('hex')}`;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const own = (value: unknown, key: string) => object(value) && Object.hasOwn(value, key);
function lookup(root: unknown, keys: string[]): { present: boolean; value: unknown } {
  let value = root;
  for (const key of keys) {
    if (!own(value, key)) return { present: false, value: undefined };
    value = (value as Record<string, unknown>)[key];
  }
  return { present: true, value };
}
function assign(root: Record<string, unknown>, keys: string[], present: boolean, value: unknown, baseline: unknown): void {
  let parent = root;
  const parents: Array<[Record<string, unknown>, string]> = [];
  for (const key of keys.slice(0, -1)) {
    if (!own(parent, key) || !object(parent[key])) throw new Error('Settings parent was edited');
    parents.push([parent, key]); parent = parent[key] as Record<string, unknown>;
  }
  const key = keys.at(-1)!;
  if (present) Object.defineProperty(parent, key, { value, enumerable: true, configurable: true, writable: true });
  else delete parent[key];
  for (let index = parents.length - 1; index >= 0; index--) {
    const [container, name] = parents[index];
    if (Object.keys(container[name] as object).length) break;
    const prior = lookup(baseline, keys.slice(0, index + 1));
    if (prior.present) { if (!object(prior.value)) container[name] = prior.value; break; }
    delete container[name];
  }
}
const contributions = (entry: SettingsOwnershipRecord): SettingsContribution[] => entry.contributions || [{ hash: entry.hash, value: entry.value, owners: entry.owners }];

export function restoreSettings(file: string, record: ArtifactOwnershipRecord, owner: string): {
  decisions: RemovalDecision[]; write?: RemovalWrite; retained: boolean;
} {
  const decisions: RemovalDecision[] = [];
  const report = (pointer: string, action: RemovalDecision['action'], reason: string) => decisions.push({
    path: file, pointer, action, reason, kind: 'settings', owned: true,
  });
  let before: Buffer, document: Record<string, unknown>;
  try {
    before = fs.readFileSync(file); document = parseSettings(file, before);
    if (!object(document)) throw new Error('Invalid settings document');
  } catch {
    report('', 'preserve', 'missing, unreadable or invalid settings; unverifiable');
    return { decisions, retained: true };
  }
  // Older receipts verify leaves, but cannot prove ownership of empty parents.
  let baseline: Record<string, unknown> = parseSettings(file, before), original: Buffer | null | undefined;
  const preimage = record.settingsPreimage;
  try {
    if (preimage?.present === false) { baseline = {}; original = null; }
    else if (preimage?.present && typeof preimage.bytes === 'string') {
      const bytes = Buffer.from(preimage.bytes, 'base64');
      if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` === preimage.hash) {
        const parsed = parseSettings(file, bytes);
        if (object(parsed)) { baseline = parsed; original = bytes; }
      }
    }
  } catch { /* Leaf preimages can still recover values without a byte preimage. */ }
  if (!Object.keys(record.settings || {}).length && record.owners?.includes(owner)) {
    const others = record.owners.filter(candidate => candidate !== owner);
    const currentHash = `sha256:${createHash('sha256').update(before).digest('hex')}`;
    if (currentHash !== record.hash || original === undefined || stableSettings(document) !== stableSettings(baseline)) {
      report('', 'preserve', 'operator-edited or unverifiable settings bytes preserved');
      return { decisions, retained: true };
    }
    record.owners = others;
    report('', 'release', others.length ? 'shared settings formatting retained' : 'restore verified pre-deploy settings bytes');
    return { decisions, retained: false, ...(!others.length && (original === null || !before.equals(original))
      ? { write: { path: file, before, after: original } } : {}) };
  }
  let retained = false, changed = false;
  for (const [pointer, entry] of Object.entries(record.settings || {})) {
    if (!entry.owners?.includes(owner)) continue;
    const keys = pointer.slice(1).split('/').map(key => key.replaceAll('~1', '/').replaceAll('~0', '~'));
    const preserve = (reason: string) => { retained = true; report(pointer, 'preserve', reason); };
    if (!pointer.startsWith('/') || keys.some(key => ['__proto__', 'constructor', 'prototype'].includes(key))
      || entry.previous?.unverifiable || typeof entry.previous?.present !== 'boolean'
      || entry.hash !== digest(entry.value)) { preserve('unverifiable settings contribution or pre-deploy value'); continue; }
    const current = lookup(document, keys);
    const items = contributions(entry);
    if (items.some(item => !Array.isArray(item.owners) || item.hash !== digest(item.value))) {
      preserve('unverifiable settings contribution digest'); continue;
    }
    const other = items.flatMap(item => {
      const owners = item.owners.filter(candidate => candidate !== owner);
      return owners.length ? [{ ...item, owners }] : [];
    });
    if (Array.isArray(entry.value)) {
      if (!current.present || !Array.isArray(current.value)) { preserve('operator-edited settings value preserved'); continue; }
      const value = [...current.value], expected = [...entry.value];
      const unresolved: SettingsContribution[] = [];
      for (const item of items.filter(item => item.owners.includes(owner) && item.owners.length === 1)) {
        const index = value.findIndex(candidate => digest(candidate) === item.hash);
        if (index < 0) { unresolved.push(item); continue; }
        value.splice(index, 1);
        const expectedIndex = expected.findIndex(candidate => digest(candidate) === item.hash);
        if (expectedIndex >= 0) expected.splice(expectedIndex, 1);
      }
      const next = [...other, ...unresolved];
      const restorePrevious = !next.length && digest(current.value) === entry.hash;
      const restoredValue = restorePrevious && entry.previous.present ? entry.previous.value : value;
      const present = restorePrevious ? entry.previous.present : value.length > 0 || entry.previous.present;
      // Preserve an operator's replacement or deletion of a contributed hook.
      if (unresolved.length) preserve('operator-edited hook or array entry preserved; contribution retained for retry');
      else report(pointer, 'release', digest(current.value) !== entry.hash ? 'remove recorded entries; operator-edited array entries preserved'
        : other.length ? 'shared settings entries retained; release this owner only' : 'restore pre-deploy hook or array entries');
      if (stableSettings(restoredValue) !== stableSettings(current.value) || !present) {
        assign(document, keys, present, restoredValue, baseline); changed = true;
      }
      if (next.length) {
        entry.contributions = next; entry.owners = [...new Set(next.flatMap(item => item.owners))].sort();
        entry.value = expected; entry.hash = digest(expected);
      } else delete record.settings![pointer];
    } else {
      if (!current.present || digest(current.value) !== entry.hash) { preserve('operator-edited settings value preserved'); continue; }
      const last = other.at(-1);
      const present = !!last || entry.previous.present;
      const value = last ? last.value : entry.previous.value;
      assign(document, keys, present, value, baseline);
      changed ||= !present || stableSettings(value) !== stableSettings(current.value);
      report(pointer, 'release', last ? 'restore remaining framework settings value' : 'restore pre-deploy settings value');
      if (last) {
        entry.contributions = other; entry.owners = [...new Set(other.flatMap(item => item.owners))].sort();
        entry.value = value; entry.hash = digest(value);
      } else delete record.settings![pointer];
    }
  }
  if (!decisions.length) report('', 'release', 'no settings contributions remain for this framework');
  record.owners = [...new Set(Object.values(record.settings || {}).flatMap(entry => entry.owners))].sort();
  if (record.frameworkSlug === owner) delete record.frameworkSlug;
  let after: Buffer | null = before;
  if (changed) {
    after = original !== undefined && `sha256:${createHash('sha256').update(before).digest('hex')}` === record.hash && stableSettings(document) === stableSettings(baseline) ? original
      : renderSettings(file, before, document);
    record.hash = after ? `sha256:${createHash('sha256').update(after).digest('hex')}` : record.hash;
  }
  return { decisions, retained, ...(after === null || !before.equals(after) ? { write: { path: file, before, after } } : {}) };
}
