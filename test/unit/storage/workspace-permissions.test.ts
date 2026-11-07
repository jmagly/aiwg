// Reproduces shared-workspace ACL mask loss and dropped decision journal records.
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, chmod, stat, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { atomicConfigWrite } from '../../../src/config/worker-write.js';
import { buildDecisionLedgerRecord, appendDecisionLedgerRecord, rotateDecisionLedger } from '../../../src/decision/ledger.js';
import { appendDecisionOpportunity } from '../../../src/decision/offload.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn), spawnSync: vi.fn(actual.spawnSync),
    exec: vi.fn(actual.exec), execSync: vi.fn(actual.execSync), execFile: vi.fn(actual.execFile), execFileSync: vi.fn(actual.execFileSync) };
});

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'aiwg-shared-write-')); roots.push(root);
  vi.stubEnv('AIWG_ARTIFACTS_PATH', join(root, '.aiwg'));
  await chmod(root, 0o2770);
  return root;
}
function acl(root: string): boolean {
  try {
    execFileSync('setfacl', ['-m', 'd:u::rwx,d:g::rwx,d:m::rwx,d:o::---', root], { timeout: 2000, stdio: 'pipe' });
    return true;
  } catch { return false; }
}

it('keeps inherited ACL masks for new config files and preserves replacement modes under umask', async ctx => {
  const root = await workspace();
  if (!acl(root)) { ctx.skip(); return; }
  const config = join(root, '.aiwg', 'aiwg.config');
  await atomicConfigWrite(config, '{}');
  expect((await stat(config)).mode & 0o777).toBe(0o660);
  expect(execFileSync('getfacl', ['-cp', config], { timeout: 2000, encoding: 'utf8' })).toContain('mask::rw-');
  // Without a default ACL, creation is also filtered by the process umask.
  execFileSync('setfacl', ['-b', config], { timeout: 2000 });
  execFileSync('setfacl', ['-k', join(root, '.aiwg')], { timeout: 2000 });
  await chmod(config, 0o660);
  await atomicConfigWrite(config, '{"updated":true}');
  expect((await stat(config)).mode & 0o777).toBe(0o660);
});

it('appends both journals and rotates a pre-existing 0660 ledger in a shared workspace', async ctx => {
  const root = await workspace();
  if (!acl(root)) { ctx.skip(); return; }
  const directory = join(root, '.aiwg', 'decision');
  await mkdir(directory, { recursive: true });
  const file = join(directory, 'ledger.jsonl');
  await writeFile(file, '', { mode: 0o660 });
  const record = buildDecisionLedgerRecord(
    { question: 'Proceed?', mode: { kind: 'yes-no' } },
    { schema: 'aiwg-decision-ask/v1', status: 'fallback', answer: null, confidence: null, probability: null,
      fallback: 'llm', reason: 'not-configured', model: null, usage: null, latencyMs: 0 },
    { projectRoot: root, transport: 'cli', provider: 'codex', sessionId: 'shared-test', caller: null },
  );
  const warnings: string[] = [];
  for (let index = 0; index < 3; index++) {
    expect(await appendDecisionLedgerRecord(record, { projectRoot: root, warn: text => warnings.push(text) })).toBe(true);
  }
  expect(await appendDecisionOpportunity({ schema: 'aiwg-decision-opportunity/v1', correlationId: record.id,
    timestamp: record.timestamp, phase: 'completed', provider: 'codex', sessionId: 'shared-test', sessionSource: 'explicit',
    transport: 'cli', caller: 'test:shared', category: 'organic', eligible: true, attempted: true,
    outcome: 'fallback', reason: 'not-configured', ledgerRecorded: true }, root, text => warnings.push(text))).toBe(true);
  expect(warnings).toEqual([]);
  expect((await readFile(file, 'utf8')).trim().split('\n')).toHaveLength(3);
  const rotated = await rotateDecisionLedger({ projectRoot: root, all: true });
  expect(rotated.archived).toBe(3);
  for (const target of [file, rotated.archivePath!]) expect((await stat(target)).mode & 0o777).toBe(0o660);
});

it('diagnoses and repairs collapsed non-secret masks without changing secrets or symlink targets', async ctx => {
  const root = await workspace();
  if (!acl(root)) { ctx.skip(); return; }
  const { inspectWorkspacePermissions } = await import('../../../src/storage/workspace-permissions-health.js');
  const { symlink } = await import('node:fs/promises');
  const receiptDir = join(root, '.aiwg', 'receipts');
  await mkdir(receiptDir, { recursive: true, mode: 0o700 });
  const receipt = join(receiptDir, 'codex.json');
  await writeFile(receipt, '{}', { mode: 0o600 });
  const secret = join(root, '.aiwg', 'secret.key');
  await writeFile(secret, 'synthetic-secret', { mode: 0o600 });
  await symlink(secret, join(receiptDir, 'linked.json'));
  const before = await inspectWorkspacePermissions(root);
  expect(before.findings.map(finding => finding.path)).toEqual(expect.arrayContaining([receiptDir, receipt]));
  expect(before.findings.every(finding => !finding.repaired)).toBe(true);
  const repaired = await inspectWorkspacePermissions(root, true);
  expect(repaired.findings.every(finding => finding.repaired)).toBe(true);
  expect((await stat(receiptDir)).mode & 0o7777).toBe(0o2770);
  expect((await stat(receipt)).mode & 0o777).toBe(0o660);
  expect((await stat(secret)).mode & 0o777).toBe(0o600);
  expect((await inspectWorkspacePermissions(root)).findings).toEqual([]);
});

it.skipIf(process.platform === 'win32')('reports and repairs a group-readable journal outside the shared-workspace policy', async () => {
  const root = await workspace();
  await chmod(root, 0o700);
  const { inspectWorkspacePermissions } = await import('../../../src/storage/workspace-permissions-health.js');
  const directory = join(root, '.aiwg', 'decision');
  await mkdir(directory, { recursive: true });
  const ledger = join(directory, 'ledger.jsonl');
  await writeFile(ledger, ''); await chmod(ledger, 0o660);
  expect(await inspectWorkspacePermissions(root)).toMatchObject({ findings: [{ path: ledger, reason: 'ledger-permissions',
    repaired: false, repair: 'aiwg doctor --decision-offload --fix' }], journals: [{ state: 'unsafe' }] });
  await inspectWorkspacePermissions(root, true);
  expect((await stat(ledger)).mode & 0o777).toBe(0o600);
});

it.skipIf(process.platform === 'win32')('detects sharing by setgid and others bits, rejects mismatched gids and rechecks changed policy', async () => {
  const root = await workspace();
  const { sharedWorkspace, workspacePermissionsAllowed } = await import('../../../src/storage/workspace-permissions.js');
  const gid = (await stat(root)).gid;
  expect(sharedWorkspace(join(root, 'missing', 'nested'))).toEqual({ gid });
  expect(workspacePermissionsAllowed(join(root, 'file'), { mode: 0o660, gid })).toBe(true);
  expect(workspacePermissionsAllowed(join(root, 'file'), { mode: 0o660, gid: gid + 1 })).toBe(false);
  expect(workspacePermissionsAllowed(join(root, 'file'), { mode: 0o664, gid })).toBe(false);
  await chmod(root, 0o2775);
  expect(sharedWorkspace(root)).toBeNull();
  await chmod(root, 0o770);
  expect(sharedWorkspace(root)).toBeNull();
});

it('keeps effect ledger directories and its sensitive index key private under default ACLs', async ctx => {
  const root = await workspace();
  if (!acl(root)) { ctx.skip(); return; }
  const { resolveLedgerPaths, ensureLedgerDirectories, loadIndexKey } = await import('../../../src/effects/store.js');
  const paths = resolveLedgerPaths(root, 'delivery');
  await ensureLedgerDirectories(paths);
  expect(await loadIndexKey(paths)).toHaveLength(32);
  expect((await stat(paths.root)).mode & 0o777).toBe(0o700);
  expect((await stat(paths.indexKey)).mode & 0o777).toBe(0o600);
  await chmod(paths.indexKey, 0o660);
  await expect(loadIndexKey(paths)).rejects.toThrow();
});

it('keeps provider receipts and firewall baselines shared on create and replace', async ctx => {
  const root = await workspace();
  if (!acl(root)) { ctx.skip(); return; }
  const { createProviderTransformationReceipt, writeProviderTransformationReceipt } = await import('../../../src/providers/transformation-receipt.js');
  const { scanContextMemoryFirewall, writeReviewBaseline } = await import('../../../tools/security/context-memory-firewall.mjs');
  await writeFile(join(root, 'AIWG.md'), '# Synthetic context\n');
  const receipt = await createProviderTransformationReceipt({ projectRoot: root, provider: 'codex', scope: 'project',
    generatedAt: '2026-11-07T00:00:00.000Z', source: { subject: 'fixture', sha256: 'a'.repeat(64), verification: 'verified' },
    transformer: { id: 'test', version: '1', providerAdapter: 'codex', providerAdapterVersion: '1' }, outputPaths: ['AIWG.md'] });
  const target = await writeProviderTransformationReceipt(root, receipt);
  await writeProviderTransformationReceipt(root, { ...receipt, source: { ...receipt.source, sha256: 'b'.repeat(64) } });
  const scan = await scanContextMemoryFirewall({ rootDir: root, providers: ['codex'], contentScan: false });
  const baseline = await writeReviewBaseline(scan, '.aiwg/context-memory-firewall-baseline.json');
  await writeReviewBaseline(scan, '.aiwg/context-memory-firewall-baseline.json');
  for (const file of [target, baseline]) expect((await stat(file)).mode & 0o777).toBe(0o660);
});

it('records every bounded ask under shard load without launching permission subprocesses', async ctx => {
  const root = await workspace();
  if (!acl(root)) { ctx.skip(); return; }
  const childProcess = await import('node:child_process');
  const launches = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync'] as const;
  const spies = launches.map(name => vi.mocked(childProcess[name]).mockClear().mockImplementation(() => { throw new Error('Unexpected write-path subprocess'); }));
  try {
    const { runDecisionOffloadCheckpoint } = await import('../../../src/decision/offload.js');
    for (let index = 0; index < 10; index++) {
      const invocation = await runDecisionOffloadCheckpoint({ question: 'Proceed?', mode: { kind: 'yes-no' } }, {
        projectRoot: root, transport: 'cli', caller: 'test:shared', explicitSessionId: 'acl-load', env: {},
        resolveProvider: async () => ({ provider: 'codex', source: 'explicit', warnings: [] }),
        ask: async () => ({ schema: 'aiwg-decision-ask/v1', status: 'fallback', answer: null, confidence: null,
          probability: null, fallback: 'llm', reason: 'not-configured', model: null, usage: null, latencyMs: 0 }),
      });
      expect(invocation.opportunity.ledgerRecorded).toBe(true);
      expect(invocation.opportunityRecorded).toBe(true);
    }
    expect((await readFile(join(root, '.aiwg', 'decision', 'ledger.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(10);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  } finally { for (const spy of spies) spy.mockRestore(); }
});
