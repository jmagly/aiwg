// Verify shared journal acceptance, private journal rejection and visible CLI/doctor diagnostics.
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildDecisionLedgerRecord, appendDecisionLedgerRecord, rotateDecisionLedger } from '../../../src/decision/ledger.js';
import { runDecisionOffloadCheckpoint } from '../../../src/decision/offload.js';
import { inspectDecisionRecording } from '../../../src/decision/recording-health.js';
import { readAcl } from '../../../src/utils/workspace-permissions.mjs';
import { heldoutDirectory, writeHeldoutFile } from '../../../src/decision/heldout/journal.js';
import { formatDecisionOffloadReport } from '../../../tools/cli/decision-offload-report.mjs';
import type { DecisionAskInput, DecisionAskResult } from '../../../src/decision/ask.js';

const roots: string[] = [];
const input: DecisionAskInput = { question: 'Synthetic choice?', mode: { kind: 'yes-no' } };
const answer: DecisionAskResult = { schema: 'aiwg-decision-ask/v1', status: 'answered', answer: true,
  confidence: 0.95, fallback: null, reason: 'none', model: 'fake-local', usage: null, latencyMs: 0 };
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(shared = false) {
  const root = await mkdtemp(join(tmpdir(), 'aiwg-shared-recording-'));
  roots.push(root);
  await chmod(root, shared ? 0o2770 : 0o700);
  return root;
}
function options(projectRoot: string) {
  return { projectRoot, transport: 'cli' as const, caller: 'fixture:pick', explicitProvider: 'codex',
    explicitSessionId: 'fixture', env: {}, ask: async () => answer, warn: () => {}, timeoutMs: 2000,
    resolveProvider: async () => ({ provider: 'codex', source: 'explicit' as const, candidates: ['codex'], reason: 'fixture' }) };
}

describe.skipIf(process.platform === 'win32')('shared decision recording', () => {
  it('records ledger and opportunities with setgid alone', async () => {
    const root = await fixture(true);
    const result = await runDecisionOffloadCheckpoint(input, options(root));
    expect(result).toMatchObject({ outcome: 'answered', attemptRecorded: true, opportunityRecorded: true,
      opportunity: { ledgerRecorded: true } });
    expect(result.result).not.toHaveProperty('ledger');
    for (const name of ['ledger.jsonl', 'opportunities.jsonl']) {
      const file = join(root, '.aiwg', 'decision', name);
      expect((await stat(file)).gid).toBe((await stat(root)).gid);
      expect((await stat(file)).mode & 0o007).toBe(0);
    }
    expect((await inspectDecisionRecording(root)).findings).toEqual([]);
  });

  it('records and rotates under default ACLs without collapsing masks', async context => {
    const root = await fixture(true);
    try {
      execFileSync('setfacl', ['-m', 'd:u::rwx,d:g::rwx,d:m::rwx,d:o::---', '--', root], { timeout: 5000 });
      if (!readAcl(root)?.includes('default:mask::rwx')) throw new Error('ACLs unsupported');
    } catch { context.skip(); return; }
    const result = await runDecisionOffloadCheckpoint(input, options(root));
    expect(result.opportunity.ledgerRecorded).toBe(true);
    const traces = join(root, '.aiwg', 'traces');
    await heldoutDirectory(traces);
    const trace = join(traces, 'synthetic.json');
    await writeHeldoutFile(trace, { events: [] });
    expect(readAcl(trace)).toMatch(/^mask::rw-$/m);
    for (const name of ['ledger.jsonl', 'opportunities.jsonl']) {
      expect(readAcl(join(root, '.aiwg', 'decision', name))).toMatch(/^mask::rw-$/m);
    }
    const record = buildDecisionLedgerRecord(input, answer, { transport: 'cli', provider: 'codex',
      sessionId: 'fixture', projectRoot: root, now: () => Date.now() - 1000 });
    expect(await appendDecisionLedgerRecord(record, { projectRoot: root })).toBe(true);
    const rotated = await rotateDecisionLedger({ projectRoot: root, keepLast: '1' });
    expect(rotated.archived).toBe(1);
    expect(readAcl(rotated.archivePath!)).toMatch(/^mask::rw-$/m);
    expect(readAcl(join(root, '.aiwg', 'decision', 'ledger.jsonl'))).toMatch(/^mask::rw-$/m);
  });

  it('rejects group bits outside shared workspaces and reports a JSON skip plus doctor repair', async () => {
    const root = await fixture();
    const directory = join(root, '.aiwg', 'decision');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, 'ledger.jsonl');
    await writeFile(file, '', { mode: 0o660 });
    await chmod(file, 0o660);
    const result = await runDecisionOffloadCheckpoint(input, options(root));
    expect(JSON.parse(JSON.stringify(result.result)).ledger).toMatch(/^skipped:.*group or other permission/);
    expect(await readFile(file, 'utf8')).toBe('');
    const recording = await inspectDecisionRecording(root);
    expect(recording).toMatchObject({ status: 'skipped', findings: [{ path: file, reason: 'unsafe-permissions' }] });
    expect(formatDecisionOffloadReport({ recording }).join('\n')).toContain('Recording skipped:unsafe-permissions');
    expect(formatDecisionOffloadReport({ recording }).join('\n')).toContain('Repair:');

    const packageRoot = resolve('.');
    const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, 'empty-config'),
      AIWG_ROOT: packageRoot, AIWG_HOME: root, AIWG_RESOLVE_IMPL_FROM: 'dist', AIWG_DECISION_ENABLED: 'false',
      AIWG_ARTIFACTS_PATH: '', JEV_API_KEY: '', AIWG_DECISION_JEV_API_KEY: '' };
    const doctor = execFileSync(process.execPath, [join(packageRoot, 'tools/cli/doctor.mjs'), '--decision-offload', '--json'],
      { cwd: root, env, encoding: 'utf8', timeout: 30_000 });
    expect(JSON.parse(doctor).decisionOffload.recording).toMatchObject({ status: 'skipped', findings: [{ reason: 'unsafe-permissions' }] });
    const ask = execFileSync(process.execPath, [join(packageRoot, 'bin/aiwg.mjs'), 'decision', 'ask', '--question', 'Synthetic?', '--yes-no', '--provider', 'codex', '--json'],
      { cwd: root, env, encoding: 'utf8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'] });
    expect(JSON.parse(ask).ledger).toMatch(/^skipped:/);
  });

  it('continues to reject other access in a shared workspace', async () => {
    const root = await fixture(true);
    const directory = join(root, '.aiwg', 'decision');
    await mkdir(directory, { recursive: true });
    const file = join(directory, 'ledger.jsonl');
    await writeFile(file, '');
    await chmod(file, 0o664);
    const result = await runDecisionOffloadCheckpoint(input, options(root));
    expect(result.result?.ledger).toMatch(/^skipped:/);
    expect(await readFile(file, 'utf8')).toBe('');
  });

  it('rejects a private workspace opportunity journal with group bits', async () => {
    const root = await fixture();
    const directory = join(root, '.aiwg', 'decision');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, 'opportunities.jsonl');
    await writeFile(file, '');
    await chmod(file, 0o660);
    const result = await runDecisionOffloadCheckpoint(input, options(root));
    expect(result).toMatchObject({ attemptRecorded: false, opportunityRecorded: false,
      opportunity: { ledgerRecorded: true } });
    expect(await readFile(file, 'utf8')).toBe('');
    expect(await inspectDecisionRecording(root)).toMatchObject({ status: 'skipped',
      findings: [{ path: file, reason: 'unsafe-permissions' }] });
  });
});
