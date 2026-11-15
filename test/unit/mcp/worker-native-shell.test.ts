// Exercise the production native-shell bridge with a fake CLI and real owned process group.
import { mkdtemp, mkdir, writeFile, readFile, lstat } from 'node:fs/promises';
import { rm } from '../../helpers/worker-capture-cleanup.mjs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { loadWorkerInputs } from '../../fixtures/ralph-external/conductor-worker-inputs.mjs';
import { registerWorkerInvokeToolset } from '../../../src/mcp/tools/worker-invoke.mjs';

it.each([false, true])('T-OG-17 launches a pinned native worker with framed stdin, drained pipes and confirmed stop with missing parent=%s', async missingParent => {
  const project = await mkdtemp(path.join(tmpdir(), 'aiwg-mcp-native-'));
  const runDir = path.join(project, 'worker-runs', 'nested', 'attempt-1');
  const work = path.join(project, '.aiwg', 'working', 'worktrees', 'worker');
  await mkdir(work, { recursive: true });
  await writeFile(path.join(project, 'brief.md'), 'private fixture brief');
  let fixtureCli = await readFile(new URL('../../fixtures/ralph-external/mcp-recorded-worker.mjs', import.meta.url), 'utf8');
  // Point the fake CLI's identity wait at the explicitly requested capture directory.
  if (missingParent) fixtureCli = fixtureCli.replace(
    "const run = entry.startsWith('.worker-run-') ? path.join(project, entry, 'run') : path.join(project, entry);",
    `const run = ${JSON.stringify(runDir)};`);
  await writeFile(path.join(project, 'codex'), fixtureCli.replace('#!/usr/bin/env node', `#!${process.execPath}`), { mode: 0o700 });
  const tools = new Map<string, any>();
  try {
    await registerWorkerInvokeToolset({ registerTool(name, config, handler) { tools.set(name, { config, handler }); } }, {
      projectRoot: project, ensureWorkerContext: false,
      gateInputs: { live: { supported: true, availMemGb: 64, load1: 0.1, cores: 8, loadRatio: 0.05,
        memPsiAvg10: 0, memPsiAvg60: 0, memPsiAvg300: 0, workers: 0, freeDiskGb: 100 } },
      loadWorkerInputs: async () => loadWorkerInputs({ cwd: project }),
    });
    const response = await tools.get('worker-invoke').handler({ operation: 'run', request_id: 'native-fixture',
      role: 'coding', task: 'implementation', group: 'workers', transport: 'shell',
      brief: path.join(project, 'brief.md'), workdir: work, final_output: path.join(work, 'claims.json'),
      ...(missingParent ? { run_dir: runDir } : {}) });
    const result = JSON.parse(response.content[0].text);
    expect(path.isAbsolute(result.run_dir)).toBe(true);
    if (missingParent) {
      expect(result.run_dir).toBe(runDir);
      expect((await lstat(path.dirname(runDir))).mode & 0o777).toBe(0o700);
    }
    const record = JSON.parse(await readFile(path.join(result.run_dir, 'invocation.json'), 'utf8'));
    expect(record).toMatchObject({ origin: 'launcher', invocationId: result.invocationId, worktree: { path: work } });
    for (const name of ['exit.json', 'worker-exit.json', 'final-evidence.json']) {
      expect(JSON.parse(await readFile(path.join(result.run_dir, name), 'utf8'))).toHaveProperty('invocationId', result.invocationId);
    }
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'completed', termination: 'confirmed', isolationMode: 'native-sandbox' });
    const proof = JSON.parse(await readFile(path.join(work, 'proof.json'), 'utf8'));
    expect(proof).toMatchObject({ cwd: work, group: 'workers' });
    expect(proof.prompt).toContain('private fixture brief');
    const status = await tools.get('worker-invoke').handler({ operation: 'status', invocation_id: result.invocationId });
    expect(JSON.parse(status.content[0].text)).toMatchObject({ status: 'completed', termination: 'confirmed', run_dir: result.run_dir });
  } finally { await rm(project, { recursive: true, force: true }); }
}, 30000);
