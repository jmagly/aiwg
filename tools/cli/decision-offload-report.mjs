import { fileURLToPath } from 'node:url';
import { importImpl } from '../_resolve-impl.mjs';

/** Offline inspection only: never probes a service or records an opportunity. */
export async function collectDecisionOffloadReport(projectRoot) {
  try {
    const { buildDecisionOffloadSnapshot } = await importImpl(import.meta.url, 'decision/offload.js');
    return await buildDecisionOffloadSnapshot({ projectRoot, frameworkRoot: fileURLToPath(new URL('../../', import.meta.url)) });
  } catch {
    // An unavailable reader must not be interpreted as healthy adoption, nor
    // leak exception details that can include private paths or stored values.
    return { status: 'unknown', observation: 'unknown', reason: 'report-unavailable', advisory: true };
  }
}

export function formatDecisionOffloadReport(snapshot) {
  const lines = ['Decision offload (offline, advisory):'];
  if (snapshot.status === 'unknown' && snapshot.reason === 'report-unavailable') {
    lines.push('  Observation: unknown (report unavailable).');
    return lines;
  }
  const calls = snapshot.calls?.organic;
  const opportunities = snapshot.opportunities?.organic;
  lines.push(`  Scope: ${snapshot.scope?.mode ?? 'unknown'}${snapshot.scope?.sessionId ? ` (${snapshot.scope.sessionId})` : ''}`);
  lines.push(`  Ask: ${snapshot.readiness?.ask?.state ?? 'unknown'}; evaluate: ${snapshot.readiness?.evaluate?.state ?? 'unknown'} (no probe)`);
  lines.push(`  Completed calls: ${calls?.completed ?? 'unknown'}; answered: ${calls?.answered ?? 'unknown'}; fallback: ${calls?.fallback ?? 'unknown'}`);
  if (calls) {
    lines.push(`  Estimated LLM tokens avoided: ${calls.llmTokensAvoided}; Jev tokens: ${calls.jevTokens}`);
    for (const [reason, count] of Object.entries(calls.fallbackReasons ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`  Fallback ${reason}: ${count}`);
    }
  }
  if (opportunities) lines.push(`  Observed checkpoints: ${opportunities.observed}; eligible: ${opportunities.eligible}; attempted: ${opportunities.attempted}; skipped: ${opportunities.skipped}; unknown: ${opportunities.unknown}`);
  lines.push(`  Activation: rule=${snapshot.activation?.ruleDelivery ?? 'unknown'}, anchor=${snapshot.activation?.startupAnchor ?? 'unknown'}, native=${snapshot.activation?.nativeActivation ?? 'unknown'}`);
  lines.push(`  Drift: ${snapshot.drift?.status ?? 'unknown'}${snapshot.drift?.reasons?.length ? ` (${snapshot.drift.reasons.join(', ')})` : ''}`);
  if (snapshot.activityHint?.status === 'advisory') lines.push(`  Activity hint (low confidence): ${snapshot.activityHint.reason}; eligible count unknown.`);
  if (snapshot.drift?.note) lines.push(`  ${snapshot.drift.note}`);
  lines.push('  Diagnostic/setup/benchmark calls are excluded from organic adoption.');
  return lines;
}
