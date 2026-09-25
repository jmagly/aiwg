/**
 * Multi-process first-writer-wins: separate Node processes race on the same
 * effect IDs (and on the genesis keyring and index key). Exactly one index
 * entry and one intent record exist per ID; every other process receives the
 * winner's receipt or a conflict. Offline only.
 */
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memoryCheckpointSink, openEffectLedger, staticKeyProvider, verifyLedger } from '../../../src/effects/index.js';
import { harness, scope, testKey, testKeySeedHex, type Harness } from './helpers.js';

type Result = { index: number; effectId?: string; writer?: string; seq?: number; idempotent?: boolean; code?: string; exitCode?: number };

let h: Harness;
beforeEach(() => { h = harness(); });
afterEach(() => h.cleanup());

function start(writer: string, salt: string, count: number, first = 0) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'test/fixtures/effects-runtime/ledger-writer-process.mjs',
    h.dir, writer, testKeySeedHex('a'), salt, String(count), String(first)], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  let errors = '';
  let ready!: () => void;
  const initialized = new Promise<void>(resolve => { ready = resolve; });
  child.stdout.on('data', chunk => { output += String(chunk); if (output.includes('ready\n')) ready(); });
  child.stderr.on('data', chunk => { errors += String(chunk); });
  const result = new Promise<Result[]>((resolve, reject) => child.on('exit', code => {
    if (code !== 0) reject(new Error(errors || `exit ${code}`));
    else resolve(JSON.parse(output.trim().split('\n').at(-1)!) as Result[]);
  }));
  return { child, initialized, result };
}

async function race(workers: Array<ReturnType<typeof start>>): Promise<Result[][]> {
  await Promise.all(workers.map(worker => worker.initialized));
  for (const worker of workers) worker.child.stdin.write('go\n');
  return Promise.all(workers.map(worker => worker.result));
}

const ledgerRoot = () => join(h.dir, '.aiwg', 'effects', 'delivery');
const intentLines = () => readdirSync(join(ledgerRoot(), 'segments')).filter(name => name.endsWith('.jsonl'))
  .flatMap(name => readFileSync(join(ledgerRoot(), 'segments', name), 'utf8').trim().split('\n').filter(Boolean));
const verifier = () => openEffectLedger({ projectDir: h.dir, scope, writer: 'auditor', keyProvider: staticKeyProvider(testKey('a')), sink: memoryCheckpointSink() });

describe('multi-process first writer wins', () => {
  it('EFF-RACE-01 processes racing with the same payload digest converge on one receipt per effect ID', async () => {
    const count = 8;
    const results = await race(['proc-1', 'proc-2', 'proc-3', 'proc-4'].map(writer => start(writer, 'same', count)));
    for (let index = 0; index < count; index += 1) {
      const outcomes = results.map(list => list.find(result => result.index === index)!);
      expect(outcomes.every(outcome => outcome.effectId && !outcome.code), JSON.stringify(outcomes)).toBe(true);
      expect(new Set(outcomes.map(outcome => outcome.effectId)).size).toBe(1);
      expect(outcomes.filter(outcome => !outcome.idempotent)).toHaveLength(1);
      const winner = outcomes.find(outcome => !outcome.idempotent)!;
      expect(outcomes.every(outcome => outcome.writer === winner.writer && outcome.seq === winner.seq)).toBe(true);
    }
    expect(intentLines()).toHaveLength(count);
    expect(readdirSync(join(ledgerRoot(), 'index'))).toHaveLength(count);
    const verification = await verifyLedger(verifier(), { sink: null });
    expect(verification.failures).toEqual([]);
    expect(verification.ok).toBe(true);
  }, 60_000);

  it('EFF-RACE-02 processes racing with different payload digests yield one winner and conflicts (exit 5)', async () => {
    const count = 6;
    const results = await race(['proc-1', 'proc-2', 'proc-3'].map((writer, position) => start(writer, `salt-${position}`, count)));
    for (let index = 0; index < count; index += 1) {
      const outcomes = results.map(list => list.find(result => result.index === index)!);
      expect(outcomes.filter(outcome => outcome.effectId && !outcome.idempotent)).toHaveLength(1);
      expect(outcomes.filter(outcome => outcome.code === 'conflict' && outcome.exitCode === 5)).toHaveLength(2);
    }
    expect(intentLines()).toHaveLength(count);
    expect((await verifyLedger(verifier(), { sink: null })).ok).toBe(true);
  }, 60_000);

  it('EFF-RACE-03 two processes sharing one writer ID serialize on the writer lock and keep one valid chain', async () => {
    const results = await race([start('shared', 'x', 5, 0), start('shared', 'x', 5, 100)]);
    expect(results.flat().every(result => result.writer === 'shared' && !result.idempotent)).toBe(true);
    const lines = readFileSync(join(ledgerRoot(), 'segments', 'shared.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(lines.map(line => line.seq)).toEqual([...Array(10).keys()]);
    expect((await verifyLedger(verifier(), { sink: null })).ok).toBe(true);
  }, 60_000);
});
