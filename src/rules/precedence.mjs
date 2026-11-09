// Resolve instruction ordering without changing activation, pinning, or enforcement.
import { RULE_PIN_TIERS } from './pins.mjs';

export function validateRulePrecedenceConfig(value) {
  if (value === undefined) return [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['rules.precedence: must be an object'];
  const errors = [];
  for (const [id, override] of Object.entries(value)) {
    const label = `rules.precedence.${id}`;
    if (!id.length || ['__proto__', 'prototype', 'constructor'].includes(id)) errors.push(`${label}: invalid rule id`);
    if (!override || typeof override !== 'object' || Array.isArray(override) || !Object.keys(override).length) {
      errors.push(`${label}: expected a non-empty override object`); continue;
    }
    for (const key of Object.keys(override)) if (!['tier', 'project_context'].includes(key)) errors.push(`${label}.${key}: unknown field`);
    if (override.tier !== undefined && !RULE_PIN_TIERS.includes(override.tier)) errors.push(`${label}.tier: expected ${RULE_PIN_TIERS.join(', ')}`);
    if (override.project_context !== undefined && typeof override.project_context !== 'boolean') errors.push(`${label}.project_context: must be a boolean`);
  }
  return errors;
}

/** IDs include a source slug and, when indexed, the stable rule identity. */
export function resolveRulePrecedence(rule, configs = { project: {}, user: {} }, aliases = []) {
  if (rule.precedence !== undefined && !RULE_PIN_TIERS.includes(rule.precedence)) throw new Error(`Rule ${rule.name ?? rule.id}: invalid precedence`);
  if (rule.overridable !== undefined && typeof rule.overridable !== 'boolean') throw new Error(`Rule ${rule.name ?? rule.id}: overridable must be a boolean`);
  let result = { precedence: rule.precedence ?? 'medium', overridable: rule.overridable ?? true,
    precedence_source: 'rule', project_context: false };
  const ids = new Set([rule.name, rule.id, ...aliases].filter(Boolean));
  for (const source of ['user', 'project']) {
    const errors = validateRulePrecedenceConfig(configs[source]?.rules?.precedence);
    if (errors.length) throw new Error(errors.join('\n'));
    const matches = Object.entries(configs[source]?.rules?.precedence ?? {}).filter(([id]) => ids.has(id));
    if (matches.length > 1) throw new Error(`Multiple precedence overrides name rule ${rule.name ?? rule.id} in ${source}`);
    if (!matches.length) continue;
    if (!result.overridable) throw new Error(`Rule ${rule.name ?? rule.id} is non-overridable (${source} rules.precedence)`);
    const [, override] = matches[0];
    result = { ...result, precedence: override.tier ?? result.precedence,
      project_context: override.project_context ?? result.project_context, precedence_source: source };
  }
  return result;
}

export const RULE_PRECEDENCE_TEXT = [
  'A skill follows its bound rules, even when its own instructions conflict.',
  'Between rules, higher precedence wins: critical > high > medium > low (default medium).',
  'At equal precedence, the narrower scope wins. When resolving a conflict, name the rule followed.',
  'Only explicit rules.precedence overrides may let project context outrank a named overridable rule;',
  'non-overridable rules cannot be overridden or demoted. Other layer ordering and platform constraints stay unchanged.',
  'Effective project ordering and its source are listed in WORKSPACE.md; skills never weaken non-overridable rules.',
].join('\n');
