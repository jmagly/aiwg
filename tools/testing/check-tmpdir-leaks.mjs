#!/usr/bin/env node
/**
 * TMPDIR leak gate (#3018).
 *
 * Used by run-default-lane.mjs (npm test) after the child exits, including on
 * test failure. Can also inspect a private TMPDIR from a direct Vitest run:
 *
 *   node tools/testing/check-tmpdir-leaks.mjs --dir /path/to/private-tmp-dir
 *
 * This checker only reports entries; it never deletes them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Entries Node/tooling itself creates directly under the OS temp directory,
 * independent of how many tests ran or which ones (process-wide compile
 * caches) — not a per-test leak and not owned by any single test file.
 */
export const DEFAULT_ALLOWED_ENTRIES = [/^node-compile-cache$/, /^tsx-\d+$/];

/**
 * Entries left behind under `dir`, excluding `DEFAULT_ALLOWED_ENTRIES` and any
 * caller-supplied `allow` patterns. Returns `[]` (not an error) when `dir`
 * does not exist — a run that never created the directory at all leaked
 * nothing into it.
 */
export function findLeakedEntries(dir, { allow = [] } = {}) {
  const patterns = [...DEFAULT_ALLOWED_ENTRIES, ...allow];
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  return entries.filter(name => !patterns.some(pattern => pattern.test(name))).sort();
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const args = process.argv.slice(2);
  const dirFlagIndex = args.indexOf('--dir');
  const dir = dirFlagIndex >= 0 ? args[dirFlagIndex + 1] : process.env.TMPDIR;
  if (!dir) {
    console.error('Usage: check-tmpdir-leaks.mjs --dir <private-tmp-dir>  (or set TMPDIR)');
    process.exitCode = 2;
  } else {
    const resolved = path.resolve(dir);
    const leaked = findLeakedEntries(resolved);
    if (leaked.length) {
      for (const name of leaked) console.error(path.join(resolved, name));
      console.error(`Found ${leaked.length} entries left behind in ${resolved}.`);
      console.error('A test run must remove every temp directory it creates, including on failure '
        + '(afterEach/afterAll cleanup, or try/finally in the creating helper) (#3018).');
      process.exitCode = 1;
    } else {
      console.log(`TMPDIR leak gate: 0 entries left in ${resolved}.`);
    }
  }
}
