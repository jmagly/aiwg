#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const REQUIRED_SECTIONS = Object.freeze([
  'Actions This Cycle',
  'Task Checklist',
  'Blockers',
  'Open Questions',
  'Next Steps',
]);

const ALLOWED_STATUSES = new Set(['Progress', 'Blocked', 'Review Needed', 'Escalation']);
const PLACEHOLDER = /\{\{|\}\}|\[(?:specific|what|none,|completed tasks|remaining tasks)/i;
const TEMPLATE_URL = new URL('../../../templates/issue-comments/al-cycle.md', import.meta.url);
const EFFECT_ID = /^eff1_[a-z2-7]{51}[aq]$/;

function nonEmpty(value, fallback = 'None.') {
  if (Array.isArray(value)) return value.filter(Boolean).join('\n') || fallback;
  if (typeof value === 'string' && value.trim()) return value.trim();
  return fallback;
}

export function renderCycleComment(input) {
  const cycle = Number(input?.cycle);
  const status = input?.status;
  if (!Number.isInteger(cycle) || cycle < 1) throw new Error('cycle must be a positive integer');
  if (!ALLOWED_STATUSES.has(status)) throw new Error(`unsupported status: ${status ?? '(missing)'}`);

  const fields = {
    'Actions This Cycle': nonEmpty(input.actions, '- No repository or tracker actions were completed this cycle.'),
    'Task Checklist': nonEmpty(input.checklist, '- [ ] No checklist state was supplied.'),
    Blockers: nonEmpty(input.blockers),
    'Open Questions': nonEmpty(input.openQuestions),
    'Next Steps': nonEmpty(input.nextSteps, 'Reassess the issue in the next cycle.'),
  };

  const replacements = {
    cycle: String(cycle),
    status,
    actions: fields['Actions This Cycle'],
    checklist: fields['Task Checklist'],
    blockers: fields.Blockers,
    open_questions: fields['Open Questions'],
    next_steps: fields['Next Steps'],
  };
  let rendered = readFileSync(TEMPLATE_URL, 'utf8').trim();
  for (const [name, value] of Object.entries(replacements)) {
    // Replace via callback. Cycle evidence quoting shell, regex or TOML can contain
    // $&, $`, $' or $$, which a replacement string reinterprets instead of inserting.
    rendered = rendered.replaceAll(`{{${name}}}`, () => value);
  }
  if (/\{\{[^}]+\}\}/.test(rendered)) throw new Error('canonical template contains an unresolved field');
  if (input.effectId !== undefined) {
    // The effect-ledger marker lets `aiwg effect record|reconcile --kind tracker.comment` find this exact comment.
    if (typeof input.effectId !== 'string' || !EFFECT_ID.test(input.effectId)) throw new Error('effectId must be an aiwg effect ID');
    rendered += `\n\n<!-- aiwg-effect: ${input.effectId} -->`;
  }
  return rendered;
}

export function validateCycleComment(markdown) {
  const errors = [];
  if (typeof markdown !== 'string' || !markdown.trim()) return { valid: false, errors: ['comment is empty'] };
  if (!/^\*\*AL CYCLE #\d+ – (Progress|Blocked|Review Needed|Escalation)\*\*/m.test(markdown)) {
    errors.push('canonical AL CYCLE heading is missing or invalid');
  }

  for (const [index, section] of REQUIRED_SECTIONS.entries()) {
    const heading = `### ${section}`;
    const start = markdown.indexOf(heading);
    if (start < 0) {
      errors.push(`required section is missing: ${section}`);
      continue;
    }
    const prior = index === 0 ? -1 : markdown.indexOf(`### ${REQUIRED_SECTIONS[index - 1]}`);
    if (prior >= start) errors.push(`required section is out of order: ${section}`);
    const nextStarts = REQUIRED_SECTIONS.slice(index + 1)
      .map(name => markdown.indexOf(`### ${name}`, start + heading.length))
      .filter(position => position >= 0);
    const end = nextStarts.length ? Math.min(...nextStarts) : markdown.indexOf('\n---', start + heading.length);
    const content = markdown.slice(start + heading.length, end >= 0 ? end : undefined).trim();
    if (!content) errors.push(`required section is empty: ${section}`);
    else if (PLACEHOLDER.test(content)) errors.push(`required section contains placeholder text: ${section}`);
  }
  return { valid: errors.length === 0, errors };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    if (!rest[i].startsWith('--')) continue;
    options[rest[i].slice(2)] = rest[i + 1];
    i += 1;
  }
  return { command, options };
}

function readInput(path) {
  return readFileSync(path, 'utf8');
}

function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === 'render' && options['input-json']) {
    const rendered = renderCycleComment(JSON.parse(readInput(options['input-json'])));
    const verdict = validateCycleComment(rendered);
    if (!verdict.valid) throw new Error(verdict.errors.join('; '));
    process.stdout.write(`${rendered}\n`);
    return;
  }
  if (command === 'validate' && options['comment-file']) {
    const verdict = validateCycleComment(readInput(options['comment-file']));
    process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
    if (!verdict.valid) process.exitCode = 1;
    return;
  }
  process.stderr.write('Usage: cycle-comment.mjs render --input-json <file> | validate --comment-file <file>\n');
  process.exitCode = 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
