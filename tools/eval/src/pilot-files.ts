// Load frozen eval inputs and enforce content commitments before any fixture execution.
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateEvalContract } from './contracts.js';
import type { FileRef, PilotDataset, ResponseTape } from './pilot-types.js';

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export function digest(value: unknown): string { return hash(Buffer.from(canonical(value))); }
export function hash(bytes: Buffer): string { return `sha256:${createHash('sha256').update(bytes).digest('hex')}`; }
export function opaque(prefix: string, value: unknown): string { return `${prefix}-${digest(value).slice(7, 23)}`; }
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 4294967296; };
}
export function shuffle<T>(values: T[], rand: () => number): T[] {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1)); [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
export async function pinnedFile(root: string, reference: FileRef): Promise<Buffer> {
  if (path.isAbsolute(reference.ref)) throw new Error('Pinned fixture ref must be relative');
  const base = await realpath(root);
  const target = await realpath(path.resolve(base, reference.ref));
  const relative = path.relative(base, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Pinned fixture ref escapes root');
  const bytes = await readFile(target);
  if (hash(bytes) !== reference.digest) throw new Error(`Pinned fixture digest mismatch: ${reference.ref}`);
  return bytes;
}
export async function loadPilot(datasetPath: string, fixtureRoot: string): Promise<{ dataset: PilotDataset; tapes: ResponseTape[] }> {
  const dataset = JSON.parse(await readFile(datasetPath, 'utf8')) as PilotDataset;
  validateEvalContract('PilotDataset', dataset);
  const { commitment, ...content } = dataset;
  if (digest(content) !== commitment) throw new Error('Frozen dataset commitment mismatch');
  if (new Set(dataset.tasks.map(t => t.id)).size !== 48) throw new Error('Frozen task identities must be unique');
  for (const family of ['corpus-verification', 'coding-repair', 'security-testing']) {
    for (const [split, expected] of [['dev', 4], ['held-out', 12]] as const) {
      if (dataset.tasks.filter(t => t.pilot.family === family && t.pilot.split === split).length !== expected) throw new Error('Frozen stratified split mismatch');
    }
  }
  const configurations = ['none', 'all', 'discover', 'expert', 'dag', 'loop', 'graph', 'weakened-guard'];
  if (new Set(dataset.arms.map(a => a.id)).size !== 8 || configurations.some(c => dataset.arms.filter(a => a.configuration === c).length !== 1)) throw new Error('Frozen arm identity mismatch');
  for (const arm of dataset.arms) {
    if ((['none', 'all', 'discover', 'expert'].includes(arm.configuration) ? 'H1' : 'H2') !== arm.hypothesis) throw new Error('Arm hypothesis mismatch');
    if (arm.hypothesis === 'H2' && !arm.graph) throw new Error('H2 arm requires a pinned graph');
    for (const ref of [...arm.context, ...(arm.graph ? [arm.graph] : [])]) await pinnedFile(fixtureRoot, ref);
  }
  const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
  for (const code of [dataset.pins.checker, dataset.pins.flow_runtime]) await pinnedFile(repoRoot, code);
  if (dataset.pins.repository_snapshot !== digest(dataset.tasks.map(t => t.pilot.input))) throw new Error('Repository fixture snapshot mismatch');
  for (const task of dataset.tasks) for (const check of task.pilot.checks) await pinnedFile(fixtureRoot, check);
  const tapes = JSON.parse((await pinnedFile(fixtureRoot, dataset.responses)).toString('utf8')) as ResponseTape[];
  validateEvalContract('ResponseTapes', tapes);
  // Missing fixture observations become retained failed runs; ambiguous observations abort.
  const seen = new Set<string>();
  for (const tape of tapes) {
    const key = `${tape.task_id}:${tape.arm_id}`;
    if (seen.has(key) || !dataset.tasks.some(t => t.id === tape.task_id) || !['h1-none', 'h1-all', 'h1-discover', 'h1-expert', 'h2'].includes(tape.arm_id)) throw new Error('Invalid or duplicate response tape');
    seen.add(key);
  }
  return { dataset, tapes };
}
