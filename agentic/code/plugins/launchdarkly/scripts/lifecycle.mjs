/** AIWG policy helpers over sanitized metadata, not management API responses.
 * Lifecycle authority: https://launchdarkly.com/docs/home/flags/flag-status.md
 * Code-reference scope: https://launchdarkly.com/docs/home/flags/code-references.md
 * Conservative experiment residue policy follows the supplied eval findings.
 */
export const cleanupOrder = Object.freeze(['approvals', 'experiments', 'expiring-targets',
  'flag-release-plan', 'environment-release-plan', 'agent-configs', 'metrics', 'flags', 'segments']);

export function auditFlagDebt(flags) {
  if (!Array.isArray(flags)) throw new Error('Sanitized flag inventory required');
  const findings = [];
  for (const flag of flags) {
    const reasons = [];
    if (!flag.owner) reasons.push('missing-owner');
    if (!flag.removalCriteria) reasons.push('missing-removal-criteria');
    if (flag.temporary === false && flag.evaluationCount === 0) reasons.push('never-evaluated-permanent');
    if (!Number.isInteger(flag.evaluationCount) || flag.evaluationCount < 0) reasons.push('unknown-evaluation-coverage');
    if (flag.temporary === true && flag.criteriaMet === true) reasons.push('temporary-removal-candidate');
    if (flag.codeRefsComplete !== true) reasons.push('incomplete-code-reference-coverage');
    if (flag.experimentPinned === true) reasons.push('archive-only-residue');
    if (reasons.length) findings.push({ key: flag.key, owner: flag.owner || 'unassigned', reasons });
  }
  return { mode: 'read-only', scanned: flags.length, findings };
}

export function prepareCleanupDraft({ card, release, scan, readiness, resources = [] }) {
  if (!card?.key || !card.owner || !card.removal_criteria || release?.completed !== true ||
      !release.flags?.includes(card.key) || !release.revision || scan?.complete !== true ||
      scan.revision !== release.revision || !scan.scan_ref || !Array.isArray(scan.references) ||
      readiness?.status !== 'safe' || readiness.criteria_met !== true) {
    throw new Error('Cleanup criteria or complete release/scan evidence missing');
  }
  if (!Array.isArray(resources) || resources.some(r => !cleanupOrder.includes(r.kind))) {
    throw new Error('Unknown dependency kind');
  }
  const ordered = [...resources].sort((a, b) => cleanupOrder.indexOf(a.kind) - cleanupOrder.indexOf(b.kind));
  const blockers = ordered.filter(r => r.unresolved === true).map(r => ({ kind: r.kind, key: r.key, reason: 'unresolved-dependency' }));
  if (readiness.experiment_pinned === true) blockers.push({ kind: 'flags', key: card.key, reason: 'archive-only-residue' });
  return {
    publish: false, owner: card.owner, revision: release.revision,
    dependency_order: ordered.map(({ kind, key }) => ({ kind, key })), blockers,
    title: `Remove completed feature flag ${card.key}`,
    body: [
      `Owner: ${card.owner}. Card: ${card.key}. Removal criteria: ${card.removal_criteria}.`,
      `Release revision: ${release.revision}. Complete code-reference scan: ${scan.scan_ref}.`,
      'Preserve the selected behavior, remove the toggle branches, update both-state and fallback tests, and review the diff.',
      'Re-scan after removal; authorize actual archival only after references are gone and dependencies are resolved.',
      readiness.experiment_pinned ? 'Experiment-pinned flag/metric: archive-only residue; deletion remains blocked.' : 'Recheck removal readiness before archival.',
      'Draft only. Human approval of the exact production diff is required before any provider write.',
    ].join('\n\n'),
  };
}
