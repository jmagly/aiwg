/**
 * Optional sqlite backend guard for tests (#2515).
 *
 * `better-sqlite3` is an *optional* peer dependency, so `npm install && npm test`
 * on a clean checkout does not provide it. Suites that need the backend must
 * report as skipped with a named remedy rather than failing with downstream
 * symptoms that never mention the cause.
 *
 * Missing optional features warn; they do not error. CI installs the backend
 * and therefore runs every suite below for real.
 */

import { describe, it } from 'vitest';
import { requireFeaturePackage } from '../../src/features/runtime.js';

/** Resolve once per worker, through the same path production code uses. */
function resolveSqlite(): boolean {
  try {
    requireFeaturePackage('better-sqlite3');
    return true;
  } catch {
    return false;
  }
}

export const sqliteAvailable = resolveSqlite();

export const SQLITE_SKIP_REASON =
  'optional sqlite backend unavailable — `better-sqlite3` is not installed; ' +
  'run `npm run features:sqlite` (or `aiwg features install sqlite`) to enable these suites';

let warned = false;

/** Warn once per worker so a skipped suite is never silently invisible. */
export function warnSqliteUnavailable(): void {
  if (sqliteAvailable || warned) return;
  warned = true;
  console.warn(`[skip] ${SQLITE_SKIP_REASON}`);
}

warnSqliteUnavailable();

/** `describe` that skips, with a reason, when the sqlite backend is absent. */
export const describeWithSqlite = describe.skipIf(!sqliteAvailable);

/** `it` that skips, with a reason, when the sqlite backend is absent. */
export const itWithSqlite = it.skipIf(!sqliteAvailable);

/** Guard for table-driven suites that loop over several backends. */
export function backendUnavailable(backend: string): boolean {
  return backend === 'sqlite' && !sqliteAvailable;
}
