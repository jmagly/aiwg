import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteGraphBackend } from '../../../src/artifacts/backends/sqlite-backend.js';
import { describeWithSqlite } from '../../helpers/sqlite.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const tsxImportUrl = import.meta.resolve('tsx');
const backendUrl = pathToFileURL(
  fileURLToPath(new URL('../../../src/artifacts/backends/sqlite-backend.ts', import.meta.url)),
).href;
const featureRuntimeUrl = new URL('../../../src/features/runtime.ts', import.meta.url).href;

function waitForLocker(child: ChildProcess, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = '';
    let diagnostic = '';
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.stderr?.off('data', onDiagnostic);
      child.off('error', onError);
      child.off('close', onClose);
      if (error) reject(error); else resolve();
    };
    const onData = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const newline = output.indexOf('\n');
      if (newline >= 0) {
        if (output.slice(0, newline) === 'locked') finish();
        else finish(new Error('Locker emitted an unexpected readiness marker'));
      } else if (output.length > 4_096) finish(new Error('Locker readiness output exceeded its limit'));
    };
    const onDiagnostic = (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString('utf8')).slice(-2_048); };
    const onError = (error: Error) => finish(new Error(`Locker spawn failed: ${error.message}`));
    const onClose = (code: number | null, signal: string | null) => {
      finish(new Error(`Locker closed before readiness (code=${code}, signal=${signal}): ${diagnostic}`));
    };
    const timer = setTimeout(() => finish(new Error(`Locker readiness timed out: ${diagnostic}`)), timeoutMs);
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onDiagnostic);
    child.on('error', onError);
    child.on('close', onClose);
    if (child.exitCode !== null || child.signalCode !== null) onClose(child.exitCode, child.signalCode);
  });
}

function waitForLockerExit(child: ChildProcess): Promise<{ code: number | null; signal: string | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.off('close', onClose);
      child.off('error', onError);
    };
    const onClose = (code: number | null, signal: string | null) => { cleanup(); resolve({ code, signal }); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Locker did not exit after committing')); }, 2_000);
    child.once('close', onClose);
    child.once('error', onError);
  });
}

async function stopLocker(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(escalate);
      clearTimeout(deadline);
      child.off('close', onClose);
      child.off('error', onError);
      if (error) reject(error); else resolve();
    };
    const onClose = () => finish();
    const onError = (error: Error) => finish(error);
    const escalate = setTimeout(() => child.kill('SIGKILL'), 500);
    const deadline = setTimeout(() => finish(new Error('Locker did not terminate after SIGKILL')), 2_000);
    child.once('close', onClose);
    child.once('error', onError);
    child.kill('SIGTERM');
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describeWithSqlite('SQLite same-host concurrency and crash recovery (#2189)', () => {
  it('waits for a rollback-journal writer before initializing WAL and the graph schema', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-sqlite-init-'));
    roots.push(root);
    const dbPath = join(root, 'graph.db');
    const locker = spawn(process.execPath, ['--import', tsxImportUrl, '--input-type=module', '--eval', `
      const { requireFeaturePackage } = await import(${JSON.stringify(featureRuntimeUrl)});
      const Database = requireFeaturePackage('better-sqlite3');
      const db = new Database(process.argv[1]);
      db.exec('CREATE TABLE seed (id TEXT); BEGIN IMMEDIATE');
      process.stdout.write('locked\\n');
      setTimeout(() => { db.exec('COMMIT'); db.close(); }, 250);
    `, dbPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await waitForLocker(locker);
      const graph = new SqliteGraphBackend(dbPath, { busyTimeoutMs: 2_000 });
      try {
        graph.addNode('initialized');
        expect(graph.hasNode('initialized')).toBe(true);
        expect(graph.walMetrics().busy).toBe(0);
      } finally {
        graph.close();
      }
      expect(await waitForLockerExit(locker)).toEqual({ code: 0, signal: null });
    } finally {
      await stopLocker(locker);
    }
  }, 10_000);

  it('serializes multiple processes, deduplicates same-key races, and reopens committed WAL writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-sqlite-concurrency-'));
    roots.push(root);
    const dbPath = join(root, 'graph.db');
    const worker = `
      const { SqliteGraphBackend } = await import(${JSON.stringify(backendUrl)});
      const db = new SqliteGraphBackend(process.argv[1], { busyTimeoutMs: 10000 });
      const worker = process.argv[2];
      for (let i = 0; i < 20; i++) {
        db.addNode('shared', { worker, iteration: i });
        db.addEdge('worker-' + worker, 'node-' + worker + '-' + i, 'emits');
      }
      if (worker !== 'crash') db.close();
    `;
    const run = (workerId: string) => execFileAsync(process.execPath, [
      '--import', tsxImportUrl,
      '--input-type=module',
      '--eval', worker,
      dbPath,
      workerId,
    ]);

    await Promise.all(['a', 'b', 'c', 'crash'].map(run));

    const reopened = new SqliteGraphBackend(dbPath);
    try {
      expect(reopened.nodes().filter(id => id === 'shared')).toEqual(['shared']);
      expect(reopened.edgeCount()).toBe(80);
      for (const workerId of ['a', 'b', 'c', 'crash']) {
        expect(reopened.hasEdge(`worker-${workerId}`, `node-${workerId}-19`, 'emits')).toBe(true);
      }
    } finally {
      reopened.close();
    }
  }, 30_000);
});

describeWithSqlite('SQLite locker readiness protocol', () => {
  it.each([
    ['early exit', 'process.stderr.write("synthetic startup failure"); process.exit(7)', /code=7.*synthetic startup failure/],
    ['wrong marker', 'process.stdout.write("not-locked\\n"); setInterval(() => {}, 1000)', /unexpected readiness marker/],
    ['partial marker', 'process.stdout.write("lock"); setInterval(() => {}, 1000)', /readiness timed out/],
    ['no marker', 'setInterval(() => {}, 1000)', /readiness timed out/],
    ['oversized marker', 'process.stdout.write("x".repeat(4097)); setInterval(() => {}, 1000)', /output exceeded/],
  ] as const)('rejects %s and terminates its child', async (_name, script, error) => {
    const child = spawn(process.execPath, ['--eval', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    try { await expect(waitForLocker(child, 2_000)).rejects.toThrow(error); }
    finally { await stopLocker(child); }
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(child.stdout?.listenerCount('data')).toBe(0);
    expect(child.stderr?.listenerCount('data')).toBe(0);
  });

  it('accumulates a split marker before accepting readiness', async () => {
    const child = spawn(process.execPath, ['--eval', 'process.stdout.write("lo"); setTimeout(() => process.stdout.write("cked\\n"), 20); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'pipe'] });
    try { await expect(waitForLocker(child)).resolves.toBeUndefined(); }
    finally { await stopLocker(child); }
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(child.stdout?.listenerCount('data')).toBe(0);
  });

  it('reports spawn failure without waiting for the readiness deadline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-locker-spawn-'));
    roots.push(root);
    const child = spawn(join(root, 'missing-executable'), [], { stdio: ['ignore', 'pipe', 'pipe'] });
    try { await expect(waitForLocker(child)).rejects.toThrow(/Locker spawn failed:.*ENOENT/); }
    finally { await stopLocker(child); }
  });

  it('escalates cleanup when a ready child ignores SIGTERM', async () => {
    const child = spawn(process.execPath, ['--eval', 'process.on("SIGTERM", () => {}); process.stdout.write("locked\\n"); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'pipe'] });
    try { await waitForLocker(child); }
    finally { await stopLocker(child); }
    expect(child.signalCode).toBe('SIGKILL');
  });
});
