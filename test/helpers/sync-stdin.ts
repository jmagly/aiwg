// Capture descriptor-backed stdin at a mocked synchronous call, before cleanup.
import { fstatSync, readSync } from 'node:fs';

const snapshots = new WeakMap<object, string>();

export function captureSyncStdinCall(run: (...args: any[]) => unknown, args: any[]): unknown {
  const options = args[2];
  const stdin = Array.isArray(options?.stdio) ? options.stdio[0] : undefined;
  if (typeof stdin === 'number' && fstatSync(stdin).isFile()) {
    const bytes = Buffer.alloc(fstatSync(stdin).size);
    readSync(stdin, bytes, 0, bytes.length, 0);
    snapshots.set(options, bytes.toString('utf8'));
  }
  return run(...args);
}

export function capturedSyncStdin(options: object): string | undefined {
  return snapshots.get(options);
}
