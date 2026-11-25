// Observe terminal quota failures from bounded stream tails using configured installation scopes.
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { importImpl } from '../../_resolve-impl.mjs';
import { withWorkerPath } from './worker-inputs.mjs';

async function streamTail(filename, inspect) {
  if (!await inspect(filename, 'file')) return '';
  const handle = await withWorkerPath(filename, target => open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('Worker quota capture must be an unaliased regular file');
    const bytes = Buffer.alloc(Math.min(stat.size, 1024 * 1024));
    let length = 0;
    const start = Math.max(0, stat.size - bytes.length);
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, start + length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    return bytes.subarray(0, length).toString('utf8');
  } finally { await handle.close(); }
}

export async function observeWorkerQuotaCapture({ invocation, paths, quotaScope, exitCode, inspect }) {
  const { parseWorkerQuotaFailure, recordWorkerQuotaFailure } = await importImpl(import.meta.url, 'models/worker-quota-observations.mjs');
  const output = (await Promise.all([paths.stdout, paths.stderr].filter(Boolean).map(filename => streamTail(filename, inspect)))).join('\n');
  if (!parseWorkerQuotaFailure(output, Date.now(), exitCode !== 0)) return false;
  const cli = invocation.selected?.cli;
  if (!quotaScope) {
    const { readAiwgConfig } = await importImpl(import.meta.url, 'config/aiwg-config.js');
    quotaScope = (await readAiwgConfig(invocation.cwd))?.parallelism?.clis?.[cli]?.quotaScope;
  }
  return recordWorkerQuotaFailure({ cwd: invocation.cwd, cli, quotaScope, output, exitCode });
}
