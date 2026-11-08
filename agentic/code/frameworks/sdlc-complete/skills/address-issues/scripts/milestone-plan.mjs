// Render a read-only milestone triage and dispatch preview; never execute planned work.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function text(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be nonempty text`);
  return value;
}

function slots(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative integer`);
  return value;
}

function ownership(value) {
  text(value, 'ownership path');
  if (path.posix.isAbsolute(value) || /[\\*?\[\]{}]/.test(value)
      || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('ownership paths must be literal repository-relative files or directories');
  }
  return value;
}

function validateIssue(issue, seen) {
  text(issue.id, 'issue id');
  if (seen.has(issue.id)) throw new Error(`duplicate issue id: ${issue.id}`);
  seen.add(issue.id);
  text(issue.title, 'issue title');
  text(issue.reason, 'triage reason');
  if (!['ready', 'blocked', 'needs-input'].includes(issue.status)) throw new Error('unknown triage status');
  if (issue.status !== 'ready') return;
  for (const field of ['role', 'task', 'brief', 'workdir', 'finalOutput']) text(issue[field], field);
  slots(issue.effectiveMaxParallel, 'effectiveMaxParallel');
  if (!Array.isArray(issue.paths) || !issue.paths.length) throw new Error('ready issue requires ownership paths');
  issue.paths.forEach(ownership);
  if (!Array.isArray(issue.dependsOn)) throw new Error('ready issue requires dependsOn (unresolved issue ids)');
  issue.dependsOn.forEach(id => text(id, 'dependency id'));
}

function overlap(left, right) {
  return left.some(a => right.some(b => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)));
}

export function planMilestone(input) {
  text(input.milestone, 'milestone');
  text(input.group, 'group');
  const capacity = Math.min(...['project', 'group', 'context'].map(key => slots(input.remaining?.[key], `remaining.${key}`)));
  if (!Array.isArray(input.issues)) throw new Error('issues must be an array');
  const seen = new Set();
  input.issues.forEach(issue => validateIssue(issue, seen));
  const host = input.resources;
  const admitted = host?.ok === true && host.freshness?.status === 'fresh'
    && Number.isSafeInteger(host.slots) && host.slots > 0;
  const limit = admitted ? Math.min(capacity, host.slots) : 0;
  const dispatch = [];
  const triage = input.issues.map(issue => {
    let decision = issue.status;
    if (issue.status === 'ready') {
      if (!admitted) decision = 'queued: host admission unavailable';
      else if (issue.dependsOn.length) decision = `queued: unresolved dependencies: ${issue.dependsOn.join(', ')}`;
      else if (dispatch.some(selected => overlap(issue.paths, selected.paths))) decision = 'queued: overlapping ownership';
      else if (dispatch.length >= Math.min(limit, issue.effectiveMaxParallel,
        ...dispatch.map(selected => selected.effectiveMaxParallel))) decision = 'queued: capacity exhausted';
      else { dispatch.push(issue); decision = 'planned'; }
    }
    return { ...issue, decision };
  });
  return { milestone: input.milestone, group: input.group, triage, dispatch };
}

function cell(value) {
  return String(value).replace(/[\x00-\x1f\x7f]/g, ' ').replaceAll('|', '\\|')
    .replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function table(headers, rows) {
  return [headers, headers.map(() => '---'), ...rows]
    .map(row => `| ${row.map(cell).join(' | ')} |`).join('\n');
}

export function renderMilestonePlan(plan) {
  return [
    `Milestone: ${cell(plan.milestone)} (dry-run)`, '', 'Triage',
    table(['Issue', 'Status', 'Title', 'Reason', 'Decision'], plan.triage.map(issue =>
      [issue.id, issue.status, issue.title, issue.reason, issue.decision])), '',
    `Planned dispatch (${plan.dispatch.length})`,
    table(['Issue', 'Role', 'Group', 'Brief', 'Worktree', 'Final output'], plan.dispatch.map(issue =>
      [issue.id, issue.role, plan.group, issue.brief, issue.workdir, issue.finalOutput])), '',
    'No workers launched; no worktrees, tracker writes, qualification, resolution or checkpoints performed.',
    'Preview only: re-check resources, self-count active workers and resolve each brief before launch.', '',
  ].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 3 || !args.includes('--dry-run') || args.filter(arg => arg === '--dry-run').length !== 1
        || args.indexOf('--input-json') < 0 || !args[args.indexOf('--input-json') + 1]
        || args[args.indexOf('--input-json') + 1].startsWith('--')) {
      throw new Error('usage: milestone-plan.mjs --input-json <file> --dry-run (planning only)');
    }
    const input = JSON.parse(readFileSync(args[args.indexOf('--input-json') + 1], 'utf8'));
    process.stdout.write(renderMilestonePlan(planMilestone(input)));
  } catch (error) {
    console.error(`milestone-plan: ${error.message}`);
    process.exitCode = 2;
  }
}
