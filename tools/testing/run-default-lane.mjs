#!/usr/bin/env node
/** Run the default lane in an owned TMPDIR and check it even when tests fail. */
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ALLOWED_ENTRIES, findLeakedEntries } from './check-tmpdir-leaks.mjs';
import { importImpl } from '../_resolve-impl.mjs';

const { signalChild } = await importImpl(import.meta.url, 'process/signal-child.mjs');

export async function runDefaultLane(args = [], { command = process.execPath, runnerArgs } = {}) {
  // Keep the extra path component short for Unix-domain socket fixtures.
  const directory = mkdtempSync(path.join(tmpdir(), 'awt-'));
  const root = fileURLToPath(new URL('../../', import.meta.url));
  let code = 1;
  let child;
  const forwardSignal = signal => signalChild(child, signal);
  const onInterrupt = () => forwardSignal('SIGINT');
  const onTerminate = () => forwardSignal('SIGTERM');
  try {
    child = spawn(command, runnerArgs ?? [
      path.join(root, 'node_modules/vitest/vitest.mjs'), 'run',
      '--config', 'config/vitest.config.js', ...args,
    ], {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, TMPDIR: directory, TMP: directory, TEMP: directory,
        NODE_DISABLE_COMPILE_CACHE: '1', DISABLE_V8_COMPILE_CACHE: '1', TSX_DISABLE_CACHE: '1' },
    });
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onTerminate);
    code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (status) => resolve(status ?? 1));
    });
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
    const leaked = findLeakedEntries(directory);
    // These process-wide caches belong to this run too. Remove only the
    // checker's known tooling entries, never an unowned system temp directory.
    for (const name of readdirSync(directory)) {
      if (DEFAULT_ALLOWED_ENTRIES.some(pattern => pattern.test(name))) {
        rmSync(path.join(directory, name), { recursive: true, force: true });
      }
    }
    if (leaked.length) {
      console.error(`TMPDIR leak gate: ${leaked.length} entries left in ${directory}:\n${leaked.join('\n')}`);
      code = 1;
    } else {
      rmdirSync(directory);
      console.log('TMPDIR leak gate: 0 entries left behind.');
    }
  }
  return code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runDefaultLane(process.argv.slice(2));
}
