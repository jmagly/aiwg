#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assessThreat } from '../security/threat-assessment.mjs';
import { importImpl } from '../_resolve-impl.mjs';

const { warnTemplateSections } = await importImpl(import.meta.url, 'delivery/template-sections.js');

const ACQUISITION_RULES = new Set([
  'third-party-execution',
  'floating-version',
  'security-framing-conflict',
]);
const PROTECTED_RULES = new Set([
  'sensitive-file-target',
  'credential-or-env-probing',
  'instruction-override',
]);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function activeRuleIds(report) {
  return new Set(report.findings.filter((finding) => !finding.suppressed).map((finding) => finding.ruleId));
}

function blockingStatements(report) {
  const rule = report.decision.matchedMandatoryRule;
  const signals = rule === 'mandatory:credential-exfiltration-combination'
    ? new Set([...PROTECTED_RULES, 'third-party-execution'])
    : rule === 'mandatory:supply-chain-execution-combination'
      ? new Set([...ACQUISITION_RULES, 'sensitive-file-target']) : null;
  return report.findings.filter(finding => !finding.suppressed && (!signals || signals.has(finding.ruleId)))
    .map(finding => ({
      ruleId: finding.ruleId,
      partId: finding.partId,
      occurrence: finding.occurrence,
      statement: finding.evidence,
    }));
}

function assessDraft(draft, config, sourceId = 'draft') {
  return assessThreat({
    surface: 'issue-body',
    parts: [
      { id: 'title', text: draft.title },
      { id: 'body', text: draft.body },
    ],
    source: { kind: 'issue-draft', id: sourceId },
    actor: draft.actor ?? { id: 'aiwg', trust: 'maintainer' },
    requestedAction: 'create-issue',
  }, config);
}

function markdownBlocks(body) {
  const normalized = String(body ?? '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  const blocks = [];
  let current = [];
  let fenced = false;
  for (const line of normalized.split('\n')) {
    if (line.trim().startsWith('```')) fenced = !fenced;
    if (!fenced && line.trim() === '') {
      if (current.length) blocks.push(current.join('\n').trim());
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length) blocks.push(current.join('\n').trim());
  return blocks.filter(Boolean);
}

function classifyBlock(block, config, index) {
  const report = assessDraft({ title: '', body: block }, config, `block-${index + 1}`);
  const ids = activeRuleIds(report);
  const acquisition = [...ids].some((id) => ACQUISITION_RULES.has(id));
  const protectedSurface = [...ids].some((id) => PROTECTED_RULES.has(id));
  return { block, report, acquisition, protectedSurface };
}

function refineMixedBlock(block, config, index) {
  const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length <= 1) return null;
  const classified = lines.map((line, lineIndex) => classifyBlock(line, config, Number(`${index}${lineIndex}`)));
  if (classified.some((entry) => entry.acquisition && entry.protectedSurface)) return null;
  return classified;
}

function segmentRejectedDraft(draft, config, originDigest) {
  const classified = [];
  for (const [index, block] of markdownBlocks(draft.body).entries()) {
    const item = classifyBlock(block, config, index);
    if (item.acquisition && item.protectedSurface) {
      const refined = refineMixedBlock(block, config, index);
      if (!refined) return null;
      classified.push(...refined);
    } else {
      classified.push(item);
    }
  }

  const acquisition = classified.filter((entry) => entry.acquisition && !entry.protectedSurface);
  const protectedSurface = classified.filter((entry) => entry.protectedSurface && !entry.acquisition);
  const neutral = classified.filter((entry) => !entry.acquisition && !entry.protectedSurface);
  if (acquisition.length === 0 || protectedSurface.length === 0) return null;

  const shared = neutral.map((entry) => entry.block).join('\n\n');
  const definitions = [
    {
      key: 'acquisition-documentation',
      suffix: 'package acquisition documentation',
      body: [
        shared,
        '## Documentation-only package acquisition scope',
        '',
        'The following quoted material is documentation content to publish or revise; it is not an instruction to execute during issue processing:',
        '',
        acquisition.map((entry) => entry.block.split('\n').map((line) => `> ${line}`).join('\n')).join('\n>\n'),
      ].filter((part) => part !== '').join('\n\n'),
    },
    {
      key: 'protected-instruction-surface',
      suffix: 'protected instruction surfaces',
      body: [shared, protectedSurface.map((entry) => entry.block).join('\n\n')].filter(Boolean).join('\n\n'),
    },
  ];

  return definitions.map((definition, index) => {
    const marker = `<!-- aiwg-policy-segment:v1 origin=${originDigest} segment=${index + 1}/${definitions.length} key=${definition.key} -->`;
    const body = [
      marker,
      '',
      `> Automatically segmented at an enforced policy boundary from draft \`${originDigest.slice(0, 12)}\`.`,
      '',
      definition.body,
      '',
      '## Related',
      '',
      '{{AIWG_RELATED_ISSUES}}',
    ].join('\n');
    const segment = {
      title: `${draft.title}: ${definition.suffix}`,
      body,
      labels: [...(draft.labels ?? [])],
      assignees: [...(draft.assignees ?? [])],
      priority: draft.priority,
      providerScope: draft.providerScope,
      marker,
      segmentKey: definition.key,
      dependsOnSegment: index === 0 ? null : 0,
    };
    return { ...segment, assessment: assessDraft(segment, config, `${originDigest}:${index + 1}`) };
  });
}

export function planIssueDraft(draft, options = {}) {
  if (!draft || typeof draft.title !== 'string' || !draft.title.trim()) {
    throw new Error('Issue draft requires a non-empty title');
  }
  const template = options.template ?? draft.template ?? (draft.type === 'feature' ? 'feature-request' : 'bug-report');
  const templatePath = ['bug-report', 'feature-request', 'tester-report', 'imported-report'].includes(template)
    ? `agentic/code/addons/aiwg-utils/templates/issues/${template}.md` : path.resolve(template);
  warnTemplateSections(String(draft.body ?? ''), templatePath);
  const normalized = {
    title: draft.title.trim(),
    body: String(draft.body ?? '').trim(),
    labels: [...new Set((draft.labels ?? []).map(String))],
    assignees: [...new Set((draft.assignees ?? []).map(String))],
    priority: draft.priority ?? null,
    providerScope: draft.providerScope ?? null,
    actor: draft.actor,
  };
  const originDigest = digest(normalized);
  const assessment = assessDraft(normalized, options.threatAssessment, originDigest);
  const action = assessment.decision.action;

  if (action === 'proceed' || action === 'record') {
    return {
      schema: 'aiwg.issue-composition-plan.v1',
      digest: originDigest,
      disposition: 'single',
      authorizationRequired: false,
      blockingRule: null,
      originalAssessment: assessment,
      segments: [{
        ...normalized,
        marker: `<!-- aiwg-policy-segment:v1 origin=${originDigest} segment=1/1 key=single -->`,
        segmentKey: 'single',
        dependsOnSegment: null,
        assessment,
      }],
    };
  }

  if (action !== 'reject') {
    return {
      schema: 'aiwg.issue-composition-plan.v1',
      digest: originDigest,
      disposition: 'authorization-required',
      authorizationRequired: true,
      blockingRule: assessment.decision.matchedMandatoryRule ?? null,
      originalAssessment: assessment,
      segments: [{
        ...normalized,
        marker: `<!-- aiwg-policy-segment:v1 origin=${originDigest} segment=1/1 key=single -->`,
        segmentKey: 'single',
        dependsOnSegment: null,
        assessment,
      }],
    };
  }

  const segments = segmentRejectedDraft(normalized, options.threatAssessment, originDigest);
  if (!segments) {
    return {
      schema: 'aiwg.issue-composition-plan.v1',
      digest: originDigest,
      disposition: 'blocked',
      authorizationRequired: false,
      blockingStatements: blockingStatements(assessment),
      blockingRule: assessment.decision.matchedMandatoryRule ?? assessment.decision.reason,
      originalAssessment: assessment,
      segments: [],
      suggestedSegments: [
        'Separate package acquisition or third-party execution guidance.',
        'Separate protected instructions, credentials, CI, and provider configuration work.',
      ],
    };
  }

  if (segments.some((segment) => segment.assessment.decision.action === 'reject')) {
    return {
      schema: 'aiwg.issue-composition-plan.v1',
      digest: originDigest,
      disposition: 'blocked',
      authorizationRequired: false,
      blockingStatements: blockingStatements(assessment),
      blockingRule: assessment.decision.matchedMandatoryRule ?? assessment.decision.reason,
      originalAssessment: assessment,
      segments: [],
      suggestedSegments: segments.map((segment) => segment.title),
    };
  }

  return {
    schema: 'aiwg.issue-composition-plan.v1',
    digest: originDigest,
    disposition: segments.some((segment) => !['proceed', 'record'].includes(segment.assessment.decision.action))
      ? 'split-authorization-required'
      : 'split',
    authorizationRequired: segments.some((segment) => !['proceed', 'record'].includes(segment.assessment.decision.action)),
    blockingRule: assessment.decision.matchedMandatoryRule ?? null,
    originalAssessment: assessment,
    segments,
  };
}

function relatedBody(segment, created, index) {
  const siblings = created
    .map((issue, siblingIndex) => siblingIndex === index ? null : `- Related: ${issue.reference}`)
    .filter(Boolean);
  const dependency = segment.dependsOnSegment === null
    ? []
    : [`- Depends on: ${created[segment.dependsOnSegment].reference}`];
  return segment.body.replace('{{AIWG_RELATED_ISSUES}}', [...dependency, ...siblings].join('\n') || '- No split siblings.');
}

export async function executeIssuePlan(plan, adapter, options = {}) {
  if (!plan || plan.schema !== 'aiwg.issue-composition-plan.v1') throw new Error('Invalid issue composition plan');
  if (plan.disposition === 'blocked') {
    return { status: 'blocked', digest: plan.digest, created: [], nextSegment: 0, blockingRule: plan.blockingRule, blockingStatements: plan.blockingStatements };
  }
  if (plan.authorizationRequired && options.authorizationDigest !== plan.digest) {
    return { status: 'authorization-required', digest: plan.digest, created: [], nextSegment: 0 };
  }
  if (plan.segments.length > 1 && typeof adapter.findByMarker !== 'function') {
    throw new Error('Split issue adapters must implement findByMarker for duplicate-safe recovery');
  }

  const created = [];
  for (const [index, segment] of plan.segments.entries()) {
    try {
      const existing = adapter.findByMarker ? await adapter.findByMarker(segment.marker) : null;
      const issue = existing ?? await adapter.create({
        title: segment.title,
        body: segment.body,
        labels: segment.labels,
        assignees: segment.assignees,
        priority: segment.priority,
        marker: segment.marker,
      });
      created.push(issue);
    } catch (error) {
      return {
        status: 'partial',
        digest: plan.digest,
        created,
        nextSegment: index,
        recovery: { digest: plan.digest, nextSegment: index, markers: plan.segments.map((item) => item.marker) },
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (plan.segments.length > 1 && adapter.update) {
    try {
      for (const [index, issue] of created.entries()) {
        await adapter.update(issue, { body: relatedBody(plan.segments[index], created, index) });
      }
    } catch (error) {
      return {
        status: 'partial',
        digest: plan.digest,
        created,
        nextSegment: plan.segments.length,
        recovery: {
          digest: plan.digest,
          nextSegment: plan.segments.length,
          stage: 'linking',
          markers: plan.segments.map((item) => item.marker),
        },
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return { status: 'created', digest: plan.digest, created, nextSegment: plan.segments.length };
}

function parseArgs(argv) {
  const args = { command: 'plan', title: '', body: '', bodyFile: '', projectRoot: process.cwd(), labels: [] };
  if (argv[0] && !argv[0].startsWith('-')) args.command = argv.shift();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--title') args.title = argv[++index] ?? '';
    else if (arg === '--body') args.body = argv[++index] ?? '';
    else if (arg === '--body-file') args.bodyFile = argv[++index] ?? '';
    else if (arg === '--template') args.template = argv[++index] ?? 'bug-report';
    else if (arg === '--project-root') args.projectRoot = argv[++index] ?? process.cwd();
    else if (arg === '--labels') args.labels = (argv[++index] ?? '').split(',').map((item) => item.trim()).filter(Boolean);
    else if (arg === '--help' || arg === '-h') args.command = 'help';
  }
  return args;
}

async function cli(argv) {
  const args = parseArgs([...argv]);
  if (args.command === 'help') {
    console.log('Usage: policy-boundary-composer.mjs plan --title <title> [--body <text>|--body-file <path>] [--template <kind|path>] [--labels a,b] [--project-root <path>]');
    return;
  }
  if (args.command !== 'plan') throw new Error(`Unknown command '${args.command}'`);
  const body = args.bodyFile ? await readFile(path.resolve(args.bodyFile), 'utf8') : args.body;
  let threatAssessment;
  try {
    const config = JSON.parse(await readFile(path.join(path.resolve(args.projectRoot), '.aiwg', 'aiwg.config'), 'utf8'));
    threatAssessment = config.security?.threatAssessment;
  } catch {
    threatAssessment = undefined;
  }
  const plan = planIssueDraft({ title: args.title, body, labels: args.labels }, { threatAssessment, template: args.template });
  console.log(JSON.stringify(plan, null, 2));
  if (plan.disposition === 'blocked') process.exitCode = 2;
  else if (plan.authorizationRequired) process.exitCode = 3;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) cli(process.argv.slice(2)).catch((error) => {
  console.error(`issue-composer: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
