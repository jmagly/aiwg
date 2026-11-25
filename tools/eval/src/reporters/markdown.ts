/**
 * Markdown report generator for eval results
 */

import { pilotMarkdown } from '../pilot-report.js';
import type { EvalReport } from '../models/types.js';
import { legacyIntegrityMetadata } from '../integrity.js';

export function generateMarkdownReport(report: EvalReport): string {
  const normalized = report.integrity_state ? report : { ...report, ...legacyIntegrityMetadata(report) };
  const uncertainty = normalized.uncertainty
    ? `${(normalized.uncertainty.estimate * 100).toFixed(1)}% `
      + `(95% CI ${(normalized.uncertainty.lower_bound * 100).toFixed(1)}–${(normalized.uncertainty.upper_bound * 100).toFixed(1)}%)`
    : 'not available';
  const baseline = normalized.paired_baseline
    ? `${normalized.paired_baseline.label}: ${normalized.paired_baseline.baseline_score} → `
      + `${normalized.paired_baseline.current_score} (Δ ${normalized.paired_baseline.delta >= 0 ? '+' : ''}${normalized.paired_baseline.delta})`
    : 'not supplied';
  const lines = [
    `# AIWG Model Evaluation Report`,
    '',
    `**Model**: ${report.model}`,
    `**Backend**: ${report.backend}`,
    `**Date**: ${report.date.split('T')[0]}`,
    `**AIWG Version**: ${report.aiwgVersion}`,
    '',
    `## Scores`,
    '',
    `| Dimension | Score | Tier | Tests | Passed |`,
    `|-----------|-------|------|-------|--------|`,
  ];

  for (const dim of report.dimensions) {
    lines.push(
      `| ${dim.dimension} | ${dim.score} | ${dim.tier} | ${dim.testCases} | ${dim.passed} |`
    );
  }

  lines.push(
    '',
    `**Overall**: ${report.overall}/100 — **${report.overallTier} tier**`,
    '',
    `## Evaluation Integrity`,
    '',
    `- **Mode**: ${normalized.integrity_mode}`,
    `- **State**: ${normalized.integrity_state}`,
    `- **Fresh workspace**: ${normalized.fresh_workspace_required ? normalized.fresh_workspace_verified ? 'required and verified' : 'required but unverified' : 'not required'}`,
    `- **Sample size**: ${normalized.sample_n}`,
    `- **Uncertainty**: ${uncertainty}`,
    `- **Paired baseline**: ${baseline}`,
    `- **Trusted score source**: ${normalized.trusted_score_source}`,
    `- **Compromise labels**: ${normalized.compromise_labels?.length ? normalized.compromise_labels.join(', ') : 'none'}`,
    `- **Weak-signal reason**: ${normalized.weak_signal_reason ?? 'none'}`,
    '',
    `> Dimension scores are smoke diagnostics unless integrity and uncertainty evidence are present.`,
    '',
    `## Release Gate`,
    '',
    `**Decision**: ${normalized.release_gate?.decision ?? 'HOLD'}`,
    '',
    ...((normalized.release_gate?.reasons ?? ['integrity evidence unavailable']).map(reason => `- ${reason}`)),
    '',
    `## Recommendation`,
    '',
  );

  const suitable = report.dimensions.filter((d) => d.score >= 70).map((d) => d.dimension);
  const limited = report.dimensions.filter((d) => d.score >= 50 && d.score < 70).map((d) => d.dimension);
  const notRec = report.dimensions.filter((d) => d.score < 50).map((d) => d.dimension);

  if (suitable.length > 0) lines.push(`Suitable for: ${suitable.join(', ')}`);
  if (limited.length > 0) lines.push(`Limited for: ${limited.join(', ')}`);
  if (notRec.length > 0) lines.push(`Not recommended for: ${notRec.join(', ')}`);

  lines.push('', `Total evaluation time: ${(report.totalLatencyMs / 1000).toFixed(1)}s`);

  if (report.pilot) lines.push('', pilotMarkdown(report.pilot));
  return lines.join('\n');
}
