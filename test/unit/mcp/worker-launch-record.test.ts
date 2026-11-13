// Prove the returned MCP run directory is real launcher authority for installed verification and delivery.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { rmSync } from '../../helpers/worker-capture-cleanup.mjs';
import { waitForCondition } from '../../helpers/worker-lifecycle.mjs';
import { loadWorkerInputs } from '../../fixtures/ralph-external/conductor-worker-inputs.mjs';
import { createInvocationRegistry, registerWorkerInvokeToolset } from '../../../src/mcp/tools/worker-invoke.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const fixtures = path.join(repo, 'test/fixtures/ralph-external');
const quote = (s: string) => "'" + s.replaceAll("'", "'\"'\"'") + "'";

it.each(['accepted', 'blocked', 'rejected'])('T-OG-17 MCP launch returns owned run_dir and %s delivery honors verification', outcome => {
  const root = mkdtempSync(path.join(tmpdir(), 'aiwg-mcp-record-'));
  const work = path.join(root, '.aiwg', 'working', 'worktrees', 'worker');
  const clients = path.join(root, 'clients');
  try {
    mkdirSync(work, { recursive: true });
    mkdirSync(path.join(clients, 'proc'), { recursive: true });
    writeFileSync(path.join(root, 'codex'), readFileSync(path.join(fixtures, 'mcp-recorded-worker.mjs'), 'utf8')
      .replace('#!/usr/bin/env node', `#!${process.execPath}`), { mode: 0o700 });
    writeFileSync(path.join(root, 'brief.md'), 'Synthetic private worker brief.');
    writeFileSync(path.join(root, 'answer.txt'), 'original');
    copyFileSync(path.join(fixtures, 'verification-inputs.mjs'), path.join(clients, 'inputs.mjs'));
    writeFileSync(path.join(clients, 'qualified-roots.json'), JSON.stringify([work]));
    copyFileSync(path.join(fixtures, 'verification-systemd.mjs'), path.join(clients, 'client.mjs'));
    writeFileSync(path.join(clients, 'mode.txt'), outcome === 'blocked' ? 'unavailable' : 'enforced');
    for (const name of ['systemd-run', 'systemctl']) {
      writeFileSync(path.join(clients, name), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(clients, 'client.mjs'))} "$@"\n`, { mode: 0o700 });
    }
    const chosen = outcome === 'accepted' ? 'auto' : path.join(root, 'chosen-run');
    const result = spawnSync(process.execPath, ['--import', path.join(clients, 'inputs.mjs'),
      path.join(fixtures, 'mcp-launch-deliver.mjs'), root, chosen, outcome], {
      cwd: root, encoding: 'utf8', timeout: 20000,
      env: { NODE_ENV: 'test', CI: 'true', HOME: root, PATH: clients + path.delimiter + process.env.PATH,
        AIWG_EFFECT_LEDGER_TEST_KEY: '42'.repeat(32), AIWG_RESOLVE_IMPL_FROM: 'dist',
        AIWG_CONDUCTOR_PROBE_ARTIFACT: outcome === 'accepted' ? '1' : '0',
        AIWG_CONDUCTOR_PROBE_INPUTS: path.join(fixtures, 'conductor-worker-inputs.mjs') },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.run, JSON.stringify(output)).toMatchObject({ status: 'completed', termination: 'confirmed' });
    expect(path.isAbsolute(output.run.run_dir)).toBe(true);
    if (chosen !== 'auto') expect(output.run.run_dir).toBe(chosen);
    expect(output.status).toMatchObject({ run_dir: output.run.run_dir, invocationId: output.run.invocationId });
    expect(output.owner).toBe(output.run.invocationId);
    expect(output.records['invocation.json']).toMatchObject({ origin: 'launcher', invocationId: output.run.invocationId, worktree: { path: work } });
    expect(output.records['exit.json']).toMatchObject({ invocationId: output.run.invocationId, termination: 'confirmed', captureSeal: { digest: expect.stringMatching(/^sha256:/), files: expect.any(Array) } });
    if (outcome === 'accepted') expect(output.records['invocation.json'].artifacts).toEqual([expect.objectContaining({ name: 'brief' })]);
    expect(output.records['worker-exit.json']).toMatchObject({ invocationId: output.run.invocationId, exitCode: 0 });
    expect(output.records['final-evidence.json']).toMatchObject({ invocationId: output.run.invocationId, terminalSuccess: true });
    expect(output.verification, JSON.stringify(output.verification)).toMatchObject({ status: outcome });
    expect(output.bytes).toBe(outcome === 'accepted' ? 'accepted-worker-bytes' : 'original');
    if (outcome === 'accepted') expect(output.verification.deliveryRecord).toMatchObject({ phase: 'completed', recordHash: expect.stringMatching(/^sha256:/) });
    else expect(output.verification.deliveryRecord).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30000);

async function localHarness() {
  const root = mkdtempSync(path.join(tmpdir(), 'aiwg-mcp-owned-'));
  const work = path.join(root, '.aiwg', 'working', 'worktrees', 'worker');
  mkdirSync(work, { recursive: true });
  writeFileSync(path.join(root, 'brief.md'), 'Synthetic private brief');
  const tools = new Map<string, any>();
  const registry = createInvocationRegistry();
  await registerWorkerInvokeToolset({ registerTool(name, _schema, handler) { tools.set(name, handler); } }, {
    projectRoot: root, ensureWorkerContext: false, registry,
    loadWorkerInputs: () => loadWorkerInputs({ cwd: root }),
    gateInputs: { live: { supported: true, availMemGb: 64, load1: 0.1, cores: 8, loadRatio: 0.05,
      memPsiAvg10: 0, memPsiAvg60: 0, memPsiAvg300: 0, workers: 0, freeDiskGb: 100 } },
  });
  const call = async (input: object) => {
    const response = await tools.get('worker-invoke')(input);
    return response.isError ? { isError: true, text: response.content[0].text } : JSON.parse(response.content[0].text);
  };
  const input = { operation: 'run', request_id: 'owned-run', role: 'coding', task: 'implementation', group: 'workers',
    transport: 'shell', brief: path.join(root, 'brief.md'), workdir: work, final_output: path.join(work, 'claims.json') };
  return { root, work, registry, call, input };
}

it.each(['outside', 'worker', 'occupied', 'symlink', 'relative'])('T-OG-17 refuses unsafe run_dir %s before dispatch', async kind => {
  const h = await localHarness();
  try {
    const chosen = path.join(h.root, 'chosen-run');
    mkdirSync(chosen, { mode: 0o700 });
    writeFileSync(path.join(chosen, 'retained'), 'existing data');
    symlinkSync(h.work, path.join(h.root, 'link'));
    const run_dir = ({ outside: path.join(h.root, '..', 'outside'), worker: path.join(h.work, 'run'), occupied: chosen,
      symlink: path.join(h.root, 'link', 'run'), relative: 'relative-run' })[kind];
    const result = await h.call({ ...h.input, run_dir });
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'blocked', termination: 'confirmed' });
    expect(h.registry.canStart()).toBe(true);
    expect(existsSync(h.input.final_output)).toBe(false);
    expect(existsSync(path.join(h.work, 'artifact.txt'))).toBe(false);
    expect(readFileSync(path.join(chosen, 'retained'), 'utf8')).toBe('existing data');
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

it('T-OG-17 keeps live run_dir status and cancellation bound to the capture owner', async () => {
  const h = await localHarness();
  try {
    const cli = readFileSync(path.join(fixtures, 'mcp-recorded-worker.mjs'), 'utf8')
      .replace('#!/usr/bin/env node', `#!${process.execPath}`)
      .replace("writeFileSync('artifact.txt'", "await new Promise(() => setInterval(() => {}, 100));\nwriteFileSync('artifact.txt'");
    writeFileSync(path.join(h.root, 'codex'), cli, { mode: 0o700 });
    const pending = h.call(h.input);
    await waitForCondition(() => existsSync(path.join(h.work, 'proof.json')), 10000);
    const entry = h.registry.values()[0];
    const status = await h.call({ operation: 'status', invocation_id: entry.invocationId });
    expect(status).toMatchObject({ status: 'running', run_dir: expect.stringMatching(/^\//) });
    await h.call({ operation: 'cancel', invocation_id: entry.invocationId });
    const result = await pending;
    expect(result).toMatchObject({ status: 'cancelled', termination: 'confirmed', run_dir: status.run_dir });
    expect(JSON.parse(readFileSync(path.join(status.run_dir, 'exit.json'), 'utf8'))).toMatchObject({ cancelled: true, termination: 'confirmed' });
    expect(h.registry.canStart()).toBe(true);
  } finally { rmSync(h.root, { recursive: true, force: true }); }
}, 20000);
