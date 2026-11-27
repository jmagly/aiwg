// Local, deterministic companion to feature-flag-fit; no vendor calls or writes.
// Design basis and AIWG judgments: ../../../../rules/feature-flag-fit.md.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';

const skips = ['prototype', 'spike', 'docs_only', 'library_no_runtime',
  'one_off_script', 'static_no_runtime_no_js', 'very_small'];
const triggers = ['trunk_unfinished', 'dark_launch', 'migration', 'experiment',
  'entitlement', 'external_kill_switch', 'llm_runtime'];
const exclusions = ['secrets', 'static_config', 'data_store', 'startup_config', 'per_commit'];
const kinds = ['release', 'kill-switch', 'experiment', 'migration', 'operational', 'permission (entitlement)'];
const nonempty = value => typeof value === 'string' && value.trim().length > 0 && !/^<[^>]+>$/.test(value.trim());
const requireText = (value, field) => {
  if (!nonempty(value)) throw new Error(`Supply ${field}; placeholders are not evidence`);
};
const enumValue = (value, values, field) => {
  if (!values.includes(value)) throw new Error(`Invalid ${field}: expected ${values.join('|')}`);
};
const dateValue = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

export function assess(input) {
  const policy = input.feature_flags?.policy ?? 'suggest';
  enumValue(policy, ['suggest', 'always', 'never'], 'feature_flags.policy');
  const facts = input.facts ?? {};
  for (const value of Object.values(facts)) {
    if (typeof value !== 'boolean') throw new Error('Classified facts must be booleans');
  }
  const never = input.never_flags ?? [];
  for (const item of never) enumValue(item, exclusions, 'never_flags');
  const outcome = (fit, reason) => ({ fit, reason, suggestion: fit === 'skip' ? null : fit });
  if (policy === 'never' || input.declined) return outcome('skip', 'policy or recorded scope decline');
  if (never.length) return outcome('skip', `never-flag: ${never.join(', ')}`);
  const skip = skips.find(key => facts[key]);
  if (skip) return outcome('skip', skip);
  if (facts.production && facts.blast_radius && facts.low_risk_tolerance) {
    return outcome('recommend', 'production blast radius with Low risk tolerance [AIWG-J]');
  }
  const trigger = triggers.find(key => facts[key]);
  if (trigger) return outcome('recommend', trigger);
  if (policy === 'always') return outcome('recommend', 'always policy for eligible work [AIWG-J]');
  if (facts.user_facing && facts.low_risk && facts.infrequent_deploy) {
    return outcome('offer', 'low-risk user-facing change with infrequent deploys; default no');
  }
  return outcome('skip', 'no qualifying trigger');
}

export function providerRoute(provider = 'none', installed = [], capabilities = {}) {
  if (!/^[a-z][a-z0-9-]*$/.test(provider)) throw new Error('Invalid feature_flags.provider');
  if (provider === 'none') return { mode: 'cards-and-code', skills: {} };
  if (provider === 'openfeature') return { mode: 'openfeature-client', skills: {} };
  // Capability names are discovered from installed addon metadata, never guessed.
  if (!installed.includes(provider)) return { mode: 'cards-and-code', skills: {}, missing: provider };
  return { mode: 'addon', skills: capabilities[provider] ?? {} };
}

export function validateCard(card) {
  for (const field of ['id', 'owner', 'service', 'default_rationale', 'removal_criteria', 'removal_task']) {
    requireText(card[field], field);
  }
  enumValue(card.kind, kinds, 'kind');
  enumValue(card.value_type, ['boolean', 'string', 'number', 'JSON'], 'value_type');
  enumValue(card.dynamism, ['static', 'per-request'], 'dynamism');
  enumValue(card.lifetime, ['temporary', 'permanent'], 'lifetime');
  for (const field of ['live', 'removal_criteria_met', 'code_removed']) {
    if (typeof card[field] !== 'boolean') throw new Error(`Supply boolean ${field}`);
  }
  if (card.review_by != null && !dateValue(card.review_by)) throw new Error('Invalid review_by date');
  if (!Array.isArray(card.requirements) || !card.requirements.length || !card.requirements.every(nonempty)) {
    throw new Error('Link requirements/story IDs');
  }
  const value = card.default_value;
  const valid = card.value_type === 'JSON' ? value !== undefined
    : card.value_type === 'number' ? typeof value === 'number' && Number.isFinite(value)
      : typeof value === card.value_type;
  if (!valid) throw new Error('Supply default_value matching value_type');
}

export function renderCard(card) {
  validateCard(card);
  for (const field of ['targeting_rollout', 'metrics_rollback', 'test_plan']) requireText(card[field], field);
  const { targeting_rollout, metrics_rollback, test_plan, ...metadata } = card;
  return `---\n${yaml.dump(metadata, { noRefs: true })}---\n\n# Feature Toggle Card\n\n`
    + `## Targeting and rollout\n\n${targeting_rollout}\n\n`
    + `## Metrics and rollback\n\n${metrics_rollback}\n\n## Test plan\n\n${test_plan}\n`;
}

export function plan(input) {
  requireText(input.scope, 'scope');
  const assessment = assess(input);
  const decision = input.decision ?? 'pending';
  enumValue(decision, ['accepted', 'declined', 'pending'], 'decision');
  const record = { scope: input.scope, ...assessment, decision,
    requirements: input.requirements ?? [], declined: Boolean(input.declined) || decision === 'declined' };
  const route = providerRoute(input.feature_flags?.provider, input.installed_addons, input.provider_capabilities);
  const cards = assessment.fit !== 'skip' && decision === 'accepted'
    ? (input.cards ?? []).map(card => {
      if (!(input.requirements ?? []).every(id => card.requirements?.includes(id))) {
        throw new Error('Each card must link the feature requirements/story IDs');
      }
      return renderCard(card);
    }) : [];
  if (assessment.fit !== 'skip' && decision === 'accepted' && !cards.length) {
    throw new Error('Accepted planning requires cards');
  }
  return { record, cards, route };
}

export function readCard(file) {
  const front = readFileSync(file, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!front) throw new Error(`Missing card frontmatter: ${file}`);
  // JSON schema preserves YYYY-MM-DD strings rather than constructing Date objects.
  return { ...yaml.load(front[1], { schema: yaml.JSON_SCHEMA }), source: file };
}

export function readiness(cards) {
  const failures = cards.filter(card => card.live &&
    (!nonempty(card.owner) || !nonempty(card.removal_criteria)))
    .map(card => ({ id: card.id, reason: 'Live flag requires owner and removal criteria' }));
  return { status: failures.length ? 'FAIL' : 'PASS', failures };
}

export function debt(cards, asOf, caps = {}) {
  if (!dateValue(asOf)) throw new Error('Supply as_of YYYY-MM-DD');
  for (const cap of Object.values(caps)) {
    if (!Number.isInteger(cap) || cap < 0) throw new Error('Caps must be nonnegative integers');
  }
  const rows = [], counts = {}, metadata_issues = [];
  for (const card of cards) {
    try { validateCard(card); } catch (error) { metadata_issues.push({ id: card.id, reason: error.message }); }
    if (card.lifetime !== 'temporary') continue;
    if (card.live) counts[card.service] = (counts[card.service] ?? 0) + 1;
    const reasons = [];
    if (card.removal_criteria_met) reasons.push('removal criteria met');
    if (dateValue(card.review_by) && card.review_by < asOf) reasons.push('past review-by');
    if (reasons.length) rows.push({ id: card.id, source: card.source, reasons,
      stage: card.code_removed ? 'ready to archive'
        : card.removal_criteria_met ? 'ready for code removal' : 'review required',
      owner: card.owner, removal_task: card.removal_task });
  }
  const services = [...new Set([...Object.keys(counts), ...Object.keys(caps)])].sort();
  return { as_of: asOf, rows, metadata_issues, counts: services.map(service => ({ service,
    live_temporary: counts[service] ?? 0, cap: caps[service] ?? null,
    over_cap: caps[service] != null && (counts[service] ?? 0) > caps[service] })) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [mode, file] = process.argv.slice(2);
    enumValue(mode, ['plan', 'debt', 'readiness'], 'mode');
    const input = JSON.parse(readFileSync(file, 'utf8'));
    const cards = mode === 'plan' ? [] : input.cards.map(readCard);
    const result = mode === 'plan' ? plan(input) : mode === 'debt'
      ? debt(cards, input.as_of, input.temporary_flag_caps) : readiness(cards);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (mode === 'readiness' && result.status === 'FAIL') process.exitCode = 1;
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
