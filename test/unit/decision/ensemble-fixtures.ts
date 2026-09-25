import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '../../..');
export const FIXTURE_DIR = 'test/fixtures/decision/ensemble';
export type PatchOp = { op: 'add' | 'remove' | 'replace'; path: string; value?: unknown };
export interface AntiFixtureCase { id: string; base: string; layer: 'schema' | 'semantic'; patch: PatchOp[]; expect?: string }

export function readFixture<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(ROOT, FIXTURE_DIR, name), 'utf8')) as T;
}
export function records<T extends { id: string }>(name: string): Map<string, T> {
  return new Map(readFixture<{ records: T[] }>(name).records.map(record => [record.id, record]));
}

/** Minimal RFC 6902 subset used by the anti-fixtures. */
export function applyPatch<T>(value: T, patch: readonly PatchOp[] = []): T {
  const target = structuredClone(value) as Record<string, unknown>;
  for (const op of patch) {
    const parts = op.path.split('/').slice(1);
    const key = parts.pop()!;
    const parent = parts.reduce<any>((node, part) => node[part], target);
    if (op.op === 'remove') {
      if (Array.isArray(parent)) parent.splice(Number(key), 1); else delete parent[key];
    } else if (Array.isArray(parent) && key === '-') parent.push(op.value);
    else parent[key] = op.value;
  }
  return target as T;
}

/** Seeded Fisher-Yates (mulberry32) so permutation tests are reproducible. */
export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index--) {
    const swap = Math.floor(next() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap]!, copy[index]!];
  }
  return copy;
}
