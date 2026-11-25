import { link, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { observeWorkerQuotaCapture } from '../../../tools/ralph-external/lib/worker-quota-capture.mjs';
import { completeShellWorkerCapture } from '../../../tools/ralph-external/lib/worker-shell-capture.mjs';
import { WorkerCaptureOwner } from '../../../tools/ralph-external/lib/worker-capture.mjs';
import { inspectWorkerPath } from '../../../src/serve/worker-invocation-paths.js';
import { loadWorkerQuotaObservations } from '../../../src/models/worker-quota-observations.mjs';

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) {
  // Capture sealing intentionally makes its directory read-only.
  const { rm: removeCaptures } = await import('../../helpers/worker-capture-cleanup.mjs');
  await removeCaptures(root, { recursive: true, force: true });
} });

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'aiwg-quota-capture-')); roots.push(root);
  const cwd = path.join(root, 'project'); await mkdir(cwd);
  await mkdir(path.join(cwd, '.aiwg'));
  await writeFile(path.join(cwd, '.aiwg/aiwg.config'), JSON.stringify({ version: '1.0', providers: ['codex'],
    parallelism: { clis: { codex: { adapter: 'providers:codex', accountScope: 'synthetic', quotaScope: 'shared' } } } }));
  vi.stubEnv('AIWG_CONFIG', path.join(root, 'config'));
  vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
  const paths = { stdout: path.join(root, 'stdout'), stderr: path.join(root, 'stderr') };
  const invocation = { cwd, selected: { cli: 'codex' } };
  const output = await readFile(path.resolve('test/fixtures/worker-quota/codex-usage-limit.jsonl'), 'utf8');
  return { root, paths, invocation, output, inspect: inspectWorkerPath, exitCode: 1 };
}

it('records an exit-zero terminal error and reads only a bounded tail of a large stream', async () => {
  const f = await fixture();
  await writeFile(f.paths.stdout, 'x'.repeat(2 * 1024 * 1024) + '\n' + f.output);
  expect(await completeShellWorkerCapture({ ...f, quotaScope: 'shared' }, 0)).toBe(1);
  expect(await loadWorkerQuotaObservations(f.invocation.cwd)).toEqual([expect.objectContaining({ quotaScope: 'shared', resetAt: '2026-11-29T10:56:00.000Z' })]);
});

it('preserves success and ordinary failure exit codes without creating observations', async () => {
  const f = await fixture();
  expect(await completeShellWorkerCapture(f, 0)).toBe(0);
  expect(await completeShellWorkerCapture(f, 7)).toBe(7);
  expect(await observeWorkerQuotaCapture({ ...f, paths: {} })).toBe(false);
  expect(await loadWorkerQuotaObservations(f.invocation.cwd)).toEqual([]);
});

it('binds stderr usage-limit text to the configured installation quota, ignoring an event-supplied scope', async () => {
  const f = await fixture();
  await writeFile(f.paths.stderr, f.output.replaceAll('"type":"error"', '"quota_scope":"forged","type":"error"'));
  expect(await observeWorkerQuotaCapture(f)).toBe(true);
  expect((await loadWorkerQuotaObservations(f.invocation.cwd))[0].quotaScope).toBe('shared');
  await writeFile(f.paths.stderr, "You've hit your usage limit. Please try again at Nov 29th, 2026 10:56 AM UTC.");
  expect(await observeWorkerQuotaCapture(f)).toBe(true);
});

it('does not infer an account when the installation has no configured scope', async () => {
  const f = await fixture();
  await writeFile(path.join(f.invocation.cwd, '.aiwg/aiwg.config'), JSON.stringify({ version: '1.0', providers: ['codex'] }));
  await writeFile(f.paths.stdout, f.output);
  expect(await observeWorkerQuotaCapture(f)).toBe(false);
});

it('refuses aliased capture inputs', async () => {
  const f = await fixture();
  await writeFile(f.paths.stdout, f.output);
  await link(f.paths.stdout, path.join(f.root, 'alias'));
  await expect(observeWorkerQuotaCapture(f)).rejects.toThrow(/unaliased/);
});

it('records exhaustion when the existing capture owner finishes a launched attempt', async () => {
  const f = await fixture();
  const runDir = path.join(f.root, 'run'); await mkdir(runDir);
  await writeFile(f.paths.stdout, f.output);
  const owner = new WorkerCaptureOwner({ runDir, paths: f.paths, captures: {}, inspect: f.inspect, invocationId: 'synthetic' });
  const publish = vi.fn(async () => {});
  const writer = owner.writer(publish);
  await writer(runDir, 'invocation.json', f.invocation, f.inspect);
  await writer(runDir, 'exit.json', { exitCode: 1 }, f.inspect);
  await owner.finish();
  expect((await loadWorkerQuotaObservations(f.invocation.cwd))[0].quotaScope).toBe('shared');
});

it('completes through the shell helper CLI entry while preserving a nonzero exit', async () => {
  const f = await fixture();
  await writeFile(f.paths.stdout, f.output);
  const argv = process.argv; const exitCode = process.exitCode;
  try {
    process.argv = [process.execPath, fileURLToPath(new URL('../../../tools/ralph-external/lib/worker-shell-capture.mjs', import.meta.url)),
      JSON.stringify({ invocation: f.invocation, paths: f.paths, quotaScope: 'shared' }), '--complete', '9'];
    vi.resetModules();
    await import('../../../tools/ralph-external/lib/worker-shell-capture.mjs');
    expect(process.exitCode).toBe(9);
  } finally { process.argv = argv; process.exitCode = exitCode; }
});
