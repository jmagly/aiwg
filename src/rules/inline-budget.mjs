/** Configurable lint guard only. Call with the complete projected startup set. */
export const DEFAULT_RULES_INLINE_BUDGET_TOKENS = 64000;

export function validateRulesConfig(rules) {
  if (rules === undefined) return [];
  if (rules === null || typeof rules !== 'object' || Array.isArray(rules)) return ['rules: must be an object'];
  const errors = Object.keys(rules).filter(key => key !== 'inline_budget_tokens').map(key => `rules.${key}: unknown field`);
  if (rules.inline_budget_tokens !== undefined && (!Number.isSafeInteger(rules.inline_budget_tokens) || rules.inline_budget_tokens < 0)) {
    errors.push('rules.inline_budget_tokens: must be a non-negative safe integer');
  }
  return errors;
}

export function resolveRulesInlineBudget(config = {}, env = process.env) {
  const errors = validateRulesConfig(config.rules);
  if (errors.length) throw new Error(errors.join('\n'));
  const override = env.AIWG_RULES_INLINE_BUDGET_TOKENS;
  if (override !== undefined) {
    if (!/^\d+$/.test(override) || !Number.isSafeInteger(Number(override))) {
      throw new Error('AIWG_RULES_INLINE_BUDGET_TOKENS: must be a non-negative safe integer');
    }
    return Number(override);
  }
  return config.rules?.inline_budget_tokens ?? DEFAULT_RULES_INLINE_BUDGET_TOKENS;
}

/** No filesystem writes or activation/selection changes. Provider hard caps are separate. */
export function guardRulesInlineBudget({ provider, files, config = {}, env = process.env, reportOnly = false }) {
  if (typeof provider !== 'string' || !provider.trim() || !Array.isArray(files)) {
    throw new Error('Startup budget requires a provider and the complete projected files array.');
  }
  const limit = resolveRulesInlineBudget(config, env);
  const contributors = files.map(file => {
    if (!file || typeof file.path !== 'string' || !file.path.trim()) throw new Error('Startup contributor requires a path');
    const bytes = file.bytes ?? (typeof file.content === 'string' ? Buffer.byteLength(file.content, 'utf8') : undefined);
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error(`Invalid startup byte count for ${file.path}`);
    return { path: file.path, bytes, estimated_tokens: bytes / 4 };
  }).sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
  const selected_bytes = contributors.reduce((total, file) => total + file.bytes, 0);
  if (!Number.isSafeInteger(selected_bytes)) throw new Error('Startup byte total exceeds safe integer range');
  const selected_tokens = selected_bytes / 4;
  const exceeded = limit > 0 && selected_tokens > limit;
  const report = { provider, limit, selected_bytes, selected_tokens, estimate: 'UTF-8 bytes / 4', disabled: limit === 0, exceeded, contributors };
  const diagnostics = exceeded ? [{ severity: reportOnly ? 'warn' : 'error', code: 'inline-budget',
    message: `Rules startup budget exceeded for ${provider}: ${selected_tokens} estimated tokens (${selected_bytes} bytes) selected; limit ${limit}. Contributors: ${contributors.map(file => `${file.path}: ${file.bytes} bytes (${file.estimated_tokens} tokens)`).join(', ')}. Activation-selected content is preserved.` }] : [];
  return { report, diagnostics, passed: !exceeded || reportOnly };
}
