/**
 * Provider-neutral model-role classification.
 *
 * Canonical agents historically used Claude family aliases, then moved to
 * pinned and provider-qualified identifiers. Deployment and filtering must
 * classify the family consistently without treating an unknown identifier as
 * coding.
 *
 * @implements #1801
 */

// Families by provider tier. Flagship families (Claude Fable, OpenAI GPT-6
// Astra) classify as reasoning: deployment never selects a flagship for a
// role, but an explicitly elected flagship pin must still classify.
const ROLE_PATTERNS = [
  ['reasoning', /(?:^|[/:._-])(?:opus|fable|sol|astra)(?:$|[/:._\[-]|\d)/i],
  ['coding', /(?:^|[/:._-])(?:sonnet|terra)(?:$|[/:._\[-]|\d)/i],
  ['efficiency', /(?:^|[/:._-])(?:haiku|luna)(?:$|[/:._\[-]|\d)/i],
];

/**
 * @typedef {'reasoning' | 'coding' | 'efficiency' | 'unknown'} ModelRole
 */

/**
 * Classify aliases, pinned family IDs, and provider-qualified IDs.
 *
 * Missing model metadata is handled separately from an explicit unknown pin:
 * callers may supply `defaultRole` for legacy artifacts that omit the field.
 *
 * @param {unknown} model
 * @param {{ defaultRole?: Exclude<ModelRole, 'unknown'> }} [options]
 * @returns {ModelRole}
 */
export function classifyModelRole(model, options = {}) {
  if (model === undefined || model === null || String(model).trim() === '') {
    return options.defaultRole ?? 'unknown';
  }

  const normalized = String(model).trim().replace(/^['"]|['"]$/g, '');
  for (const [role, pattern] of ROLE_PATTERNS) {
    if (pattern.test(normalized)) return /** @type {ModelRole} */ (role);
  }

  return 'unknown';
}

/**
 * Select a role-specific model without manufacturing a coding classification.
 *
 * @param {unknown} originalModel
 * @param {{reasoning: string, coding: string, efficiency: string}} models
 * @param {{ defaultRole?: 'reasoning' | 'coding' | 'efficiency' }} [options]
 * @returns {string | null}
 */
export function modelForRole(originalModel, models, options = {}) {
  const role = classifyModelRole(originalModel, options);
  return role === 'unknown' ? null : models[role];
}
