// Collect existing refusal diagnostics for shell output without mutating the JSON plan.
import type { WorkerResolutionPlan } from '../../models/resolver.js';
import type { WorkerPolicyDiagnostic } from '../../models/types.js';

export function shellRefusalDiagnostics(plan: Pick<WorkerResolutionPlan, 'diagnostics' | 'exclusions'>): WorkerPolicyDiagnostic[] {
  const seen = new Set<string>();
  return [...plan.diagnostics, ...plan.exclusions.flatMap(row => row.diagnostics)].filter(diagnostic => {
    if (diagnostic.blocking === false) return false;
    const key = JSON.stringify(diagnostic);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
