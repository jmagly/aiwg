import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mcHandler } from '../../../../src/cli/handlers/mc.js';
import { summaryLedger } from '../../../fixtures/mission-summary.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'mc-summary-')); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
const context = (args: string[]) => ({ args, rawArgs: ['mc', ...args], cwd: root, frameworkRoot: root });

describe('mc summary', () => {
  it.each([
    ['accepted', 'accepted'], ['completed', 'completed'], ['failed', 'failed'],
    ['unknown', 'unknown'], ['routed', 'unknown'], ['plan-only', 'unknown'],
    ['review-no-evidence', 'completed'],
  ])('reads %s as %s without writing', async (kind, status) => {
    const bytes = JSON.stringify(summaryLedger(kind));
    await writeFile(join(root, 'ledger.json'), bytes);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await mcHandler.execute(context(['summary', '--ledger', 'ledger.json', '--json']));
    expect(result.exitCode).toBe(0);
    const summary = JSON.parse(String(output.mock.calls[0][0]));
    expect(summary.cycles[0].status).toBe(status);
    expect(await readFile(join(root, 'ledger.json'), 'utf8')).toBe(bytes);
    expect(await readdir(root)).toEqual(['ledger.json']);
  });

  it('prints a human-readable summary', async () => {
    await writeFile(join(root, 'ledger.json'), JSON.stringify(summaryLedger('review-no-evidence')));
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect((await mcHandler.execute(context(['summary', '--ledger=ledger.json']))).exitCode).toBe(0);
    expect(output.mock.calls.flat().join('\n')).toContain('accepted: 0, completed: 1, failed: 0, unknown: 0');
    expect(output.mock.calls.flat().join('\n')).toContain('independent acceptance with evidence is unavailable');
  });

  it('shows summary help before reading any file', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect((await mcHandler.execute(context(['summary', '--ledger', 'absent.json', '--help']))).exitCode).toBe(0);
    expect(output.mock.calls.flat().join('\n')).toContain('Usage: aiwg mc summary');
    expect(await readdir(root)).toEqual([]);
  });

  it.each([[], ['--ledger'], ['--ledger', '--json'], ['--ledger', 'missing.json']].map(args => ({ args })))
  ('rejects missing ledger input $args without writing', async ({ args }) => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect((await mcHandler.execute(context(['summary', ...args]))).exitCode).toBe(1);
    expect(await readdir(root)).toEqual([]);
  });

  it('accepts a future execution mode and reports its cycles unknown', async () => {
    await writeFile(join(root, 'ledger.json'), JSON.stringify({ missionId: 'fixture', executionMode: 'future-mode',
      cycles: [{ cycleId: 'c1', routed: true }], checkpoint: { completed: ['c1'], failed: [], pending: [] } }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect((await mcHandler.execute(context(['summary', '--ledger', 'ledger.json', '--json']))).exitCode).toBe(0);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).cycles[0].status).toBe('unknown');
  });

  it.each(['not-json', 'null', '{}', '{"missionId":"fixture","cycles":[],"checkpoint":{}}'])
  ('rejects malformed ledger %s without writing', async bytes => {
    await writeFile(join(root, 'ledger.json'), bytes);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect((await mcHandler.execute(context(['summary', '--ledger', 'ledger.json']))).exitCode).toBe(1);
    expect(await readFile(join(root, 'ledger.json'), 'utf8')).toBe(bytes);
    expect(await readdir(root)).toEqual(['ledger.json']);
  });
});
