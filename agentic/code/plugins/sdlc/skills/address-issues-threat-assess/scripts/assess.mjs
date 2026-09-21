#!/usr/bin/env node
import fs from 'node:fs';
import {
  assessThreat,
  formatThreatAssessment,
} from '../../../tools/security/threat-assessment.mjs';

/** Header the address-issues renderer emits on every cycle comment. */
export const AL_CYCLE_MARKER = /(?:^|\n)[^\n]{0,40}?AL CYCLE #\d+\s*[\u2013\u2014-]/;
/** Hidden marker some renderers add so cycle comments can be found by machines. */
export const ADDRESS_ISSUES_CYCLE_MARKER = /<!--\s*aiwg-address-issues:cycle-/;

function parseArgs(argv) {
  const args = { format: 'text', text: '', issueJson: '', configJson: '', surface: '', trustedActors: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--format' && argv[index + 1]) args.format = argv[++index];
    else if (arg === '--text' && argv[index + 1]) args.text = argv[++index];
    else if (arg === '--issue-json' && argv[index + 1]) args.issueJson = argv[++index];
    else if (arg === '--config-json' && argv[index + 1]) args.configJson = argv[++index];
    else if (arg === '--surface' && argv[index + 1]) args.surface = argv[++index];
    else if (arg === '--trusted-actor' && argv[index + 1]) args.trustedActors.push(argv[++index]);
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: assess.mjs [--issue-json <file>] [--text <body>] [--surface <surface>] [--trusted-actor <login>]... [--config-json <file>] [--format text|json]');
      process.exit(0);
    }
  }
  return args;
}

/**
 * Logins whose AL CYCLE comments are the orchestrator reporting on itself.
 * Resolved from the project's tracker-actor configuration so the exemption is
 * bound to the identity address-issues writes with, not to a hard-coded name.
 */
export function resolveTrustedActors(aiwgConfig) {
  const remotes = aiwgConfig?.remotes ?? {};
  return [remotes.tracker_actor?.login, remotes.customer_tracker_actor?.login]
    .filter(login => typeof login === 'string' && login.trim())
    .map(login => login.trim().toLowerCase());
}

/**
 * True for a comment the orchestrator itself posted as cycle status: it must
 * be authored by a trusted tracker actor AND carry the AL CYCLE header or the
 * hidden cycle marker. Either condition alone is not enough — a trusted
 * maintainer's ordinary comment is still assessed, and an untrusted author
 * cannot exempt text by pasting the header.
 */
export function isOrchestratorStatusComment(comment, trustedActors = []) {
  const author = String(comment?.author ?? '').trim().toLowerCase();
  if (!author || !trustedActors.includes(author)) return false;
  const body = String(comment?.body ?? '');
  return AL_CYCLE_MARKER.test(body) || ADDRESS_ISSUES_CYCLE_MARKER.test(body);
}

function loadInput(args) {
  if (args.issueJson) {
    const issue = JSON.parse(fs.readFileSync(args.issueJson, 'utf8'));
    return {
      number: issue.number,
      title: issue.title || '',
      body: issue.body || '',
      author: issue.author || issue.user || '',
      labels: Array.isArray(issue.labels) ? issue.labels : [],
      comments: Array.isArray(issue.comments) ? issue.comments : [],
    };
  }
  if (args.text) return { title: '', body: args.text, author: '', labels: [], comments: [] };
  return { title: '', body: fs.readFileSync(0, 'utf8'), author: '', labels: [], comments: [] };
}

function commentPart(comment, index, trustedActors) {
  const orchestrator = isOrchestratorStatusComment(comment, trustedActors);
  return {
    id: `comment-${index + 1}`,
    text: String(comment.body || ''),
    source: {
      kind: orchestrator ? 'orchestrator-cycle-comment' : 'issue-comment',
      author: comment.author || '',
      ...(comment.id !== undefined ? { commentId: comment.id } : {}),
    },
    ...(orchestrator ? { context: 'orchestrator-status' } : {}),
  };
}

function legacySeverity(finding) {
  return {
    informational: 1,
    low: 2,
    moderate: 3,
    high: 4,
    critical: 5,
  }[finding.severity] ?? 1;
}

/**
 * Compatibility wrapper for address-issues callers. New integrations should
 * call assessThreat() with an explicit forge surface.
 *
 * `options.trustedActors` lists the tracker logins address-issues writes with;
 * their AL CYCLE comments are classified `orchestrator-status` and never drive
 * the verdict (#2549). Every finding carries `source` (author, comment id) so
 * a self-referential hit is visible at a glance.
 */
export function assessIssue(issue, threatAssessmentConfig, options = {}) {
  const trustedActors = (options.trustedActors ?? []).map(login => String(login).trim().toLowerCase());
  const report = assessThreat({
    surface: 'issue-body',
    parts: [
      { id: 'title', text: issue.title || '', source: { kind: 'issue-title', author: issue.author || '' } },
      { id: 'body', text: issue.body || '', source: { kind: 'issue-body', author: issue.author || '' } },
      ...(issue.comments ?? [])
        .map((comment, index) => ({ comment, index }))
        .filter(({ comment }) => !comment.isBot)
        .map(({ comment, index }) => commentPart(comment, index, trustedActors)),
    ],
    source: { kind: 'forge-issue', id: issue.number },
    actor: { id: issue.author || '', trust: 'untrusted' },
    requestedAction: 'issue-triage-and-implementation',
  }, threatAssessmentConfig);
  return toLegacyReport(report, issue);
}

/**
 * Assess free text on an explicit surface (for example the rendered AL CYCLE
 * comment on `outbound-maintainer-comment` before it is posted). Same report
 * shape as assessIssue so callers can reuse the verdict handling.
 */
export function assessText(text, surface, threatAssessmentConfig, options = {}) {
  const report = assessThreat({
    surface,
    content: String(text ?? ''),
    source: options.source ?? { kind: surface === 'outbound-maintainer-comment' ? 'orchestrator-comment' : 'text' },
    actor: options.actor ?? { trust: surface === 'outbound-maintainer-comment' ? 'orchestrator' : 'untrusted' },
    requestedAction: options.requestedAction ?? (surface === 'outbound-maintainer-comment' ? 'post-maintainer-comment' : 'consume-as-data'),
  }, threatAssessmentConfig);
  return toLegacyReport(report, { title: '', author: '', labels: [] });
}

function toLegacyReport(report, issue) {
  const action = report.decision.action;
  const verdict = action === 'reject'
    ? 'reject'
    : ['flag', 'require-authorization'].includes(action) ? 'flag' : 'safe';
  const signals = report.findings
    .filter(finding => !finding.suppressed)
    .map(finding => ({
      id: finding.ruleId,
      severity: legacySeverity(finding),
      evidence: [finding.evidence],
      context: finding.context,
      taxonomy: finding.taxonomy,
      source: { partId: finding.partId, ...(finding.source ?? {}) },
    }));
  const why = !report.completeness.complete
    ? `Threat assessment was incomplete (${report.completeness.reasons.join(', ')}); manual authorization is required.`
    : report.decision.matchedMandatoryRule
    ? `This is reject rather than flag because mandatory policy rule '${report.decision.matchedMandatoryRule}' matched.`
    : signals.length
      ? `The '${report.profile}' profile selected '${action}' for ${report.risk.severity} risk.`
      : 'No active prompt-injection or supply-chain risk was detected.';
  const operatorNextSteps = verdict === 'reject'
    ? [
        'Split documentation-only work from CI, agent-instruction, credential, or secret-provisioning changes.',
        'Route secret and credential operations through the project-approved, human-controlled security workflow.',
        'Re-file or re-scope the request so autonomous work does not combine sensitive-file changes with credential or unpinned execution.',
      ]
    : verdict === 'flag'
      ? [
          'Review the quoted evidence and repository context.',
          'Explicitly authorize this issue and run if the requested sensitive work is legitimate.',
          'Otherwise re-scope the issue to remove the flagged operation.',
        ]
      : [];
  const details = [
    formatThreatAssessment(report),
    '',
    '**Operator next steps:**',
    ...(operatorNextSteps.length ? operatorNextSteps.map(step => `- ${step}`) : ['- No special action required.']),
  ].join('\n');
  return {
    verdict,
    action: verdict === 'reject' ? 'stop-and-reject' : verdict === 'flag' ? 'require-human-authorization' : 'proceed',
    score: report.risk.score,
    issue: {
      number: issue.number,
      title: issue.title,
      author: issue.author,
      labels: issue.labels,
    },
    signals,
    why_verdict: why,
    why_reject: verdict === 'reject' ? why : null,
    threshold_explanation: report.decision.matchedMandatoryRule
      ? `Reject rule crossed: ${report.decision.matchedMandatoryRule}.`
      : report.decision.reason,
    operator_next_steps: operatorNextSteps,
    policy_context:
      'Without explicit configuration, this deterministic preflight applies the conservative generic policy; resolved project policy never replaces repository authorization, provider safeguards, or secret-handling controls.',
    policy_report: report,
    comment_markdown: details,
  };
}

function printText(report) {
  console.log(`verdict: ${report.verdict}`);
  console.log(`action: ${report.action}`);
  console.log(`score: ${report.score}`);
  console.log(`why: ${report.why_verdict}`);
  console.log(`threshold: ${report.threshold_explanation}`);
  console.log(report.comment_markdown);
}

export function runCli(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    const issue = loadInput(args);
    const defaultConfig = `${process.cwd()}/.aiwg/aiwg.config`;
    const configPath = args.configJson || (fs.existsSync(defaultConfig) ? defaultConfig : '');
    const aiwgConfig = configPath ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
    const config = aiwgConfig.security?.threatAssessment;
    const trustedActors = [...resolveTrustedActors(aiwgConfig), ...args.trustedActors];
    const report = args.surface
      ? assessText(issue.body, args.surface, config)
      : assessIssue(issue, config, { trustedActors });
    if (args.format === 'json') console.log(JSON.stringify(report, null, 2));
    else printText(report);
  } catch (error) {
    console.error(`address-issues-threat-assess: ${error.message}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) runCli();
