// Presents the same read-only authorization health snapshot in status probes and doctor checks.
import { importImpl } from '../_resolve-impl.mjs';
export async function readAuthorizationHealth(projectDir) {
  try {
    const { authorizationHealth } = await importImpl(import.meta.url, 'policy/authorization-operations.js');
    return await authorizationHealth(projectDir);
  } catch {
    return { active: 0, expiringSoon: 0, unverifiable: null, index: 'unknown',
      failures: [{ reason: 'authorization-health-unavailable' }] };
  }
}
export async function checkAuthorizationHealth(projectDir, check) {
  const report = await readAuthorizationHealth(projectDir);
  const warning = report.failures.length || report.expiringSoon || ['drift', 'missing', 'unknown'].includes(report.index);
  check('authorization-grants', warning ? 'warn' : 'ok',
    `${report.active} active, ${report.expiringSoon} expiring-soon, ${report.unverifiable ?? 'unknown'} unverifiable; index ${report.index}`
    + (report.failures.length ? `; ${report.failures.length} verification failure(s)` : '')
    + (warning ? ' — inspect with "aiwg config authorization list" and "aiwg config authorization verify"' : ''));
  return report;
}
