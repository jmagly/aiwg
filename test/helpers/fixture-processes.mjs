import { afterAll, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { signalChild } from '../../src/process/signal-child.mjs';

const pidFileEnv = 'AIWG_TEST_PROCESS_PID_FILE';

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

/** Own only fixture PIDs recorded in this test's private journal. */
export function useFixtureProcesses() {
  const pending = new Set();
  const children = new Map();
  let directory;
  let previousPidFile;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'aiwg-fixture-processes-'));
    previousPidFile = process.env[pidFileEnv];
    process.env[pidFileEnv] = join(directory, 'pids');
  });

  afterEach(async () => {
    try {
      const journal = join(directory, 'pids');
      try {
        for (const line of readFileSync(journal, 'utf8').trim().split('\n')) {
          const pid = Number(line);
          if (Number.isSafeInteger(pid) && pid > 0) pending.add(pid);
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      // Track immediately at spawn too: a failing test can precede fixture startup.
      for (const pid of children.keys()) pending.add(pid);
      await Promise.all([...pending].map(async pid => {
        const child = children.get(pid);
        if (child ? child.exitCode === null && child.signalCode === null : isAlive(pid)) {
          // Synchronous APIs expose a PID rather than a ChildProcess. Their
          // journal also covers descendants if a shell wasn't replaced by exec.
          signalChild(child ?? { pid, kill: signal => process.kill(pid, signal) }, 'SIGKILL');
        }
        const deadline = Date.now() + 5_000;
        while (child ? child.exitCode === null && child.signalCode === null : isAlive(pid)) {
          if (Date.now() >= deadline) throw new Error(`Fixture child ${pid} survived SIGKILL`);
          await delay(10);
        }
        pending.delete(pid);
        children.delete(pid);
      }));
    } finally {
      if (previousPidFile === undefined) delete process.env[pidFileEnv];
      else process.env[pidFileEnv] = previousPidFile;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    if (pending.size || children.size) {
      throw new Error(`Fixture children outlived the test file: ${[...new Set([...pending, ...children.keys()])].join(', ')}`);
    }
  });

  return child => {
    if (child.pid) children.set(child.pid, child);
    return child;
  };
}
